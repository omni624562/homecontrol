"""大門口進出人數：從哪出現、在哪消失；手機都不在時用來判斷是不是真的都出門了。"""

import time

import pytest

from plughub.doorcount import DoorCount, classify

DOOR = [[0.0, 0.4], [0.2, 0.4], [0.2, 0.9], [0.0, 0.9]]  # 畫面左邊是家門
PIXEL = "EA:1C:F4:0C:26:B4"


def near(p):
    return "home" if p[0] <= 0.26 else "away"


def walk(dc, tid, t0, xs):
    for i, x in enumerate(xs):
        dc.feed(t0 + i * 0.2, [(tid, x, 0.7)])
    return t0 + len(xs) * 0.2


OUT = [0.1] * 6 + [0.3, 0.45, 0.6, 0.75, 0.85, 0.9, 0.9, 0.92, 0.93, 0.95]
IN = OUT[::-1]


def test_out_and_in():
    dc = DoorCount()
    end = walk(dc, 1, 100, OUT)
    assert dc.flush(end + 1, near) == []  # 才剛消失，再等等
    assert [w for w, _ in dc.flush(end + 4, near)] == ["out"]
    end = walk(dc, 2, 200, IN)
    assert [w for w, _ in dc.flush(end + 4, near)] == ["in"]


def test_passerby_and_door_to_door_not_counted():
    dc = DoorCount()
    end = walk(dc, 1, 100, [0.9, 0.8, 0.6, 0.4, 0.3, 0.4, 0.6, 0.8, 0.9, 0.95, 0.95, 0.95])  # 送貨：走到門口又走掉
    walk(dc, 2, 100, [0.1] * 12)  # 出來拿鞋又進去
    walk(dc, 3, 100, [0.1, 0.5])  # 閃一下的雜訊
    assert dc.flush(end + 10, near) == []


def test_lost_track_at_door_cancels_out():
    """在門口跟丟、同一個人變成兩段：一進一出，抵銷。"""
    dc = DoorCount()
    walk(dc, 1, 100, [0.9, 0.8, 0.6, 0.4, 0.3, 0.15, 0.1, 0.1, 0.1, 0.1, 0.1])
    end = walk(dc, 2, 103, [0.1, 0.1, 0.1, 0.1, 0.1, 0.3, 0.5, 0.7, 0.9, 0.9, 0.9])
    ways = [w for w, _ in dc.flush(end + 4, near)]
    assert sorted(ways) == ["in", "out"]


def test_two_people_counted_separately():
    dc = DoorCount()
    for i, x in enumerate(OUT):
        dc.feed(100 + i * 0.2, [(1, x, 0.7), (2, x, 0.6)])
    assert [w for w, _ in dc.flush(110, near)] == ["out", "out"]


def test_too_short_to_tell_direction():
    dc = DoorCount()
    end = walk(dc, 1, 100, [0.9, 0.7, 0.5, 0.3, 0.2, 0.1, 0.1])  # 7 筆：頭尾各 1 秒重疊
    assert dc.flush(end + 4, near) == []


def test_classify_majority():
    assert classify([(0.1, 0.5)] * 3 + [(0.5, 0.5)] * 2, [(0.9, 0.5)] * 5, near) == "out"
    assert classify([], [], near) is None


@pytest.fixture
def hub(app_module, monkeypatch):
    h = app_module.hub
    h.notes = []
    monkeypatch.setattr(h.notifier, "send", lambda title, msg, priority="default": h.notes.append((title, msg)))
    h.ran = []
    monkeypatch.setattr(h, "_presence_scene", lambda sid, why: h.ran.append(why))
    monkeypatch.setattr(h.cameras, "state", {})
    h._door_outs, h._door_out, h._door_live, h._room_seen = [], 0.0, 0.0, (0.0, "")
    h.store.data.pop("home_count", None)
    return h


CAM = {"id": "outdoor", "name": "大門口", "role": "entry", "zones": [{"id": "door", "kind": "door", "poly": DOOR}]}


def feed(hub, now, tid, xs):
    hub.cameras.state["outdoor"] = {"engine": "stream", "samples": [(now + i * 0.2, [(tid, x, 0.7)]) for i, x in enumerate(xs)]}
    hub._door_feed(CAM, now + len(xs) * 0.2)
    hub.cameras.state["outdoor"]["samples"] = []
    hub._door_feed(CAM, now + len(xs) * 0.2 + 4)
    return now + len(xs) * 0.2 + 4


def home(hub, now, *macs):
    hub.store.data["people"] = [{"id": f"p{i}", "name": n, "macs": [m]} for i, (n, m) in enumerate(macs)]
    hub._router_since = now - 3600
    hub.router.clients = {m: {"mac": m, "seen": now} for _, m in macs}
    hub._router_presence(now)


def test_hub_counts_and_logs(hub):
    now = time.time()
    home(hub, now, ("May", PIXEL), ("ERIC", "AA:BB:CC:00:00:01"))
    assert hub.home_count == 2  # 兩支手機在家：至少 2 人
    feed(hub, now, 7, OUT)
    assert hub.home_count == 1
    last = hub.store.data["presence_log"][-1]
    assert last["door"] == "out" and last["k"] == 1 and last["n"] == 1 and last["why"] == "大門口"
    feed(hub, now + 30, 8, IN)
    assert hub.home_count == 2


def test_wifi_off_but_nobody_left_holds(hub):
    """ERIC 出門（大門口看到 1 人出去），May 在家把 Wi-Fi 關了：只有一個人對得上，另一個先當作還在家。"""
    now = time.time()
    home(hub, now, ("May", PIXEL), ("ERIC", "AA:BB:CC:00:00:01"))
    t = feed(hub, now, 7, OUT)
    for c in hub.router.clients.values():
        c["seen"] = t - 700
    hub._door_feed(CAM, t + 1)
    hub._router_presence(t + 1)
    assert hub.ran == []
    assert sorted(st["home"] for st in hub._presence.values()) == [False, True]
    log = hub.store.data["presence_log"]
    assert any(e.get("stay") and "大門口沒看到人出去" in e["why"] for e in log)
    assert any(e.get("home") is False and "看到人出去" in e["why"] for e in log)
    n = len(log)
    hub._router_presence(t + 60)
    assert len(hub.store.data["presence_log"]) == n  # 「先當作還在家」只記一次
    # 另一個人也出門了：大門口又看到一個人出去 → 執行
    t2 = feed(hub, t + 600, 9, OUT)
    hub._router_presence(t2)
    assert hub.ran == ["大家都出門了"]


def test_everyone_seen_leaving_runs_at_once(hub):
    now = time.time()
    home(hub, now, ("May", PIXEL))
    hub._room_seen = (now - 20, "IN_HOUSE")  # 出門前才在客廳走動
    t = feed(hub, now, 7, OUT)
    hub.router.clients[PIXEL]["seen"] = t - 700
    hub._door_feed(CAM, t + 1)
    hub._router_presence(t + 1)
    assert hub.ran == ["大家都出門了"]


def test_missed_exit_gives_up_after_quiet_half_hour(hub):
    """兩個人貼著走被算成一個（少算一個出去）：手機斷線 30 分鐘、家裡也沒動靜，還是算出門。"""
    now = time.time()
    home(hub, now, ("May", PIXEL), ("ERIC", "AA:BB:CC:00:00:01"))
    t = feed(hub, now, 7, OUT)
    for c in hub.router.clients.values():
        c["seen"] = t - 700
    hub._router_presence(t + 1)
    assert hub.ran == []
    hub._door_feed(CAM, t + 1500)
    hub._router_presence(t + 1500)
    assert hub.ran == ["大家都出門了"]
    assert any("家裡也沒動靜" in (e.get("why") or "") for e in hub.store.data["presence_log"])


def test_moving_in_room_keeps_person_home(hub):
    """手機斷線、門口沒人出去、客廳還有人在動：一直算在家。"""
    now = time.time()
    home(hub, now, ("May", PIXEL))
    hub.cameras.state["outdoor"] = {"engine": "stream", "samples": []}
    hub._door_feed(CAM, now + 4000)
    hub.router.clients[PIXEL]["seen"] = now
    hub._room_seen = (now + 3900, "IN_HOUSE")
    hub._router_presence(now + 4000)
    assert hub.ran == [] and hub._presence["p0"]["home"]


def test_phone_back_cancels_stay(hub):
    now = time.time()
    home(hub, now, ("May", PIXEL))
    hub.router.clients[PIXEL]["seen"] = now - 700
    hub.cameras.state["outdoor"] = {"engine": "stream", "samples": []}
    hub._door_feed(CAM, now + 1)
    hub._router_presence(now + 1)
    assert hub._presence["p0"]["home"] and hub._presence["p0"].get("stay")
    hub.router.clients[PIXEL]["seen"] = now + 100
    hub._router_presence(now + 100)
    assert hub._presence["p0"]["home"] and hub.ran == []


def test_door_camera_down_uses_wifi_only(hub):
    now = time.time()
    home(hub, now, ("May", PIXEL))
    hub._door_live = now - 600
    hub.router.clients[PIXEL]["seen"] = now - 700
    hub._router_presence(now + 1)
    assert hub.ran == ["大家都出門了"]


# 真的畫面（2026-11-28 重跑錄影得到的腳的位置）：家門在左邊牆面，上緣緊貼著電梯
REAL = {"id": "outdoor", "name": "大門口", "role": "entry", "zones": [
    {"id": "door", "kind": "door", "poly": [[0.07, 0.23], [0.13, 0.22], [0.22, 0.59], [0.15, 0.61]]},
    {"id": "lift", "kind": "door", "poly": [[0.17, 0.18], [0.14, 0.07], [0.27, 0.03], [0.28, 0.29], [0.19, 0.33]]},
]}
RIGHT_DOOR = [(0.41, 0.50), (0.40, 0.55), (0.39, 0.60), (0.40, 0.52), (0.41, 0.51)]  # 鄰居的門（樓梯後面）
INTO_LIFT = [(0.20, 0.28), (0.19, 0.27), (0.18, 0.30), (0.18, 0.29), (0.20, 0.24)]  # 走進電梯：離家門區域只有 3～6%
OUT_OF_LIFT = [(0.21, 0.36), (0.22, 0.34), (0.23, 0.41), (0.21, 0.33), (0.23, 0.37)]
AT_HOME_DOOR = [(0.21, 0.56), (0.20, 0.55), (0.19, 0.56), (0.18, 0.53), (0.17, 0.51)]


def real(hub, first, last):
    return classify(first, last, lambda f: hub._door_where(REAL, REAL["zones"][0], f))


def test_neighbour_taking_lift_not_counted(hub):
    assert real(hub, RIGHT_DOOR, INTO_LIFT) is None  # 以前：算成「進來」
    assert real(hub, INTO_LIFT[::-1], RIGHT_DOOR) is None  # 以前：算成「出去」


def test_family_between_lift_and_home_door(hub):
    assert real(hub, OUT_OF_LIFT, AT_HOME_DOOR) == "in"
    assert real(hub, AT_HOME_DOOR, INTO_LIFT) == "out"
    assert real(hub, AT_HOME_DOOR, AT_HOME_DOOR) is None

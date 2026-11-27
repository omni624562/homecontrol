"""大門口進出人數：從哪出現、在哪消失；手機都不在時用來判斷是不是真的都出門了。"""

import time

import pytest

from plughub.doorcount import DoorCount, classify

DOOR = [[0.0, 0.4], [0.2, 0.4], [0.2, 0.9], [0.0, 0.9]]  # 畫面左邊是家門
PIXEL = "EA:1C:F4:0C:26:B4"


def near(p):
    return p[0] <= 0.26


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
    """ERIC 出門（大門口看到 1 人出去），May 在家把 Wi-Fi 關了：家裡還有 1 人，不執行「出門」。"""
    now = time.time()
    home(hub, now, ("May", PIXEL), ("ERIC", "AA:BB:CC:00:00:01"))
    t = feed(hub, now, 7, OUT)
    for c in hub.router.clients.values():
        c["seen"] = t - 700
    hub._door_feed(CAM, t + 1)
    hub._router_presence(t + 1)
    assert hub.ran == [] and hub._away_hold
    assert "大門口沒看到最後 1 個人出去" in hub.store.data["presence_log"][-1]["why"]
    # May 也出門了：大門口看到最後一個人出去 → 執行
    t2 = feed(hub, t + 600, 9, OUT)
    hub._away_hold_check(t2)
    assert hub.ran == ["大家都出門了（大門口看到最後一個人出去）"] and hub.home_count == 0


def test_everyone_seen_leaving_runs_at_once(hub):
    now = time.time()
    home(hub, now, ("May", PIXEL))
    hub._room_seen = (now - 20, "IN_HOUSE")  # 出門前才在客廳走動
    t = feed(hub, now, 7, OUT)
    hub.router.clients[PIXEL]["seen"] = t - 700
    hub._door_feed(CAM, t + 1)
    hub._router_presence(t + 1)
    assert hub.ran == ["大家都出門了"]


def test_door_hold_gives_up_after_quiet_hour(hub):
    """兩個人貼著走被算成一個（少算一個出去）：家裡 1 小時都沒動靜就照常執行。"""
    now = time.time()
    home(hub, now, ("May", PIXEL), ("ERIC", "AA:BB:CC:00:00:01"))
    t = feed(hub, now, 7, OUT)
    for c in hub.router.clients.values():
        c["seen"] = t - 700
    hub._router_presence(t + 1)
    assert hub._away_hold
    hub._door_feed(CAM, t + 1800)
    hub._away_hold_check(t + 1800)
    assert hub.ran == []
    hub._door_feed(CAM, t + 3700)
    hub._away_hold_check(t + 3700)
    assert hub.ran == ["大家都出門了（家裡一陣子沒動靜）"]


def test_counting_ignored_when_camera_not_tracking(hub):
    now = time.time()
    home(hub, now, ("May", PIXEL))
    hub.cameras.state["outdoor"] = {"engine": "cpu"}
    hub._door_feed(CAM, now)
    hub.router.clients[PIXEL]["seen"] = now - 700
    hub._router_presence(now)
    assert hub.ran == ["大家都出門了"]  # 沒在算進出：照原本的（只看手機）


def test_count_starts_from_phones_when_presence_restored(hub):
    """重開後「誰在家」是還原的（沒有變化）：人數還是要從手機在家的人數開始。"""
    now = time.time()
    home(hub, now, ("May", PIXEL))
    hub.store.data.pop("home_count", None)
    hub._router_presence(now + 5)
    assert hub.home_count == 1 and "home_count" in hub.store.data

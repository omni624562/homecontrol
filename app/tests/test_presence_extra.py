"""誰在家：最近變化的紀錄、Kobo 換 MAC 不通知、ARP 封包、公車首班車。"""

import socket
import sys
import time
from datetime import datetime

import pytest

from plughub import arpprobe
from plughub.bus import Bus

PIXEL = "EA:1C:F4:0C:26:B4"


@pytest.fixture
def hub(app_module, monkeypatch):
    h = app_module.hub
    notes = []
    monkeypatch.setattr(h.notifier, "send", lambda title, msg, priority="default": notes.append((title, msg)))
    h.notes = notes
    return h


def test_presence_log_records_reason(hub):
    hub.store.data["people"] = [{"id": "p1", "name": "ERIC", "macs": [PIXEL]}]
    hub.router.nodes = [{"mac": "60:CF:84:41:27:D0", "model": "RT-BE92U", "ip": "x", "main": True}]
    now = time.time()
    hub._router_since = now - 3600
    hub.router.clients = {PIXEL: {"mac": PIXEL, "seen": now - 7200}}
    hub._router_presence(now)  # 第一次：只記狀態
    hub.router.clients[PIXEL].update(seen=now, node="60:CF:84:41:27:D0", band="5G")
    hub._router_presence(now)
    log = hub.store.data["presence_log"]
    assert log[-1]["name"] == "ERIC" and log[-1]["home"] is True
    assert log[-1]["why"] == "手機連上 RT-BE92U 5G"
    hub.router.clients[PIXEL]["seen"] = now - 3600
    hub._router_presence(now)
    assert log[-1]["home"] is False and "沒連線" in log[-1]["why"]


def test_probe_reason(hub):
    hub.store.data["people"] = [{"id": "p1", "name": "May", "macs": ["5E:00:F6:90:A6:49"]}]
    now = time.time()
    hub.router.clients = {"5E:00:F6:90:A6:49": {"mac": "5E:00:F6:90:A6:49", "seen": now, "probe": now}}
    p = hub.store.data["people"][0]
    assert hub._presence_why(p, True, now, 600) == "樹莓派直接問到手機"


def test_probe_people_marks_seen(hub, monkeypatch):
    mac = "5E:00:F6:90:A6:49"
    hub.store.data["people"] = [{"id": "p1", "name": "May", "macs": [mac]}]
    hub.router.clients = {mac: {"mac": mac, "seen": time.time() - 300, "ip": "10.0.2.31"}}
    asked = []
    monkeypatch.setattr(sys.modules["plughub.hub"].arpprobe, "probe", lambda ip, m: asked.append((ip, m)) or True)
    import asyncio

    asyncio.run(hub._probe_people())
    assert asked == [("10.0.2.31", mac)]
    assert time.time() - hub.router.clients[mac]["seen"] < 5 and hub.router.clients[mac]["probe"]


def test_rotated_mac_not_alerted(hub):
    r = hub.router
    old, new = "00:08:22:68:A2:27", "00:08:22:BC:E8:D0"
    r.names = {old: {"name": "kobo"}, new: {"name": "kobo"}}
    hub.store.data["net_seeded"] = True
    hub.store.data["net_devices"] = {old: {"first": 1}}
    r.clients = {new: {"mac": new, "seen": time.time(), "ssid": "castle"}}
    hub._router_new_devices(time.time())
    assert not [n for n in hub.notes if n[0] == "有新裝置連上網路"]
    assert hub.store.data["net_devices"][new]["same_as"] == old
    # 手機的私人 MAC（0x02）不算同一台
    priv = "5E:00:F6:00:00:01"
    r.names[priv] = {"name": "kobo"}
    r.names["5E:00:F6:00:00:02"] = {"name": "kobo"}
    hub.store.data["net_devices"]["5E:00:F6:00:00:02"] = {"first": 1}
    r.clients = {priv: {"mac": priv, "seen": time.time()}}
    hub._router_new_devices(time.time())
    assert [n for n in hub.notes if n[0] == "有新裝置連上網路"]


def test_arp_frame_and_reply():
    me, them = bytes.fromhex("2ccf6726f722"), bytes.fromhex("ea1cf40c26b4")
    f = arpprobe.frame(me, "10.0.2.77", them, "10.0.2.111")
    assert len(f) == 42 and f[:6] == them and f[12:14] == b"\x08\x06"
    reply = me + them + b"\x08\x06" + bytes.fromhex("000108000604") + b"\x00\x02" + them + socket.inet_aton("10.0.2.111") + me + socket.inet_aton("10.0.2.77")
    assert arpprobe.is_reply(reply, them, "10.0.2.111")
    assert not arpprobe.is_reply(reply, me, "10.0.2.111")  # MAC 不對
    assert not arpprobe.is_reply(reply, them, "10.0.2.112")  # IP 不對


def test_arp_probe_refuses_public_ip():
    assert arpprobe.probe("8.8.8.8", PIXEL) is False


def test_bus_next_first():
    r = {"firsts": {"0": 360, "1": 330, "h0": 420, "h1": None}}
    fri_night = datetime(2026, 11, 20, 23, 30)  # 明天週六：假日班表
    assert Bus.next_first(r, "0", fri_night) == "07:00"
    assert Bus.next_first(r, "1", fri_night) == "05:30"  # 假日沒寫就用平日
    mon_early = datetime(2026, 11, 23, 4, 0)
    assert Bus.next_first(r, "0", mon_early) == "06:00"
    assert Bus.next_first({}, "0", mon_early) is None


def test_bus_nearby(tmp_path, monkeypatch):
    import plughub.bus as bus

    def fake_get(dataset, **q):
        if dataset == bus.ROUTES:
            return [{"id": "1", "namezh": "橘18"}, {"id": "2", "namezh": "F312"}, {"id": "3", "namezh": "遠方"}]
        return [
            {"routeid": "1", "namezh": "家門口", "latitude": "25.0001", "longitude": "121.5"},
            {"routeid": "1", "namezh": "遠一點", "latitude": "25.003", "longitude": "121.5"},
            {"routeid": "2", "namezh": "巷口", "latitude": "25.004", "longitude": "121.5"},
            {"routeid": "3", "namezh": "山上", "latitude": "25.1", "longitude": "121.5"},
        ]

    monkeypatch.setattr(bus, "_get", fake_get)
    b = bus.Bus(tmp_path, lambda: {}, lambda: (25.0, 121.5))
    assert b.due() == "nearby"
    b.fetch("nearby")
    assert [(x["name"], x["stop"]) for x in b.nearby] == [("橘18", "家門口"), ("F312", "巷口")]
    assert b.report(None)["nearby"][0]["m"] == 11
    assert b.due() is None  # 沒設定路線、附近也查過了
    # 存檔：重開也在
    assert bus.Bus(tmp_path, lambda: {}, lambda: (25.0, 121.5)).due() is None


def test_garbage_done_today(tmp_path):
    from datetime import datetime

    from plughub.localinfo import LocalInfo

    li = LocalInfo.__new__(LocalInfo)
    li.truck, li.arrivals, li.no_pickup = None, {}, lambda d, m: None
    sat = datetime(2026, 11, 21, 20, 30)  # 週六
    s = {"lineid": "L", "rank": 3, "time": "20:17", "days": {"garbage": [5], "recycling": [], "foodscraps": []}}
    assert not li.done_today(s, sat)  # 還在追蹤時間內
    assert li.done_today(s, datetime(2026, 11, 21, 21, 0))  # 過了 20:17 + 40 分
    assert not li.done_today(s, datetime(2026, 11, 22, 21, 0))  # 週日不收
    li.arrivals = {"L:3": [{"d": "2026-11-21", "m": 20 * 60 + 11}]}
    assert li.done_today(s, sat)  # 記到車子已經到過
    li.truck = {"stops": 0}
    assert not li.done_today(s, sat)  # 車子還在（剛到站）



def test_garbage_lunar_new_year(tmp_path):
    from datetime import date

    from plughub.daysoff import DaysOff
    from plughub.localinfo import LocalInfo

    off = DaysOff(tmp_path, None)
    off._read_holidays(2027, [{"date": "20270205", "isHoliday": True, "description": "農曆除夕"},
                              {"date": "20270206", "isHoliday": True, "description": "春節"},
                              {"date": "20270207", "isHoliday": True, "description": "春節"},
                              {"date": "20270208", "isHoliday": True, "description": "春節"}])
    assert off.garbage_off(date(2027, 2, 5), 20 * 60 + 17) == "除夕停收"  # 除夕只收到 18:00
    assert off.garbage_off(date(2027, 2, 5), 10 * 60) is None
    assert off.garbage_off(date(2027, 2, 7), 600) == "春節停收"  # 週日也算
    assert off.garbage_off(date(2027, 2, 9), 600) is None  # 初四恢復

    li = LocalInfo.__new__(LocalInfo)
    li.no_pickup = off.garbage_off
    s = {"time": "20:17", "days": {"garbage": [0, 1, 3, 4, 5], "recycling": [], "foodscraps": []}}
    assert li.week_kinds(s, date(2027, 2, 5)) == ["一般垃圾"] and li.today_kinds(s, date(2027, 2, 5)) == []
    assert li.off_reason(s, date(2027, 2, 6)) == "春節停收"
    assert li.off_reason(s, date(2027, 2, 7)) is None  # 週日本來就不收，不用寫停收
    assert li.today_kinds(s, date(2027, 2, 9)) == ["一般垃圾"]


# ---- 回家自動開 ----

MOM = "5E:00:F6:90:A6:49"


def _arrive_setup(hub, monkeypatch):
    hub.store.data["people"] = [{"id": "p1", "name": "ERIC", "macs": [PIXEL]}, {"id": "p2", "name": "May", "macs": [MOM]}]
    now = time.time()
    hub._router_since = now - 3600
    hub.router.clients = {PIXEL: {"mac": PIXEL, "seen": now - 7200}, MOM: {"mac": MOM, "seen": now - 7200}}
    hub._presence = {}
    hub._router_presence(now)  # 先記下：兩個人都不在家
    ran, opened = [], []
    monkeypatch.setattr(hub, "_presence_scene", lambda sid, why: ran.append((sid, why)))

    async def fake_arrive_plugs(r, why):
        opened.append((tuple(r["plugs"]), why))

    monkeypatch.setattr(hub, "_arrive_plugs", fake_arrive_plugs)
    import asyncio

    monkeypatch.setattr(hub, "_spawn", lambda coro: asyncio.run(coro))
    return now, ran, opened


def test_arrive_rules_by_person_and_empty_house(hub, monkeypatch):
    from plughub.hub import arrive_rule

    now, ran, opened = _arrive_setup(hub, monkeypatch)
    monkeypatch.setattr(hub, "is_dark", lambda: True)
    hub.store.data["arrive_rules"] = [
        arrive_rule(id="a", who="any", only_empty=True, kind="scene", scene="s-home"),
        arrive_rule(id="b", who="p2", kind="plugs", plugs=["fan"], when="dark"),
        arrive_rule(id="c", who="p2", kind="plugs", plugs=["tv"], enabled=False),
    ]
    hub.router.clients[PIXEL]["seen"] = now  # ERIC 先回家：家裡原本沒人 → 執行 a；b 是 May 的
    hub._router_presence(now)
    assert ran == [("s-home", "ERIC回家了")] and opened == []
    hub.router.clients[MOM]["seen"] = now  # May 回家：家裡已經有人 → a 不做；b 做；c 暫停
    hub._router_presence(now)
    assert len(ran) == 1 and opened == [(("fan",), "May回家了")]
    assert hub.store.data["arrive_rules"][1]["last"]
    # 白天：「天黑後」的不做
    monkeypatch.setattr(hub, "is_dark", lambda: False)
    hub._arrive(["p2"], was_empty=False)
    assert len(opened) == 1


def test_arrive_rule_time_range_and_days(hub, monkeypatch):
    from plughub import hub as hubmod
    from plughub.hub import arrive_rule

    _arrive_setup(hub, monkeypatch)

    class FakeDT(datetime):
        @classmethod
        def now(cls, tz=None):
            return datetime(2026, 11, 28, 18, 30)  # 週六 18:30

    monkeypatch.setattr(hubmod, "datetime", FakeDT)
    hub.store.data["arrive_rules"] = [
        arrive_rule(id="a", who="p1", kind="scene", scene="s1", when="range", start="17:00", end="22:00", days="weekday"),
        arrive_rule(id="b", who="p1", kind="scene", scene="s2", when="range", start="17:00", end="22:00", days="weekend"),
        arrive_rule(id="c", who="p1", kind="scene", scene="s3", when="range", start="20:00", end="23:00"),
    ]
    ran = []
    monkeypatch.setattr(hub, "_presence_scene", lambda sid, why: ran.append(sid))
    hub._arrive(["p1"], was_empty=True)
    assert ran == ["s2"]


def test_migrate_old_home_settings(hub):
    hub.store.data["people"] = [{"id": "p1", "name": "ERIC", "macs": []}]
    hub.store.data["scenes"] = [{"id": "s-home", "name": "回家", "icon": "x", "actions": {}}, {"id": "s-n", "name": "晚上", "icon": "x", "actions": {}}]
    hub.store.data["settings"]["presence"] = {"home_scene": "s-home", "home_dark_only": True}
    hub.store.data["settings"]["face_actions"] = {"p1": {"night": "s-n", "notify": True}}
    hub._migrate_arrive_rules()
    rules = hub.store.data["arrive_rules"]
    assert [(r["who"], r["only_empty"], r["when"], r["scene"]) for r in rules] == [("any", True, "dark", "s-home"), ("p1", False, "dark", "s-n")]
    assert hub.store.data["settings"]["presence"]["home_scene"] is None
    assert hub.store.data["settings"]["face_actions"] == {"p1": {"notify": True}}


def _fake_plug(hub, pid):
    from plughub.hub import Plug

    hub.plugs[pid] = Plug(id=pid, device_key=pid, kasa_name=pid, model="HS103", host="10.0.0.9", is_on=False, online=True)
    return pid


def test_arrive_rules_api(app_module):
    from fastapi.testclient import TestClient

    app_module.store.data["people"] = [{"id": "p1", "name": "ERIC", "macs": []}]
    app_module.store.data["arrive_rules"] = []
    pid = _fake_plug(app_module.hub, "fan")
    c = TestClient(app_module.app, base_url="http://hub:8100")
    token, _ = app_module.auth.pair(app_module.auth.new_code())
    c.cookies.set("plughub_token", token)
    r = c.post("/api/arrive-rules", json={"who": "p1", "kind": "plugs", "plugs": []})
    assert r.status_code == 400 and "插座" in r.json()["detail"]
    assert c.post("/api/arrive-rules", json={"who": "ghost", "kind": "scene", "scene": "x"}).status_code == 400
    assert c.post("/api/arrive-rules", json={"who": "p1", "kind": "plugs", "plugs": ["x"], "when": "range", "start": "17:00"}).status_code == 400
    r = c.post("/api/arrive-rules", json={"who": "p1", "kind": "plugs", "plugs": [pid, "nope"], "when": "dark", "for_min": 30}).json()
    rule = r["rules"][0]
    assert rule["plugs"] == [pid] and rule["when"] == "dark" and rule["for_min"] == 30 and rule["enabled"]
    r = c.put(f"/api/arrive-rules/{rule['id']}", json={"enabled": False, "days": "weekend"}).json()
    assert r["rules"][0]["enabled"] is False and r["rules"][0]["days"] == "weekend" and r["rules"][0]["plugs"] == [pid]
    assert c.put("/api/arrive-rules/zzz", json={}).status_code == 404
    assert c.delete(f"/api/arrive-rules/{rule['id']}").json()["rules"] == []
    assert c.delete(f"/api/arrive-rules/{rule['id']}").status_code == 404


def test_arrive_suggestions(hub):
    hub.store.data["people"] = [{"id": "p1", "name": "阿爸", "macs": []}]
    hub.store.data["arrive_rules"] = []
    now = time.time()
    base = now - 10 * 86400
    hub.store.data["presence_log"] = [{"t": base + i * 86400, "name": "阿爸", "home": True, "why": "x"} for i in range(5)]
    fan = _fake_plug(hub, "fan")
    for i in range(3):
        hub.store.energy.log_switch(base + i * 86400 + 300, fan, True, "button")
    hub.store.energy.log_switch(base + 4 * 86400 + 3600, fan, True, "button")  # 回家 1 小時後才開：不算
    s = hub.arrive_suggestions()
    assert s and s[0]["who"] == "p1" and s[0]["plug"] == fan and s[0]["hits"] == 3 and s[0]["n"] == 5
    from plughub.hub import arrive_rule

    hub.store.data["arrive_rules"] = [arrive_rule(who="p1", plugs=[fan])]
    assert hub.arrive_suggestions() == []


def test_plug_icon_pick(app_module):
    import re
    from pathlib import Path
    from fastapi.testclient import TestClient
    from plughub.store import ICONS

    pid = _fake_plug(app_module.hub, "lamp")
    c = TestClient(app_module.app, base_url="http://hub:8100")
    token, _ = app_module.auth.pair(app_module.auth.new_code())
    c.cookies.set("plughub_token", token)
    assert c.patch(f"/api/plugs/{pid}", json={"icon": "rocket"}).status_code == 400
    assert c.patch(f"/api/plugs/{pid}", json={"icon": "lamp-floor"}).status_code == 200
    plug = next(p for p in c.get("/api/state").json()["plugs"] if p["id"] == pid)
    assert plug["icon"] == "lamp-floor"
    c.patch(f"/api/plugs/{pid}", json={"icon": None})
    assert app_module.store.meta(pid).icon is None
    # 前端圖庫的代碼要跟後端一致
    src = (Path(__file__).parent.parent / "web/src/components/icons.tsx").read_text("utf-8")
    assert set(re.findall(r'\{ key: "([a-z-]+)", label:', src)) == set(ICONS)


def test_plug_usage_habit(app_module):
    from fastapi.testclient import TestClient
    from plughub.store import usage_watts

    pid = _fake_plug(app_module.hub, "kitchen")
    c = TestClient(app_module.app, base_url="http://hub:8100")
    token, _ = app_module.auth.pair(app_module.auth.new_code())
    c.cookies.set("plughub_token", token)
    u = {"kind": "air-fryer", "watts": 1500, "days": 7, "times": 1, "minutes": 30}
    # 1.5 kW × 0.5 h × 0.7 = 0.525 度／天 → 平均 21.9 W
    assert usage_watts(u) == 21.9
    assert c.patch(f"/api/plugs/{pid}", json={"usage": {**u, "days": 9}}).status_code == 400
    assert c.patch(f"/api/plugs/{pid}", json={"usage": {**u, "times": 21}}).status_code == 400
    assert c.patch(f"/api/plugs/{pid}", json={"usage": {**u, "kind": "microwave", "times": 8, "minutes": 2}}).status_code == 200
    assert c.patch(f"/api/plugs/{pid}", json={"usage": {**u, "kind": "rocket"}}).status_code == 400
    assert c.patch(f"/api/plugs/{pid}", json={"usage": u}).status_code == 200
    meta = app_module.store.meta(pid)
    assert meta.watts == 21.9 and meta.usage["minutes"] == 30
    plug = next(p for p in c.get("/api/state").json()["plugs"] if p["id"] == pid)
    assert plug["usage"]["kind"] == "air-fryer" and plug["watts"] == 21.9
    # 改回一般瓦數：使用習慣清掉
    c.patch(f"/api/plugs/{pid}", json={"watts": 40})
    assert meta.watts == 40 and meta.usage is None


def test_away_held_while_room_camera_sees_people(hub):
    """手機都不在 Wi-Fi（有人把 Wi-Fi 關了），但房間的攝影機剛看到人：「出門」先不執行。"""
    ran = []
    hub._presence_scene = lambda sid, why: ran.append(why)
    hub.store.data["people"] = [{"id": "p1", "name": "May", "macs": [PIXEL]}]
    now = time.time()
    hub._router_since = now - 3600
    hub.router.clients = {PIXEL: {"mac": PIXEL, "seen": now}}
    hub._router_presence(now)
    hub._room_seen = (now - 120, "IN_HOUSE")
    hub.router.clients[PIXEL]["seen"] = now - 700
    hub._router_presence(now)
    assert ran == [] and hub._away_hold
    assert hub.store.data["presence_log"][-1]["hold"] is True
    assert any("先不執行" in n[1] for n in hub.notes)
    hub._away_hold_check(now + 300)  # 攝影機還在 15 分鐘內看過人
    assert ran == []
    hub._away_hold_check(now + 900)  # 15 分鐘都沒看到人：執行
    assert len(ran) == 1 and not hub._away_hold


def test_away_hold_cancelled_when_phone_back(hub):
    ran = []
    hub._presence_scene = lambda sid, why: ran.append(why)
    hub.store.data["people"] = [{"id": "p1", "name": "May", "macs": [PIXEL]}]
    now = time.time()
    hub._router_since = now - 3600
    hub.router.clients = {PIXEL: {"mac": PIXEL, "seen": now}}
    hub._router_presence(now)
    hub._room_seen = (now, "IN_HOUSE")
    hub.router.clients[PIXEL]["seen"] = now - 700
    hub._router_presence(now)
    hub.router.clients[PIXEL]["seen"] = now + 60  # Wi-Fi 打開了
    hub._router_presence(now + 60)
    assert not hub._away_hold
    hub._away_hold_check(now + 2000)
    assert ran == []


def test_away_runs_when_no_one_seen(hub):
    ran = []
    hub._presence_scene = lambda sid, why: ran.append(why)
    hub.store.data["people"] = [{"id": "p1", "name": "May", "macs": [PIXEL]}]
    now = time.time()
    hub._router_since = now - 3600
    hub.router.clients = {PIXEL: {"mac": PIXEL, "seen": now}}
    hub._router_presence(now)
    hub._room_seen = (now - 3600, "IN_HOUSE")
    hub.router.clients[PIXEL]["seen"] = now - 700
    hub._router_presence(now)
    assert ran == ["大家都出門了"]


def test_static_fake_person_is_not_someone_home(app_module):
    """沙發上的衣服堆一直被認成人（位置不動、編號一直換）：不算有人在家；走動的人才算。"""
    hub = app_module.hub
    pile = lambda i: {"engine": "stream", "person": 0.6, "tracks": [{"id": i, "foot": (0.19, 0.996)}]}  # noqa: E731
    assert [hub._room_people("inhouse", pile(i)) for i in (1, 1, 2, 3, 3)] == [0, 0, 0, 0, 0]
    walk = lambda x: {"engine": "stream", "person": 0.9, "tracks": [{"id": 9, "foot": (x, 0.6)}, {"id": 3, "foot": (0.19, 0.996)}]}  # noqa: E731
    assert [hub._room_people("inhouse", walk(x)) for x in (0.5, 0.52, 0.6, 0.6)] == [0, 0, 1, 1]  # 走過之後坐著不動也還算
    assert hub._room_people("inhouse", {"engine": "pi", "person": True}) == 1  # 沒有追蹤資料：照舊


def test_away_hold_survives_restart(app_module):
    hub = app_module.hub
    hub._away_hold = 123.0
    assert hub.store.data["away_hold"] == 123.0
    hub._away_hold = None
    assert hub._away_hold is None


def test_camera_alert_skips_thing_that_never_moved(app_module, monkeypatch):
    """沒人在家，客廳攝影機一直「看到人」但那個人從沒動過（衣服堆）：不發警報；有在動的才發。"""
    hub = app_module.hub
    notes = []
    monkeypatch.setattr(hub.notifier, "send", lambda title, msg, priority="default": notes.append(title))
    monkeypatch.setattr(hub, "people_report", lambda: [{"name": "May", "home": False}])
    monkeypatch.setattr(hub.cameras, "get", lambda cid: {"id": cid, "name": "IN_HOUSE", "role": "room"})
    monkeypatch.setattr(hub.cameras, "state", {"inhouse": {"engine": "stream"}})
    now = time.time()
    hub._cam_moved.clear()
    hub._cam_quiet.clear()
    hub._cam_pending = {"inhouse": now - 300}
    hub._camera_pending(now)
    assert notes == [] and not hub._cam_pending
    hub._cam_pending = {"inhouse": now - 300}
    hub._cam_moved["inhouse"] = now - 200
    hub._camera_pending(now)
    assert notes == ["⚠️ 沒人在家，但攝影機看到人"]
    hub._cam_quiet.clear()
    hub._cam_alert.clear()


def test_everyone_out_false_while_holding(app_module, monkeypatch):
    hub = app_module.hub
    monkeypatch.setattr(hub, "people_report", lambda: [{"name": "May", "home": False}])
    hub._away_hold = None
    assert hub.everyone_out()
    hub._away_hold = time.time()
    assert not hub.everyone_out()
    hub._away_hold = None

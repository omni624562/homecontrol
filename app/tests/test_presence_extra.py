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
    li.truck, li.arrivals = None, {}
    sat = datetime(2026, 11, 21, 20, 30)  # 週六
    s = {"lineid": "L", "rank": 3, "time": "20:17", "days": {"garbage": [5], "recycling": [], "foodscraps": []}}
    assert not li.done_today(s, sat)  # 還在追蹤時間內
    assert li.done_today(s, datetime(2026, 11, 21, 21, 0))  # 過了 20:17 + 40 分
    assert not li.done_today(s, datetime(2026, 11, 22, 21, 0))  # 週日不收
    li.arrivals = {"L:3": [{"d": "2026-11-21", "m": 20 * 60 + 11}]}
    assert li.done_today(s, sat)  # 記到車子已經到過
    li.truck = {"stops": 0}
    assert not li.done_today(s, sat)  # 車子還在（剛到站）

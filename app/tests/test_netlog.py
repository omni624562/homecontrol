"""網路狀況：基地台卡住、外網斷線、停電恢復、一週動靜。"""
from __future__ import annotations

import asyncio
import types
from datetime import datetime

from plughub import netlog

A = {"mac": "AA", "model": "RT-BE92U", "main": True}
B = {"mac": "BB", "model": "RT-AX86U", "main": False}


def test_wifi_by_node():
    cl = {"1": {"node": "AA"}, "2": {"node": "BB"}, "3": {"node": "AA", "wired": True}, "4": {"node": "BB"}}
    assert netlog.wifi_by_node(cl, ["1", "2", "3"]) == {"AA": 1, "BB": 1}


def test_ap_check_stuck_and_back():
    st: dict = {}
    assert netlog.ap_check([A, B], {"AA": 5, "BB": 2}, st, 0) == []
    assert netlog.ap_check([A, B], {"AA": 7}, st, 100) == []  # 剛變 0 台
    assert netlog.ap_check([A, B], {"AA": 7}, st, 100 + 599) == []  # 還不到 10 分鐘
    ev = netlog.ap_check([A, B], {"AA": 7}, st, 100 + 600)
    assert [(k, n["mac"]) for k, n in ev] == [("stuck", "BB")]
    assert netlog.ap_check([A, B], {"AA": 7}, st, 2000) == []  # 只通知一次
    ev = netlog.ap_check([A, B], {"AA": 6, "BB": 1}, st, 3000)
    assert ev[0][0] == "back" and ev[0][1]["start"] == 100


def test_ap_check_ignores_few_devices_and_never_used_nodes():
    st: dict = {}
    netlog.ap_check([A, B], {"AA": 3}, st, 0)
    assert netlog.ap_check([A, B], {"AA": 3}, st, 5000) == []  # 全家只有 3 台：不判斷
    st2: dict = {}
    assert netlog.ap_check([A, B], {"AA": 9}, st2, 0) == []
    assert netlog.ap_check([A, B], {"AA": 9}, st2, 5000) == []  # BB 從來沒有裝置連過：不算卡住


def test_week_grid():
    start = int(datetime(2026, 11, 16, 8, 0).timestamp())  # 週一 08:00
    vals = [0.0, 0.5, 1.2, None] + [0.0] * 8  # 08:00～08:55 每 5 分鐘
    g = netlog.week_grid(start, 300, {"r": vals}, 0.4)["rooms"]["r"]
    assert g[0][8] == round(2 / 11, 3)
    assert g[0][9] is None and g[1][8] is None


def test_fmt_dur():
    assert netlog.fmt_dur(30) == "1 分鐘"
    assert netlog.fmt_dur(3600 * 2 + 300) == "2 小時 5 分"


def _hub_with_plug(app_module, monkeypatch, pid="p-r", risky=False):
    hub = app_module.hub
    plug = types.SimpleNamespace(id=pid, online=False, is_on=True, offline_since=1000.0, kasa_name="燈")
    hub.plugs[pid] = plug
    calls = []

    async def fake_power(p, on, force=False):
        calls.append((p, on))
        hub.plugs[p].is_on = on

    async def no_sleep(_):
        return None

    monkeypatch.setattr(hub, "set_power", fake_power)
    monkeypatch.setattr(hub, "_spawn", lambda coro: asyncio.run(coro))
    monkeypatch.setattr(asyncio, "sleep", no_sleep)
    sent = []
    monkeypatch.setattr(hub.notifier, "send", lambda *a, **k: sent.append(a))
    if risky:
        hub.store.meta(pid).risky = True
    return hub, plug, calls, sent


def test_power_restore_turns_back_on(app_module, monkeypatch):
    import time as t
    hub, plug, calls, sent = _hub_with_plug(app_module, monkeypatch)
    plug.offline_since = t.time() - 60
    hub._before["p-r"] = True
    plug.is_on = False  # 回來時變成關的
    plug.online = True
    hub._maybe_restore(plug, False)
    assert calls == [("p-r", True)]
    assert sent and "開回" in sent[0][1]
    assert hub.store.data["net_events"][-1]["kind"] == "power"


def test_power_restore_skips_risky_and_same_state(app_module, monkeypatch):
    import time as t
    hub, plug, calls, _ = _hub_with_plug(app_module, monkeypatch, risky=True)
    plug.offline_since = t.time() - 60
    hub._before["p-r"] = True
    hub._maybe_restore(plug, False)  # 高風險電器不自動開
    hub._before["p-r"] = False
    hub._maybe_restore(plug, False)  # 一樣：不動
    assert calls == []


def test_power_restore_turns_off_and_respects_setting(app_module, monkeypatch):
    import time as t
    hub, plug, calls, _ = _hub_with_plug(app_module, monkeypatch, risky=True)
    plug.offline_since = t.time() - 60
    plug.online, plug.is_on = True, True
    hub._before["p-r"] = False
    hub._maybe_restore(plug, True)  # 本來關著、回來變開：關掉（高風險也關）
    assert calls == [("p-r", False)]
    hub.store.data["settings"]["power_restore"] = False
    plug.is_on = True
    hub._before["p-r"] = False
    hub._maybe_restore(plug, True)
    assert calls == [("p-r", False)]


def test_wan_outage_logged_after_recovery(app_module, monkeypatch):
    hub = app_module.hub
    sent = []
    monkeypatch.setattr(hub.notifier, "send", lambda *a, **k: sent.append(a))
    res = iter([False, False, False, True])

    async def fake_ok():
        return next(res)

    import sys
    monkeypatch.setattr(sys.modules["plughub.netlog"], "wan_ok", fake_ok)  # conftest 重新載入過 plughub
    for _ in range(3):
        asyncio.run(hub._wan_tick())
    assert hub._wan["down"] and not sent
    assert any(e["kind"] == "wan" and e["end"] is None for e in hub.net_events_report()["events"])
    asyncio.run(hub._wan_tick())
    assert not hub._wan["down"] and "外網恢復" in sent[0][0]
    assert hub.store.data["net_events"][-1]["kind"] == "wan"


def test_ap_stuck_notifies(app_module, monkeypatch):
    hub = app_module.hub
    sent = []
    monkeypatch.setattr(hub.notifier, "send", lambda *a, **k: sent.append(a))
    monkeypatch.setattr(hub, "_spawn", lambda coro: coro.close())
    r = hub.router
    r.ok = True
    r.nodes = [A, B]
    hub._router_since = 0.0
    hub._ap_state = {"BB": {"last": 9000.0, "zero": None, "stuck": None}}
    monkeypatch.setattr(r, "online", lambda mac, within=90: True)
    r.clients = {str(i): {"node": "AA"} for i in range(6)}
    hub._check_aps(10000)
    hub._check_aps(10000 + 601)
    assert sent and "RT-AX86U" in sent[0][1]
    r.clients["x"] = {"node": "BB"}
    hub._check_aps(11000)
    assert "恢復" in sent[-1][0] and hub.store.data["net_events"][-1]["kind"] == "ap"

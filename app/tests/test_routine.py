"""例行判斷：電費級距、晚安檢查、離家模式自動開關、插座連線健檢、每月報告。"""
from __future__ import annotations

import asyncio
import sys
import time
import types
from datetime import date, datetime

from plughub import routine


def test_tier_alert():
    d = date(2026, 11, 20)  # 非夏月
    assert routine.tier_alert(300, 60, 40, 20, d) is None  # 300+20=320，還在 330 以下
    hit = routine.tier_alert(300, 80, 40, 20, d)
    assert hit == {"est": 340, "limit": 330, "extra": 40.0, "from": 2.26, "to": 3.13}
    assert routine.tier_alert(300, 80, 40, 3, d) is None  # 月初太早，不預估
    assert routine.tier_alert(300, 80, 0, 20, d) is None  # 沒有上個月的資料


def test_month_helpers_and_net_summary():
    assert routine.prev_month(date(2026, 1, 1)) == "2025-12"
    s, e = routine.month_range("2025-12")
    assert datetime.fromtimestamp(s) == datetime(2025, 12, 1) and datetime.fromtimestamp(e) == datetime(2026, 1, 1)
    evs = [{"kind": "wan", "start": s + 10, "end": s + 70}, {"kind": "wan", "start": s + 100, "end": s + 160},
           {"kind": "plug", "start": e + 5, "end": e + 50}]
    assert routine.net_summary(evs, s, e) == {"wan": {"count": 2, "sec": 120.0}}


def test_night_due():
    assert routine.night_due("23:30", datetime(2026, 11, 23, 23, 0), None) is None
    assert routine.night_due("23:30", datetime(2026, 11, 23, 23, 31), None) == "2026-11-23"
    assert routine.night_due("23:30", datetime(2026, 11, 24, 1, 0), None) == "2026-11-23"  # 樹莓派重開，凌晨補做
    assert routine.night_due("23:30", datetime(2026, 11, 24, 1, 0), "2026-11-23") is None  # 做過了
    assert routine.night_due("23:30", datetime(2026, 11, 24, 3, 0), None) is None  # 太晚了
    assert routine.night_due("00:30", datetime(2026, 11, 24, 0, 40), None) == "2026-11-23"  # 過午夜的時間算前一晚
    assert routine.night_due("00:30", datetime(2026, 11, 24, 12, 0), None) is None
    assert routine.night_due("", datetime(2026, 11, 24, 0, 40), None) is None


def test_away_auto():
    cfg = {"auto_on": True, "plugs": ["a"], "auto_h": 4}
    assert routine.away_auto(cfg, False, 0.0 + 1, 4 * 3600) is None
    assert routine.away_auto(cfg, False, 1.0, 4 * 3600 + 2) == "on"
    assert routine.away_auto(cfg, True, None, 99999) is None
    assert routine.away_auto({**cfg, "enabled": True}, False, 1.0, 99999) is None
    assert routine.away_auto({**cfg, "auto_on": False}, False, 1.0, 99999) is None
    assert routine.away_auto({**cfg, "plugs": []}, False, 1.0, 99999) is None


def test_plug_health():
    now = 100 * 86400.0
    drops: dict = {}
    for i in range(3):
        routine.add_drop(drops, "a", now - 1000 * (i + 1), now - 1000 * (i + 1) + 60)
    routine.add_drop(drops, "b", now - 40 * 86400, now - 40 * 86400 + 60)  # 太久以前：丟掉
    routine.add_drop(drops, "b", now - 5000, now - 4900)
    assert len(drops["b"]) == 1
    # 停電：四個插座同時斷，不算插座的問題
    for pid in ("a", "b", "c", "d"):
        routine.add_drop(drops, pid, now - 20000, now - 19000)
    plugs = [{"id": "a", "name": "A", "rssi": -75}, {"id": "b", "name": "B", "rssi": -50},
             {"id": "c", "name": "C", "rssi": -72}, {"id": "d", "name": "D", "rssi": None}]
    out = {h["id"]: h for h in routine.plug_health(drops, plugs, now)}
    assert out["a"]["drops"] == 3 and out["a"]["level"] == "bad" and "訊號弱" in out["a"]["tip"]
    assert out["b"]["drops"] == 1 and out["b"]["level"] == "ok"
    assert out["c"]["drops"] == 0 and out["c"]["level"] == "warn"
    assert out["d"]["level"] == "ok" and out["d"]["tip"] == ""
    assert [h["id"] for h in routine.plug_health(drops, plugs, now)][0] == "a"


def _hub(app_module, monkeypatch, plugs):
    hub = app_module.hub
    for pid, on in plugs.items():
        hub.plugs[pid] = types.SimpleNamespace(id=pid, online=True, is_on=on, kasa_name=pid, rssi=-50, device_key=pid, offline_since=None)
        hub.store.meta(pid)
    calls, sent = [], []

    async def fake_power(p, on, force=False):
        calls.append((p, on))

    monkeypatch.setattr(hub, "set_power", fake_power)
    monkeypatch.setattr(hub, "_spawn", lambda coro: asyncio.run(coro))
    monkeypatch.setattr(hub, "changed", lambda: asyncio.sleep(0))
    monkeypatch.setattr(hub.notifier, "send", lambda *a, **k: sent.append(a))
    return hub, calls, sent


def test_night_check_notify_and_off(app_module, monkeypatch):
    hub, calls, sent = _hub(app_module, monkeypatch, {"tv": True, "fan": True, "lamp": False, "fridge": True})
    hub.store.meta("fridge").keep_on = True
    hub.store.data["settings"]["goodnight"] = {"at": "23:30", "mode": "notify", "keep": ["fan"]}
    hub._check_night(time.time(), datetime(2026, 11, 23, 23, 40))
    assert len(sent) == 1 and "tv" in sent[0][1] and "fan" not in sent[0][1] and "fridge" not in sent[0][1]
    hub._check_night(time.time(), datetime(2026, 11, 23, 23, 50))  # 一個晚上一次
    assert len(sent) == 1
    hub.store.data["settings"]["goodnight"]["mode"] = "off"
    hub._check_night(time.time(), datetime(2026, 11, 24, 23, 40))
    assert calls == [("tv", False)] and "關掉" in sent[-1][0]


def test_night_check_skips_when_nobody_home(app_module, monkeypatch):
    hub, _, sent = _hub(app_module, monkeypatch, {"tv": True})
    hub.store.data["people"] = [{"id": "x", "name": "X", "macs": []}]
    hub._presence["x"] = {"home": False, "since": 1.0}
    hub._check_night(time.time(), datetime(2026, 11, 23, 23, 40))
    assert sent == []


def test_away_auto_on_and_end_on_arrival(app_module, monkeypatch):
    hub, _, sent = _hub(app_module, monkeypatch, {"lamp": False})
    marked = []
    monkeypatch.setattr(hub, "mark_native", lambda: marked.append(1))
    hub.store.data["settings"]["away"] = {"enabled": False, "start": "18:00", "end": "23:00", "plugs": ["lamp"], "auto_on": True, "auto_h": 4}
    hub.store.data["people"] = [{"id": "x", "name": "X", "macs": []}]
    now = time.time()
    hub._presence["x"] = {"home": False, "since": now - 3 * 3600}
    hub._check_away_auto(now)
    assert not hub.store.data["settings"]["away"]["enabled"]
    hub._presence["x"] = {"home": False, "since": now - 5 * 3600}
    hub._check_away_auto(now)
    assert hub.store.data["settings"]["away"]["enabled"] and marked and "離家模式" in sent[-1][0]
    hub._away_end(["X"])
    assert not hub.store.data["settings"]["away"]["enabled"] and "關閉" in sent[-1][0]


def test_api_plug_health_and_monthly(app_module):
    from fastapi.testclient import TestClient

    c = TestClient(app_module.app, base_url="http://hub:8100")
    token, _ = app_module.auth.pair(app_module.auth.new_code())
    c.cookies.set("plughub_token", token)
    assert c.get("/api/net/plug-health").json() == {"plugs": []}
    text = c.get("/api/report/monthly").json()["text"]
    assert "插座用電" in text and "斷線" in text
    r = c.put("/api/settings", json={"goodnight": {"at": "00:15", "mode": "off", "keep": ["nope"]}, "monthly": False, "remind": {"tier": False}})
    assert r.status_code == 200
    s = app_module.store.data["settings"]
    assert s["goodnight"] == {"at": "00:15", "mode": "off", "keep": []} and s["monthly"] is False and s["remind"]["tier"] is False
    assert c.put("/api/settings", json={"goodnight": {"at": "25:99"}}).status_code == 400


def test_tier_check_runs_and_sends_once(app_module, monkeypatch):
    hub, _, sent = _hub(app_module, monkeypatch, {"heater": True})
    rep = {"projected": {"kwh": 90.0}, "last_month": {"kwh": 40.0},
           "plugs": [{"known": True, "name": "電暖器", "month_kwh": 60.0}]}
    monkeypatch.setattr(hub, "energy_report", lambda: rep)
    hub.store.data["settings"]["household_monthly_kwh"] = 300
    hub._check_tier(datetime(2026, 11, 20, 10, 0))
    hub._check_tier(datetime(2026, 11, 21, 10, 0))
    assert len(sent) == 1 and "跳級" in sent[0][0] and "電暖器 60.0 度" in sent[0][1]

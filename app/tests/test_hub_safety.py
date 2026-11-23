"""防呆：最長開啟時間、鎖定、定時關閉；排程跳過放假日。"""

import asyncio
import sys
import time
from datetime import date

import pytest

from plughub.hub import DEFAULT_MAX_ON


def hubmod():
    """app_module 會重新載入 plughub，類別要從重新載入後的模組拿。"""
    return sys.modules["plughub.hub"]


class FakeDevice:
    """假的插座：記錄被開關幾次，可以設定成沒回應。"""

    def __init__(self):
        self.calls: list[str] = []
        self.broken = False
        self.children = []

    async def turn_on(self):
        if self.broken:
            raise TimeoutError("沒回應")
        self.calls.append("on")

    async def turn_off(self):
        if self.broken:
            raise TimeoutError("沒回應")
        self.calls.append("off")

    async def update(self):
        raise RuntimeError("測試不讀狀態")

    async def disconnect(self):
        pass


@pytest.fixture
def hub(app_module, monkeypatch):
    h = app_module.hub
    notes = []
    monkeypatch.setattr(h.notifier, "send", lambda title, msg, priority="default": notes.append((title, priority)))
    h.notes = notes
    return h


def add_plug(hub, pid="p1", name="陽台澆水", on=False):
    dev = FakeDevice()
    hub.devices[pid] = hubmod().DeviceEntry(dev, [pid])
    hub.plugs[pid] = hubmod().Plug(id=pid, device_key=pid, kasa_name=name, model="HS103", host="10.0.0.9", is_on=on, online=True)
    return dev


def run(coro):
    return asyncio.run(coro)


def test_water_plug_gets_default_limit(hub):
    add_plug(hub, "p1", "陽台澆水")
    add_plug(hub, "p2", "立燈")
    hub._default_max_on()
    assert hub.store.meta("p1").max_on_s == DEFAULT_MAX_ON
    assert hub.store.meta("p2").max_on_s is None


def test_timer_cannot_exceed_max_on(hub):
    add_plug(hub)
    hub.store.meta("p1").max_on_s = 60
    run(hub.set_timer("p1", 3600))
    left = hub.store.data["timers"]["p1"] - time.time()
    assert 55 < left <= 60


def test_turned_on_elsewhere_still_capped(hub):
    """從插座按鈕、Google Home 打開也一樣有上限。"""
    add_plug(hub)
    hub.store.meta("p1").max_on_s = 90
    hub.store.data["on_since"]["p1"] = time.time() - 10
    hub._cap_on_time("p1")
    assert 75 < hub.store.data["timers"]["p1"] - time.time() <= 80


def test_expired_timer_turns_off(hub):
    dev = add_plug(hub, on=True)
    hub.store.meta("p1").max_on_s = 60
    hub.store.data["timers"]["p1"] = time.time() - 1
    run(hub._run_timers())
    assert dev.calls == ["off"]
    assert "p1" not in hub.store.data["timers"]
    assert hub.notes[-1][0] == "自動關閉"


def test_guarded_plug_keeps_retrying_and_alerts(hub):
    dev = add_plug(hub, on=True)
    dev.broken = True
    hub.store.meta("p1").max_on_s = 60
    hub.store.data["timers"]["p1"] = time.time() - 600  # 早就該關了
    run(hub._run_timers())
    run(hub._run_timers())
    assert "p1" in hub.store.data["timers"]  # 不放棄
    assert hub.notes == [("⚠️ 關不掉！", "urgent")]  # 只通知一次
    dev.broken = False
    run(hub._run_timers())
    assert dev.calls == ["off"] and hub.notes[-1][0] == "已經關閉"


def test_plain_timer_gives_up_after_5_minutes(hub):
    dev = add_plug(hub, "p2", "立燈", on=True)
    dev.broken = True
    hub.store.data["timers"]["p2"] = time.time() - 301
    run(hub._run_timers())
    assert "p2" not in hub.store.data["timers"]
    assert hub.notes[-1] == ("定時關閉失敗", "high")


def test_locked_plug(hub):
    dev = add_plug(hub)
    hub.store.meta("p1").protect = "lock"
    with pytest.raises(hubmod().Locked):
        run(hub.set_power("p1", True))
    assert dev.calls == []
    run(hub.set_power("p1", False, force=True))  # 定時到了照樣關
    assert dev.calls == ["off"]


def test_keep_on_not_turned_off(hub):
    dev = add_plug(hub, "p2", "冰箱", on=True)
    hub.store.meta("p2").keep_on = True
    dev2 = add_plug(hub, "p3", "電視", on=True)
    run(hub.turn_off())
    assert dev.calls == [] and dev2.calls == ["off"]


# ---- 排程跳過 ----

WORKDAY = date(2026, 11, 18)  # 星期三
HOLIDAY = date(2026, 10, 9)  # 補假（星期五）


def test_skip_reasons(hub, monkeypatch):
    hub.daysoff.holidays[HOLIDAY.isoformat()] = "補假"
    monkeypatch.setattr(hub.daysoff, "rainy", lambda day: "雨量站 24 小時 12 mm" if day == WORKDAY else None)
    monkeypatch.setattr(hub.alerts, "dayoff", lambda county, town, day: None)
    sched = {"id": "s1", "skip_holiday": True, "skip_rain": False}
    assert hub.skip_reason(sched, HOLIDAY) == "補假"
    assert hub.skip_reason(sched, WORKDAY) is None
    hub.store.data["day_off"] = WORKDAY.isoformat()  # 按了「今天放假」（颱風假）
    assert hub.skip_reason(sched, WORKDAY) == "今天放假"
    assert hub.skip_reason({"id": "s2"}, HOLIDAY) is None  # 沒勾不跳過
    assert hub.skip_reason({"id": "s3", "skip_rain": True}, WORKDAY).startswith("雨量站")


def test_typhoon_day_off_skips(hub, monkeypatch):
    monkeypatch.setattr(hub.alerts, "dayoff", lambda county, town, day: {"full": True, "text": "今天停止上班、停止上課"})
    assert hub.skip_reason({"id": "s", "skip_holiday": True}, WORKDAY).startswith("停止上班")
    monkeypatch.setattr(hub.alerts, "dayoff", lambda county, town, day: {"full": False, "text": "停止上課"})
    assert hub.skip_reason({"id": "s", "skip_holiday": True}, WORKDAY) is None


# ---- 大家都出門：高風險電器 ----


def everyone_out(hub, monkeypatch, minutes_ago=1):
    monkeypatch.setattr(hub, "people_report", lambda: [{"id": "a", "home": False, "since": time.time() - minutes_ago * 60}])


def test_risky_turned_off_right_away(hub, monkeypatch):
    heater = add_plug(hub, "h", "電暖器", on=True)
    lamp = add_plug(hub, "l", "立燈", on=True)
    hub._default_max_on()
    assert hub.store.meta("h").risky and not hub.store.meta("l").risky
    everyone_out(hub, monkeypatch, minutes_ago=1)  # 剛出門，一般電器還要等 10 分鐘

    async def go():
        hub._check_left_on(time.time())
        await asyncio.gather(*hub._bg)
        hub._check_left_on(time.time())  # 同一次出門不重複
        await asyncio.gather(*hub._bg)

    run(go())
    assert heater.calls == ["off"] and lamp.calls == []
    assert [n[0] for n in hub.notes] == ["沒人在家，已關掉高風險電器"]


def test_risky_notify_only(hub, monkeypatch):
    heater = add_plug(hub, "h", "熨斗", on=True)
    hub.store.meta("h").risky = True
    hub.store.data["settings"]["presence"] = {"risky_off": False, "left_on": "none"}
    everyone_out(hub, monkeypatch)
    hub._check_left_on(time.time())
    assert heater.calls == []
    assert hub.notes == [("⚠️ 沒人在家，高風險電器還開著", "urgent")]


def test_risky_broken_plug_alerts(hub, monkeypatch):
    heater = add_plug(hub, "h", "電暖器", on=True)
    heater.broken = True
    hub.store.meta("h").risky = True
    everyone_out(hub, monkeypatch)

    async def go():
        hub._check_left_on(time.time())
        await asyncio.gather(*hub._bg)

    run(go())
    assert hub.notes[-1] == ("⚠️ 高風險電器關不掉！", "urgent")


def test_anomaly_from_energy_log(hub):
    from datetime import date, timedelta

    add_plug(hub, "f", "冰箱")
    today = date.today()
    for i in range(1, 18):
        hub.store.energy.add((today - timedelta(days=i)).isoformat(), "f", 2.0 if i <= 3 else 1.0)
    hub.store.energy.flush()
    found = hub.find_anomalies(today)
    assert found and found[0]["plug"] == "f" and "冰箱" in found[0]["text"]



def test_discover_survives_bad_sysinfo(app_module, monkeypatch):
    """插座回的資料少了 relay_state：不能讓啟動整個失敗，先當離線。"""
    import asyncio
    import sys

    hub = app_module.hub
    hub_mod = sys.modules["plughub.hub"]

    class Bad:
        alias, model, host, mac, children = "壞插座", "HS103", "10.0.0.9", "AA:BB:CC:DD:EE:FF", []

        async def update(self):
            return None

        @property
        def is_on(self):
            raise KeyError("relay_state")

    async def fake_discover(*a, **k):
        return {"10.0.0.9": Bad()}

    monkeypatch.setattr(hub_mod.Discover, "discover", fake_discover)
    monkeypatch.setattr(hub_mod, "_is_plug", lambda d: True)
    asyncio.run(hub.discover())
    pid = hub_mod._plug_id("AA:BB:CC:DD:EE:FF")
    assert pid in hub.plugs and hub.plugs[pid].online is False

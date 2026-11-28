"""欠著補做：自動化要關的插座連不上／沒回應 → 連回來補關；重開後記得攝影機看到的事、補做錯過的排程。"""

import json
import time
from datetime import datetime, timedelta

from test_hub_safety import add_plug, hub, hubmod, run  # noqa: F401


def test_offline_plug_is_owed_then_made_up(hub):
    a, b = add_plug(hub, "a", "電暖器", on=True), add_plug(hub, "b", "立燈", on=True)
    hub.plugs["b"].online = False
    done, owed = run(hub.switch_all({"a": False, "b": False}, "晚安檢查"))
    assert (done, owed) == (["a"], ["b"]) and a.calls == ["off"] and b.calls == []
    assert "立燈" in hub.owed_text(owed) and "補關" in hub.owed_text(owed)
    run(hub._owed_tick())  # 還沒連回來：不動
    assert b.calls == [] and "b" in hub.store.data["owed"]
    hub.plugs["b"].online = True
    run(hub._owed_tick())
    assert b.calls == ["off"] and not hub.store.data["owed"]
    assert hub.notes[-1][0] == "已經補關"


def test_no_response_is_owed_and_retried(hub):
    dev = add_plug(hub, "a", "電扇", on=True)
    dev.broken = True
    assert run(hub.switch_all({"a": False}, "沒人在家", cond="away")) == ([], ["a"])
    run(hub._owed_tick())  # 還是沒回應
    assert "a" in hub.store.data["owed"]
    dev.broken = False
    run(hub._owed_tick())  # 剛試過，隔一分鐘才再試
    assert dev.calls == []
    hub.store.data["owed"]["a"]["tried"] -= 61
    run(hub._owed_tick())
    assert dev.calls == ["off"]


def test_owed_dropped_when_user_acts_or_someone_home_or_expired(hub):
    dev = add_plug(hub, "a", "電扇", on=True)
    hub.plugs["a"].online = False
    run(hub.switch_all({"a": False}, "沒人在家", cond="away"))
    hub.plugs["a"].online = True
    run(hub.set_power("a", True))  # 有人自己動過
    assert not hub.store.data["owed"]
    # 有人回家了：不補
    hub.plugs["a"].online = False
    run(hub.switch_all({"a": False}, "沒人在家", cond="away"))
    hub.plugs["a"].online = True
    hub.people_report = lambda: [{"home": True}]
    run(hub._owed_tick())
    assert not hub.store.data["owed"] and dev.calls == ["on"]
    # 要「開」的只欠 15 分鐘
    hub.people_report = lambda: []
    hub.plugs["a"].is_on, hub.plugs["a"].online = False, False
    run(hub.switch_all({"a": True}, "07:00 的排程"))
    hub.store.data["owed"]["a"]["at"] -= 16 * 60
    hub.plugs["a"].online = True
    run(hub._owed_tick())
    assert not hub.store.data["owed"] and dev.calls == ["on"]


def test_same_state_or_locked_not_owed(hub):
    add_plug(hub, "a", "電扇", on=False)
    hub.plugs["a"].online = False  # 斷線前就關著
    add_plug(hub, "b", "冰箱", on=True)
    hub.store.meta("b").protect = "lock"
    assert run(hub.switch_all({"a": False, "b": False}, "晚安檢查")) == ([], [])


def test_schedule_owes_offline_plug_and_notifies(hub):
    add_plug(hub, "a", "電扇", on=True)
    hub.plugs["a"].online = False
    run(hub._run_one({"id": "s1", "action": "off", "plugs": ["a"], "time": "23:00", "days": list(range(7)), "enabled": True}))
    assert hub.store.data["owed"]["a"]["on"] is False
    assert hub.notes[-1] == ("排程沒做完", "high")


def test_restart_remembers_camera_and_door(hub, data_dir):
    now = time.time()
    hub._door_outs = [(now - 60, "outdoor"), (now - 9000, "outdoor")]
    hub._room_seen = (now - 30, "客廳")
    hub._cam_moved = {"inhouse": now - 30}
    hub._cam_pending = {"inhouse": now - 10}
    (data_dir / "runtime.json").write_text(json.dumps(hub._runtime(), default=str), "utf-8")
    h2 = hubmod().Hub(hub.store, hub.notifier)
    assert h2._door_outs == [(now - 60, "outdoor")]  # 太舊的不要
    assert h2._room_seen == (now - 30, "客廳") and h2._cam_moved == {"inhouse": now - 30}
    assert h2._cam_pending == {"inhouse": now - 10}
    assert h2._down and abs(h2._down[1] - now) < 5


def test_schedule_missed_during_restart_is_caught_up(hub):
    now = datetime.now().replace(microsecond=0)
    if now.hour == 0 and now.minute < 20:
        return  # 跨午夜不測
    hms = (now - timedelta(minutes=5)).strftime("%H:%M:%S")
    assert hub._due("s1", hms, now) is False  # 平常：晚 5 分鐘就不做了
    ts = now.timestamp()
    hub._down = (ts - 600, ts - 60)  # 那個時間樹莓派正好沒在跑
    assert hub._due("s1", hms, now) is True
    assert hub._due("s1", hms, now) is False  # 只補一次
    hub._down = (ts - 200, ts - 60)  # 停機前就該做的（那時候做過了）：不補
    assert hub._due("s2", hms, now) is False
    old = (now - timedelta(minutes=16)).strftime("%H:%M:%S")
    hub._down = (ts - 3600, ts - 60)
    assert hub._due("s3", old, now) is False  # 超過 15 分鐘：不補

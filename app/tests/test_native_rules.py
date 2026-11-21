"""寫進插座的備援規則、樹莓派在線時的「租約」。"""

from datetime import datetime
from types import SimpleNamespace

from plughub import native
from plughub.store import PlugMeta


class FakeStore:
    def __init__(self, schedules, meta=None, scenes=()):
        self.schedules = schedules
        self._meta = meta or PlugMeta()
        self._scenes = {s["id"]: s for s in scenes}

    def meta(self, pid):
        return self._meta

    def scene(self, sid):
        return self._scenes.get(sid)


def sched(**kw):
    base = {"id": "s", "enabled": True, "time": "07:00:00", "days": [0, 1, 2, 3, 4], "action": "on", "plugs": ["p"]}
    return {**base, **kw}


WEEKDAYS = (0, 1, 1, 1, 1, 1, 0)  # 插座的星期從星期日開始


def test_fixed_time_rule():
    assert native.schedule_rules(FakeStore([sched()]), "p") == [(1, 0, 420, WEEKDAYS)]


def test_seconds_round_up_and_duration_off_rule():
    """澆水 06:00:30 開 50 秒：插座只到分鐘，開往後取整，關在開之後。"""
    rules = native.schedule_rules(FakeStore([sched(time="06:00:30", duration_s=50)]), "p")
    assert rules == [(1, 0, 361, WEEKDAYS), (0, 0, 362, WEEKDAYS)]


def test_max_on_adds_off_rule():
    rules = native.schedule_rules(FakeStore([sched()], PlugMeta(max_on_s=600)), "p")
    assert (0, 0, 430, WEEKDAYS) in rules


def test_midnight_wraps_to_next_day():
    rules = native.schedule_rules(FakeStore([sched(time="23:59:30", days=[6])]), "p")  # 星期日 23:59:30
    assert rules == [(1, 0, 0, (0, 1, 0, 0, 0, 0, 0))]  # 往後取整 → 星期一 00:00


def test_locked_and_keep_on():
    assert native.schedule_rules(FakeStore([sched()], PlugMeta(protect="lock")), "p") == []
    assert native.schedule_rules(FakeStore([sched(action="off")], PlugMeta(keep_on=True)), "p") == []


def test_skip_days_removed_from_backup_rules():
    store = FakeStore([sched(skip_holiday=True)])
    store.sched_skip = lambda s: {4}  # 這週五放假
    assert native.schedule_rules(store, "p") == [(1, 0, 420, (0, 1, 1, 1, 1, 0, 0))]


def test_scene_schedule():
    scene = {"id": "out", "actions": {"p": "off"}, "others": "keep"}
    store = FakeStore([sched(action="scene", scene="out", plugs=[])], scenes=[scene])
    assert native.schedule_rules(store, "p") == [(0, 0, 420, WEEKDAYS)]
    assert native.schedule_rules(store, "other") == []


def test_disabled_or_no_backup():
    assert native.schedule_rules(FakeStore([sched(enabled=False)]), "p") == []
    assert native.schedule_rules(FakeStore([sched(backup=False)]), "p") == []


def test_lease_pauses_on_rule_around_fire_time():
    rule = {"sact": 1, "opt": 0, "val": 420, "wday": [1] * 7}
    sun = lambda opt, day: None  # noqa: E731
    assert native.lease_enabled(rule, datetime(2026, 11, 18, 6, 50), sun)
    assert not native.lease_enabled(rule, datetime(2026, 11, 18, 6, 59), sun)  # 執行前：交給樹莓派
    assert not native.lease_enabled(rule, datetime(2026, 11, 18, 7, 0, 30), sun)
    assert native.lease_enabled(rule, datetime(2026, 11, 18, 7, 5), sun)
    # 關閉規則一直啟用（樹莓派途中當掉也會關）
    assert native.lease_enabled({**rule, "sact": 0}, datetime(2026, 11, 18, 7, 0), sun)


def test_lease_respects_weekday():
    rule = {"sact": 1, "opt": 0, "val": 420, "wday": [0, 1, 1, 1, 1, 1, 0]}
    sun = lambda opt, day: None  # noqa: E731
    assert native.lease_enabled(rule, datetime(2026, 11, 22, 7, 0), sun)  # 星期日沒有這條


def test_lease_sunset():
    rule = {"sact": 1, "opt": 2, "val": 10, "wday": [1] * 7}
    sun = lambda opt, day: 17 * 60  # 日落 17:00  # noqa: E731
    assert not native.lease_enabled(rule, datetime(2026, 11, 18, 17, 8), sun)
    assert native.lease_enabled(rule, datetime(2026, 11, 18, 16, 0), sun)

from datetime import date, timedelta

from plughub import anomaly

TODAY = date(2026, 11, 20)


def days_back(n):
    return (TODAY - timedelta(days=n)).isoformat()


def series(base, recent, n_base=14):
    d = {days_back(i): base for i in range(4, 4 + n_base)}
    d.update({days_back(i): recent for i in (1, 2, 3)})
    d[TODAY.isoformat()] = 99  # 今天還沒過完：不算
    return d


def test_fridge_rise_detected():
    found = anomaly.daily_rise({"fridge": series(1.0, 1.6)}, TODAY)
    assert [f["plug"] for f in found] == ["fridge"]
    assert found[0]["ratio"] == 1.6


def test_small_change_ignored():
    assert anomaly.daily_rise({"a": series(1.0, 1.3)}, TODAY) == []  # 只多 30%
    assert anomaly.daily_rise({"b": series(0.05, 0.15)}, TODAY) == []  # 多 3 倍但只差 0.1 度


def test_needs_enough_history():
    assert anomaly.daily_rise({"new": series(1.0, 3.0, n_base=5)}, TODAY) == []


def test_missing_days_count_as_zero_after_first_record():
    d = {days_back(i): 1.0 for i in range(4, 18) if i % 2 == 0}  # 隔天才用（沒有紀錄 = 0）
    d.update({days_back(i): 1.0 for i in (1, 2, 3)})
    found = anomaly.daily_rise({"heater": d}, TODAY, {"heater": days_back(17)})
    assert found and found[0]["base"] == 0.5


def test_zero_baseline_not_flagged():
    """平常都沒用、最近才開始用（例如冬天開電暖器）不算異常，用電頁的「最近開很久」會講。"""
    assert anomaly.daily_rise({"x": series(0.0, 2.0)}, TODAY) == []


def test_standby_rise():
    floors = {"tv": {days_back(i): 1.0 for i in range(4, 18)} | {days_back(i): 6.0 for i in (1, 2, 3)}}
    found = anomaly.standby_rise(floors, TODAY)
    assert found and found[0]["recent"] == 6.0 and found[0]["base"] == 1.0
    floors = {"tv": {days_back(i): 1.0 for i in range(4, 18)} | {days_back(i): 3.0 for i in (1, 2, 3)}}
    assert anomaly.standby_rise(floors, TODAY) == []  # 只多 2 W


def test_describe():
    item = {"kind": "kwh", "recent": 1.6, "base": 1.0, "ratio": 1.6}
    assert "多 60%" in anomaly.describe(item, "冰箱", metered=True)
    assert "開的時間" in anomaly.describe(item, "電視", metered=False)

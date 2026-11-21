from datetime import date

import pytest

from plughub import tariff

SUMMER = date(2026, 7, 15)
WINTER = date(2026, 12, 15)


@pytest.mark.parametrize(
    ("kwh", "summer", "winter"),
    [
        (0, 1.78, 1.78),
        (120, 1.78, 1.78),  # 剛好在上限：還是這一級
        (120.1, 2.55, 2.26),
        (300, 2.55, 2.26),
        (330, 2.55, 2.26),
        (500, 3.80, 3.13),
        (700, 5.14, 4.24),
        (1000, 6.44, 5.27),
        (1001, 8.86, 7.03),
        (99999, 8.86, 7.03),
    ],
)
def test_price_tiers(kwh, summer, winter):
    assert tariff.price(kwh, SUMMER) == summer
    assert tariff.price(kwh, WINTER) == winter


@pytest.mark.parametrize(("month", "summer"), [(5, False), (6, True), (9, True), (10, False), (1, False)])
def test_summer_months(month, summer):
    assert tariff.is_summer(date(2026, month, 1)) is summer


def test_tiers_increase():
    """級距越高越貴、夏月不比非夏月便宜（改表時打錯會被抓到）。"""
    prev_s = prev_w = 0
    for cap, s, w in tariff.TIERS:
        assert s >= prev_s and w >= prev_w
        assert s >= w
        prev_s, prev_w = s, w
    assert tariff.TIERS[-1][0] is None

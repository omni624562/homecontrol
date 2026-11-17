"""台電住宅用非時間電價（累進），2025 年 10 月 1 日起的費率。

台電調整電價時改這張表。電費是用「家裡每月用電落在哪一級」的單價計算：
插座省下來的電是從最高那一級扣掉的，這樣算最接近關掉插座能省多少錢。
"""

from __future__ import annotations

from datetime import date

# (每月度數上限, 夏月單價, 非夏月單價)；上限 None 表示以上全部
TIERS: list[tuple[float | None, float, float]] = [
    (120, 1.78, 1.78),
    (330, 2.55, 2.26),
    (500, 3.80, 3.13),
    (700, 5.14, 4.24),
    (1000, 6.44, 5.27),
    (None, 8.86, 7.03),
]

SUMMER_MONTHS = {6, 7, 8, 9}


def is_summer(day: date) -> bool:
    return day.month in SUMMER_MONTHS


def price(monthly_kwh: float, day: date) -> float:
    """家裡每月用電 monthly_kwh 度時，邊際一度電的價格（元/度）。"""
    col = 1 if is_summer(day) else 2
    for tier in TIERS:
        if tier[0] is None or monthly_kwh <= tier[0]:
            return tier[col]
    return TIERS[-1][col]

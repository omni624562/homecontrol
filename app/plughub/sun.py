"""日出、日落時間（不用上網）。

演算法：美國海軍天文台 Almanac for Computers（NOAA 常用的簡化版），誤差約 1～2 分鐘，
和 TP-Link 插座自己算的結果一致。位置用插座裡存的經緯度（Kasa App 設定時寫進去的）。
"""

from __future__ import annotations

import math
from datetime import date, datetime, timedelta

ZENITH = 90.833  # 太陽上緣碰到地平線（含大氣折射）


def _event(day: date, lat: float, lon: float, rising: bool, tz_hours: float) -> float | None:
    """回傳當地時間（小時，0～24）；極區沒有日出日落時回傳 None。"""
    rad, deg = math.radians, math.degrees
    n = day.timetuple().tm_yday
    lng_hour = lon / 15
    t = n + ((6 if rising else 18) - lng_hour) / 24
    m = 0.9856 * t - 3.289
    l = (m + 1.916 * math.sin(rad(m)) + 0.020 * math.sin(rad(2 * m)) + 282.634) % 360
    ra = deg(math.atan(0.91764 * math.tan(rad(l)))) % 360
    ra = (ra + (math.floor(l / 90) * 90 - math.floor(ra / 90) * 90)) / 15
    sin_dec = 0.39782 * math.sin(rad(l))
    cos_dec = math.cos(math.asin(sin_dec))
    cos_h = (math.cos(rad(ZENITH)) - sin_dec * math.sin(rad(lat))) / (cos_dec * math.cos(rad(lat)))
    if not -1 <= cos_h <= 1:
        return None
    h = (360 - deg(math.acos(cos_h)) if rising else deg(math.acos(cos_h))) / 15
    local_t = h + ra - 0.06571 * t - 6.622
    return (local_t - lng_hour + tz_hours) % 24


def minutes(day: date, lat: float, lon: float, kind: str) -> int | None:
    """當天日出（kind="sunrise"）或日落（"sunset"）是幾點幾分（從午夜算的分鐘數）。"""
    noon = datetime.combine(day, datetime.min.time()) + timedelta(hours=12)
    tz = noon.astimezone().utcoffset().total_seconds() / 3600
    hours = _event(day, lat, lon, kind == "sunrise", tz)
    return None if hours is None else int(round(hours * 60)) % 1440

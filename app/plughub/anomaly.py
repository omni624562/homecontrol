"""用電異常：某個電器最近幾天比它自己平常用得多，或待機功率變高。

- 每天用電（energy.db 的 daily）：最近 3 個完整的天的平均，和再之前 14 天的中位數比。
  有計量的插座是實際用電（冰箱耗電上升）；沒有計量的是「開的時間 × 瓦數」（開得比平常久）。
- 待機（只有計量插座）：每天開著時量到的最低功率（power_floor），最近 3 天的中位數比之前 14 天高。

只拿自己跟自己比，不需要設定門檻。平常資料不夠（少於 7 天）就不判斷。
"""

from __future__ import annotations

from datetime import date, timedelta
from statistics import mean, median
from typing import Any

RECENT_DAYS = 3
BASE_DAYS = 14
MIN_BASE_DAYS = 7

# 每天用電：至少多 50%，而且每天多 0.15 度以上（小電器的雜訊不算）
KWH_RATIO = 1.5
KWH_MIN_DELTA = 0.15
# 待機：至少多 50%，而且多 3 W 以上
FLOOR_RATIO = 1.5
FLOOR_MIN_DELTA = 3.0


def _windows(today: date) -> tuple[list[str], list[str]]:
    recent = [(today - timedelta(days=i)).isoformat() for i in range(RECENT_DAYS, 0, -1)]
    base = [(today - timedelta(days=i)).isoformat() for i in range(RECENT_DAYS + BASE_DAYS, RECENT_DAYS, -1)]
    return recent, base


def daily_rise(per_plug: dict[str, dict[str, float]], today: date, first_day: dict[str, str] | None = None) -> list[dict[str, Any]]:
    """per_plug：插座 → {日期: 度}（沒有那天 = 0 度）。first_day：插座第一次有紀錄的日期（之前的天不算 0）。"""
    recent_days, base_days = _windows(today)
    out = []
    for plug, days in per_plug.items():
        start = (first_day or {}).get(plug) or min(days, default=None)
        if start is None:
            continue
        base_vals = [days.get(d, 0.0) for d in base_days if d >= start]
        if len(base_vals) < MIN_BASE_DAYS or start > recent_days[0]:
            continue
        base = median(base_vals)
        recent = mean(days.get(d, 0.0) for d in recent_days)
        if base > 0 and recent >= base * KWH_RATIO and recent - base >= KWH_MIN_DELTA:
            out.append({"plug": plug, "kind": "kwh", "recent": round(recent, 3), "base": round(base, 3),
                        "ratio": round(recent / base, 2)})
    return sorted(out, key=lambda x: -(x["recent"] - x["base"]))


def standby_rise(floors: dict[str, dict[str, float]], today: date) -> list[dict[str, Any]]:
    """floors：插座 → {日期: 開著時的最低功率 W}（只有有量到的天）。"""
    recent_days, base_days = _windows(today)
    out = []
    for plug, days in floors.items():
        base_vals = [days[d] for d in base_days if d in days]
        recent_vals = [days[d] for d in recent_days if d in days]
        if len(base_vals) < MIN_BASE_DAYS or len(recent_vals) < 2:
            continue
        base, recent = median(base_vals), median(recent_vals)
        if recent >= base * FLOOR_RATIO and recent - base >= FLOOR_MIN_DELTA:
            out.append({"plug": plug, "kind": "standby", "recent": round(recent, 1), "base": round(base, 1),
                        "ratio": round(recent / base, 2) if base else None})
    return sorted(out, key=lambda x: -(x["recent"] - x["base"]))


def describe(item: dict[str, Any], name: str, metered: bool) -> str:
    if item["kind"] == "standby":
        return f"{name} 待機功率從平常的 {item['base']:g} W 升到 {item['recent']:g} W，可能有東西沒關好或電器老化"
    pct = round((item["ratio"] - 1) * 100)
    if metered:
        return f"{name} 最近 3 天平均每天用 {item['recent']:.2f} 度，比平常（{item['base']:.2f} 度）多 {pct}%"
    return f"{name} 最近 3 天開的時間比平常多 {pct}%（估算每天 {item['recent']:.2f} 度）"

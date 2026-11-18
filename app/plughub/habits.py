"""從手動開關的紀錄找出習慣，建議做成排程。

只看人手動的開關（App、Google Home、插座上的按鈕），排程、情境、定時自動做的不算。
找法：同一個插座、同一個動作（開／關），在不同天的差不多時間（±25 分鐘）一再出現，
而且出現的天數夠多（至少 5 天、也至少是有紀錄天數的 40%），就是一個習慣。
如果拿日出／日落當基準時間更集中（例如天黑就開燈），就建議用「日落後幾分鐘」。
"""

from __future__ import annotations

import statistics
from collections import defaultdict
from datetime import date, datetime
from typing import Any, Callable

MANUAL = ("app", "matter", "button")
WINDOW = 25  # 分鐘：差不多的時間
MIN_DAYS = 5
MIN_RATIO = 0.4
LOOKBACK = 21  # 看最近幾天


def _round5(m: float) -> int:
    return int(round(m / 5) * 5)


def suggest(
    events: list[tuple[float, str, bool, str]],
    covered: Callable[[str, bool, int, list[int]], bool],
    sun_min: Callable[[int, date], int | None],
    first_day: date | None,
    today: date,
) -> list[dict[str, Any]]:
    """events = [(時間, 插座 ID, 開?, 來源)]；covered(插座, 開?, 分鐘, 星期) = 已經有排程管這件事。"""
    if first_day is None:
        return []
    # 有紀錄的天數（今天還沒過完不算）
    days_seen = [d for d in (date.fromordinal(o) for o in range(first_day.toordinal(), today.toordinal())) if (today - d).days <= LOOKBACK]
    if len(days_seen) < MIN_DAYS:
        return []
    weekday_count = defaultdict(int)
    for d in days_seen:
        weekday_count[d.weekday()] += 1
    groups: dict[tuple[str, bool], list[tuple[date, int]]] = defaultdict(list)
    for ts, pid, on, src in events:
        if src not in MANUAL:
            continue
        dt = datetime.fromtimestamp(ts)
        d = dt.date()
        if d not in days_seen:
            continue
        groups[(pid, on)].append((d, dt.hour * 60 + dt.minute))
    out = []
    need = max(MIN_DAYS, int(len(days_seen) * MIN_RATIO + 0.999))
    for (pid, on), evs in groups.items():
        left = list(evs)
        for _ in range(3):  # 同一個插座同一個動作，最多找 3 個時段
            best = None
            for _, c in left:
                per_day: dict[date, int] = {}
                for d, m in left:
                    if abs(m - c) <= WINDOW and (d not in per_day or abs(m - c) < abs(per_day[d] - c)):
                        per_day[d] = m
                if len(per_day) >= need:
                    spread = statistics.pstdev(per_day.values())
                    if best is None or (len(per_day), -spread) > (len(best), -statistics.pstdev(best.values())):
                        best = per_day
            if best is None:
                break
            mins = list(best.values())
            minute = _round5(statistics.median(mins))
            # 星期：有出現的比例過半的那幾天
            hits = defaultdict(int)
            for d in best:
                hits[d.weekday()] += 1
            days = sorted(w for w in range(7) if weekday_count[w] and hits[w] / weekday_count[w] >= 0.5)
            if not days:
                break
            # 跟日出／日落比會不會更準
            mode, offset = "clock", 0
            spread = statistics.pstdev(mins)
            for opt, name in ((1, "sunrise"), (2, "sunset")):
                rel = [m - s for d, m in best.items() if (s := sun_min(opt, d)) is not None]
                if len(rel) == len(best) and abs(statistics.median(rel)) <= 90 and statistics.pstdev(rel) < spread * 0.7:
                    mode, offset, spread = name, _round5(statistics.median(rel)), statistics.pstdev(rel)
            if not covered(pid, on, minute, days):
                out.append({
                    "key": f"{pid}|{int(on)}|{minute // 30}",
                    "plug": pid, "action": "on" if on else "off",
                    "time": f"{minute // 60:02d}:{minute % 60:02d}", "days": days,
                    "hits": len(best), "of": len(days_seen),
                    "mode": mode, "offset_min": offset,
                })
            used = set(best.items())
            left = [(d, m) for d, m in left if (d, m) not in used]
    return sorted(out, key=lambda s: (-s["hits"], s["time"]))

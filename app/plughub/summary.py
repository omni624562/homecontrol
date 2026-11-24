"""每天的門口摘要：紀錄裡的事件（電梯開了、陌生人、多了東西…）＋ Jetson 半夜重看錄影找到的「有人來」。

只列值得看的（包裹／多了東西、陌生人、半夜有人、待很久）；平常進出只算次數。
"""
from __future__ import annotations

from datetime import date, datetime, timedelta
from typing import Any

NIGHT = (0, 5)  # 0:00～5:59 算半夜
LINGER_S = 120  # 待超過 2 分鐘才列出來
MAX_ITEMS = 10


def _day_range(d: date) -> tuple[float, float]:
    start = datetime.combine(d, datetime.min.time()).timestamp()
    return start, (datetime.combine(d + timedelta(days=1), datetime.min.time())).timestamp()


def build_summary(d: date, cams: list[dict[str, Any]], log: list[dict[str, Any]], vis: dict[str, Any] | None) -> dict[str, Any]:
    t0, t1 = _day_range(d)
    out = []
    vcams = (vis or {}).get("cams") or {}
    for c in cams:
        name = c.get("name") or c["id"]
        items = [x for x in log if x.get("camera") == name and t0 <= x["t"] < t1]
        counts: dict[str, int] = {}
        highlights: list[dict[str, Any]] = []
        hours = [0] * 24  # 每小時有幾次事件（回放的時間軸）
        for x in items:
            kind = x.get("kind")
            if kind in ("zone", "stranger", "family", "guest", "fall", "pet"):
                hours[datetime.fromtimestamp(x["t"]).hour] += 1
            if kind == "zone":
                label = x.get("name") or "偵測到"
                counts[label] = counts.get(label, 0) + 1
                if any(w in label for w in ("多了東西", "東西不見了", "有東西變了")):
                    highlights.append({"t": x["t"], "kind": "object", "text": label, "id": x["id"], "thumb": x.get("thumb", False)})
            elif kind == "stranger":
                counts["陌生人"] = counts.get("陌生人", 0) + 1
                highlights.append({"t": x["t"], "kind": "stranger", "text": "不認得的人", "id": x["id"], "thumb": x.get("thumb", False)})
            elif kind == "family":
                counts[f"認出{x.get('name')}"] = counts.get(f"認出{x.get('name')}", 0) + 1
            elif kind == "fall":
                highlights.append({"t": x["t"], "kind": "fall", "text": "可能有人跌倒", "id": x["id"], "thumb": x.get("thumb", False)})
        v = vcams.get(c["id"])
        if v is not None:
            visits = v.get("visits") or []
            counts["有人來"] = len(visits)
            for vi in visits:
                hour = datetime.fromtimestamp(vi["start"]).hour
                hours[hour] += 1
                dur = vi["end"] - vi["start"]
                if NIGHT[0] <= hour <= NIGHT[1]:
                    highlights.append({"t": vi["start"], "kind": "night", "text": "半夜有人經過", "end": vi["end"]})
                elif dur >= LINGER_S:
                    highlights.append({"t": vi["start"], "kind": "linger", "text": f"有人待了 {round(dur / 60)} 分鐘", "end": vi["end"]})
            for cls, n in (v.get("counts") or {}).items():
                counts[{"dog": "狗", "cat": "貓", "suitcase": "行李箱", "backpack": "背包", "handbag": "包包", "bicycle": "腳踏車"}.get(cls, cls)] = n
        highlights.sort(key=lambda h: h["t"])
        out.append({"id": c["id"], "name": name, "role": c.get("role"), "counts": counts, "hours": hours, "highlights": highlights[:MAX_ITEMS],
                    "more": max(0, len(highlights) - MAX_ITEMS), "indexed": v is not None})
    return {"day": d.isoformat(), "cams": out, "indexed": bool(vcams)}

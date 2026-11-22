"""訊號地圖的幾何計算：點在哪個區域、兩點之間隔了幾道牆、一條線經過哪些區域（跟前端 map-model.ts 同一套算法）。"""

from __future__ import annotations

import math
from typing import Any


def room_pts(r: dict[str, Any]) -> list[list[float]]:
    pts = r.get("pts")
    if pts and len(pts) >= 4:
        return pts
    x, y, w, h = r["x"], r["y"], r["w"], r["h"]
    return [[x, y], [x + w, y], [x + w, y + h], [x, y + h]]


def in_room(r: dict[str, Any], x: float, y: float) -> bool:
    if x < r["x"] or x > r["x"] + r["w"] or y < r["y"] or y > r["y"] + r["h"]:
        return False
    p = room_pts(r)
    inside = False
    j = len(p) - 1
    for i in range(len(p)):
        (xi, yi), (xj, yj) = p[i], p[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


def room_at(fp: dict[str, Any], x: float, y: float) -> dict[str, Any] | None:
    return next((r for r in fp.get("rooms") or [] if in_room(r, x, y)), None)


def _hit(x1, y1, x2, y2, x3, y3, x4, y4) -> tuple[float, float] | None:  # noqa: ANN001
    d = (x2 - x1) * (y4 - y3) - (y2 - y1) * (x4 - x3)
    if abs(d) < 1e-9:
        return None
    s = ((x3 - x1) * (y4 - y3) - (y3 - y1) * (x4 - x3)) / d
    u = ((x3 - x1) * (y2 - y1) - (y3 - y1) * (x2 - x1)) / d
    return (s, u) if 0 < s < 1 and 0 <= u <= 1 else None


def walls_crossed(fp: dict[str, Any], x1: float, y1: float, x2: float, y2: float) -> int:
    """兩點之間隔了幾道實牆；剛好從門口穿過去的不算。"""
    n = 0
    doors = fp.get("doors") or []
    for w in fp.get("walls") or []:
        hit = _hit(x1, y1, x2, y2, w["x1"], w["y1"], w["x2"], w["y2"])
        if not hit:
            continue
        length = math.hypot(w["x2"] - w["x1"], w["y2"] - w["y1"]) or 1
        at = hit[1] * length
        opened = False
        for dr in doors:
            if dr.get("wall") != w["id"]:
                continue
            half = min(dr["w"], length) / 2
            c = max(half, min(length - half, dr["t"] * length))
            if c - half <= at <= c + half:
                opened = True
                break
        if not opened:
            n += 1
    return n


def rooms_along(fp: dict[str, Any], x1: float, y1: float, x2: float, y2: float) -> list[str]:
    """線經過哪些區域（照順序）。"""
    out: list[str] = []
    steps = max(2, math.ceil(math.hypot(x2 - x1, y2 - y1) / 8))
    for i in range(steps + 1):
        r = room_at(fp, x1 + (x2 - x1) * i / steps, y1 + (y2 - y1) * i / steps)
        if r and r["name"] not in out:
            out.append(r["name"])
    return out


def room_lengths(fp: dict[str, Any], x1: float, y1: float, x2: float, y2: float) -> dict[str, float]:
    """線在每個區域裡走了多長（地圖單位）：區域代碼 → 長度。"""
    out: dict[str, float] = {}
    length = math.hypot(x2 - x1, y2 - y1)
    steps = max(2, math.ceil(length / 8))
    seg = length / steps
    for i in range(steps):
        t = (i + 0.5) / steps
        r = room_at(fp, x1 + (x2 - x1) * t, y1 + (y2 - y1) * t)
        if r:
            out[r["id"]] = out.get(r["id"], 0.0) + seg
    return out

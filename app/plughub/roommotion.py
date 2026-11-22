"""每個房間有沒有人在走動：把每條訊號線（裝置 ↔ 它連的基地台）的擾動，分給線經過的房間。

一個房間的分數 = 經過它的線的擾動，依「線在這個房間裡走了多長」加權平均：
- 只有一條熱的線經過、其他經過它的線都安靜 → 分數被拉低（比較可能是別間）
- 裝置和基地台所在的房間多算 1 公尺（訊號在兩端附近對人最敏感）
- 線每穿過一道牆，權重打七折（被牆吃掉的訊號，人走過去的跳動比較小）
沒有任何線經過的房間不列出來（偵測不到，不是安靜）。
"""

from __future__ import annotations

from typing import Any

from . import geom

ACTIVE = 0.4  # 分數到這裡算「有人在動」
STRONG = 1.0
END_BONUS_M = 1.0
WALL_FACTOR = 0.7


def links(fp: dict[str, Any], node_of: dict[str, str | None]) -> list[dict[str, Any]]:
    """每台放在地圖上、連著某一台基地台的裝置：一條線，和它在各房間的權重（公尺）。"""
    w = fp.get("w") or 1000
    mpp = (fp.get("meters") or 12) / w
    items = fp.get("items") or {}
    aps = [(a, items[f"ap:{a['id']}"]) for a in fp.get("aps") or [] if f"ap:{a['id']}" in items and a.get("node")]
    out = []
    for key, it in items.items():
        if key.startswith("ap:"):
            continue
        node = node_of.get(key)
        ap = next(((a, at) for a, at in aps if a["node"] == node), None) if node else None
        if not ap:
            continue
        a, at = ap
        walls = geom.walls_crossed(fp, it["x"], it["y"], at["x"], at["y"])
        weights = {r: v * mpp for r, v in geom.room_lengths(fp, it["x"], it["y"], at["x"], at["y"]).items()}
        for x, y in ((it["x"], it["y"]), (at["x"], at["y"])):
            r = geom.room_at(fp, x, y)
            if r:
                weights[r["id"]] = weights.get(r["id"], 0.0) + END_BONUS_M
        f = WALL_FACTOR ** walls
        out.append({"key": key, "ap": a["id"], "walls": walls, "w": {r: v * f for r, v in weights.items() if v > 0}})
    return out


def scores(lks: list[dict[str, Any]], motion: dict[str, float | None]) -> dict[str, dict[str, Any]]:
    """房間代碼 → {score：加權平均擾動, cover：有讀數的線的總權重, hot：這間有哪些熱的線}。"""
    num: dict[str, float] = {}
    den: dict[str, float] = {}
    hot: dict[str, list[str]] = {}
    for lk in lks:
        m = motion.get(lk["key"])
        if m is None:
            continue
        for r, wt in lk["w"].items():
            num[r] = num.get(r, 0.0) + m * wt
            den[r] = den.get(r, 0.0) + wt
            if m >= ACTIVE:
                hot.setdefault(r, []).append(lk["key"])
    return {r: {"score": round(num[r] / den[r], 2), "cover": round(den[r], 1), "hot": hot.get(r, [])} for r in den if den[r] > 0}

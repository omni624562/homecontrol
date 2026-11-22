"""每個房間有沒有人在走動：把每條訊號線（裝置 ↔ 它連的基地台）的擾動，分給線經過的房間。

一條線經過好幾間時，擾動照「份量」分下去：
- 份量 = 線在這間走了多長，裝置那一端多算 1.5 公尺、基地台那一端多算 0.5 公尺
  （訊號在裝置附近對人最敏感；基地台那邊每條線都會經過，多算會讓它一直亮）
- 每條線的份量加起來是 1（擾動是實際量到的，穿牆不再打折）
房間分數 = Σ 擾動 × 份量 ÷ max(1, Σ 份量)：
- 裝置所在的房間拿到最多；線只是擦過的房間只拿到一點
- 很多安靜的線經過的房間，分數被拉低（比較可能是別間）
沒有任何線經過的房間不列出來（偵測不到，不是安靜）。
"""

from __future__ import annotations

from typing import Any

from . import geom

ACTIVE = 0.4  # 分數到這裡算「有人在動」
STRONG = 1.0
DEV_BONUS_M = 3.0
AP_BONUS_M = 0.5


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
        for x, y, bonus in ((it["x"], it["y"], DEV_BONUS_M), (at["x"], at["y"], AP_BONUS_M)):
            r = geom.room_at(fp, x, y)
            if r:
                weights[r["id"]] = weights.get(r["id"], 0.0) + bonus
        total = sum(weights.values())
        if total <= 0:
            continue
        f = 1 / total
        out.append({"key": key, "ap": a["id"], "walls": walls, "w": {r: round(v * f, 4) for r, v in weights.items() if v > 0}})
    return out


def scores(lks: list[dict[str, Any]], motion: dict[str, float | None]) -> dict[str, dict[str, Any]]:
    """房間代碼 → {score：分到的擾動, cover：經過這間、有讀數的線的總份量, hot：這間有哪些熱的線}。"""
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
    return {r: {"score": round(num[r] / max(1.0, den[r]), 2), "cover": round(den[r], 2), "hot": hot.get(r, [])} for r in den if den[r] > 0}

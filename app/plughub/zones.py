"""攝影機畫面上的區域和線：區域有人／逗留、東西多了／不見了、門（例如電梯門）、經過線的方向。

座標都是 0～1（畫面寬、高的比例）。這裡只放判斷用的小函式（好測試）；通知、情境在 hub.py。
"""
from __future__ import annotations

from typing import Any

AREA_LEAVE = 5  # 秒：區域裡多久沒看到人才算離開
OBJ_SAME = 0.55  # 跟「正常的樣子」相似度到這裡算沒變
OBJ_HOLD = 120  # 秒：變了而且一直維持這麼久（中間沒人）才算東西多了／不見了
OBJ_LEARN = 60  # 秒：還沒有「正常的樣子」時，沒人、畫面穩定這麼久就自己記起來
OBJ_KEEP = 3  # 最多記幾張正常的樣子（白天、晚上、最近一次變化之後）
LINE_MATCH = 0.25  # 前後兩張裡的同一個人，腳的位置最多移動這麼遠（每秒 3 張，走樓梯也跟得上）
LINE_GAP = 20  # 秒：同一條線同一個方向，這麼久內只算一次


def inside(pt: tuple[float, float] | list[float], poly: list[list[float]]) -> bool:
    """點在不在多邊形裡（射線法）。"""
    x, y = pt
    hit = False
    n = len(poly)
    for i in range(n):
        x1, y1 = poly[i]
        x2, y2 = poly[(i + 1) % n]
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / ((y2 - y1) or 1e-9) + x1:
            hit = not hit
    return hit


def foot(p: dict[str, Any]) -> tuple[float, float] | None:
    """一個人的腳在畫面上的位置（0～1）：腳踝看得到就用腳踝，不然用身體框的底部中間。"""
    return p.get("foot")


def area_track(st: dict[str, Any], here: bool, now: float, linger: float) -> list[str]:
    """區域裡有沒有人 → 事件："enter"（有人進來）、"linger"（待超過 linger 秒，一次）、"leave"（走了）。

    st：{"in": 現在有人嗎, "since": 這次從什麼時候進來, "seen": 最後一次看到, "lingered": 這次講過逗留了沒}
    """
    out: list[str] = []
    if here:
        st["seen"] = now
        if not st.get("in"):
            st.update({"in": True, "since": now, "lingered": False})
            out.append("enter")
        if linger and not st.get("lingered") and now - st["since"] >= linger:
            st["lingered"] = True
            out.append("linger")
    elif st.get("in") and now - (st.get("seen") or 0) >= AREA_LEAVE:
        st["in"] = False
        out.append("leave")
    return out


def object_track(st: dict[str, Any], score: float | None, energy: float, now: float, someone: bool) -> str | None:
    """東西多了／不見了：跟「正常的樣子」比，變了而且（沒人的時候）一直維持 OBJ_HOLD 秒才算。

    score：跟記住的正常樣子最像的相似度（還沒記過就是 None）；energy：現在這一塊的邊緣量（東西多了通常變多）。
    回傳 "learn"（該把現在的樣子記成正常的）、"more"（多了東西）、"less"（東西不見了）、"changed"（變了，看不出多還是少）或 None。
    st：{"diff": 從什麼時候開始跟正常的不一樣, "calm": 從什麼時候開始沒人又穩定, "base_e": 正常樣子的邊緣量}
    """
    if someone:  # 有人在畫面裡：先不判斷（人本身就會讓畫面變）
        st["calm"] = None
        return None
    if st.get("calm") is None:
        st["calm"] = now
    if score is None:
        return "learn" if now - st["calm"] >= OBJ_LEARN else None
    if score >= OBJ_SAME:
        st["diff"] = None
        return None
    if st.get("diff") is None:
        st["diff"] = now
    if now - st["diff"] < OBJ_HOLD:
        return None
    st["diff"] = None
    base = st.get("base_e") or 0.0
    if base and energy > base * 1.15:
        return "more"
    if base and energy < base * 0.85:
        return "less"
    return "changed"


def side(a: list[float], b: list[float], p: tuple[float, float]) -> float:
    """點在線 a→b 的哪一邊（外積）。畫面座標 y 往下，所以負的是「沿著 a→b 走時的左手邊」＝回來那一邊（畫面上箭頭指的方向）。"""
    return (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])


def _cross(a: list[float], b: list[float], p: tuple[float, float], q: tuple[float, float]) -> bool:
    """線段 p→q 有沒有穿過線段 a→b。"""
    d1, d2 = side(a, b, p), side(a, b, q)
    d3, d4 = side(list(p), list(q), tuple(a)), side(list(p), list(q), tuple(b))  # type: ignore[arg-type]
    return d1 * d2 < 0 and d3 * d4 < 0


def line_track(st: dict[str, Any], line: dict[str, Any], feet: list[tuple[float, float]], now: float) -> list[str]:
    """這一張的腳的位置，跟上一張比：有人穿過線就回傳方向 "in"（往箭頭那邊，回來）或 "out"（出去）。
    箭頭在線的「左手邊」：線由上往下畫，箭頭就指向畫面右邊。

    st：{"prev": [上一張的腳的位置], "at": {"in": 上次算的時間, "out": …}}
    """
    out: list[str] = []
    prev = st.get("prev") or []
    a, b = line["a"], line["b"]
    used: set[int] = set()
    for q in feet:
        best, bd = None, LINE_MATCH
        for i, p in enumerate(prev):
            d = ((p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2) ** 0.5
            if i not in used and d < bd:
                best, bd = i, d
        if best is None:
            continue
        used.add(best)
        p = prev[best]
        if _cross(a, b, tuple(p), q):  # type: ignore[arg-type]
            way = "in" if side(a, b, q) < 0 else "out"
            last = st.setdefault("at", {}).get(way)
            if last is None or now - last >= LINE_GAP:
                st["at"][way] = now
                out.append(way)
    st["prev"] = [list(q) for q in feet]
    return out

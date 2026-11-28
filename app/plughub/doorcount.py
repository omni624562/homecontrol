"""大門口進出人數：門口的攝影機追蹤每個人的腳，看他從哪裡出現、在哪裡消失。

- 在「大門」旁邊出現、在離開的地方（電梯、樓梯那頭）消失 → 出去 1 人
- 在離開的地方出現、在「大門」旁邊消失 → 進來 1 人
- 兩頭都在大門旁邊（出來拿鞋又進去）、兩頭都不在（鄰居搭電梯、送貨的經過）→ 不算
- 有一頭說不準在哪（大門跟電梯中間）→ 不算

每個位置是哪裡由 hub 判斷（where）：大門跟電梯緊貼著，離哪個區域近就算哪個——
只看「離大門近不近」的話，走進電梯會被當成走進家門（2026-11-28 早上鄰居三次進出全算反）。

追蹤中途跟丟、同一個人變成兩段也沒關係：在走廊中間斷掉的那一段兩頭都不在大門、不算；
在大門口斷掉的，前一段算「進來」、後一段算「出去」，剛好抵銷。
兩個人緊貼著走被看成一個人會少算——所以人數只是估計，hub 會用手機、房間的攝影機往上修正。

只有 Jetson 串流（每秒 5 次、有每個人的編號）才算得出來。
"""
from __future__ import annotations

from typing import Any, Callable

GONE = 3.0  # 秒：這麼久沒再看到這個人，算他離開畫面了
MIN_LIFE = 0.8  # 秒：看到不到這麼久的不算（雜訊）
EDGE = 5  # 每個人留最前面、最後面各幾筆腳的位置（每秒 5 筆 → 各 1 秒）

Pt = tuple[float, float]


class DoorCount:
    def __init__(self) -> None:
        self.tracks: dict[Any, dict[str, Any]] = {}  # 編號 → {"t0", "t1", "first": [腳], "last": [腳]}

    def feed(self, t: float, pts: list[tuple[Any, float, float]]) -> None:
        """一筆追蹤結果：這個時間，每個人（編號）的腳在哪。"""
        for tid, x, y in pts:
            tr = self.tracks.get(tid)
            if tr is None:
                tr = self.tracks[tid] = {"t0": t, "t1": t, "n": 0, "first": [], "last": []}
            tr["t1"] = t
            tr["n"] += 1
            if len(tr["first"]) < EDGE:
                tr["first"].append((x, y))
            tr["last"].append((x, y))
            del tr["last"][:-EDGE]

    def flush(self, now: float, where: Callable[[Pt], str | None]) -> list[tuple[str, float]]:
        """離開畫面的人：回傳 [("in" 或 "out", 時間)]。where(腳) = "home"（大門旁邊）、"away"（電梯、樓梯那頭）、None（說不準）。"""
        out: list[tuple[str, float]] = []
        for tid in [k for k, tr in self.tracks.items() if now - tr["t1"] >= GONE]:
            tr = self.tracks.pop(tid)
            if tr["t1"] - tr["t0"] < MIN_LIFE or tr["n"] < 2 * EDGE:  # 太短：出現跟消失是同一段路，分不出方向
                continue
            way = classify(tr["first"], tr["last"], where)
            if way:
                out.append((way, tr["t1"]))
        return out


def classify(first: list[Pt], last: list[Pt], where: Callable[[Pt], str | None]) -> str | None:
    """出現的地方、消失的地方 → "out"（從大門出去）、"in"（走進大門）、None（不算）。
    出現看最早那 1 秒、消失看最後那 1 秒；過半在同一個地方才算在那裡（腳的位置會抖）。"""
    def place(pts: list[Pt]) -> str | None:
        got = [where(p) for p in pts]
        return next((w for w in ("home", "away") if got.count(w) * 2 > len(got)), None)

    a, b = place(first), place(last)
    if a == "home" and b == "away":
        return "out"
    if a == "away" and b == "home":
        return "in"
    return None

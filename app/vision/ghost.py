"""門口攝影機「一直待在同一個地方、分數不高的人」：多半是鞋子、雨傘、掛著的衣服被認成人，不算有人。

實際例子：大門口樓梯邊的鞋子，被認成人 0.55～0.68 分、框幾乎不動，一晚上 1000 多次，
害「有人待了 9 分鐘」「同一個不認得的人今天第 3 次出現」。真的人通常 0.8 分以上、會動。
只給門口的攝影機用：房間裡坐著、躺著的人本來就會很久不動。
"""
from __future__ import annotations

from typing import Any

GHOST_MAX = 0.7  # 分數比這個低的才可能是假的人（真的人在門口多半 0.8 以上）
GHOST_IOU = 0.8  # 框跟第一次看到的位置重疊這麼多算「沒動」
GHOST_S = 8  # 秒：先確認會不會動：同一個地方這麼久都沒動，就當作是東西（走路的人幾秒內框就移開了）
GHOST_N = 3  # 而且至少看到這麼多次
FORGET_S = 300  # 秒：還沒認定之前，這麼久沒再看到就忘掉
GHOST_FORGET_S = 1800  # 秒：認定是東西以後，這麼久沒再看到才忘掉（東西被拿走了）


def _iou(a, b) -> float:
    iw = max(0.0, min(a[0] + a[2], b[0] + b[2]) - max(a[0], b[0]))
    ih = max(0.0, min(a[1] + a[3], b[1] + b[3]) - max(a[1], b[1]))
    inter = iw * ih
    return inter / (a[2] * a[3] + b[2] * b[3] - inter + 1e-9)


class Ghosts:
    def __init__(self) -> None:
        self.spots: list[dict[str, Any]] = []  # {"box", "first", "last", "n"}
        self.gone: list[dict[str, Any]] = []  # 認定過、後來不見了的（整天紀錄回頭補用）

    def is_ghost(self, o: dict[str, Any], now: float) -> bool:
        """記下這個「人」；回傳它是不是那個一直不動的假的人。分數高的一律算真的人（真的人站到那個位置也看得到）。"""
        if o.get("name") != "person" or o["score"] >= GHOST_MAX:
            return False
        b = o["box"]
        spot = next((s for s in self.spots if _iou(s["box"], b) >= GHOST_IOU), None)
        if spot is None:
            self.spots.append({"box": list(b), "first": now, "last": now, "n": 1})
            return False
        spot["last"] = now
        spot["n"] += 1
        return spot["n"] >= GHOST_N and now - spot["first"] >= GHOST_S

    @staticmethod
    def _settled(s: dict[str, Any]) -> bool:
        return s["n"] >= GHOST_N and s["last"] - s["first"] >= GHOST_S

    def tidy(self, now: float) -> None:
        keep = []
        for s in self.spots:
            if now - s["last"] < (GHOST_FORGET_S if self._settled(s) else FORGET_S):
                keep.append(s)
            elif self._settled(s):
                self.gone.append(s)
        self.spots = keep[-50:]  # 最多記 50 個位置

    def filter(self, objs: list[dict[str, Any]], now: float) -> list[dict[str, Any]]:
        """拿掉這一張裡假的人。"""
        self.tidy(now)
        return [o for o in objs if not self.is_ghost(o, now)]


def mask(t, cls, score, box) -> list[bool]:
    """已經存好的一整天紀錄：每一列是不是假的人。先照時間找出一直不動的位置，再回頭把那段時間裡（包括剛開始確認的那幾秒）低分的人都拿掉。"""
    g = Ghosts()
    order = sorted(range(len(t)), key=lambda i: float(t[i]))
    rows = [(float(t[i]), str(cls[i]), float(score[i]), [float(v) for v in box[i]]) for i in range(len(t))]
    for i in order:
        now, c, s, b = rows[i]
        g.is_ghost({"name": c, "score": s, "box": b}, now)
        g.tidy(now)
    spots = [s for s in g.spots + g.gone if g._settled(s)]
    return [c == "person" and s < GHOST_MAX and any(sp["first"] <= now <= sp["last"] and _iou(sp["box"], b) >= GHOST_IOU for sp in spots)
            for now, c, s, b in rows]

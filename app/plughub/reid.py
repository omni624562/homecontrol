"""同一個陌生人又來了：門口每次有人來（沒認出家人），記下他的外觀（衣服、身形；Jetson 算的 SigLIP 2 特徵），
跟今天前幾次比；同一個人今天第 NOTIFY_AT 次出現才通知（送貨、鄰居路過一兩次不吵）。

不算的（多半是家人）：
- 這次認出家人的臉
- 前後 5 分鐘內有家人的手機連上或離開 Wi-Fi
- 外觀跟今天認出的家人一樣（今天穿的衣服）
特徵只在記憶體裡、只留今天；看不出原本的樣子。
"""
from __future__ import annotations

from datetime import date, datetime
from typing import Any

SAME = 0.9  # 外觀相似度到這裡算同一個人（實測：門口同一人 0.91，不同人約 0.78）
NOTIFY_AT = 3
FAMILY_GAP = 300  # 秒：家人手機進出前後這麼久的「有人來」不算


def _unit(v: Any) -> Any:
    import numpy as np

    v = np.asarray(v, np.float32)
    n = float(np.linalg.norm(v))
    return v / n if n else v


def mean_emb(embs: list[Any]) -> Any:
    import numpy as np

    return _unit(np.mean([_unit(e) for e in embs], axis=0))


class Repeats:
    def __init__(self) -> None:
        self.day: date | None = None
        self.unknown: list[dict[str, Any]] = []  # {"emb", "times": [...], "notified": bool}
        self.family: list[Any] = []  # 今天認出的家人的外觀

    def _roll(self, now: float) -> None:
        d = datetime.fromtimestamp(now).date()
        if d != self.day:
            self.day, self.unknown, self.family = d, [], []

    def add_family(self, emb: Any, now: float) -> None:
        self._roll(now)
        self.family.append(_unit(emb))

    def add_visit(self, emb: Any, now: float) -> dict[str, Any] | None:
        """一次沒認出是誰的「有人來」。同一個人今天第 NOTIFY_AT 次（只講一次）→ 回傳那個人的紀錄。"""
        self._roll(now)
        e = _unit(emb)
        if any(float(e @ f) >= SAME for f in self.family):
            return None
        best = max(self.unknown, key=lambda u: float(e @ u["emb"]), default=None)
        if best is not None and float(e @ best["emb"]) >= SAME:
            n = len(best["times"])
            best["emb"] = _unit(best["emb"] * n + e)  # 慢慢平均，換個角度也認得
            best["times"].append(now)
            if len(best["times"]) >= NOTIFY_AT and not best["notified"]:
                best["notified"] = True
                return best
            return None
        self.unknown.append({"emb": e, "times": [now], "notified": False})
        return None


def family_moved(presence: dict[str, dict[str, Any]], start: float, end: float) -> bool:
    """這段時間（前後 FAMILY_GAP 秒）有家人的手機連上或離開 Wi-Fi 嗎。"""
    return any(start - FAMILY_GAP <= float(p.get("since") or 0) <= end + FAMILY_GAP for p in presence.values())

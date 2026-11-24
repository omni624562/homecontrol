"""很久沒動靜提醒（照護）：房間的攝影機，家裡有人、白天卻比平常久都沒看到人動，就通知家人。

- 「有動」：Jetson 追蹤的人位置或大小變了、出現新的人，或關節點（有開跌倒偵測時）動了；坐著看電視手有動也算有動
- 每天記「設定時段裡最久多久沒動」（分鐘，留 14 天），自動門檻 = 過去 7 天的中位數 × 2（至少 60 分鐘；學不到 3 天先用 120）
- 只在設定時段、而且有家人的手機在家時才提醒；提醒一次後要等有人動了才會再提醒
"""
from __future__ import annotations

from datetime import date, datetime, timedelta
from typing import Any

MOVE = 0.02  # 框的中心移動超過畫面的 2% 算有動
SIZE = 0.12  # 框的大小變超過 12%（站起來、坐下、轉身）
KP_MOVE = 0.012  # 關節點平均移動
MIN_ALERT = 60  # 分鐘：自動門檻至少這樣
DEFAULT_ALERT = 120  # 分鐘：學不到 3 天時
KEEP_DAYS = 14


def moved(prev: dict[int, list[float]], tracks: list[dict[str, Any]]) -> bool:
    """跟上一次比，追蹤的人有沒有動。"""
    for t in tracks:
        p = prev.get(t["id"])
        if p is None:
            return True  # 新出現的人
        x, y, w, h = t["box"]
        px, py, pw, ph = p
        if abs((x + w / 2) - (px + pw / 2)) > MOVE or abs((y + h / 2) - (py + ph / 2)) > MOVE:
            return True
        if abs(w * h - pw * ph) / max(1e-6, pw * ph) > SIZE:
            return True
    return False


def pose_moved(poses: list[list[Any]]) -> bool:
    """連續幾次的姿勢（每次的人照順序比）：身體的框動了、或軀幹角度變了（坐著轉身、彎腰）。"""
    for (_, a), (_, b) in zip(poses, poses[1:]):
        if len(a) != len(b):
            return True
        for pa, pb in zip(a, b):
            (ax, ay, aw, ah), (bx, by, bw, bh) = pa["box"], pb["box"]
            scale = max(1.0, float(ah))
            if (abs((ax + aw / 2) - (bx + bw / 2)) + abs((ay + ah / 2) - (by + bh / 2))) / scale > KP_MOVE * 4:
                return True
            if pa.get("torso") is not None and pb.get("torso") is not None and abs(pa["torso"] - pb["torso"]) > 10:
                return True
    return False


def threshold(days: dict[str, int], today: date) -> tuple[int, int | None, int]:
    """(門檻分鐘, 平常最久幾分鐘（中位數）, 學了幾天)。"""
    past = [v for d, v in days.items() if (today - date.fromisoformat(d)).days in range(1, 8)]
    if len(past) < 3:
        return DEFAULT_ALERT, None, len(past)
    med = sorted(past)[len(past) // 2]
    return max(MIN_ALERT, med * 2), med, len(past)


def in_window(when: datetime, window: str) -> bool:
    if not window:
        return True
    a, b = window.split("-")
    hm = when.hour * 60 + when.minute
    s, e = int(a[:2]) * 60 + int(a[3:]), int(b[:2]) * 60 + int(b[3:])
    return s <= hm < e if s <= e else hm >= s or hm < e


def record_gap(days: dict[str, int], when: datetime, gap_min: int) -> None:
    d = when.date().isoformat()
    days[d] = max(days.get(d, 0), gap_min)
    for k in [k for k in days if (when.date() - date.fromisoformat(k)).days > KEEP_DAYS]:
        del days[k]


def week(days: dict[str, int], today: date) -> list[dict[str, Any]]:
    return [{"d": (today - timedelta(days=i)).isoformat(), "max": days.get((today - timedelta(days=i)).isoformat())} for i in range(6, -1, -1)]

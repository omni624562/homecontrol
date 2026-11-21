"""人在哪個房間（實驗）：用家人手機的 Wi-Fi 訊號，跟事先在每個房間記下來的訊號比。

路由器只看得到手機連在哪一台（RT-BE92U 或 RT-AX86U 節點）和訊號強度，
所以要先「教」：拿著手機站在某個房間，按「我在這裡」，記 2 分鐘的訊號（指紋）。
之後每次都拿最近 90 秒的訊號，跟每個房間的指紋比，算出最像哪一間、有幾成把握。

- 每個房間的模型：連到每台路由器的機率 ×（那台路由器的訊號強度：平均、標準差的常態分布）
- 只用教過（至少 MIN_SAMPLES 筆）的房間；把握不到 65% 就說「不確定」，並列出最可能的兩間
- 只有 2 台路由器，隔一道牆的相鄰房間常分不出來；家具、門開關、手機放口袋或桌上都會影響

指紋、最近的訊號都只存在樹莓派上。
"""

from __future__ import annotations

import math
import time
from collections import deque
from typing import Any

TRAIN_S = 120  # 每次教多久
RECENT_S = 90  # 用最近多久的訊號判斷
MIN_RECENT = 3
MIN_SAMPLES = 15  # 房間至少要有幾筆才拿來比
KEEP = 240  # 每個房間每台路由器最多留幾筆（新的蓋舊的）
MIN_SD = 3.0  # 訊號標準差至少算 3 dBm（避免教的時候剛好很穩，之後差一點就判不是）
SURE = 0.65  # 兩間時最高的一定 ≥ 0.5，所以門檻要高一點


class Locator:
    def __init__(self, data: dict[str, Any]) -> None:
        # data = store.data["locate"]：{"prints": {MAC: {房間: {路由器: [RSSI, ...]}}}}
        self.data = data
        self.data.setdefault("prints", {})
        self.recent: dict[str, deque[tuple[float, str, int]]] = {}
        self.training: dict[str, tuple[str, float]] = {}  # MAC → (房間, 到幾點)
        self._fed: dict[str, float] = {}

    # ---- 收資料 ----
    def feed(self, mac: str, at: float, node: str | None, rssi: int | None) -> bool:
        """路由器有新的訊號就丟進來（同一個時間點只收一次）。回傳是不是新資料。"""
        if not node or rssi is None or rssi >= 0 or at <= self._fed.get(mac, 0):
            return False
        self._fed[mac] = at
        q = self.recent.setdefault(mac, deque(maxlen=200))
        q.append((at, node, int(rssi)))
        room, until = self.training.get(mac, (None, 0.0))
        if room and at <= until:
            per = self.data["prints"].setdefault(mac, {}).setdefault(room, {})
            vals = per.setdefault(node, [])
            vals.append(int(rssi))
            del vals[:-KEEP]
        elif room:
            del self.training[mac]
        return True

    def train(self, macs: list[str], room: str, seconds: float = TRAIN_S, now: float | None = None) -> float:
        until = (time.time() if now is None else now) + seconds
        for m in macs:
            self.training[m] = (room, until)
        return until

    def cancel(self, macs: list[str]) -> None:
        for m in macs:
            self.training.pop(m, None)

    def forget(self, macs: list[str], room: str | None = None) -> None:
        for m in macs:
            if room is None:
                self.data["prints"].pop(m, None)
            else:
                self.data["prints"].get(m, {}).pop(room, None)

    def counts(self, macs: list[str]) -> dict[str, int]:
        out: dict[str, int] = {}
        for m in macs:
            for room, per in self.data["prints"].get(m, {}).items():
                out[room] = out.get(room, 0) + sum(len(v) for v in per.values())
        return out

    # ---- 判斷 ----
    @staticmethod
    def _model(per: dict[str, list[int]]) -> dict[str, tuple[float, float, float]]:
        """房間的模型：路由器 → (連到它的比例, 平均, 標準差)。"""
        total = sum(len(v) for v in per.values())
        out = {}
        for node, vals in per.items():
            if not vals:
                continue
            mu = sum(vals) / len(vals)
            sd = math.sqrt(sum((v - mu) ** 2 for v in vals) / len(vals))
            out[node] = (len(vals) / total, mu, max(MIN_SD, sd))
        return out

    def estimate(self, mac: str, now: float | None = None) -> dict[str, Any] | None:
        now = time.time() if now is None else now
        recent = [s for s in self.recent.get(mac, ()) if now - s[0] <= RECENT_S]
        rooms = {r: per for r, per in self.data["prints"].get(mac, {}).items()
                 if sum(len(v) for v in per.values()) >= MIN_SAMPLES}
        if len(recent) < MIN_RECENT or not rooms:
            return None
        scores = {}
        for room, per in rooms.items():
            model = self._model(per)
            ll = 0.0
            for _, node, rssi in recent:
                if node in model:
                    share, mu, sd = model[node]
                    ll += math.log(share * 0.98 + 0.01) - math.log(sd) - (rssi - mu) ** 2 / (2 * sd * sd)
                else:
                    ll += math.log(0.01) - math.log(10) - 4.5  # 這間教的時候從沒連到這台路由器
            scores[room] = ll / len(recent)
        # 平均每筆的 log likelihood 換成機率；乘上筆數的一部分，讓資料多的時候比較果斷，但不會過度自信
        k = min(len(recent), 10)
        top = max(scores.values())
        exp = {r: math.exp((s - top) * k) for r, s in scores.items()}
        z = sum(exp.values())
        ranked = sorted(((r, e / z) for r, e in exp.items()), key=lambda x: -x[1])
        best, p = ranked[0]
        return {"room": best if p >= SURE else None, "p": round(p, 2),
                "top": [{"room": r, "p": round(q, 2)} for r, q in ranked[:3]],
                "samples": len(recent), "at": recent[-1][0]}

    def estimate_any(self, macs: list[str], now: float | None = None) -> dict[str, Any] | None:
        """一個人有好幾台裝置：用最近有訊號的那台。"""
        ests = [e for m in macs if (e := self.estimate(m, now))]
        return max(ests, key=lambda e: e["at"]) if ests else None

    def training_left(self, macs: list[str], now: float | None = None) -> dict[str, Any] | None:
        now = time.time() if now is None else now
        for m in macs:
            room, until = self.training.get(m, (None, 0.0))
            if room and until > now:
                return {"room": room, "left": round(until - now)}
        return None

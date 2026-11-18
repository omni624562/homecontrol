"""Wi-Fi 感測（實驗）：用插座回報的 Wi-Fi 訊號強度（RSSI）的擾動，猜附近有沒有人在動。

人走動時身體會擋住、反射訊號，插座量到的 RSSI 會比平常跳得厲害。
每 2 秒讀一次每台插座的 RSSI，保留最近 1 小時；
「擾動指數」= 最近 30 秒的標準差 − 這台插座平常安靜時的標準差（過去一小時的低百分位）。

只讀取，不控制任何東西。RSSI 只是一個數字、解析度 1 dBm，準確度有限：
只能偵測走動，不能偵測靜止的人；路由器、其他 Wi-Fi、微波爐也會造成擾動。
"""

from __future__ import annotations

import asyncio
import statistics
import time
from collections import deque
from typing import Any

INTERVAL = 2.0  # 秒
KEEP = 3600  # 保留幾秒
WINDOW = 30  # 擾動用幾秒的資料算
INVALID = -95  # 比這個低的讀數是錯誤值（插座偶爾回報 -105、-110）


class Sensing:
    def __init__(self) -> None:
        self.samples: dict[str, deque[tuple[float, int]]] = {}  # 裝置 → (時間, RSSI)
        self.motion: dict[str, deque[tuple[float, float]]] = {}  # 裝置 → (時間, 擾動指數)
        self._raw: dict[str, deque[tuple[float, float]]] = {}  # 裝置 → (時間, 原始標準差)

    async def sample(self, devices: dict[str, Any]) -> None:
        """讀一輪：devices = {裝置 key: python-kasa 裝置}。"""
        now = time.time()

        async def one(key: str, dev: Any) -> None:
            try:
                r = await asyncio.wait_for(dev.protocol.query({"netif": {"get_stainfo": {}}}), 1.5)
                rssi = int(r["netif"]["get_stainfo"]["rssi"])
            except Exception:  # noqa: BLE001
                return
            if rssi <= INVALID:
                return
            buf = self.samples.setdefault(key, deque(maxlen=int(KEEP / INTERVAL) + 10))
            buf.append((now, rssi))
            self._update_motion(key, now)

        await asyncio.gather(*(one(k, d) for k, d in devices.items()))

    def _update_motion(self, key: str, now: float) -> None:
        buf = self.samples[key]
        recent = [v for t, v in buf if now - t <= WINDOW]
        if len(recent) < 5:
            return
        sd = statistics.pstdev(recent)
        raw_hist = self._raw.setdefault(key, deque(maxlen=int(KEEP / INTERVAL) + 10))
        # 平常安靜時的波動：過去一小時原始標準差裡偏低的那一段（第 20 百分位）
        raw = sorted(x for _, x in raw_hist)
        base = raw[len(raw) // 5] if len(raw) >= 30 else sd
        raw_hist.append((now, sd))
        hist = self.motion.setdefault(key, deque(maxlen=int(KEEP / INTERVAL) + 10))
        hist.append((now, max(0.0, sd - base)))

    def report(self, names: dict[str, str], minutes: int = 60) -> dict[str, Any]:
        """每分鐘一格：平均 RSSI、最大擾動；加上目前的擾動。"""
        now = time.time()
        start = now - minutes * 60
        out = []
        for key, buf in self.samples.items():
            cols: list[dict[str, Any]] = []
            for i in range(minutes):
                a, b = start + i * 60, start + (i + 1) * 60
                vals = [v for t, v in buf if a <= t < b]
                mot = [m for t, m in self.motion.get(key, []) if a <= t < b]
                cols.append({"rssi": round(statistics.mean(vals), 1) if vals else None, "motion": round(max(mot), 2) if mot else None})
            cur = self.motion.get(key)
            out.append({
                "key": key, "name": names.get(key, key),
                "now": round(cur[-1][1], 2) if cur and now - cur[-1][0] < 10 else None,
                "rssi": buf[-1][1] if buf else None,
                "cols": cols,
            })
        active = [d for d in out if d["now"] is not None and d["now"] >= 1.0]
        return {"minutes": minutes, "start": start, "devices": sorted(out, key=lambda d: d["name"]),
                "active": [d["name"] for d in active], "samples": sum(len(b) for b in self.samples.values())}

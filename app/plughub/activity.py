"""家裡活動熱圖：攝影機看到的人，每小時有人幾秒、畫面上哪些位置最常有人（腳的位置）。

- 資料來源：Jetson 每秒 5 次的追蹤（腳的位置）；Jetson 不在時用樹莓派每秒一次的「有沒有人」（只有時間，沒有位置）
- 存在 data/activity.json：{攝影機: {日期: {"h": [24 小時各幾秒], "g": [GW×GH 格各幾次]}}}，留 21 天（才比得了上週）
只有數字，沒有畫面。
"""
from __future__ import annotations

import json
import time
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any

GW, GH = 32, 18
KEEP_DAYS = 21
SAVE_EVERY = 300


class Activity:
    def __init__(self, data_dir: Path) -> None:
        self.path = data_dir / "activity.json"
        try:
            self.data: dict[str, dict[str, dict[str, list[float]]]] = json.loads(self.path.read_text("utf-8"))
        except (FileNotFoundError, ValueError):
            self.data = {}
        self._saved = time.time()

    def _day(self, cam: str, t: float) -> dict[str, list[float]]:
        d = datetime.fromtimestamp(t).date().isoformat()
        return self.data.setdefault(cam, {}).setdefault(d, {"h": [0.0] * 24, "g": [0] * (GW * GH)})

    def add(self, cam: str, t: float, feet: list[tuple[float, float]], dt: float) -> None:
        """這一刻（持續 dt 秒）看到的人腳的位置；沒人就不記。"""
        if not feet:
            return
        day = self._day(cam, t)
        day["h"][datetime.fromtimestamp(t).hour] += dt
        for x, y in feet:
            gx, gy = min(GW - 1, max(0, int(x * GW))), min(GH - 1, max(0, int(y * GH)))
            day["g"][gy * GW + gx] += 1

    def add_presence(self, cam: str, t: float, dt: float) -> None:
        """只知道有人（沒有位置）。"""
        self._day(cam, t)["h"][datetime.fromtimestamp(t).hour] += dt

    def maybe_save(self, force: bool = False) -> None:
        if not force and time.time() - self._saved < SAVE_EVERY:
            return
        cut = (date.today() - timedelta(days=KEEP_DAYS)).isoformat()
        for cam in self.data.values():
            for d in [d for d in cam if d < cut]:
                del cam[d]
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self.data), "utf-8")
        tmp.replace(self.path)
        self._saved = time.time()

    def days(self, rng: str, today: date | None = None) -> list[str]:
        today = today or date.today()
        if rng == "today":
            return [today.isoformat()]
        start = today - timedelta(days=today.weekday())  # 這週從星期一開始
        if rng in ("lastweek", "lastweek_same"):  # lastweek_same：上週同樣的那幾天（跟「這週到今天」比才公平）
            n = 7 if rng == "lastweek" else (today - start).days + 1
            start -= timedelta(days=7)
            return [(start + timedelta(days=i)).isoformat() for i in range(n)]
        return [(start + timedelta(days=i)).isoformat() for i in range((today - start).days + 1)]

    def summary(self, cam: str, rng: str, today: date | None = None) -> dict[str, Any]:
        h = [0.0] * 24
        g = [0] * (GW * GH)
        n = 0
        for d in self.days(rng, today):
            day = (self.data.get(cam) or {}).get(d)
            if not day:
                continue
            n += 1
            h = [a + b for a, b in zip(h, day["h"])]
            g = [a + b for a, b in zip(g, day["g"])]
        return {"hours": [round(v) for v in h], "seconds": round(sum(h)), "grid": g, "gw": GW, "gh": GH, "days": n}

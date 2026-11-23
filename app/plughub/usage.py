"""功能使用統計：每天每個功能用了幾次，只存在樹莓派上（data/usage.json），不會傳出去。

用來判斷哪些功能常用、哪些很久沒人碰（可以收起來或拿掉）。不記是誰、不記內容，只記次數。
- 頁面：畫面切換頁面時回報「page:頁名」
- 操作：每個會改東西的 API（開關、跑情境、改設定…）自動用處理它的函式名稱記一次「api:名稱」
- 背景：排程執行「auto:schedule」、送出的通知「notify:標題」、看攝影機畫面「view:camera」
保留 120 天。
"""
from __future__ import annotations

import json
import logging
import re
import time
from datetime import date, timedelta
from pathlib import Path
from typing import Any

_LOGGER = logging.getLogger(__name__)
KEEP_DAYS = 120
SAVE_EVERY = 60  # 秒；當機最多少記這一分鐘
KEY_RE = re.compile(r"^[a-z]+:[\w\-./]{1,60}$")


class Usage:
    def __init__(self, data_dir: Path) -> None:
        self.path = data_dir / "usage.json"
        self.days: dict[str, dict[str, int]] = {}
        try:
            raw = json.loads(self.path.read_text("utf-8"))
            self.days = {d: {k: int(n) for k, n in v.items()} for d, v in (raw.get("days") or {}).items()}
        except FileNotFoundError:
            pass
        except Exception as err:  # noqa: BLE001
            _LOGGER.warning("讀不到使用統計：%s", err)
        self._saved = time.time()
        self._dirty = False
        self._seen: dict[str, float] = {}  # 節流用：key → 上次記的時間

    def hit(self, key: str, every: float = 0, today: date | None = None) -> bool:
        """記一次。every > 0：同一個 key 在這麼多秒內只算一次（例如看即時畫面會一直抓圖）。"""
        if not KEY_RE.match(key):
            return False
        now = time.time()
        if every and now - self._seen.get(key, -1e18) < every:
            return False
        self._seen[key] = now
        day = (today or date.today()).isoformat()
        bucket = self.days.setdefault(day, {})
        bucket[key] = bucket.get(key, 0) + 1
        self._dirty = True
        if now - self._saved >= SAVE_EVERY:
            self.save()
        return True

    def save(self) -> None:
        if not self._dirty:
            return
        cut = (date.today() - timedelta(days=KEEP_DAYS)).isoformat()
        self.days = {d: v for d, v in self.days.items() if d >= cut}
        try:
            tmp = self.path.with_suffix(".tmp")
            tmp.write_text(json.dumps({"days": self.days}, ensure_ascii=False), "utf-8")
            tmp.replace(self.path)
            self._dirty = False
            self._saved = time.time()
        except OSError as err:
            _LOGGER.warning("存不了使用統計：%s", err)

    def summary(self, today: date | None = None) -> dict[str, Any]:
        """每個功能：近 7／30／120 天幾次、最後一次是哪天。since = 從哪天開始記。"""
        today = today or date.today()
        d7 = (today - timedelta(days=6)).isoformat()
        d30 = (today - timedelta(days=29)).isoformat()
        out: dict[str, dict[str, Any]] = {}
        for day in sorted(self.days):
            for key, n in self.days[day].items():
                row = out.setdefault(key, {"d7": 0, "d30": 0, "all": 0, "last": day})
                row["all"] += n
                row["last"] = day
                if day >= d30:
                    row["d30"] += n
                if day >= d7:
                    row["d7"] += n
        return {"since": min(self.days) if self.days else today.isoformat(), "today": today.isoformat(), "items": out}

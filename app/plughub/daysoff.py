"""放假日和天氣：排程可以設定「國定假日不執行」「下雨不執行」。

- 國定假日：從 TaiwanCalendar（整理自行政院人事行政總處的辦公日曆表）下載當年的假日表，存在樹莓派上，一年只下載一次。
  只把「平日放假」（國定假日、補假）當作假日；週末本來就由排程的星期決定。
- 下雨：用中央氣象署的雨量站實測和鄉鎮預報（weather.py）。
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
import urllib.request
from datetime import date, timedelta
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .weather import Weather

_LOGGER = logging.getLogger(__name__)

HOLIDAY_URL = "https://cdn.jsdelivr.net/gh/ruyut/TaiwanCalendar/data/{year}.json"
HOLIDAY_RETRY = 6 * 3600


def _get_json(url: str) -> object:
    req = urllib.request.Request(url, headers={"User-Agent": "home-hub/1.0"})
    with urllib.request.urlopen(req, timeout=15) as res:
        return json.loads(res.read().decode("utf-8"))


class DaysOff:
    def __init__(self, data_dir: Path, weather: "Weather") -> None:
        self.weather = weather
        self.dir = data_dir
        self.holidays: dict[str, str] = {}  # "2026-10-09" → "補假"（只有平日放假的）
        self.lunar: dict[str, str] = {}  # 農曆年：「農曆除夕」「春節」（初一～初三），不管星期幾
        self.years: set[int] = set()
        self._hol_try: dict[int, float] = {}
        for f in data_dir.glob("holidays-*.json"):
            try:
                self._read_holidays(int(f.stem.split("-")[1]), json.loads(f.read_text("utf-8")))
            except Exception:  # noqa: BLE001
                pass

    def _read_holidays(self, year: int, rows: object) -> None:
        for r in rows if isinstance(rows, list) else []:
            d = str(r.get("date", ""))
            if len(d) == 8 and r.get("isHoliday"):
                day = date(int(d[:4]), int(d[4:6]), int(d[6:]))
                if r.get("description") in ("農曆除夕", "春節"):
                    self.lunar[day.isoformat()] = r["description"]
                if day.weekday() < 5:
                    self.holidays[day.isoformat()] = r.get("description") or "放假"
        self.years.add(year)

    async def refresh(self, location: tuple[float, float] | None, need_weather: bool, show: bool = False) -> bool:
        """需要的話下載假日表、查天氣。有新資料回傳 True。"""
        changed = False
        today = date.today()
        now = time.time()
        for year in {today.year, (today + timedelta(days=7)).year}:
            if year in self.years or now - self._hol_try.get(year, 0) < HOLIDAY_RETRY:
                continue
            self._hol_try[year] = now
            try:
                rows = await asyncio.to_thread(_get_json, HOLIDAY_URL.format(year=year))
                self._read_holidays(year, rows)
                (self.dir / f"holidays-{year}.json").write_text(json.dumps(rows, ensure_ascii=False), "utf-8")
                _LOGGER.info("下載了 %d 年的假日表", year)
                changed = True
            except Exception as err:  # noqa: BLE001
                _LOGGER.warning("%d 年的假日表下載失敗：%s", year, err)
        if need_weather or show:
            before = self._rain_sig()
            await self.weather.refresh(location, show)
            changed = changed or self._rain_sig() != before  # 哪幾天會因為下雨跳過變了，才要重寫插座裡的規則
        return changed

    def _rain_sig(self) -> tuple:
        today = date.today()
        return tuple(bool(self.weather.rainy(today + timedelta(days=i))) for i in range(7))

    def holiday(self, day: date) -> str | None:
        return self.holidays.get(day.isoformat())

    def garbage_off(self, day: date, minute: int | None) -> str | None:
        """新北市垃圾車停收：初一～初三全天停收；除夕只收到 18:00（表定在那之後的就算停收）。"""
        kind = self.lunar.get(day.isoformat())
        if kind == "春節":
            return "春節停收"
        if kind == "農曆除夕" and (minute is None or minute >= 18 * 60):
            return "除夕停收"
        return None

    def rainy(self, day: date) -> str | None:
        """過去 24 小時下過雨，或白天降雨機率高：回傳原因。"""
        return self.weather.rainy(day)

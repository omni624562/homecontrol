"""放假日和天氣：排程可以設定「國定假日不執行」「下雨不執行」。

- 國定假日：從 TaiwanCalendar（整理自行政院人事行政總處的辦公日曆表）下載當年的假日表，存在樹莓派上，一年只下載一次。
  只把「平日放假」（國定假日、補假）當作假日；週末本來就由排程的星期決定。
- 天氣：向 Open-Meteo 查昨天的雨量和今天、明天的預報。只送出四捨五入到小數一位的經緯度（大約 10 公里內），
  不送其他資料。只有在有排程打開「下雨不執行」時才查，每 3 小時一次。
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
import urllib.request
from datetime import date, timedelta
from pathlib import Path

_LOGGER = logging.getLogger(__name__)

HOLIDAY_URL = "https://cdn.jsdelivr.net/gh/ruyut/TaiwanCalendar/data/{year}.json"
WEATHER_URL = (
    "https://api.open-meteo.com/v1/forecast?latitude={lat}&longitude={lon}"
    "&daily=precipitation_sum,precipitation_probability_max&past_days=1&forecast_days=2&timezone=Asia%2FTaipei"
)
RAIN_MM = 3.0  # 一天的雨量超過這麼多就算「下雨」
HOLIDAY_RETRY = 6 * 3600
WEATHER_EVERY = 3 * 3600


def _get_json(url: str) -> object:
    req = urllib.request.Request(url, headers={"User-Agent": "home-hub/1.0"})
    with urllib.request.urlopen(req, timeout=15) as res:
        return json.loads(res.read().decode("utf-8"))


class DaysOff:
    def __init__(self, data_dir: Path) -> None:
        self.dir = data_dir
        self.holidays: dict[str, str] = {}  # "2026-10-09" → "補假"（只有平日放假的）
        self.years: set[int] = set()
        self.rain: dict[str, float] = {}  # "2026-11-18" → 雨量（公釐，過去是實際、未來是預報）
        self.weather_at = 0.0
        self.weather_error: str | None = None
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
                if day.weekday() < 5:
                    self.holidays[day.isoformat()] = r.get("description") or "放假"
        self.years.add(year)

    async def refresh(self, location: tuple[float, float] | None, need_weather: bool) -> bool:
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
        if need_weather and location and now - self.weather_at >= WEATHER_EVERY:
            self.weather_at = now
            lat, lon = (round(x, 1) for x in location)
            try:
                d = await asyncio.to_thread(_get_json, WEATHER_URL.format(lat=lat, lon=lon))
                daily = d["daily"]  # type: ignore[index]
                rain = {t: float(mm or 0) for t, mm in zip(daily["time"], daily["precipitation_sum"])}
                changed = changed or rain != self.rain
                self.rain = rain
                self.weather_error = None
            except Exception as err:  # noqa: BLE001
                self.weather_error = str(err)[:120]
                _LOGGER.warning("天氣查詢失敗：%s", err)
        return changed

    def holiday(self, day: date) -> str | None:
        return self.holidays.get(day.isoformat())

    def rainy(self, day: date) -> str | None:
        """昨天下過雨或今天預報會下雨：回傳原因。"""
        y = self.rain.get((day - timedelta(days=1)).isoformat())
        t = self.rain.get(day.isoformat())
        if y is not None and y >= RAIN_MM:
            return f"前一天下了 {y:.0f} mm 的雨"
        if t is not None and t >= RAIN_MM:
            return f"預報會下 {t:.0f} mm 的雨"
        return None

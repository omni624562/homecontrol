"""天氣：中央氣象署（測站實測、鄉鎮預報）和環境部（空品測站）的開放資料。

- 需要授權碼：氣象署（opendata.cwa.gov.tw）、環境部（data.moenv.gov.tw），存在 data/secrets.json，不會回傳給瀏覽器。
- 選測站：一天一次下載全國的測站清單，在樹莓派上算出離家最近的幾個（家裡的經緯度不會送出去）。
  之後只查那幾個測站／那個鄉鎮，所以氣象署和環境部會知道要查哪個測站和鄉鎮。
- 現在：最近、有在回報的氣象站（溫度、濕度、風、天氣）＋最近的雨量站（今天累積、過去 24 小時）。
- 預報：所在鄉鎮的 3 天逐時預報（溫度、體感、3 小時降雨機率、天氣）和一週逐 12 小時預報（高低溫、降雨機率、紫外線）。
"""

from __future__ import annotations

import asyncio
import json
import logging
import math
import time
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any

_LOGGER = logging.getLogger(__name__)

CWA = "https://opendata.cwa.gov.tw/api/v1/rest/datastore/{ds}"
MOENV = "https://data.moenv.gov.tw/api/v2/aqx_p_432"
# 各縣市的鄉鎮預報：3 天逐時的資料集編號；一週逐 12 小時的是 +2
TOWN_DS = {
    "宜蘭縣": 1, "桃園市": 5, "新竹縣": 9, "苗栗縣": 13, "彰化縣": 17, "南投縣": 21, "雲林縣": 25, "嘉義縣": 29,
    "屏東縣": 33, "臺東縣": 37, "花蓮縣": 41, "澎湖縣": 45, "基隆市": 49, "新竹市": 53, "嘉義市": 57, "臺北市": 61,
    "高雄市": 65, "新北市": 69, "臺中市": 73, "臺南市": 77, "連江縣": 81, "金門縣": 85,
}
OBS_DS = ("O-A0003-001", "O-A0001-001")  # 氣象站（每 10 分鐘）、自動氣象站（每小時）
RAIN_DS = "O-A0002-001"
RESOLVE_EVERY = 24 * 3600
OBS_EVERY = 10 * 60
FORECAST_EVERY = 60 * 60
AIR_EVERY = 30 * 60
RAIN_MM = 3.0  # 過去 24 小時下超過這麼多就算「下雨」
RAIN_POP = 70  # 白天（6–18 點）降雨機率到這麼高也算


def _get(url: str, **q: str) -> Any:
    req = urllib.request.Request(f"{url}?{urllib.parse.urlencode(q)}", headers={"User-Agent": "home-hub/1.0"})
    with urllib.request.urlopen(req, timeout=60) as res:
        return json.loads(res.read().decode("utf-8"))


def _num(v: Any) -> float | None:
    try:
        x = float(v)
    except (TypeError, ValueError):
        return None
    return None if x <= -90 else x  # 氣象署用 -99、-999 表示沒有資料


def _wgs84(st: dict) -> tuple[float, float] | None:
    for c in st.get("GeoInfo", {}).get("Coordinates", []):
        if c.get("CoordinateName") == "WGS84":
            return float(c["StationLatitude"]), float(c["StationLongitude"])
    return None


class Weather:
    def __init__(self, secrets_path: Path) -> None:
        self._path = secrets_path
        self.home: tuple[float, float] | None = None
        self.stations: list[dict] = []  # [{id, ds, name, km}]
        self.rain_stations: list[dict] = []
        self.county: str | None = None
        self.town: str | None = None
        self.air_site: dict | None = None
        self.obs: dict | None = None
        self.rain_obs: dict | None = None
        self.hourly: list[dict] = []
        self.daily: list[dict] = []
        self.periods: list[dict] = []  # 一週預報的每 12 小時
        self.air: dict | None = None
        self.error: str | None = None
        self.air_error: str | None = None
        self.updated = 0.0
        self._at: dict[str, float] = {}

    # ---- 金鑰 ----
    def _secrets(self) -> dict:
        try:
            return json.loads(self._path.read_text("utf-8"))
        except Exception:  # noqa: BLE001
            return {}

    def set_keys(self, cwa: str | None = None, moenv: str | None = None) -> None:
        """None = 不改、空字串 = 刪掉。"""
        data = self._secrets()
        for name, v in (("cwa_key", cwa), ("moenv_key", moenv)):
            if v is None:
                continue
            if v.strip():
                data[name] = v.strip()
            else:
                data.pop(name, None)
        tmp = self._path.with_suffix(".tmp")
        tmp.write_text(json.dumps(data), "utf-8")
        tmp.chmod(0o600)
        tmp.replace(self._path)
        self.reset()

    def key(self) -> str | None:
        return self._secrets().get("cwa_key") or None

    def air_key(self) -> str | None:
        return self._secrets().get("moenv_key") or None

    def reset(self) -> None:
        """金鑰或位置變了：重新選測站、全部重查。"""
        self._at.clear()

    def _due(self, what: str, every: float) -> bool:
        if time.time() - self._at.get(what, 0) < every:
            return False
        self._at[what] = time.time()
        return True

    def _km(self, lat: float, lon: float) -> float:
        hl, ho = self.home  # type: ignore[misc]
        return math.hypot((lat - hl) * 111.2, (lon - ho) * 111.2 * math.cos(math.radians(hl)))

    def _cwa(self, ds: str, **q: str) -> Any:
        d = _get(CWA.format(ds=ds), Authorization=self.key() or "", format="JSON", **q)
        if str(d.get("success")) != "true":
            raise RuntimeError(f"{ds} 回傳失敗")
        return d["records"]

    # ---- 更新 ----
    async def refresh(self, home: tuple[float, float] | None, show: bool) -> bool:
        """需要的話更新；有新資料回傳 True。show=False 時只為了「下雨不執行」，每小時查一次。"""
        if not home or not self.key():
            return False
        if home != self.home:
            self.home = home
            self.reset()
        changed = False
        try:
            if self._due("resolve", RESOLVE_EVERY):
                await asyncio.to_thread(self._resolve)
            if self._due("obs", OBS_EVERY if show else FORECAST_EVERY):
                await asyncio.to_thread(self._observe)
                changed = True
            if self._due("forecast", FORECAST_EVERY):
                await asyncio.to_thread(self._forecast)
                changed = True
            self.error = None
        except Exception as err:  # noqa: BLE001
            self.error = str(err)[:160].replace(self.key() or "\0", "…")
            if not self.stations:
                self._at.pop("resolve", None)  # 還沒選好測站：下一輪再試
            _LOGGER.warning("氣象署資料查詢失敗：%s", self.error)
        if show and self.air_key() and self._due("air", AIR_EVERY):
            try:
                await asyncio.to_thread(self._air)
                self.air_error = None
                changed = True
            except Exception as err:  # noqa: BLE001
                self.air_error = str(err)[:160].replace(self.air_key() or "\0", "…")
                _LOGGER.warning("環境部空品查詢失敗：%s", self.air_error)
        if changed:
            self.updated = time.time()
        return changed

    def _resolve(self) -> None:
        """下載全國測站清單，在這裡算出最近的氣象站、雨量站、鄉鎮。"""
        cands = []
        for ds in OBS_DS:
            for st in self._cwa(ds)["Station"]:
                ll = _wgs84(st)
                if ll and _num(st.get("WeatherElement", {}).get("AirTemperature")) is not None:
                    cands.append({"id": st["StationId"], "ds": ds, "name": st["StationName"], "km": round(self._km(*ll), 1),
                                  "county": st["GeoInfo"].get("CountyName")})
        cands.sort(key=lambda x: x["km"])
        seen: set[str] = set()
        self.stations = [x for x in cands if not (x["id"] in seen or seen.add(x["id"]))][:3]  # 兩個資料集會有同一個站
        rains = []
        for st in self._cwa(RAIN_DS)["Station"]:
            ll = _wgs84(st)
            if ll and _num(st.get("RainfallElement", {}).get("Past24hr", {}).get("Precipitation")) is not None:
                rains.append({"id": st["StationId"], "name": st["StationName"], "km": round(self._km(*ll), 1)})
        rains.sort(key=lambda x: x["km"])
        self.rain_stations = rains[:2]
        county = self.stations[0]["county"] if self.stations else None
        if county and county.replace("台", "臺") in TOWN_DS:
            self.county = county.replace("台", "臺")
            ds = f"F-D0047-{TOWN_DS[self.county]:03d}"
            towns = self._cwa(ds, ElementName="溫度")["Locations"][0]["Location"]
            self.town = min(towns, key=lambda t: self._km(float(t["Latitude"]), float(t["Longitude"])))["LocationName"]
        if self.air_key():
            sites = self._moenv()
            sites = [s for s in sites if _num(s.get("latitude")) is not None]
            if sites:
                s = min(sites, key=lambda s: self._km(float(s["latitude"]), float(s["longitude"])))
                self.air_site = {"name": s.get("sitename"), "km": round(self._km(float(s["latitude"]), float(s["longitude"])), 1)}
        _LOGGER.info("天氣：測站 %s、雨量站 %s、鄉鎮 %s%s", [s["name"] for s in self.stations],
                     [s["name"] for s in self.rain_stations], self.county, self.town)

    def _observe(self) -> None:
        obs = None
        for ds in OBS_DS:
            ids = [s for s in self.stations if s["ds"] == ds]
            if not ids:
                continue
            got = {st["StationId"]: st for st in self._cwa(ds, StationId=",".join(s["id"] for s in ids))["Station"]}
            for s in ids:
                st = got.get(s["id"])
                we = (st or {}).get("WeatherElement", {})
                if st and _num(we.get("AirTemperature")) is not None:
                    o = {"station": s["name"], "km": s["km"], "at": st["ObsTime"]["DateTime"],
                         "temp": _num(we.get("AirTemperature")), "humidity": _num(we.get("RelativeHumidity")),
                         "wind": _num(we.get("WindSpeed")), "gust": _num(we.get("GustInfo", {}).get("PeakGustSpeed")),
                         "text": we.get("Weather") if we.get("Weather") not in (None, "", "-99") else None,
                         "high": _num(we.get("DailyExtreme", {}).get("DailyHigh", {}).get("TemperatureInfo", {}).get("AirTemperature")),
                         "low": _num(we.get("DailyExtreme", {}).get("DailyLow", {}).get("TemperatureInfo", {}).get("AirTemperature"))}
                    if obs is None or s["km"] < obs["km"]:
                        obs = o
        if obs is None and self.stations:
            self._at.pop("resolve", None)  # 附近的測站都沒資料：明天前重新選
        self.obs = obs
        if self.rain_stations:
            got = {st["StationId"]: st for st in self._cwa(RAIN_DS, StationId=",".join(s["id"] for s in self.rain_stations))["Station"]}
            for s in self.rain_stations:
                re_ = got.get(s["id"], {}).get("RainfallElement", {})
                p24 = _num(re_.get("Past24hr", {}).get("Precipitation"))
                if p24 is not None:
                    self.rain_obs = {"station": s["name"], "km": s["km"], "at": got[s["id"]]["ObsTime"]["DateTime"],
                                     "today": _num(re_.get("Now", {}).get("Precipitation")),
                                     "past1h": _num(re_.get("Past1hr", {}).get("Precipitation")), "past24h": p24}
                    break

    def _forecast(self) -> None:
        if not (self.county and self.town):
            return
        n = TOWN_DS[self.county]

        def elements(ds: str, names: str) -> dict[str, list]:
            loc = self._cwa(ds, LocationName=self.town, ElementName=names)["Locations"][0]["Location"][0]
            return {e["ElementName"]: e["Time"] for e in loc["WeatherElement"]}

        h = elements(f"F-D0047-{n:03d}", "溫度,體感溫度,相對濕度,3小時降雨機率,天氣現象")
        now = datetime.now().astimezone()
        hour0 = now.replace(minute=0, second=0, microsecond=0)

        def at(rows: list, key: str) -> dict[datetime, Any]:
            return {datetime.fromisoformat(r["DataTime"]): r["ElementValue"][0][key] for r in rows}

        def span(rows: list) -> list[tuple[datetime, datetime, dict]]:
            return [(datetime.fromisoformat(r["StartTime"]), datetime.fromisoformat(r["EndTime"]), r["ElementValue"][0]) for r in rows]

        temp, feels, hum = at(h["溫度"], "Temperature"), at(h["體感溫度"], "ApparentTemperature"), at(h["相對濕度"], "RelativeHumidity")
        pops, wxs = span(h["3小時降雨機率"]), span(h["天氣現象"])

        def inside(rows: list, t: datetime) -> dict:
            return next((v for a, b, v in rows if a <= t < b), {})

        hourly = []
        for i in range(25):
            t = hour0 + timedelta(hours=i)
            if t not in temp:
                continue
            w = inside(wxs, t)
            hourly.append({"t": t.strftime("%H:%M"), "temp": _num(temp[t]), "feels": _num(feels.get(t)), "humidity": _num(hum.get(t)),
                           "pop": _num(inside(pops, t).get("ProbabilityOfPrecipitation")), "code": w.get("WeatherCode"),
                           "text": w.get("Weather"), "day": 1 if 6 <= t.hour < 18 else 0})
        self.hourly = hourly[:24]

        w = elements(f"F-D0047-{n + 2:03d}", "最高溫度,最低溫度,12小時降雨機率,天氣現象,紫外線指數")
        periods = []
        for (a, b, wx), (_, _, hi), (_, _, lo), (_, _, pop) in zip(span(w["天氣現象"]), span(w["最高溫度"]), span(w["最低溫度"]), span(w["12小時降雨機率"])):
            periods.append({"start": a.isoformat(), "day": a.hour == 6, "date": a.date().isoformat(), "code": wx.get("WeatherCode"),
                            "text": wx.get("Weather"), "max": _num(hi.get("MaxTemperature")), "min": _num(lo.get("MinTemperature")),
                            "pop": _num(pop.get("ProbabilityOfPrecipitation"))})
        uv = {datetime.fromisoformat(r["StartTime"]).date().isoformat(): _num(r["ElementValue"][0].get("UVIndex")) for r in w.get("紫外線指數", [])}
        self.periods = periods
        days: dict[str, dict] = {}
        for p in periods:
            d = days.setdefault(p["date"], {"date": p["date"], "max": p["max"], "min": p["min"], "pop": p["pop"], "code": p["code"], "text": p["text"], "uv": uv.get(p["date"])})
            if p["day"]:  # 白天的天氣代表這一天
                d.update(code=p["code"], text=p["text"])
            for k, f in (("max", max), ("min", min), ("pop", max)):
                vals = [x for x in (d[k], p[k]) if x is not None]
                d[k] = f(vals) if vals else None
        self.daily = [d for k, d in sorted(days.items()) if k >= date.today().isoformat()]

    def _moenv(self) -> list[dict]:
        d = _get(MOENV, api_key=self.air_key() or "", format="json", limit="1000")
        rows = d.get("records", d) if isinstance(d, dict) else d
        if not isinstance(rows, list):
            raise RuntimeError("環境部回傳的格式看不懂")
        return rows

    def _air(self) -> None:
        if not self.air_site:
            self._at.pop("resolve", None)
            self._resolve()
        rows = [r for r in self._moenv() if self.air_site and r.get("sitename") == self.air_site["name"]]
        if rows:
            r = rows[0]
            self.air = {"site": r.get("sitename"), "km": self.air_site["km"] if self.air_site else None, "at": r.get("publishtime"),
                        "aqi": _num(r.get("aqi")), "status": r.get("status"), "pm25": _num(r.get("pm2.5")),
                        "pm25_avg": _num(r.get("pm2.5_avg")), "pollutant": r.get("pollutant") or None}

    # ---- 給排程用 ----
    def day_pop(self, day: date) -> float | None:
        """那一天白天（6–18 點）的降雨機率。"""
        for p in self.periods:
            if p["date"] == day.isoformat() and p["day"]:
                return p["pop"]
        return None

    def rainy(self, day: date) -> str | None:
        today = date.today()
        if day == today and self.rain_obs and (self.rain_obs.get("past24h") or 0) >= RAIN_MM:
            return f"過去 24 小時下了 {self.rain_obs['past24h']:.0f} mm 的雨（{self.rain_obs['station']}雨量站）"
        pop = self.day_pop(day)
        if pop is not None and pop >= RAIN_POP:
            return f"白天降雨機率 {pop:.0f}%（氣象署預報）"
        return None

    def report(self) -> dict | None:
        if not self.key():
            return None
        o = self.obs or {}
        h0 = self.hourly[0] if self.hourly else {}
        return {
            "temp": o.get("temp") if o.get("temp") is not None else h0.get("temp"),
            "feels": h0.get("feels"), "humidity": o.get("humidity") if o.get("humidity") is not None else h0.get("humidity"),
            "wind": o.get("wind"), "gust": o.get("gust"), "obs_text": o.get("text"),
            "high": o.get("high"), "low": o.get("low"),
            "code": h0.get("code"), "text": h0.get("text"), "day": h0.get("day", 1),
            "station": o.get("station"), "station_km": o.get("km"), "obs_at": o.get("at"),
            "rain": self.rain_obs, "air": self.air, "air_site": self.air_site,
            "place": f"{self.county or ''}{self.town or ''}" or None,
            "hourly": self.hourly, "daily": self.daily,
            "pop_today": self.day_pop(date.today()), "pop_tomorrow": self.day_pop(date.today() + timedelta(days=1)),
            "rain_mm": RAIN_MM, "rain_pop": RAIN_POP,
            "updated": self.updated or None, "error": self.error, "air_error": self.air_error,
            "air_key": bool(self.air_key()),
        }

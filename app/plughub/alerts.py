"""出事時的資訊：停班停課、天氣特報、地震、台電供電、明後天的空品預報。

都是整份抓回來，在樹莓派上比對你家的縣市、區（不會把位置或地址送出去）：
- 停班停課：行政院人事行政總處（網頁表格，不需要金鑰）
- 天氣特報：氣象署 W-C0033-001；地震：氣象署 E-A0015-001、E-A0016-001（用現有的氣象署授權碼）
- 供電：台電「今日電力資訊」（不需要金鑰）
- 空品預報：環境部 aqf_p_01（用現有的環境部金鑰）
"""
from __future__ import annotations

import html
import json
import logging
import math
import re
import time
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any, Callable

_LOGGER = logging.getLogger(__name__)

DGPA = "https://www.dgpa.gov.tw/typh/daily/nds.html"
CWA = "https://opendata.cwa.gov.tw/api/v1/rest/datastore/{ds}"
TAIPOWER = "https://service.taipower.com.tw/data/opendata/apply/file/d006020/001.json"
AQF = "https://data.moenv.gov.tw/api/v2/aqf_p_01"

EVERY = {"dayoff": 600, "warn": 600, "quake": 180, "power": 900, "aqf": 3600}

# 縣市 → 空品區
AIR_ZONE = {
    "基隆市": "北部", "臺北市": "北部", "新北市": "北部", "桃園市": "北部",
    "新竹市": "竹苗", "新竹縣": "竹苗", "苗栗縣": "竹苗",
    "臺中市": "中部", "彰化縣": "中部", "南投縣": "中部",
    "雲林縣": "雲嘉南", "嘉義市": "雲嘉南", "嘉義縣": "雲嘉南", "臺南市": "雲嘉南",
    "高雄市": "高屏", "屏東縣": "高屏", "宜蘭縣": "宜蘭", "花蓮縣": "花東", "臺東縣": "花東",
    "澎湖縣": "澎湖", "金門縣": "金門", "連江縣": "馬祖",
}
POWER_LIGHT = {"G": "綠燈", "Y": "黃燈", "O": "橘燈", "R": "紅燈", "B": "黑燈"}


def _tw(s: str | None) -> str:
    return (s or "").replace("台", "臺").strip()


def _get(url: str, raw: bool = False, **q: str) -> Any:
    full = f"{url}?{urllib.parse.urlencode(q)}" if q else url
    req = urllib.request.Request(full, headers={"User-Agent": "home-hub/1.0"})
    with urllib.request.urlopen(req, timeout=40) as res:
        b = res.read()
    return b.decode("utf-8", "replace") if raw else json.loads(b.decode("utf-8-sig"))


def _text(s: str) -> str:
    s = re.sub(r"<br\s*/?>", "。", s, flags=re.I)
    s = html.unescape(re.sub(r"<[^>]+>", "", s))
    return re.sub(r"\s+", "", s)


def intensity_rank(s: str | None) -> float:
    """「3級」→3、「5弱」→5、「5強」→5.5"""
    m = re.match(r"(\d)\s*(級|弱|強)?", s or "")
    if not m:
        return 0
    return int(m.group(1)) + (0.5 if m.group(2) == "強" else 0)


def aqi_status(aqi: float | None) -> str | None:
    if aqi is None:
        return None
    for lim, name in ((50, "良好"), (100, "普通"), (150, "對敏感族群不健康"), (200, "對所有族群不健康"), (300, "非常不健康")):
        if aqi <= lim:
            return name
    return "危害"


class Alerts:
    def __init__(self, data_dir: Path, cwa_key: Callable[[], str | None], moenv_key: Callable[[], str | None]) -> None:
        self._path = data_dir / "alerts_cache.json"
        self._cwa_key = cwa_key
        self._moenv_key = moenv_key
        self.dgpa: list[dict[str, str]] = []  # [{city, text}]：有發布的縣市
        self.warnings: list[dict[str, Any]] = []  # 你家縣市目前的特報
        self.quake: dict[str, Any] | None = None  # 最近一次地震（你家附近的震度）
        self.power: dict[str, Any] | None = None
        self.aqf: list[dict[str, Any]] = []  # 你家空品區接下來幾天
        self.errors: dict[str, str] = {}
        self.updated: dict[str, float] = {}
        self._at: dict[str, float] = {}
        try:
            d = json.loads(self._path.read_text("utf-8"))
            for k in ("dgpa", "warnings", "quake", "power", "aqf", "updated", "_at"):
                if k in d:
                    setattr(self, k, d[k])
        except Exception:  # noqa: BLE001
            pass

    def _save(self) -> None:
        d = {k: getattr(self, k) for k in ("dgpa", "warnings", "quake", "power", "aqf", "updated", "_at")}
        tmp = self._path.with_suffix(".tmp")
        tmp.write_text(json.dumps(d, ensure_ascii=False), "utf-8")
        tmp.replace(self._path)

    def _due(self, what: str) -> bool:
        if time.time() - self._at.get(what, 0) < EVERY[what]:
            return False
        self._at[what] = time.time()
        return True

    def refresh(self, county: str | None, home: tuple[float, float] | None) -> bool:
        """需要的話更新（在背景執行緒跑）；有變回傳 True。"""
        before = json.dumps([self.dgpa, self.warnings, self.quake, self.power, self.aqf], ensure_ascii=False, default=str)
        county = _tw(county)
        jobs: list[tuple[str, Callable[[], None]]] = [("dayoff", self._read_dgpa), ("power", self._read_power)]
        if self._cwa_key() and county:
            jobs += [("warn", lambda: self._read_warn(county)), ("quake", lambda: self._read_quake(county, home))]
        if self._moenv_key() and county in AIR_ZONE:
            jobs.append(("aqf", lambda: self._read_aqf(AIR_ZONE[county])))
        ran = False
        for what, fn in jobs:
            if not self._due(what):
                continue
            ran = True
            try:
                fn()
                self.errors.pop(what, None)
                self.updated[what] = time.time()
            except Exception as err:  # noqa: BLE001
                msg = str(err)[:160]
                for k in (self._cwa_key(), self._moenv_key()):
                    if k:
                        msg = msg.replace(k, "…")
                self.errors[what] = msg
                self._at[what] = time.time() - EVERY[what] + 120  # 2 分鐘後再試
                _LOGGER.warning("讀取失敗（%s）：%s", what, msg)
        if ran:
            self._save()
        return json.dumps([self.dgpa, self.warnings, self.quake, self.power, self.aqf], ensure_ascii=False, default=str) != before

    # ---- 停班停課 ----
    def _read_dgpa(self) -> None:
        page = _get(DGPA, raw=True)
        i = page.find('id="Table"')
        if i < 0:
            raise RuntimeError("停班停課網頁的格式變了")
        body = page[i:page.find("</TABLE>", i) if "</TABLE>" in page[i:] else len(page)]
        rows = []
        for tr in re.findall(r"<TR[^>]*>(.*?)</TR>", body, flags=re.S | re.I):
            cells = re.findall(r"<TD[^>]*>(.*?)</TD>", tr, flags=re.S | re.I)
            if len(cells) >= 2:
                city, text = _text(cells[0]), _text(cells[1])
                if city and text:
                    rows.append({"city": city, "text": text})
        self.dgpa = rows

    def dayoff(self, county: str | None, town: str | None, day: date) -> dict[str, Any] | None:
        """那一天你家縣市（有分區的話看你家的區）停止上班／上課的情形。"""
        county, town = _tw(county), _tw(town)
        if not county:
            return None
        for r in self.dgpa:
            if not _tw(r["city"]).startswith(county):
                continue
            for s in re.split(r"[。；]", r["text"]):
                if "停止上班" not in s and "停止上課" not in s:
                    continue
                if not self._about(s, day):
                    continue
                areas = re.findall(r"[一-鿿]{1,4}區", s)
                if areas and town and town not in s:
                    continue  # 只有其他區停
                part = next((p for p in ("上午", "下午", "晚上", "夜間") if p in s), None)
                return {"text": s, "work": "停止上班" in s, "school": "停止上課" in s, "part": part, "full": "停止上班" in s and not part}
        return None

    @staticmethod
    def _about(s: str, day: date) -> bool:
        today = date.today()
        if day == today and ("今天" in s or "今日" in s):
            return True
        if day == today + timedelta(days=1) and ("明天" in s or "明日" in s):
            return True
        m = re.search(r"(\d{1,2})月(\d{1,2})日", s)
        return bool(m and (int(m.group(1)), int(m.group(2))) == (day.month, day.day))

    # ---- 天氣特報 ----
    def _cwa(self, ds: str, **q: str) -> Any:
        d = _get(CWA.format(ds=ds), Authorization=self._cwa_key() or "", format="JSON", **q)
        if str(d.get("success")) != "true":
            raise RuntimeError(f"{ds} 回傳失敗")
        return d["records"]

    def _read_warn(self, county: str) -> None:
        out = []
        for loc in self._cwa("W-C0033-001").get("location", []):
            if _tw(loc.get("locationName")) != county:
                continue
            for h in (loc.get("hazardConditions") or {}).get("hazards") or []:
                info, vt = h.get("info") or {}, h.get("validTime") or {}
                out.append({"name": f"{info.get('phenomena', '')}{info.get('significance', '')}", "phen": info.get("phenomena"),
                            "start": vt.get("startTime"), "end": vt.get("endTime")})
        self.warnings = out

    # ---- 地震 ----
    def _read_quake(self, county: str, home: tuple[float, float] | None) -> None:
        best = None
        for ds in ("E-A0015-001", "E-A0016-001"):
            for e in self._cwa(ds, limit="1").get("Earthquake", []):
                info = e.get("EarthquakeInfo") or {}
                t = info.get("OriginTime") or ""
                if best is None or t > best[0]:
                    best = (t, e)
        if not best:
            return
        t, e = best
        info = e.get("EarthquakeInfo") or {}
        area, near = None, None
        for sa in (e.get("Intensity") or {}).get("ShakingArea") or []:
            if _tw(sa.get("CountyName")) == county and intensity_rank(sa.get("AreaIntensity")) > intensity_rank(area):
                area = sa.get("AreaIntensity")
            if home:
                for st in sa.get("EqStation") or []:
                    try:
                        km = math.hypot((float(st["StationLatitude"]) - home[0]) * 111.2,
                                        (float(st["StationLongitude"]) - home[1]) * 111.2 * math.cos(math.radians(home[0])))
                    except (KeyError, TypeError, ValueError):
                        continue
                    if near is None or km < near["km"]:
                        near = {"name": st.get("StationName"), "km": round(km, 1), "intensity": st.get("SeismicIntensity")}
        here = area
        if near and near["km"] <= 15 and intensity_rank(near["intensity"]) > intensity_rank(here):
            here = near["intensity"]
        self.quake = {
            "no": e.get("EarthquakeNo"), "time": t, "text": e.get("ReportContent"),
            "mag": ((info.get("EarthquakeMagnitude") or {}).get("MagnitudeValue")), "depth": info.get("FocalDepth"),
            "where": ((info.get("Epicenter") or {}).get("Location") or "").replace("  ", " "),
            "county_intensity": area, "station": near, "here": here, "rank": intensity_rank(here),
        }

    # ---- 供電 ----
    def _read_power(self) -> None:
        recs = _get(TAIPOWER).get("records") or []
        d: dict[str, Any] = {}
        for r in recs:
            d.update(r)
        rate = d.get("fore_peak_resv_rate")
        ind = d.get("fore_peak_resv_indicator")
        self.power = {
            "rate": float(rate) if rate not in (None, "") else None, "light": ind, "light_name": POWER_LIGHT.get(ind or "", ind),
            "peak": d.get("fore_peak_hour_range"), "load": d.get("curr_load"), "util": d.get("curr_util_rate"),
            "published": d.get("publish_time"),
        }

    # ---- 空品預報 ----
    def _read_aqf(self, zone: str) -> None:
        d = _get(AQF, api_key=self._moenv_key() or "", format="json", limit="300")
        rows = d.get("records", d) if isinstance(d, dict) else d
        days: dict[str, dict[str, Any]] = {}
        for r in rows if isinstance(rows, list) else []:
            if r.get("area") != zone or r.get("timeperiod") != "全日":
                continue
            try:
                aqi = float(r.get("aqi"))
            except (TypeError, ValueError):
                continue
            k = r.get("forecastdate")
            if k in days and (r.get("publishtime") or "") < days[k]["published"]:
                continue  # 同一天有新舊好幾版：用最新發布的
            days[k] = {"date": k, "aqi": aqi, "status": aqi_status(aqi), "pollutant": r.get("majorpollutant") or None,
                       "zone": zone, "published": r.get("publishtime") or ""}
        self.aqf = [days[k] for k in sorted(days)]

    def air_on(self, day: date) -> dict[str, Any] | None:
        return next((x for x in self.aqf if x["date"] == day.isoformat()), None)

    def report(self, county: str | None, town: str | None) -> dict[str, Any]:
        today = date.today()
        return {
            "county": county, "town": town,
            "dayoff": {"today": self.dayoff(county, town, today), "tomorrow": self.dayoff(county, town, today + timedelta(days=1))},
            "dgpa_any": bool(self.dgpa),
            "warnings": self.warnings, "quake": self.quake, "power": self.power,
            "air": [x for x in self.aqf if x["date"] >= today.isoformat()][:4],
            "air_key": bool(self._moenv_key()), "cwa_key": bool(self._cwa_key()),
            "errors": self.errors, "updated": self.updated,
        }


def quake_age_h(q: dict[str, Any] | None) -> float | None:
    if not q or not q.get("time"):
        return None
    try:
        return (datetime.now().astimezone() - datetime.fromisoformat(q["time"])).total_seconds() / 3600
    except ValueError:
        return None

"""生活資訊：新北市垃圾車、停水、停電（政府開放資料，不用金鑰）。

- 垃圾車：新北市環保局的「垃圾車路線」（表定時間、哪幾天收一般垃圾／回收／廚餘）和「垃圾清運車輛所在位置」（每 2 分鐘更新）。
  路線一天下載一次全部，在樹莓派上找出家附近的清運點；收運前後才每分鐘查一次車子在哪。
- 停水：台灣自來水公司「停水資訊」、臺北自來水事業處「停水資訊（大臺北地區）」。
- 停電：台電「計畫性工作停電資料」（每天更新，列到路名）。
- 全部是下載整份資料、在樹莓派上比對行政區和路名，不會送出家裡的位置或地址。
"""

from __future__ import annotations

import asyncio
import csv
import io
import json
import logging
import math
import re
import time
import urllib.request
import zipfile
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any, Callable

_LOGGER = logging.getLogger(__name__)

ROUTES_URL = "https://data.ntpc.gov.tw/api/datasets/edc3ad26-8ae7-4916-a00b-bc6048d19bf8/json?page={page}&size=1000"
TRUCKS_URL = "https://data.ntpc.gov.tw/api/datasets/28ab4122-60e1-4065-98e5-abccb69aaca6/json?page={page}&size=1000"
TWC_URL = "https://web.water.gov.tw/wateroffapi/openData/export/json"
TPW_URL = "https://webs.water.gov.taipei/apps/outage.asmx/outageOpenData"
POWER_URL = "https://service.taipower.com.tw/data/opendata/apply/file/d077004/001.zip"

DAYS = ("monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday")  # date.weekday() 的順序
KINDS = (("garbage", "一般垃圾"), ("recycling", "資源回收"), ("foodscraps", "廚餘"))
NEAR_M = 400  # 清運點：列出多遠以內的
ROUTES_EVERY = 24 * 3600
OUTAGE_EVERY = 3 * 3600
TRUCK_EVERY = 60
WINDOW_BEFORE = 45 * 60  # 表定時間前多久開始看車子
WINDOW_AFTER = 40 * 60
NOTIFY_STOPS = 3  # 剩幾站時通知


def _get(url: str, timeout: int = 60) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "home-hub/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as res:
        return res.read()


def _pages(url: str) -> list[dict]:
    rows: list[dict] = []
    for page in range(200):
        r = json.loads(_get(url.format(page=page)))
        if not r:
            break
        rows += r
        if len(r) < 1000:
            break
    return rows


def _f(v: Any) -> float | None:
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _hm(s: str) -> int | None:
    m = re.match(r"(\d{1,2}):(\d{2})", s or "")
    return int(m.group(1)) * 60 + int(m.group(2)) if m else None


class LocalInfo:
    def __init__(self, data_dir: Path, settings: Callable[[], dict], place: Callable[[], tuple[str | None, str | None]],
                 notify: Callable[[str, str], None]) -> None:
        self.dir = data_dir
        self._settings = settings  # store.data["settings"]["local"]
        self._place = place  # (縣市, 鄉鎮區)
        self._notify = notify
        self.home: tuple[float, float] | None = None
        self.lines: dict[str, list[dict]] = {}  # 家附近的路線：lineid → 每一站（照清運序）
        self.stops: list[dict] = []  # 家附近的清運點（近到遠）
        self.truck: dict | None = None
        self.outages: list[dict] = []
        self.errors: dict[str, str] = {}
        self.updated: dict[str, float] = {}
        self._at: dict[str, float] = {}
        self._notified: set[str] = set()
        try:
            self._notified = set(json.loads((data_dir / "local_notified.json").read_text("utf-8")))
        except Exception:  # noqa: BLE001
            pass
        self.arrivals: dict[str, list[dict]] = {}  # 每個清運點最近幾次車子實際到的時間
        try:
            self.arrivals = json.loads((data_dir / "garbage_arrivals.json").read_text("utf-8"))
        except Exception:  # noqa: BLE001
            pass
        try:
            cache = json.loads((data_dir / "garbage_lines.json").read_text("utf-8"))
            self.lines = cache["lines"]
            self._at["routes_home"] = 0
        except Exception:  # noqa: BLE001
            pass

    def _mark(self, key: str) -> None:
        """通知過了就記下來（重開也不重複通知）。"""
        self._notified.add(key)
        keep = sorted(self._notified)[-300:]
        try:
            (self.dir / "local_notified.json").write_text(json.dumps(keep), "utf-8")
        except OSError:
            pass

    def _due(self, what: str, every: float) -> bool:
        if time.time() - self._at.get(what, 0) < every:
            return False
        self._at[what] = time.time()
        return True

    def _m(self, lat: float, lon: float) -> float:
        hl, ho = self.home  # type: ignore[misc]
        return math.hypot((lat - hl) * 111200, (lon - ho) * 111200 * math.cos(math.radians(hl)))

    # ---- 設定 ----
    @property
    def cfg(self) -> dict:
        return self._settings()

    def dump(self) -> dict[str, Any]:
        """重開後要先顯示的資料（之後會再重新查）。"""
        return {"outages": self.outages, "truck": self.truck, "updated": self.updated, "errors": self.errors,
                "stops": self.stops, "home": list(self.home) if self.home else None}

    def load(self, d: dict[str, Any]) -> None:
        self.outages = d.get("outages") or []
        self.truck = d.get("truck")
        self.updated = d.get("updated") or {}
        self.errors = d.get("errors") or {}
        self.stops = d.get("stops") or []
        # home 留空：第一次更新時會照現在的位置重新算附近的清運點

    def my_stop(self) -> dict | None:
        """選的清運點；沒選就用最近的。"""
        sel = self.cfg.get("stop") or {}
        for s in self.lines.get(str(sel.get("lineid")), []):
            if str(s["rank"]) == str(sel.get("rank")):
                return s
        return self.stops[0] if self.stops else None

    # ---- 更新 ----
    async def refresh(self, home: tuple[float, float] | None) -> bool:
        changed = False
        if home and home != self.home:
            self.home = home
            self._at.pop("routes", None)
            self._near()
        county, _town = self._place()
        if home and county == "新北市" and self._due("routes", ROUTES_EVERY):
            changed |= await self._run("routes", self._routes)
        if self._due("outages", OUTAGE_EVERY):
            changed |= await self._run("outages", self._outages)
        if self._truck_window() and self._due("truck", TRUCK_EVERY):
            changed |= await self._run("truck", self._trucks)
        elif not self._truck_window() and self.truck:
            self.truck = None
            changed = True
        return changed

    async def _run(self, what: str, fn: Callable[[], None]) -> bool:
        try:
            await asyncio.to_thread(fn)
            self.errors.pop(what, None)
            self.updated[what] = time.time()
            return True
        except Exception as err:  # noqa: BLE001
            self.errors[what] = str(err)[:160]
            self._at[what] = time.time() - {"routes": ROUTES_EVERY, "outages": OUTAGE_EVERY}.get(what, 0) + 600  # 10 分鐘後再試
            _LOGGER.warning("生活資訊 %s 失敗：%s", what, err)
            return False

    def _routes(self) -> None:
        rows = _pages(ROUTES_URL)
        if not rows:
            raise RuntimeError("新北市的垃圾車路線下載回來是空的")
        near_lines = set()
        for r in rows:
            lat, lon = _f(r.get("latitude")), _f(r.get("longitude"))
            if lat and lon and self._m(lat, lon) <= NEAR_M:
                near_lines.add(r["lineid"])
        lines: dict[str, list[dict]] = {}
        for r in rows:
            if r["lineid"] not in near_lines:
                continue
            lat, lon = _f(r.get("latitude")), _f(r.get("longitude"))
            lines.setdefault(r["lineid"], []).append({
                "lineid": r["lineid"], "line": r.get("linename"), "rank": int(r["rank"]), "name": r.get("name"),
                "city": r.get("city"), "village": r.get("village"), "lat": lat, "lon": lon, "time": r.get("time"),
                "memo": r.get("memo") or "",
                "days": {k: [i for i, d in enumerate(DAYS) if r.get(k + d) == "Y"] for k, _ in KINDS},
            })
        for v in lines.values():
            v.sort(key=lambda s: s["rank"])
        self.lines = lines
        if lines:  # 沒找到就不要蓋掉上次存的
            (self.dir / "garbage_lines.json").write_text(json.dumps({"lines": lines}, ensure_ascii=False), "utf-8")
        self._near()
        _LOGGER.info("垃圾車：家附近 %d 條路線、%d 個清運點", len(lines), len(self.stops))

    def _near(self) -> None:
        if not self.home:
            return
        out = []
        for line in self.lines.values():
            for s in line:
                if s["lat"] and s["lon"]:
                    d = self._m(s["lat"], s["lon"])
                    if d <= NEAR_M:
                        out.append({**s, "m": round(d)})
        out.sort(key=lambda s: s["m"])
        self.stops = out

    # ---- 垃圾車 ----
    def today_kinds(self, stop: dict, day: date) -> list[str]:
        return [label for k, label in KINDS if day.weekday() in stop["days"].get(k, [])]

    def usual(self, s: dict) -> int | None:
        """這個清運點最近幾次實際到的時間（第幾分鐘，取中間值）；還沒有紀錄就回傳 None。"""
        got = sorted(x["m"] for x in self.arrivals.get(f"{s['lineid']}:{s['rank']}", [])[-7:])
        return got[len(got) // 2] if got else None

    def _arrived(self, s: dict, at: datetime) -> None:
        key = f"{s['lineid']}:{s['rank']}"
        rows = [x for x in self.arrivals.get(key, []) if x["d"] != at.date().isoformat()]
        rows.append({"d": at.date().isoformat(), "m": at.hour * 60 + at.minute})
        self.arrivals[key] = rows[-10:]
        try:
            (self.dir / "garbage_arrivals.json").write_text(json.dumps(self.arrivals), "utf-8")
        except OSError:
            pass

    def _truck_window(self) -> bool:
        s = self.my_stop()
        if not s or not self.today_kinds(s, date.today()):
            return False
        t = _hm(s["time"])
        if t is None:
            return False
        now = datetime.now()
        sched = now.replace(hour=t // 60, minute=t % 60, second=0, microsecond=0)
        early = min(0, (self.usual(s) or t) - t) * 60  # 平常比表定早到的話，提早開始看
        return -WINDOW_BEFORE + early <= (now - sched).total_seconds() <= WINDOW_AFTER

    def _trucks(self) -> None:
        s = self.my_stop()
        if not s:
            return
        route = self.lines.get(s["lineid"], [])
        rows = [r for r in _pages(TRUCKS_URL) if r.get("lineid") == s["lineid"]]
        best = None
        for r in rows:
            lat, lon = _f(r.get("latitude")), _f(r.get("longitude"))
            if not (lat and lon and route):
                continue
            at = datetime.strptime(r["time"], "%Y/%m/%d %H:%M:%S") if r.get("time") else None
            if at and (datetime.now() - at).total_seconds() > 15 * 60:
                continue  # 太舊的位置
            near = min(route, key=lambda x: math.hypot((x["lat"] or 0) - lat, (x["lon"] or 0) - lon))
            ahead = s["rank"] - near["rank"]
            dist = round(self._m(lat, lon))
            info = {"car": r.get("car"), "at": r.get("time"), "location": r.get("location"), "at_stop": near["name"],
                    "stops": ahead, "m": dist}
            t_me, t_it = _hm(s["time"]), _hm(near["time"])
            if t_me is not None and t_it is not None and ahead >= 0:
                eta = max(0, t_me - t_it)
                usual, now = self.usual(s), datetime.now()
                if usual is not None and ahead > 0:  # 時刻表常常不準：參考最近幾次實際到的時間
                    eta = min(eta, max(1, usual - (now.hour * 60 + now.minute)))
                info["eta_min"] = eta
            if best is None or (ahead >= 0 and (best["stops"] < 0 or ahead < best["stops"])):
                best = info
        prev = self.truck or {}
        if best and best["stops"] == 0 and prev.get("stops", 1) != 0 and best.get("at"):
            self._arrived(s, datetime.strptime(best["at"], "%Y/%m/%d %H:%M:%S"))  # 第一次看到車子到這一站
        self.truck = best or {"none": True}
        key = f"{date.today()}:{s['lineid']}:{s['rank']}"
        if best and 0 <= best["stops"] <= NOTIFY_STOPS and key not in self._notified and self.cfg.get("garbage_notify", True):
            self._mark(key)
            eta = f"，大約 {best['eta_min']} 分鐘" if best.get("eta_min") is not None else ""
            self._notify("垃圾車快到了", f"還有 {best['stops']} 站到「{s['name']}」{eta}（現在在{best['at_stop']}附近）")

    # ---- 停水、停電 ----
    def _outages(self) -> None:
        county, town = self._place()
        items: list[dict] = []
        errs = []
        for name, fn in (("water", self._twc), ("taipei_water", self._tpw), ("power", self._power)):
            try:
                items += fn(county, town)
            except Exception as err:  # noqa: BLE001
                errs.append(f"{name}：{str(err)[:80]}")
        if len(errs) == 3:
            raise RuntimeError("；".join(errs))
        if errs:
            self.errors["outages_part"] = "；".join(errs)
            self._at["outages"] = time.time() - OUTAGE_EVERY + 600  # 有來源失敗：10 分鐘後再試
        else:
            self.errors.pop("outages_part", None)
        now = datetime.now()
        items = [x for x in items if x["end"] >= now.isoformat(timespec="minutes")]
        items.sort(key=lambda x: x["start"])
        self.outages = items
        self._match_notify()

    def roads(self) -> list[str]:
        return [r.strip() for r in self.cfg.get("roads") or [] if r.strip()]

    def _hit(self, text: str) -> str:
        """停水／停電範圍有寫到你家的路：'road'；只是同一區：'town'。"""
        t = (text or "").replace("台", "臺")
        return "road" if any(r.replace("台", "臺") in t for r in self.roads()) else "town"

    def _twc(self, county: str | None, town: str | None) -> list[dict]:
        out = []
        for r in json.loads(_get(TWC_URL)):
            if town and town not in (r.get("影響行政區") or "") + (r.get("停水地區") or ""):
                continue
            area = r.get("停水地區") or ""
            hit = self._hit(area)
            out.append({"kind": "water", "src": "台灣自來水公司", "start": r["案件日期時間"][:16].replace(" ", "T"),
                        "end": (r.get("恢復日期時間") or r["案件日期時間"])[:16].replace(" ", "T"), "area": area[:600],
                        "reason": (r.get("停水原因") or "").strip("[]"), "hit": hit, "id": f"twc{r.get('案件編號')}",
                        "pressure": bool(r.get("降壓地區"))})
        return out

    def _tpw(self, county: str | None, town: str | None) -> list[dict]:
        out = []
        for r in json.loads(_get(TPW_URL)):
            area = r.get("SW_Area") or r.get("Description") or ""
            if town and town not in area:
                continue
            m = re.findall(r"(\d+)年(\d+)月(\d+)日", r.get("Date") or "")
            tm = re.findall(r"(\d{1,2}):(\d{2})", r.get("Time") or "")
            if not m:
                continue
            d0 = date(int(m[0][0]) + 1911, int(m[0][1]), int(m[0][2]))
            d1 = date(int(m[-1][0]) + 1911, int(m[-1][1]), int(m[-1][2]))
            h0 = f"{int(tm[0][0]):02d}:{tm[0][1]}" if tm else "00:00"
            h1 = f"{int(tm[-1][0]):02d}:{tm[-1][1]}" if len(tm) > 1 else "23:59"
            out.append({"kind": "water", "src": "臺北自來水事業處", "start": f"{d0}T{h0}", "end": f"{d1}T{h1}", "area": area[:600],
                        "reason": "", "hit": self._hit(area), "id": f"tpw{r.get('SW_No')}"})
        return out

    def _power(self, county: str | None, town: str | None) -> list[dict]:
        z = zipfile.ZipFile(io.BytesIO(_get(POWER_URL, timeout=90)))
        groups: dict[tuple, dict] = {}
        for name in z.namelist():
            if not name[0].isdigit():
                continue
            for r in csv.DictReader(io.StringIO(z.read(name).decode("utf-8-sig"))):
                area = r.get("停電範圍") or ""
                if town and town not in area:
                    continue
                for col in ("第一次停電時間", "第二次停電時間"):
                    m = re.match(r"(\d{4})/(\d{2})/(\d{2}) (\d{2}:\d{2})~(\d{2}:\d{2})", r.get(col) or "")
                    if not m:
                        continue
                    y, mo, d, a, b = m.groups()
                    key = (r.get("請求號數"), y, mo, d, a, b)
                    g = groups.setdefault(key, {"kind": "power", "src": "台電", "start": f"{y}-{mo}-{d}T{a}", "end": f"{y}-{mo}-{d}T{b}",
                                                "areas": [], "reason": r.get("工作概述") or "", "id": f"tp{key[0]}{y}{mo}{d}{a}"})
                    g["areas"].append(area.replace(county or "", "").replace(town or "", "") or area)
        out = []
        for g in groups.values():
            areas = sorted(set(g.pop("areas")))
            g["area"] = f"{town or ''}：" + "、".join(areas)
            g["hit"] = self._hit(g["area"])
            out.append(g)
        return out

    def _match_notify(self) -> None:
        if not self.cfg.get("outage_notify", True):
            return
        for x in self.outages:
            if x["hit"] == "road" and x["id"] not in self._notified:
                self._mark(x["id"])
                what = "停電" if x["kind"] == "power" else "停水"
                t0 = datetime.fromisoformat(x["start"])
                self._notify(f"你家附近要{what}", f"{t0.month}/{t0.day} {t0:%H:%M}～{x['end'][11:16]}：{x['area'][:120]}")

    def recheck(self) -> None:
        """路名改了：馬上重新比對。"""
        for x in self.outages:
            x["hit"] = self._hit(x["area"])
        self._match_notify()

    # ---- 給前端 ----
    def report(self) -> dict:
        s = self.my_stop()
        today = date.today()
        garbage = None
        if s:
            nxt = []
            for i in range(8):
                d = today + timedelta(days=i)
                k = self.today_kinds(s, d)
                if k:
                    nxt.append({"date": d.isoformat(), "kinds": k})
                if len(nxt) >= 3:
                    break
            garbage = {"stop": {k: s[k] for k in ("lineid", "line", "rank", "name", "time", "memo", "days")},
                       "today": self.today_kinds(s, today), "next": nxt, "truck": self.truck, "watching": self._truck_window()}
            u, t = self.usual(s), _hm(s["time"])
            if u is not None and t is not None and abs(u - t) >= 2:
                garbage["usual"] = f"{u // 60:02d}:{u % 60:02d}"  # 最近實際到的時間（和表定差 2 分鐘以上才給）
        horizon = (datetime.now() + timedelta(days=14)).isoformat(timespec="minutes")
        return {
            "garbage": garbage,
            "stops": [{k: x[k] for k in ("lineid", "line", "rank", "name", "time", "m", "days")} for x in self.stops[:25]],
            "outages": [x for x in self.outages if x["start"] <= horizon][:30],
            "roads": self.roads(),
            "place": "".join(p or "" for p in self._place()) or None,
            "errors": self.errors, "updated": self.updated,
            "garbage_supported": self._place()[0] == "新北市",
            "garbage_notify": self.cfg.get("garbage_notify", True), "outage_notify": self.cfg.get("outage_notify", True),
            "truck_rush": self.cfg.get("truck_rush", True),
            "truck_rush_style": self.cfg.get("truck_rush_style", "random"),
            "fun": self.cfg.get("fun", True),
        }

"""公車：新北市交通局的開放資料（不用金鑰）。

- 路線清單、每條路線的站牌：一天下載一次，在樹莓派上找出離家最近的站。
- 預估到站時間：公車動態資訊中心每 20 秒左右更新的整份檔案（全新北市，約 200 KB），
  營運時間內每分鐘下載一次，在樹莓派上挑出要的站。
  （新北市開放資料平台上同名的那份資料集是不會動的舊資料，不能用。）
- 查站牌時送出去的只有路線代碼；家的位置、選的站牌都只在樹莓派上。
"""

from __future__ import annotations

import gzip
import json
import logging
import time
import urllib.parse
import urllib.request
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Callable

_LOGGER = logging.getLogger(__name__)

API = "https://data.ntpc.gov.tw/api/datasets/{id}/json?page={page}&size=1000"
ROUTES = "0ee4e6bf-cee6-4ec8-8fe1-71f544015127"
STOPS = "34b402a8-53d9-483d-9406-24a682c2d6dc"
ESTIMATE_URL = "https://tcgbusfs.blob.core.windows.net/ntpcbus/GetEstimateTime.gz"
NEAR_M = 800  # 多遠以內的站牌可以選
STATIC_EVERY = 24 * 3600
LIVE_EVERY = 60
IDLE_EVERY = 600  # 收班後


def _get(dataset: str, **q: str) -> list[dict]:
    rows: list[dict] = []
    for page in range(60):
        url = API.format(id=dataset, page=page) + "".join(f"&{k}={urllib.parse.quote(v)}" for k, v in q.items())
        req = urllib.request.Request(url, headers={"User-Agent": "home-hub/1.0"})
        with urllib.request.urlopen(req, timeout=30) as res:
            r = json.loads(res.read() or b"[]")
        rows += r
        if len(r) < 1000:
            break
    return rows


def _hm(s: str) -> int | None:
    s = (s or "").strip()
    return int(s[:2]) * 60 + int(s[2:]) if len(s) == 4 and s.isdigit() else None


def _variant(route: str, name: str) -> bool:
    """「橘18」也包含「橘18福隆路」，但不包含「橘18A」以外的別條（例如「橘181」）。"""
    if route == name:
        return True
    return route.startswith(name) and not route[len(name)].isascii()


class Bus:
    def __init__(self, data_dir: Path, cfg: Callable[[], dict]) -> None:
        self.path = data_dir / "bus_routes.json"
        self._cfg = cfg  # settings.local.bus
        self.routes: list[dict] = []  # 設定的路線（含站牌）
        self.for_names: list[str] = []  # 上面那份是照哪些名字抓的
        self.missing: list[str] = []
        self.live: dict[str, int] = {}  # 站牌代碼 → 秒（負的是狀態碼）
        self.live_at = 0.0
        self.static_at = 0.0
        self.error: str | None = None
        self._tried = 0.0
        try:
            d = json.loads(self.path.read_text("utf-8"))
            self.routes, self.for_names, self.missing = d["routes"], d["names"], d.get("missing", [])
            self.static_at = d.get("at", 0)
        except Exception:  # noqa: BLE001
            pass

    @property
    def names(self) -> list[str]:
        return list(self._cfg().get("routes") or [])

    def due(self) -> str | None:
        """現在該做什麼：下載路線（static）、查到站時間（live），或不用做。"""
        names = self.names
        if not names:
            return None
        now = time.time()
        if now - self._tried < 20:
            return None
        stale = any("firsts" not in r for r in self.routes)  # 舊版存的沒有首班車
        if names != self.for_names or now - self.static_at > STATIC_EVERY or stale:
            return "static"
        if now - self.live_at >= (LIVE_EVERY if self._running() else IDLE_EVERY):
            return "live"
        return None

    def _running(self) -> bool:
        t = datetime.now()
        m = t.hour * 60 + t.minute
        spans = [(a, b) for r in self.routes for a, b in [(r.get("first"), r.get("last"))] if a is not None and b is not None]
        if not spans:
            return 5 * 60 + 30 <= m
        return min(a for a, _ in spans) - 20 <= m <= max(b for _, b in spans) + 120

    # ---- 下載（在背景執行緒跑）----
    def fetch(self, what: str) -> None:
        self._tried = time.time()
        try:
            if what == "static":
                self._static()
            self._live()
            self.error = None
        except Exception as err:  # noqa: BLE001
            self.error = f"{type(err).__name__}: {err}"[:160]
            _LOGGER.warning("公車 %s 失敗：%s", what, self.error)

    def _static(self) -> None:
        names = self.names
        rows = _get(ROUTES)
        if not rows:
            raise RuntimeError("路線清單下載回來是空的")
        routes, missing = [], []
        for n in names:
            hit = [r for r in rows if _variant(r.get("namezh") or "", n)]
            if not hit:
                missing.append(n)
            for r in sorted(hit, key=lambda r: len(r["namezh"])):
                firsts = [_hm(r.get(k, "")) for k in ("gofirstbustime", "backfirstbustime", "holidaygofirstbustime")]
                lasts = [_hm(r.get(k, "")) for k in ("golastbustime", "backlastbustime", "holidaygolastbustime")]
                stops = [{"id": s["id"], "name": s["namezh"], "gb": str(s["goback"]), "seq": int(s["seqno"]),
                          "lat": float(s["latitude"]), "lon": float(s["longitude"])}
                         for s in _get(STOPS, routeid=r["id"])]
                routes.append({"id": r["id"], "name": r["namezh"], "from": r.get("departurezh") or "", "to": r.get("destinationzh") or "",
                               "first": min((x for x in firsts if x is not None), default=None),
                               "last": max((x for x in lasts if x is not None), default=None),
                               # 首班車（從起點發車）：平日／假日 × 去程 0／回程 1
                               "firsts": {"0": _hm(r.get("gofirstbustime", "")), "1": _hm(r.get("backfirstbustime", "")),
                                          "h0": _hm(r.get("holidaygofirstbustime", "")), "h1": _hm(r.get("holidaybackfirstbustime", ""))},
                               "stops": sorted(stops, key=lambda s: s["seq"])})
        self.routes, self.for_names, self.missing, self.static_at = routes, names, missing, time.time()
        self.path.write_text(json.dumps({"routes": routes, "names": names, "missing": missing, "at": self.static_at}, ensure_ascii=False), "utf-8")
        _LOGGER.info("公車：%d 條路線", len(routes))

    def _live(self) -> None:
        req = urllib.request.Request(ESTIMATE_URL, headers={"User-Agent": "home-hub/1.0"})
        with urllib.request.urlopen(req, timeout=30) as res:
            raw = res.read()
        if raw[:2] == b"\x1f\x8b":
            raw = gzip.decompress(raw)
        want = {str(r["id"]) for r in self.routes}
        live: dict[str, int] = {}
        for e in json.loads(raw).get("BusInfo") or []:
            if str(e.get("RouteID")) in want:
                try:
                    live[str(e["StopID"])] = int(e["EstimateTime"])
                except (KeyError, ValueError):
                    pass
        if not live and want:
            raise RuntimeError("到站時間的檔案裡沒有這些路線")
        self.live, self.live_at = live, time.time()

    @staticmethod
    def next_first(r: dict, gb: str, now: datetime | None = None) -> str | None:
        """下一班「首班車」的發車時間 HH:MM（中午以後算明天的）。假日用假日班表。"""
        now = now or datetime.now()
        day = now if now.hour < 12 else now + timedelta(days=1)
        f = r.get("firsts") or {}
        m = f.get(("h" if day.weekday() >= 5 else "") + gb)
        if m is None:
            m = f.get(gb)
        return f"{m // 60:02d}:{m % 60:02d}" if m is not None else None

    # ---- 給前端 ----
    def report(self, dist: Callable[[float, float], float] | None) -> dict[str, Any]:
        pick = self._cfg().get("pick") or {}
        fresh = time.time() - self.live_at < 180
        out = []
        for r in self.routes if self.for_names == self.names else []:
            dirs = []
            for gb in sorted({s["gb"] for s in r["stops"]}):
                near = []
                if dist:
                    near = sorted(({"id": s["id"], "name": s["name"], "m": round(dist(s["lat"], s["lon"]))}
                                   for s in r["stops"] if s["gb"] == gb), key=lambda s: s["m"])
                    near = [s for s in near if s["m"] <= NEAR_M][:8]
                if not near:
                    continue
                chosen = pick.get(f"{r['id']}:{gb}")
                stop = None if chosen == "off" else next((s for s in near if s["id"] == chosen), near[0])
                sec = self.live.get(stop["id"]) if stop and fresh else None
                dirs.append({"gb": gb, "to": r["from"] if gb == "1" else r["to"], "stop": stop, "sec": sec, "near": near,
                             "first": self.next_first(r, gb)})
            if dirs:
                out.append({"id": r["id"], "name": r["name"], "dirs": dirs,
                            "base": next((n for n in self.names if _variant(r["name"], n)), r["name"])})
        return {"names": self.names, "routes": out, "missing": self.missing if self.for_names == self.names else [],
                "error": self.error, "updated": self.live_at or None}

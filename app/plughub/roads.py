"""家附近的街道（畫小地圖用）：OpenStreetMap 的資料，透過 Overpass API 下載。

查詢時只送出行政區的名字（例如「蘆洲區」），下載整個區的道路存在樹莓派上，
再在樹莓派上切出家附近的那一塊；不會送出家的位置。一個月更新一次。
地圖資料 © OpenStreetMap 貢獻者（ODbL）。
"""

from __future__ import annotations

import json
import logging
import time
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Callable

_LOGGER = logging.getLogger(__name__)

OVERPASS = ("https://overpass-api.de/api/interpreter", "https://overpass.private.coffee/api/interpreter")  # 常常很忙，輪流試
KINDS = "motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|pedestrian|service"
EVERY = 30 * 24 * 3600
RETRY = 900


def _ask(query: str) -> list[dict]:
    last: Exception | None = None
    for attempt in range(4):
        url = OVERPASS[attempt % len(OVERPASS)]
        try:
            req = urllib.request.Request(url, data=urllib.parse.urlencode({"data": query}).encode(), headers={"User-Agent": "home-hub/1.0"})
            with urllib.request.urlopen(req, timeout=150) as res:
                return json.loads(res.read()).get("elements") or []
        except Exception as err:  # noqa: BLE001
            last = err
            time.sleep(5)
    raise last  # type: ignore[misc]


class Roads:
    def __init__(self, data_dir: Path) -> None:
        self.path = data_dir / "roads.json"
        self.town = ""
        self.at = 0.0
        self.ways: list[dict] = []  # {"k": 等級, "n": 路名, "p": [[緯度, 經度], …]}
        self.error: str | None = None
        self._tried = 0.0
        try:
            d = json.loads(self.path.read_text("utf-8"))
            self.town, self.at, self.ways = d["town"], d["at"], d["ways"]
        except Exception:  # noqa: BLE001
            pass

    def due(self, town: str | None) -> bool:
        if not town or time.time() - self._tried < RETRY:
            return False
        return town != self.town or time.time() - self.at > EVERY

    def fetch(self, town: str) -> None:
        """在背景執行緒跑。"""
        self._tried = time.time()
        try:
            name = town.replace('"', "")
            rels = _ask(f'[out:json][timeout:60];rel["name"="{name}"]["boundary"="administrative"];out ids;')
            if not rels:
                raise RuntimeError(f"OpenStreetMap 上找不到「{town}」")
            area = 3600000000 + int(rels[0]["id"])
            rows = _ask(f'[out:json][timeout:120];way["highway"~"^({KINDS})(_link)?$"](area:{area});out geom qt;')
            ways = [{"k": (e["tags"].get("highway") or "").replace("_link", ""), "n": e["tags"].get("name") or "",
                     "p": [[round(p["lat"], 6), round(p["lon"], 6)] for p in e.get("geometry") or []]}
                    for e in rows if len(e.get("geometry") or []) >= 2]
            if not ways:
                raise RuntimeError("道路資料下載回來是空的")
            self.town, self.at, self.ways, self.error = town, time.time(), ways, None
            self.path.write_text(json.dumps({"town": town, "at": self.at, "ways": ways}, ensure_ascii=False), "utf-8")
            _LOGGER.info("街道：%s %d 條", town, len(ways))
        except Exception as err:  # noqa: BLE001
            self.error = f"{type(err).__name__}: {err}"[:160]
            _LOGGER.warning("街道下載失敗：%s", self.error)

    def near(self, xy: Callable[[float, float], tuple[float, float]], radius: float) -> list[dict]:
        """家附近的路，座標換成「離家往東、往北幾公尺」。"""
        out = []
        for w in self.ways:
            pts = [xy(lat, lon) for lat, lon in w["p"]]
            if any(abs(x) <= radius and abs(y) <= radius for x, y in pts):
                out.append({"k": w["k"], "n": w["n"], "p": [[round(x), round(y)] for x, y in pts]})
        return out

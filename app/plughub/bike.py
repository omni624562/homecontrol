"""YouBike：新北市交通局的「YouBike2.0 即時資訊」（不用金鑰）。

每 2 分鐘下載整份新北市的站點，在樹莓派上找出離家最近的幾站；不會送出家的位置。
"""

from __future__ import annotations

import json
import logging
import time
import urllib.request
from typing import Any, Callable

_LOGGER = logging.getLogger(__name__)

URL = "https://data.ntpc.gov.tw/api/datasets/010e5b15-3823-4b20-b401-b1cf000550c5/json?page={page}&size=1000"
EVERY = 120
NEAR_M = 600
NEAR_MAX = 6


def _int(v: Any) -> int:
    try:
        return int(v)
    except (TypeError, ValueError):
        return 0


class Bike:
    def __init__(self, cfg: Callable[[], dict]) -> None:
        self._cfg = cfg  # settings.local.bike
        self.rows: list[dict] = []
        self.at = 0.0
        self.error: str | None = None
        self._tried = 0.0

    def due(self) -> bool:
        return self._cfg().get("show", True) and time.time() - max(self.at, self._tried) >= EVERY

    def fetch(self) -> None:
        """在背景執行緒跑。"""
        self._tried = time.time() - EVERY + 30  # 失敗的話 30 秒後再試
        try:
            rows: list[dict] = []
            for page in range(10):
                req = urllib.request.Request(URL.format(page=page), headers={"User-Agent": "home-hub/1.0"})
                with urllib.request.urlopen(req, timeout=30) as res:
                    r = json.loads(res.read() or b"[]")
                rows += r
                if len(r) < 1000:
                    break
            if not rows:
                raise RuntimeError("下載回來是空的")
            self.rows = [{"sno": r["sno"], "name": (r.get("sna") or "").replace("YouBike2.0_", ""), "lat": float(r["lat"]), "lon": float(r["lng"]),
                          "bikes": _int(r.get("sbi_quantity")), "ebikes": _int(r.get("eyb_quantity")), "docks": _int(r.get("bemp")),
                          "ok": str(r.get("act")) == "1", "at": r.get("mday") or ""} for r in rows if r.get("lat") and r.get("lng")]
            self.at, self.error = time.time(), None
        except Exception as err:  # noqa: BLE001
            self.error = f"{type(err).__name__}: {err}"[:160]
            _LOGGER.warning("YouBike 失敗：%s", self.error)

    def report(self, dist: Callable[[float, float], float] | None) -> dict[str, Any]:
        near: list[dict] = []
        if dist and time.time() - self.at < 900:
            near = sorted(({**{k: r[k] for k in ("sno", "name", "bikes", "ebikes", "docks", "ok")}, "m": round(dist(r["lat"], r["lon"]))}
                           for r in self.rows), key=lambda r: r["m"])
            near = [r for r in near if r["m"] <= NEAR_M][:NEAR_MAX]
        pick = self._cfg().get("station")
        main = next((r["sno"] for r in near if r["sno"] == pick), near[0]["sno"] if near else None)
        return {"show": self._cfg().get("show", True), "near": near, "main": main, "error": self.error, "updated": self.at or None}

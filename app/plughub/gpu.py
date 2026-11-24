"""GPU 辨識（另一台主機，例如 Jetson，跑 app/vision）：攝影機畫面丟過去，回傳看到什麼。

- 網址存在設定（settings.vision_url）；token 跟錄影機同一組（data/secrets.json 的 recorder_token）
- 連不上、太慢就改回樹莓派自己的模型（camera.Detector），1 分鐘後再試，功能不會停
- YOLOX 的分數跟樹莓派的模型不一樣高：換算成同一把尺，認人、貓狗的門檻不用改
"""
from __future__ import annotations

import json
import logging
import time
import urllib.request
from typing import Any, Callable

from .camera import PERSON_ON, PET_ON

_LOGGER = logging.getLogger(__name__)
TIMEOUT = 3  # 秒：超過就當作這次問不到
RETRY = 60  # 秒：失敗後多久再試
GPU_PERSON_ON = 0.55  # YOLOX-m：人在這以上才算（實測家裡畫面：真的人 0.76～0.91，鞋堆、扶手 0.3～0.4）
GPU_PET_ON = 0.45
KEEP = 0.3  # 回傳給畫面的物件，分數至少這樣


def normalize(objects: list[dict[str, Any]]) -> dict[str, float]:
    """YOLOX 的物件 → {"person", "cat", "dog"} 換算到樹莓派模型的尺度（GPU 門檻 = 樹莓派門檻）。"""
    best = {"person": 0.0, "cat": 0.0, "dog": 0.0}
    for o in objects:
        if o.get("name") in best:
            best[o["name"]] = max(best[o["name"]], float(o.get("score") or 0))
    return {"person": min(1.0, best["person"] * PERSON_ON / GPU_PERSON_ON),
            "cat": min(1.0, best["cat"] * PET_ON / GPU_PET_ON), "dog": min(1.0, best["dog"] * PET_ON / GPU_PET_ON)}


class GpuVision:
    def __init__(self, settings: Callable[[], dict[str, Any]], token: Callable[[], str]) -> None:
        self._settings = settings
        self._token = token
        self.error: str | None = None
        self._fail_at = 0.0
        self.count = 0
        self.total_ms = 0.0
        self.last_ok = 0.0

    @property
    def url(self) -> str:
        return (self._settings().get("vision_url") or "").rstrip("/")

    def detect(self, jpeg: bytes) -> dict[str, Any] | None:
        """{"scores": {...}, "objects": [...]}；沒設定、連不上 → None（呼叫的人改用樹莓派的模型）。"""
        if not self.url or time.time() - self._fail_at < RETRY:
            return None
        t = time.monotonic()
        try:
            req = urllib.request.Request(self.url + "/detect", data=jpeg, method="POST",
                                         headers={"Authorization": f"Bearer {self._token()}", "Content-Type": "image/jpeg"})
            with urllib.request.urlopen(req, timeout=TIMEOUT) as r:  # noqa: S310  只連家裡網路的主機
                res = json.loads(r.read())
        except Exception as err:  # noqa: BLE001
            if not self.error:
                _LOGGER.warning("GPU 辨識連不上，先用樹莓派自己的模型：%s", err)
            self.error = str(getattr(err, "reason", None) or err)[:200]
            self._fail_at = time.time()
            return None
        if self.error:
            _LOGGER.info("GPU 辨識恢復了")
        self.error = None
        self.count += 1
        self.total_ms += (time.monotonic() - t) * 1000
        self.last_ok = time.time()
        objs = [o for o in res.get("objects") or [] if float(o.get("score") or 0) >= KEEP]
        return {"scores": normalize(objs), "objects": objs[:20]}

    def public(self) -> dict[str, Any]:
        if not self.url:
            return {"configured": False}
        return {"configured": True, "url": self.url, "ok": not self.error and time.time() - self.last_ok < 120, "error": self.error,
                "count": self.count, "avg_ms": round(self.total_ms / self.count) if self.count else None}

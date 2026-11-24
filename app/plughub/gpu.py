"""GPU 辨識（另一台主機，例如 Jetson，跑 app/vision）：攝影機畫面丟過去，回傳看到什麼。

- 網址存在設定（settings.vision_url）；token 跟錄影機同一組（data/secrets.json 的 recorder_token）
- 連不上、太慢就改回樹莓派自己的模型（camera.Detector），1 分鐘後再試，功能不會停
- YOLOX 的分數跟樹莓派的模型不一樣高：換算成同一把尺，認人、貓狗的門檻不用改
"""
from __future__ import annotations

import json
import logging
import time
import urllib.error
import urllib.parse
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
        self._pushed: str | None = None
        self._pushed_at = 0.0
        self._since: dict[str, float] = {}  # 攝影機 → 上次拿到的最新時間（只拿之後的腳的位置）

    @property
    def url(self) -> str:
        return (self._settings().get("vision_url") or "").rstrip("/")

    def _post(self, path: str, body: bytes, timeout: float = TIMEOUT, soft: tuple[int, ...] = ()) -> dict[str, Any] | None:
        """送一張畫面給影像模型服務；沒設定、連不上 → None（呼叫的人改用樹莓派的模型）。soft：這些狀態碼不算連不上。"""
        if not self.url or time.time() - self._fail_at < RETRY:
            return None
        t = time.monotonic()
        try:
            req = urllib.request.Request(self.url + path, data=body, method="POST",
                                         headers={"Authorization": f"Bearer {self._token()}", "Content-Type": "image/jpeg"})
            with urllib.request.urlopen(req, timeout=timeout) as r:  # noqa: S310  只連家裡網路的主機
                res = json.loads(r.read())
        except urllib.error.HTTPError as err:
            if err.code in soft:
                return {"_status": err.code}
            return self._failed(err)
        except Exception as err:  # noqa: BLE001
            return self._failed(err)
        if self.error:
            _LOGGER.info("GPU 辨識恢復了")
        self.error = None
        self.count += 1
        self.total_ms += (time.monotonic() - t) * 1000
        self.last_ok = time.time()
        return res

    def _failed(self, err: Exception) -> None:
        if not self.error:
            _LOGGER.warning("影像模型服務連不上，先用樹莓派自己的模型：%s", err)
        self.error = str(getattr(err, "reason", None) or err)[:200]
        self._fail_at = time.time()
        return None

    def detect(self, jpeg: bytes) -> dict[str, Any] | None:
        """{"scores": {...}, "objects": [...]}"""
        res = self._post("/detect", jpeg)
        if res is None:
            return None
        objs = [o for o in res.get("objects") or [] if float(o.get("score") or 0) >= KEEP]
        return {"scores": normalize(objs), "objects": objs[:20]}

    def pose(self, jpeg: bytes) -> list[dict[str, Any]] | None:
        """跟 vision.Pose.analyze 一樣的格式。"""
        res = self._post("/pose", jpeg)
        if res is None:
            return None
        return [{**p, "box": tuple(p["box"]), "foot": tuple(p["foot"])} for p in res.get("people") or []]

    def faces(self, jpeg: bytes) -> list[dict[str, Any]] | None:
        """跟 faces.Engine.analyze 一樣的格式（feat 換回 numpy）。"""
        import numpy as np

        res = self._post("/faces", jpeg)
        if res is None:
            return None
        return [{**f, "box": tuple(f["box"]), "feat": np.asarray(f["feat"], np.float32)} for f in res.get("faces") or []]

    def segment(self, key: str, x: float, y: float, jpeg: bytes | None) -> list[dict[str, Any]] | None:
        """點一下就框。jpeg=None：用 60 秒內編碼過的畫面（服務那邊沒有 → 回傳 "need"）。"""
        q = urllib.parse.urlencode({"key": key, "x": f"{x:.4f}", "y": f"{y:.4f}"})
        res = self._post(f"/segment?{q}", jpeg or b"", timeout=20, soft=(409,))
        if res is None:
            return None
        if res.get("_status") == 409:
            return "need"  # type: ignore[return-value]
        return res.get("shapes") or []

    # ---- 直接看影片（Jetson 的 stream.py）----

    def _get(self, path: str, timeout: float = TIMEOUT) -> bytes | None:
        if not self.url or time.time() - self._fail_at < RETRY:
            return None
        try:
            req = urllib.request.Request(self.url + path, headers={"Authorization": f"Bearer {self._token()}"})
            with urllib.request.urlopen(req, timeout=timeout) as r:  # noqa: S310  只連家裡網路的主機
                return r.read()
        except urllib.error.HTTPError as err:
            if err.code == 404:  # 還沒在看這台：不算連不上
                self._pushed = None
                return None
            return self._failed(err)
        except Exception as err:  # noqa: BLE001
            return self._failed(err)

    def push_streams(self, cams: list[dict[str, Any]]) -> None:
        """告訴 Jetson 直接看哪些攝影機的影片（網址、不要看的地方）；一樣的話 5 分鐘才再送一次（Jetson 重開也補得上）。"""
        from .recorder import rtsp_url

        if not self.url or time.time() - self._fail_at < RETRY:
            return
        g = self._settings().get("gestures") or {}
        want = {c["id"]: {"url": rtsp_url(c), "ignore": c.get("ignore") or [], "pose": bool(c.get("fall")),
                          "gesture": bool(g.get("on")) and g.get("cam") == c["id"], "sound": bool((c.get("sound") or {}).get("on"))}
                for c in cams if c.get("enabled") and c.get("host")}
        sig = json.dumps(want, sort_keys=True)
        if sig == self._pushed and time.time() - self._pushed_at < 300:
            return
        try:
            req = urllib.request.Request(self.url + "/config", data=json.dumps({"cams": want}).encode(), method="PUT",
                                         headers={"Authorization": f"Bearer {self._token()}", "Content-Type": "application/json"})
            with urllib.request.urlopen(req, timeout=TIMEOUT) as r:  # noqa: S310
                r.read()
            self._pushed, self._pushed_at = sig, time.time()
        except Exception as err:  # noqa: BLE001
            self._pushed = None
            self._failed(err)

    def stream(self, cid: str) -> dict[str, Any] | None:
        """這台攝影機在 Jetson 上的最新狀態＋畫面：{"scores", "objects", "tracks", "samples", "jpeg"}；串流不正常 → None（改成自己抓畫面）。"""
        raw = self._get(f"/cams/{urllib.parse.quote(cid)}/state?since={self._since.get(cid, 0):.2f}")
        if raw is None:
            return None
        try:
            st = json.loads(raw)
        except ValueError:
            return None
        if not st.get("ok"):
            return None
        jpeg = self._get(f"/cams/{urllib.parse.quote(cid)}/frame.jpg")
        if not jpeg:
            return None
        self._since[cid] = float(st.get("t") or 0)
        self.last_ok = time.time()
        objs = [o for o in st.get("objects") or [] if float(o.get("score") or 0) >= KEEP]
        return {"scores": normalize(objs), "objects": objs[:20], "tracks": st.get("tracks") or [], "samples": st.get("samples") or [],
                "poses": st.get("poses") or [], "gestures": st.get("gestures") or [], "gesture_now": st.get("gesture_now"),
                "sounds": st.get("sounds") or [], "sound_error": st.get("sound_error"), "jpeg": jpeg}

    def classify(self, jpeg: bytes, box: list[float]) -> str | None:
        """框裡多的是什麼（包裹、袋子、鞋子…）；看不出來、連不上 → None。"""
        q = ",".join(f"{v:.4f}" for v in box)
        res = self._post(f"/classify?box={q}", jpeg, timeout=20)
        return (res or {}).get("label")

    def sound_clip(self, cid: str, t: int) -> bytes | None:
        """聽到警報、玻璃破掉…那一刻前後各 10 秒的聲音（WAV）。"""
        return self._get(f"/cams/{urllib.parse.quote(cid)}/sound/{int(t)}.wav", timeout=10)

    def appearance(self, cid: str) -> Any:
        """這台攝影機最新畫面裡最大的那個人的外觀特徵（numpy）；沒有人、連不上 → None。"""
        import numpy as np

        res = self._post(f"/appearance?cam={urllib.parse.quote(cid)}", b"", soft=(404,))
        people = (res or {}).get("people") or []
        if not people:
            return None
        big = max(people, key=lambda p: p["box"][2] * p["box"][3])
        return np.asarray(big["emb"], np.float32)

    # ---- 錄影分析（Jetson 的 index.py）----

    def summary(self, day: str) -> dict[str, Any] | None:
        raw = self._get(f"/summary?day={urllib.parse.quote(day)}", timeout=10)
        try:
            return json.loads(raw) if raw else None
        except ValueError:
            return None

    def search(self, q: str, days: int = 7, cam: str | None = None) -> dict[str, Any] | None:
        """打字找錄影；第一次要載入文字模型，會等久一點。"""
        if not self.url:
            return None
        try:
            req = urllib.request.Request(self.url + "/search", data=json.dumps({"q": q, "days": days, "cam": cam}).encode(), method="POST",
                                         headers={"Authorization": f"Bearer {self._token()}", "Content-Type": "application/json"})
            with urllib.request.urlopen(req, timeout=60) as r:  # noqa: S310
                return json.loads(r.read())
        except Exception as err:  # noqa: BLE001
            _LOGGER.warning("找錄影失敗：%s", err)
            return None

    def public(self) -> dict[str, Any]:
        if not self.url:
            return {"configured": False}
        return {"configured": True, "url": self.url, "ok": not self.error and time.time() - self.last_ok < 120, "error": self.error,
                "count": self.count, "avg_ms": round(self.total_ms / self.count) if self.count else None}

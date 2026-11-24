"""跟錄影機（另一台主機，例如 Jetson，跑 app/recorder）講話：告訴它錄哪些攝影機、問狀態、剪片段。

- 網址存在設定（settings.recorder_url）；token 存在 data/secrets.json（recorder_token，第一次自動產生），不回傳給瀏覽器
- 攝影機的帳密只在設定錄影機時用 PUT /config 傳過去（家裡網路），樹莓派這邊照樣不回傳
"""
from __future__ import annotations

import json
import logging
import secrets
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Callable

_LOGGER = logging.getLogger(__name__)
TIMEOUT = 10


def rtsp_url(cam: dict[str, Any]) -> str:
    """Foscam 的主串流（1080p）。"""
    q = urllib.parse.quote
    return f"rtsp://{q(cam.get('user', ''), safe='')}:{q(cam.get('pwd', ''), safe='')}@{cam['host']}:{int(cam.get('port') or 88)}/videoMain"


class Recorder:
    def __init__(self, secrets_path: Path, settings: Callable[[], dict[str, Any]]) -> None:
        self._path = secrets_path
        self._settings = settings
        self.last: dict[str, Any] | None = None  # 最近一次 /status
        self.error: str | None = None
        self._pushed: str | None = None

    @property
    def url(self) -> str:
        return (self._settings().get("recorder_url") or "").rstrip("/")

    def _secrets(self) -> dict[str, Any]:
        try:
            return json.loads(self._path.read_text("utf-8"))
        except Exception:  # noqa: BLE001
            return {}

    def token(self) -> str:
        """沒有就產生一組存起來（錄影機部署時從這裡拿）。"""
        data = self._secrets()
        if not data.get("recorder_token"):
            data["recorder_token"] = secrets.token_urlsafe(32)
            tmp = self._path.with_suffix(".tmp")
            tmp.write_text(json.dumps(data), "utf-8")
            tmp.chmod(0o600)
            tmp.replace(self._path)
        return data["recorder_token"]

    def _req(self, method: str, path: str, body: Any = None, timeout: float = TIMEOUT) -> bytes:
        req = urllib.request.Request(self.url + path, method=method, data=json.dumps(body).encode() if body is not None else None,
                                     headers={"Authorization": f"Bearer {self.token()}", "Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=timeout) as r:  # noqa: S310  只連家裡網路的錄影機
            return r.read()

    def push(self, cams: list[dict[str, Any]]) -> None:
        """告訴錄影機要錄哪些（啟用的）攝影機；跟上次一樣就不送。"""
        if not self.url:
            return
        want = {c["id"]: rtsp_url(c) for c in cams if c.get("enabled") and c.get("host")}
        sig = json.dumps(want, sort_keys=True)
        if sig == self._pushed:
            return
        self._req("PUT", "/config", {"cams": want})
        self._pushed = sig

    def refresh(self, cams: list[dict[str, Any]]) -> dict[str, Any] | None:
        if not self.url:
            self.last, self.error = None, None
            return None
        try:
            self.push(cams)
            self.last = json.loads(self._req("GET", "/status"))
            self.last["at"] = time.time()
            self.error = None
        except Exception as err:  # noqa: BLE001
            self._pushed = None  # 下次再送一次設定（錄影機可能重開了）
            self.error = str(getattr(err, "reason", None) or err)[:200]
            _LOGGER.info("錄影機連不上：%s", self.error)
        return self.last

    def clip(self, cam_id: str, start: float, end: float) -> bytes:
        q = urllib.parse.urlencode({"cam": cam_id, "start": f"{start:.1f}", "end": f"{end:.1f}"})
        return self._req("GET", f"/clip?{q}", timeout=60)

    def frame(self, cam_id: str, t: float, width: int = 640) -> bytes:
        q = urllib.parse.urlencode({"cam": cam_id, "t": f"{t:.1f}", "w": width})
        return self._req("GET", f"/frame?{q}", timeout=30)

    def public(self) -> dict[str, Any]:
        """給畫面看的狀態（沒有網址以外的東西：帳密、token 都不給）。"""
        if not self.url:
            return {"configured": False}
        st = self.last or {}
        return {"configured": True, "url": self.url, "ok": bool(st) and not self.error, "error": self.error,
                "cams": st.get("cams") or {}, "disk": st.get("disk"), "keep_days": st.get("keep_days")}

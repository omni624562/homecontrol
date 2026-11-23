"""網路攝影機（Foscam）認人：每秒拿一張快照，在樹莓派上判斷畫面裡有沒有人。

- 影像只在記憶體裡處理，不存檔、不上傳；判斷完就丟掉。
- 模型：EfficientDet-Lite0（Apache 2.0），只看「人」這一類的最高分數，一張約 40 毫秒。
- 設定和帳密存在 data/cameras.json（帳密不會回傳給瀏覽器）。
- 看到人：攝影機所在的房間當作「有動靜」（動靜自動開關、地圖都用得到）；沒人在家時看到人就通知。
"""
from __future__ import annotations

import io
import json
import logging
import os
import threading
import time
import urllib.parse
import urllib.request
import uuid
from pathlib import Path
from typing import Any

_LOGGER = logging.getLogger(__name__)

MODEL = Path(os.environ.get("PLUGHUB_MODEL", Path(__file__).resolve().parent.parent / "models" / "efficientdet_lite0.tflite"))
EVERY = 1.0  # 秒：每台多久看一次
PERSON_ON = 0.4  # 「人」的分數到這裡算看到
PERSON_HITS = 2  # 最近 3 張裡有幾張看到才算有人（避免一張誤判）
HOLD = 15  # 秒：多久沒看到人才算人走了
RETRY = 30  # 秒：連不上時多久再試
ALERT_GAP = 600  # 秒：同一台「沒人在家卻看到人」的通知，至少隔這麼久
TIMEOUT = 5


def track(st: dict[str, Any], score: float, now: float) -> str | None:
    """更新一台攝影機的狀態，回傳 "on"（剛看到人）、"off"（人走了）或 None。

    st：{"recent": 最近幾張的分數, "person": 現在有沒有人, "seen": 最後一次看到人的時間, "since": 這次有人從什麼時候}
    """
    recent = st.setdefault("recent", [])
    recent.append(round(score, 3))
    del recent[:-3]
    hits = sum(1 for s in recent if s >= PERSON_ON)
    if score >= PERSON_ON:
        st["seen"] = now
    if not st.get("person"):
        if hits >= PERSON_HITS:
            st.update(person=True, since=now, seen=now)
            return "on"
        return None
    if now - (st.get("seen") or 0) >= HOLD:
        st.update(person=False, since=now)
        return "off"
    return None


class Detector:
    """樹莓派上的物件辨識（只要「人」的分數）。第一次用到才載入模型。"""

    def __init__(self, model: Path = MODEL) -> None:
        self.model = model
        self._it = None
        self._lock = threading.Lock()
        self.error: str | None = None

    def _load(self) -> Any:
        if self._it is None:
            from ai_edge_litert.interpreter import Interpreter  # 只有用到攝影機才需要

            it = Interpreter(model_path=str(self.model), num_threads=1)
            it.allocate_tensors()
            self._inp = it.get_input_details()[0]
            outs = it.get_output_details()
            self._scores = next(o["index"] for o in outs if o["shape"][-1] == 90)  # 每個錨點 × 90 類的分數
            self._it = it
        return self._it

    def person_score(self, jpeg: bytes) -> float:
        import numpy as np
        from PIL import Image

        with self._lock:
            it = self._load()
            h, w = int(self._inp["shape"][1]), int(self._inp["shape"][2])
            img = Image.open(io.BytesIO(jpeg))
            img.draft("RGB", (w * 2, h * 2))  # JPEG 直接縮小解碼，快很多
            x = np.expand_dims(np.asarray(img.convert("RGB").resize((w, h)), dtype=np.uint8), 0)
            it.set_tensor(self._inp["index"], x)
            it.invoke()
            return float(it.get_tensor(self._scores)[0][:, 0].max())  # 第 0 類是人


def _cgi(cam: dict[str, Any], cmd: str) -> bytes:
    q = urllib.parse.urlencode({"cmd": cmd, "usr": cam.get("user", ""), "pwd": cam.get("pwd", "")})
    url = f"http://{cam['host']}:{int(cam.get('port') or 88)}/cgi-bin/CGIProxy.fcgi?{q}"
    with urllib.request.urlopen(url, timeout=TIMEOUT) as r:  # noqa: S310  只連家裡網路的攝影機
        return r.read()


def snapshot(cam: dict[str, Any]) -> bytes:
    data = _cgi(cam, "snapPicture2")
    if not data.startswith(b"\xff\xd8"):  # 不是 JPEG：多半是帳密錯（回的是 XML）
        raise RuntimeError(_cgi_error(data))
    return data


def _cgi_error(data: bytes) -> str:
    text = data.decode("utf-8", "replace")
    if "<result>-2</result>" in text:
        return "帳號或密碼不對"
    if "<result>-3</result>" in text:
        return "攝影機不支援這個功能"
    return "攝影機回的不是照片"


def dev_info(cam: dict[str, Any]) -> dict[str, str]:
    """登入看看：回傳型號、名稱；帳密錯就丟例外。"""
    text = _cgi(cam, "getDevInfo").decode("utf-8", "replace")
    if "<result>0</result>" not in text:
        raise RuntimeError(_cgi_error(text.encode()))

    def tag(t: str) -> str:
        a, b = text.find(f"<{t}>"), text.find(f"</{t}>")
        return text[a + len(t) + 2:b] if a >= 0 and b > a else ""

    return {"model": tag("productName"), "name": tag("devName")}


class Cameras:
    def __init__(self, data_dir: Path) -> None:
        self.path = data_dir / "cameras.json"
        self.list: list[dict[str, Any]] = []
        self.state: dict[str, dict[str, Any]] = {}  # 攝影機 ID → 認人的狀態（不存檔）
        self.detector = Detector()
        self.load()

    def load(self) -> None:
        try:
            self.list = json.loads(self.path.read_text("utf-8")).get("cameras") or []
        except FileNotFoundError:
            self.list = []
        except Exception as err:  # noqa: BLE001
            _LOGGER.warning("讀不到攝影機設定：%s", err)
            self.list = []
        for c in self.list:
            c.setdefault("id", uuid.uuid4().hex[:8])
            c.setdefault("enabled", True)
            c.setdefault("alert", True)
            c.setdefault("room", None)

    def save(self) -> None:
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps({"cameras": self.list}, ensure_ascii=False, indent=2), "utf-8")
        os.chmod(tmp, 0o600)
        tmp.replace(self.path)

    def get(self, cid: str) -> dict[str, Any] | None:
        return next((c for c in self.list if c["id"] == cid), None)

    def public(self) -> list[dict[str, Any]]:
        """給畫面看的：不含帳密。"""
        out = []
        for c in self.list:
            st = self.state.get(c["id"], {})
            out.append({k: c.get(k) for k in ("id", "name", "host", "port", "room", "enabled", "alert", "model")}
                       | {"person": bool(st.get("person")), "since": st.get("since"), "score": (st.get("recent") or [None])[-1],
                          "ok": st.get("ok"), "error": st.get("error"), "at": st.get("at")})
        return out

    def rooms(self) -> dict[str, list[str]]:
        """房間 ID → 放在那間、有啟用的攝影機名稱。"""
        out: dict[str, list[str]] = {}
        for c in self.list:
            if c.get("enabled") and c.get("room"):
                out.setdefault(c["room"], []).append(c.get("name") or c["host"])
        return out

    def rooms_with_person(self) -> dict[str, list[str]]:
        """房間 ID → 現在在那間看到人的攝影機名稱。"""
        out: dict[str, list[str]] = {}
        for c in self.list:
            if c.get("enabled") and c.get("room") and self.state.get(c["id"], {}).get("person"):
                out.setdefault(c["room"], []).append(c.get("name") or c["host"])
        return out

    def check(self, cam: dict[str, Any], now: float) -> str | None:
        """看一台攝影機一次（在背景執行緒裡跑）：回傳 track 的結果。"""
        st = self.state.setdefault(cam["id"], {})
        if st.get("ok") is False and now - (st.get("at") or 0) < RETRY:
            return None
        try:
            score = self.detector.person_score(snapshot(cam))
        except Exception as err:  # noqa: BLE001
            msg = str(err) or type(err).__name__
            if st.get("error") != msg:
                _LOGGER.warning("攝影機 %s 讀不到：%s", cam.get("name") or cam["host"], msg)
            st.update(ok=False, error=msg, at=now)
            if st.get("person"):  # 連不上就當作人走了，不要讓燈一直開著
                st.update(person=False, since=now)
                return "off"
            return None
        st.update(ok=True, error=None, at=now)
        return track(st, score, now)

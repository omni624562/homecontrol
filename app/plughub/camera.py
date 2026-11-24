"""網路攝影機（Foscam）認人：每秒拿一張快照，在樹莓派上判斷畫面裡有沒有人。

- 影像只在記憶體裡處理，不存檔、不上傳；判斷完就丟掉。
- 模型：EfficientDet-Lite0（Apache 2.0），只看「人」這一類的最高分數，一張約 40 毫秒。
- 設定和帳密存在 data/cameras.json（帳密不會回傳給瀏覽器）。
- 看到人：攝影機所在的房間當作「有動靜」（動靜自動開關、地圖都用得到）。
- 沒人在家時看到人：先等 3 分鐘、順便直接問家人的手機；有家人的手機連上 Wi-Fi 就是家人回來，沒有才通知。
"""
from __future__ import annotations

import hmac
import io
import json
import logging
import os
import secrets
import threading
import time
import urllib.parse
import urllib.request
import uuid
from pathlib import Path
from typing import Any, Callable

_LOGGER = logging.getLogger(__name__)

MODEL = Path(os.environ.get("PLUGHUB_MODEL", Path(__file__).resolve().parent.parent / "models" / "efficientdet_lite0.tflite"))
EVERY = 1.0  # 秒：每台多久看一次
PERSON_ON = 0.4  # 「人」的分數到這裡算看到
PERSON_HITS = 2  # 最近 3 張裡有幾張看到才算有人（避免一張誤判）
HOLD = 15  # 秒：多久沒看到人才算人走了
PETS = {16: "cat", 17: "dog"}  # 物件辨識模型裡貓、狗是第幾類
PET_ON = 0.35  # 貓狗的分數到這裡算看到（比人寬鬆一點：寵物常常只露出一部分）
PET_HOLD = 60  # 秒：多久沒看到才算走了
RETRY = 30  # 秒：連不上時多久再試
ALERT_GAP = 600  # 秒：同一台「沒人在家卻看到人」的通知，至少隔這麼久
ARRIVE_WAIT = 180  # 秒：沒人在家時看到人，先等這麼久；這段時間有家人的手機連上 Wi-Fi 就是家人回來，不通知
TIMEOUT = 5


# 選了「門口」或「房間裡」時先幫忙打開的功能（之後可以自己改）
ROLE_DEFAULTS = {
    "entry": {"faces": True, "alert": True, "fall": False, "pets": True},
    "room": {"faces": True, "alert": True, "fall": True, "pets": True},
}


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


def pet_track(st: dict[str, Any], scores: dict[str, float], now: float) -> None:
    """貓、狗：最近 3 張有 2 張看到就算來了；60 秒沒看到算走了。剛來的放進 st["pet_new"] 給 hub 處理。"""
    pets = st.setdefault("pets", {})
    for name in PETS.values():
        p = pets.setdefault(name, {"recent": [], "here": False, "seen": 0.0})
        sc = scores.get(name, 0.0)
        p["recent"] = (p["recent"] + [sc])[-3:]
        if sc >= PET_ON:
            p["seen"] = now
        if not p["here"] and sum(1 for x in p["recent"] if x >= PET_ON) >= 2:
            p["here"] = True
            st.setdefault("pet_new", []).append(name)
        elif p["here"] and now - p["seen"] >= PET_HOLD:
            p["here"] = False


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
        return self.scores(jpeg)["person"]

    def scores(self, jpeg: bytes) -> dict[str, float]:
        """人、貓、狗各自的最高分數。"""
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
            s = it.get_tensor(self._scores)[0]
            out = {"person": float(s[:, 0].max())}  # 第 0 類是人
            for idx, name in PETS.items():
                out[name] = float(s[:, idx].max())
            return out


def _cgi(cam: dict[str, Any], cmd: str) -> bytes:
    q = urllib.parse.urlencode({"cmd": cmd, "usr": cam.get("user", ""), "pwd": cam.get("pwd", "")})
    url = f"http://{cam['host']}:{int(cam.get('port') or 88)}/cgi-bin/CGIProxy.fcgi?{q}"
    with urllib.request.urlopen(url, timeout=TIMEOUT) as r:  # noqa: S310  只連家裡網路的攝影機
        return r.read()


def zone_points(z: Any) -> list[list[float]]:
    """一塊區域 → 多邊形頂點（舊的方框 [x, y, w, h] 換成 4 個角）。"""
    if len(z) == 4 and all(isinstance(v, (int, float)) for v in z):
        x, y, w, h = z
        return [[x, y], [x + w, y], [x + w, y + h], [x, y + h]]
    return [[float(p[0]), float(p[1])] for p in z]


def _migrate_door(c: dict[str, Any]) -> None:
    """舊版的「門」（攝影機只能有一個）搬進區域清單，變成種類是門、叫「大門」的區域；設定、記住的樣子都保留。"""
    door = c.pop("door", None) or {}
    poly = door.get("poly") or (zone_points(door["rect"]) if door.get("rect") else None)
    if not poly:
        return
    refs = list(door.get("refs") or [])
    c["zones"] = [{"id": "door", "name": "大門", "kind": "door", "poly": poly, "linger": 0,
                   "act": {"notify": door.get("notify") or "away", "scene": door.get("scene"), "dark": True},
                   "refs": refs, "ref_when": ["day"] * len(refs)}] + [z for z in c.get("zones") or [] if z.get("id") != "door"]


def ref_counts(z: dict[str, Any]) -> dict[str, int]:
    """記住的樣子裡，白天、晚上（夜視黑白）各幾張。"""
    when = list(z.get("ref_when") or [])
    when += ["day"] * (len(z.get("refs") or []) - len(when))  # 舊資料沒有標：算白天
    return {"day": when.count("day"), "night": when.count("night")}


def _zone_state(st: dict[str, Any], z: dict[str, Any]) -> dict[str, Any]:
    zs = (st.get("zones") or {}).get(z["id"]) or {}
    return {"busy": bool(zs.get("in")), "open": bool(zs.get("open")), "score": zs.get("score")}


def mask(jpeg: bytes, zones: list[Any]) -> bytes:
    """把「不要看的地方」塗成灰色（認人、認臉、姿勢、門都不會看那裡）。每塊是 0～1 的多邊形頂點（或舊的方框）。"""
    from PIL import Image, ImageDraw

    img = Image.open(io.BytesIO(jpeg)).convert("RGB")
    W, H = img.size
    draw = ImageDraw.Draw(img)
    for z in zones:
        draw.polygon([(px * W, py * H) for px, py in zone_points(z)], fill=(128, 128, 128))
    out = io.BytesIO()
    img.save(out, "JPEG", quality=85)
    return out.getvalue()


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


class AccessCode:
    """開通「看攝影機畫面」的驗證碼：只送到手機通知（LINE），10 分鐘有效、用一次；輸錯 5 次鎖 5 分鐘。"""

    TTL = 600
    MAX_FAILS = 5
    LOCK = 300

    def __init__(self, clock=time.time) -> None:
        self.clock = clock
        self._code: tuple[str, float] | None = None
        self._fails = 0
        self._locked_until = 0.0

    def new(self) -> str:
        code = f"{secrets.randbelow(10**6):06d}"
        self._code = (code, self.clock() + self.TTL)
        return code

    def locked_for(self) -> int:
        return max(0, round(self._locked_until - self.clock()))

    def claim(self, code: str) -> bool:
        now = self.clock()
        if self.locked_for():
            return False
        code = "".join(ch for ch in str(code) if ch.isdigit())
        if self._code and self._code[1] > now and hmac.compare_digest(code, self._code[0]):
            self._code = None
            self._fails = 0
            return True
        self._fails += 1
        if self._fails >= self.MAX_FAILS:
            self._locked_until = now + self.LOCK
            self._fails = 0
            self._code = None  # 鎖住時這組碼也作廢
        return False


class Cameras:
    def __init__(self, data_dir: Path) -> None:
        self.path = data_dir / "cameras.json"
        self.list: list[dict[str, Any]] = []
        self.viewers: list[str] = []  # 可以看畫面、改攝影機設定的裝置 ID（配對的裝置 ID，或家人手機的「mac:…」）
        self.code = AccessCode()
        self.state: dict[str, dict[str, Any]] = {}  # 攝影機 ID → 認人的狀態（不存檔）
        self.frames: dict[str, bytes] = {}  # 這一輪拿到的快照（給認臉用，用完就丟，不存檔）
        self.detector = Detector()
        self.remote: Callable[[bytes], dict[str, Any] | None] | None = None  # GPU 辨識（另一台主機）；問不到就用 detector
        self.load()

    def load(self) -> None:
        try:
            data = json.loads(self.path.read_text("utf-8"))
            self.list = data.get("cameras") or []
            self.viewers = [str(x) for x in data.get("viewers") or []]
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
            c.setdefault("faces", True)  # 看到人時認臉
            c.setdefault("role", "room")  # entry：門口（認出誰回家、出門、門口的陌生人）；room：房間
            c.setdefault("light", None)  # 門口：半夜看到陌生人時打開的插座
            c.setdefault("pets", True)  # 認貓、狗
            c.setdefault("fall", c.get("role") != "entry")  # 跌倒偵測（實驗；預設只有房間的攝影機）
            c["ignore"] = [zone_points(z) for z in c.get("ignore") or []]  # 不要看的地方（例如路邊）：每塊是 0～1 的多邊形頂點
            c.setdefault("zones", [])  # 區域：[{"id","name","kind": area/object/door,"poly","linger","act": {...},"refs": [樣子…]}]
            c.setdefault("lines", [])  # 線：[{"id","name","a","b","in": {...},"out": {...}}]（箭頭那邊＝回來）
            _migrate_door(c)

    def save(self) -> None:
        tmp = self.path.with_suffix(".tmp")
        def strip(d: dict[str, Any]) -> dict[str, Any]:
            return {k: v for k, v in d.items() if not k.startswith("_")}

        clean = [{**c, "zones": [strip(z) for z in c.get("zones") or []]} for c in self.list]
        tmp.write_text(json.dumps({"cameras": clean, "viewers": self.viewers}, ensure_ascii=False, indent=2), "utf-8")
        os.chmod(tmp, 0o600)
        tmp.replace(self.path)

    def get(self, cid: str) -> dict[str, Any] | None:
        return next((c for c in self.list if c["id"] == cid), None)

    def public(self) -> list[dict[str, Any]]:
        """給畫面看的：不含帳密。"""
        out = []
        for c in self.list:
            st = self.state.get(c["id"], {})
            out.append({k: c.get(k) for k in ("id", "name", "host", "port", "room", "enabled", "alert", "model", "faces", "role", "light", "pets", "fall", "pet_notify", "ignore")}
                       | {"night": st.get("night"),
                          "pets_here": [n for n, p in (st.get("pets") or {}).items() if p.get("here")],
                          "zones": [{k: z.get(k) for k in ("id", "name", "kind", "poly", "linger", "act")} | {"refs": len(z.get("refs") or []), **ref_counts(z), **_zone_state(st, z)} for z in c.get("zones") or []],
                          "lines": [{k: ln.get(k) for k in ("id", "name", "a", "b", "in", "out")} | {"last": (st.get("lines") or {}).get(ln["id"], {}).get("last")} for ln in c.get("lines") or []]}
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

    def pets_in(self, room: str) -> list[str]:
        """這間現在看到的寵物（cat、dog）。"""
        out: set[str] = set()
        for c in self.list:
            if c.get("enabled") and c.get("room") == room:
                out |= {n for n, p in (self.state.get(c["id"], {}).get("pets") or {}).items() if p.get("here")}
        return sorted(out)

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
            jpeg = snapshot(cam)
            if cam.get("ignore"):
                jpeg = mask(jpeg, cam["ignore"])
            self.frames[cam["id"]] = jpeg
            got = self.remote(jpeg) if self.remote else None
            if got:
                sc = got["scores"]
                st.update(engine="gpu", objects=got["objects"])
            else:
                sc = self.detector.scores(jpeg)
                st.update(engine="cpu", objects=None)
            score = sc["person"]
            if cam.get("pets", True):
                pet_track(st, sc, now)
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

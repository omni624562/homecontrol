"""人臉：找臉（YuNet，MIT）、認人（SFace，Apache 2.0），都在樹莓派上跑。

- 只在攝影機看到人的時候才找臉（省 CPU）。
- 家人和訪客的臉只存「數字特徵」（每張 128 個數字），不存照片：data/faces.json（600 權限）。
- 陌生人的小圖存在 data/faces_thumbs/，7 天後自動刪掉；只有「可以看攝影機」的裝置拿得到。
- 判斷結果三種：known（認得：家人或訪客）、stranger（看清楚了、但誰都不像）、unclear（臉太小、太暗、側臉）。
"""
from __future__ import annotations

import json
import logging
import os
import threading
import time
import uuid
from pathlib import Path
from typing import Any

from .camera import MODEL

_LOGGER = logging.getLogger(__name__)

MODELS = MODEL.parent
DET_MODEL = MODELS / "face_detection_yunet_2023mar.onnx"
REC_MODEL = MODELS / "face_recognition_sface_2021dec.onnx"
DET_SCALE = 0.5  # 找臉時先把畫面縮成一半（1080p 整張要 0.3 秒，一半約 0.08 秒）
MATCH = 0.363  # SFace 建議的門檻：餘弦相似度到這裡算同一個人
STRONG = 0.5  # 這麼像就直接相信，不用等手機連上 Wi-Fi
CLEAR_W = 48  # 原圖上臉寬至少這麼多像素、偵測分數夠高，才算「看清楚」（才可能判成陌生人）
CLEAR_SCORE = 0.9
SAMPLES = 10  # 登記時每個人存幾個特徵
ENROLL_S = 40  # 登記最多拍幾秒
MIN_SAMPLES = 3
LOG_KEEP_S = 7 * 86400
LOG_MAX = 500


def _norm(v: Any) -> Any:
    import numpy as np

    v = np.asarray(v, dtype=np.float32).flatten()
    n = float(np.linalg.norm(v))
    return v / n if n else v


class Engine:
    """找臉＋認人。第一次用到才載入模型。"""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._det = None
        self._rec = None

    def _load(self) -> None:
        if self._det is None:
            import cv2

            self._det = cv2.FaceDetectorYN.create(str(DET_MODEL), "", (320, 320), 0.7, 0.3, 50)
            self._rec = cv2.FaceRecognizerSF.create(str(REC_MODEL), "")

    def analyze(self, jpeg: bytes) -> list[dict[str, Any]]:
        """一張 JPEG → 每張臉：{"w": 原圖臉寬, "score": 偵測分數, "clear": 看清楚了嗎, "feat": 特徵, "box": (x, y, w, h)}"""
        import cv2
        import numpy as np

        with self._lock:
            self._load()
            img = cv2.imdecode(np.frombuffer(jpeg, np.uint8), cv2.IMREAD_COLOR)
            if img is None:
                return []
            small = cv2.resize(img, None, fx=DET_SCALE, fy=DET_SCALE, interpolation=cv2.INTER_AREA)
            self._det.setInputSize((small.shape[1], small.shape[0]))
            _, found = self._det.detect(small)
            out = []
            for f in found if found is not None else []:
                full = f.copy()
                full[:14] = f[:14] / DET_SCALE  # 框和 5 個特徵點換回原圖座標
                w, score = float(full[2]), float(full[14])
                feat = _norm(self._rec.feature(self._rec.alignCrop(img, full)))
                out.append({"w": w, "score": score, "clear": w >= CLEAR_W and score >= CLEAR_SCORE, "feat": feat,
                            "box": tuple(int(x) for x in full[:4])})
            return out

    @staticmethod
    def thumb(jpeg: bytes, box: tuple[int, int, int, int], size: int = 160) -> bytes:
        """把臉（多留一點邊）裁成小圖。"""
        import cv2
        import numpy as np

        img = cv2.imdecode(np.frombuffer(jpeg, np.uint8), cv2.IMREAD_COLOR)
        x, y, w, h = box
        m = int(max(w, h) * 0.4)
        x0, y0 = max(0, x - m), max(0, y - m)
        crop = img[y0:min(img.shape[0], y + h + m), x0:min(img.shape[1], x + w + m)]
        if crop.size == 0:
            return b""
        scale = size / max(crop.shape[:2])
        crop = cv2.resize(crop, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
        ok, buf = cv2.imencode(".jpg", crop, [cv2.IMWRITE_JPEG_QUALITY, 80])
        return buf.tobytes() if ok else b""


def classify(face: dict[str, Any], match: tuple[str | None, float]) -> tuple[str, str | None, float]:
    """一張臉 → ("known", 誰, 相似度) / ("stranger", None, 相似度) / ("unclear", None, 相似度)。"""
    pid, sim = match
    if pid and sim >= MATCH:
        return "known", pid, sim
    return ("stranger" if face.get("clear") else "unclear"), None, sim


class Gallery:
    """認得的人：家人（id = 「誰在家」的人）和訪客（id = g-…），每人幾個特徵。"""

    def __init__(self, data_dir: Path) -> None:
        self.path = data_dir / "faces.json"
        self.people: dict[str, dict[str, Any]] = {}
        self._arr: dict[str, Any] = {}
        try:
            self.people = json.loads(self.path.read_text("utf-8")).get("people") or {}
        except FileNotFoundError:
            pass
        except Exception as err:  # noqa: BLE001
            _LOGGER.warning("讀不到人臉資料：%s", err)

    def save(self) -> None:
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps({"people": self.people}, ensure_ascii=False), "utf-8")
        os.chmod(tmp, 0o600)
        tmp.replace(self.path)
        self._arr = {}

    def set(self, pid: str, name: str, kind: str, feats: list[Any], **extra: Any) -> None:
        self.people[pid] = {**(self.people.get(pid) or {}), "name": name, "kind": kind,
                            "feats": [[round(float(x), 5) for x in f] for f in feats], "at": round(time.time()), **extra}
        self.save()

    def remove(self, pid: str) -> bool:
        if self.people.pop(pid, None) is None:
            return False
        self.save()
        return True

    def match(self, feat: Any) -> tuple[str | None, float]:
        """最像誰、多像（餘弦相似度）。"""
        import numpy as np

        best: tuple[str | None, float] = (None, 0.0)
        for pid, p in self.people.items():
            if not p.get("feats"):
                continue
            if pid not in self._arr:
                self._arr[pid] = np.asarray(p["feats"], dtype=np.float32)
            sim = float((self._arr[pid] @ feat).max())
            if sim > best[1]:
                best = (pid, sim)
        return best

    def public(self) -> list[dict[str, Any]]:
        return [{"id": pid, "name": p.get("name"), "kind": p.get("kind"), "samples": len(p.get("feats") or []), "at": p.get("at"),
                 "notify": p.get("notify", True)} for pid, p in self.people.items()]


def pick_samples(cands: list[tuple[float, Any]], n: int = SAMPLES) -> list[Any]:
    """登記：從拍到的臉裡挑品質最好、又彼此不要太像的 n 個（不同角度比較認得準）。"""
    import numpy as np

    out: list[Any] = []
    for _, f in sorted(cands, key=lambda x: -x[0]):
        if all(float(np.dot(f, g)) < 0.97 for g in out):
            out.append(f)
        if len(out) >= n:
            break
    return out


class FaceLog:
    """認臉紀錄（最近 7 天）：家人、訪客只記名字；陌生人多存一張小圖。"""

    def __init__(self, data_dir: Path) -> None:
        self.path = data_dir / "faces_log.json"
        self.dir = data_dir / "faces_thumbs"
        self.items: list[dict[str, Any]] = []
        try:
            self.items = json.loads(self.path.read_text("utf-8")).get("items") or []
        except FileNotFoundError:
            pass
        except Exception as err:  # noqa: BLE001
            _LOGGER.warning("讀不到認臉紀錄：%s", err)

    def add(self, item: dict[str, Any], thumb: bytes | None = None) -> dict[str, Any]:
        item = {"id": uuid.uuid4().hex[:10], "t": round(time.time()), **item, "thumb": bool(thumb)}
        if thumb:
            self.dir.mkdir(exist_ok=True)
            p = self.dir / f"{item['id']}.jpg"
            p.write_bytes(thumb)
            os.chmod(p, 0o600)
        self.items.append(item)
        self.prune()
        return item

    def prune(self, now: float | None = None) -> None:
        now = now or time.time()
        keep = [x for x in self.items if now - x["t"] < LOG_KEEP_S][-LOG_MAX:]
        for x in self.items:
            if x not in keep and x.get("thumb"):
                (self.dir / f"{x['id']}.jpg").unlink(missing_ok=True)
        self.items = keep
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps({"items": self.items}, ensure_ascii=False), "utf-8")
        os.chmod(tmp, 0o600)
        tmp.replace(self.path)

    def thumb_path(self, item_id: str) -> Path | None:
        if not item_id.isalnum():
            return None
        p = self.dir / f"{item_id}.jpg"
        return p if p.exists() else None

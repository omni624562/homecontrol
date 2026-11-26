"""直接看攝影機的影片：每台一條 RTSP（Jetson 硬體解碼），每秒取幾張跑物件辨識，追蹤每個人。

- 樹莓派用 PUT /config 告訴這裡要看哪些攝影機（網址、不要看的地方）；每分鐘會再送一次（這裡重開也會很快補上）
- 每個人一個編號（同一個人在連續幾張裡的框重疊就算同一個），記住腳的位置走過的路線
- 樹莓派來問：最新的物件、追蹤中的人、從上次問到現在每一刻的腳的位置（判斷過線用）、最新一張畫面
影像只在記憶體裡，不存檔。
"""
from __future__ import annotations

import logging
import threading
import time
from collections import deque
from typing import Any, Callable

import cv2
import numpy as np

LOG = logging.getLogger("vision.stream")
FPS = 5  # 每秒看幾張
PERSON_MIN = 0.55  # 追蹤的人至少要這個分數（YOLOX-m；跟樹莓派判斷「有人」同一個門檻）
MATCH_IOU = 0.25  # 跟上一張的框重疊這麼多算同一個人
LOST_S = 2.0  # 秒：多久沒看到就當作走了
SAMPLES_KEEP = 20  # 秒：腳的位置的紀錄留多久
POSE_EVERY = 0.4  # 秒：開了跌倒偵測、又有人時，多久算一次姿勢（每秒 2.5 次）
JPEG_Q = 85


def iou(a: list[float], b: list[float]) -> float:
    ax1, ay1, bx1, by1 = a[0] + a[2], a[1] + a[3], b[0] + b[2], b[1] + b[3]
    iw, ih = max(0.0, min(ax1, bx1) - max(a[0], b[0])), max(0.0, min(ay1, by1) - max(a[1], b[1]))
    inter = iw * ih
    return inter / (a[2] * a[3] + b[2] * b[3] - inter + 1e-9)


class Tracker:
    """很簡單的追蹤：每張畫面的人框，跟還在追的框照重疊程度配對（貪婪法）；配不到的開新編號。"""

    def __init__(self) -> None:
        self.next_id = 1
        self.tracks: dict[int, dict[str, Any]] = {}

    def update(self, people: list[dict[str, Any]], now: float) -> list[dict[str, Any]]:
        pairs = sorted(((iou(t["box"], p["box"]), tid, i) for tid, t in self.tracks.items() for i, p in enumerate(people)), reverse=True)
        used_t, used_p = set(), set()
        for v, tid, i in pairs:
            if v < MATCH_IOU:
                break
            if tid in used_t or i in used_p:
                continue
            used_t.add(tid)
            used_p.add(i)
            self._set(self.tracks[tid], people[i], now)
        for i, p in enumerate(people):
            if i not in used_p:
                t = {"id": self.next_id, "since": now, "path": deque(maxlen=50)}
                self.next_id += 1
                self.tracks[t["id"]] = t
                self._set(t, p, now)
        for tid in [k for k, t in self.tracks.items() if now - t["seen"] > LOST_S]:
            del self.tracks[tid]
        return [self.public(t) for t in self.tracks.values() if t["seen"] == now]

    @staticmethod
    def _set(t: dict[str, Any], p: dict[str, Any], now: float) -> None:
        x, y, w, h = p["box"]
        t.update(box=p["box"], score=p["score"], seen=now, foot=(round(x + w / 2, 4), round(min(1.0, y + h), 4)))
        t["path"].append((round(now, 2), *t["foot"]))

    @staticmethod
    def public(t: dict[str, Any]) -> dict[str, Any]:
        return {"id": t["id"], "box": t["box"], "score": t["score"], "foot": t["foot"], "since": round(t["since"], 2), "age": round(t["seen"] - t["since"], 1)}


ENHANCE = {"on": True}  # 樹莓派送設定時會改（設定頁「夜間畫面增強」）
DARK = 80  # 畫面平均亮度低於這個算暗
_clahe = cv2.createCLAHE(clipLimit=3.0, tileGridSize=(8, 8))


def is_dark(img: np.ndarray) -> bool:
    """太暗，或攝影機切到夜視（紅外線，幾乎沒有顏色）。"""
    small = cv2.resize(img, (160, 90), interpolation=cv2.INTER_AREA)
    gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
    hsv = cv2.cvtColor(small, cv2.COLOR_BGR2HSV)
    return float(gray.mean()) < DARK or float(hsv[..., 1].mean()) < 12


def enhance(img: np.ndarray) -> np.ndarray:
    """夜間畫面增強：亮度做局部對比強化（CLAHE）再去一點雜訊；只用來辨識，錄影和看到的畫面不變。"""
    if not ENHANCE["on"] or not is_dark(img):
        return img
    lab = cv2.cvtColor(img, cv2.COLOR_BGR2LAB)
    l, a, b = cv2.split(lab)
    l = cv2.fastNlMeansDenoising(_clahe.apply(l), None, 5, 7, 21) if img.shape[0] <= 720 else _clahe.apply(l)
    return cv2.cvtColor(cv2.merge([l, a, b]), cv2.COLOR_LAB2BGR)


def mask(img: np.ndarray, polys: list[list[list[float]]]) -> np.ndarray:
    """不要看的地方塗成灰色（跟樹莓派 camera.mask 一樣）。"""
    if not polys:
        return img
    h, w = img.shape[:2]
    out = img.copy()
    for poly in polys:
        pts = np.array([[int(px * w), int(py * h)] for px, py in poly], np.int32)
        if len(pts) >= 3:
            cv2.fillPoly(out, [pts], (128, 128, 128))
    return out


class Cam:
    def __init__(self, cid: str, url: str, ignore: list, detect: Callable[[np.ndarray], list[dict[str, Any]]],
                 pose: Callable[[np.ndarray], list[dict[str, Any]] | None] | None = None, pose_on: bool = False) -> None:
        self.id, self.url, self.ignore = cid, url, ignore
        self.detect = detect
        self.pose, self.pose_on = pose, pose_on
        self.poses: deque = deque()  # (t, [姿勢])：跌倒偵測用
        self.pose_t = 0.0
        self.stop = False
        self.lock = threading.Lock()
        self.frame: np.ndarray | None = None
        self.frame_t = 0.0
        self.objects: list[dict[str, Any]] = []
        self.tracks: list[dict[str, Any]] = []
        self.samples: deque = deque()  # (t, [(track_id, x, y)])：每一張看到的人腳的位置
        self.person = 0.0  # 這一張「人」的最高分
        self.error: str | None = None
        self.fps = 0.0
        self.tracker = Tracker()
        self.thread = threading.Thread(target=self._run, daemon=True)
        self.thread.start()

    def _pipeline(self) -> str:
        return (f"rtspsrc location={self.url} protocols=tcp latency=200 ! rtph264depay ! h264parse ! nvv4l2decoder ! "
                f"nvvidconv ! video/x-raw,format=BGRx ! videorate ! video/x-raw,framerate={FPS}/1 ! "
                "videoconvert ! video/x-raw,format=BGR ! appsink drop=true max-buffers=1 sync=false")

    def _run(self) -> None:
        delay = 5
        while not self.stop:
            cap = cv2.VideoCapture(self._pipeline(), cv2.CAP_GSTREAMER)
            started = time.time()
            if not cap.isOpened():
                self.error = "串流打不開"
            n, t0 = 0, time.time()
            while not self.stop and cap.isOpened():
                ok, img = cap.read()
                if not ok:
                    self.error = "串流中斷"
                    break
                now = time.time()
                try:
                    self._process(img, now)
                    self.error = None
                except Exception as err:  # noqa: BLE001
                    self.error = str(err)[:200]
                    LOG.exception("%s 分析失敗", self.id)
                n += 1
                if now - t0 >= 5:
                    self.fps, n, t0 = round(n / (now - t0), 1), 0, now
            cap.release()
            if self.stop:
                break
            LOG.warning("%s 串流斷了：%s", self.id, self.error)
            delay = 5 if time.time() - started > 120 else min(60, delay * 2)
            time.sleep(delay)

    def _process(self, img: np.ndarray, now: float) -> None:
        seen = enhance(img)  # 天黑時先提亮再辨識
        objs = self.detect(mask(seen, self.ignore))
        people = [o for o in objs if o["name"] == "person" and o["score"] >= PERSON_MIN]
        tracks = self.tracker.update(people, now)
        pose = None
        if self.pose_on and self.pose and tracks and now - self.pose_t >= POSE_EVERY - 0.02:
            self.pose_t = now
            pose = self.pose(seen)
        with self.lock:
            if pose is not None:
                self.poses.append((round(now, 2), pose))
            while self.poses and now - self.poses[0][0] > SAMPLES_KEEP:
                self.poses.popleft()
            self.frame, self.frame_t = img, now
            self.objects = objs
            self.tracks = tracks
            self.person = max((o["score"] for o in objs if o["name"] == "person"), default=0.0)
            self.samples.append((round(now, 2), [(t["id"], *t["foot"]) for t in tracks]))
            while self.samples and now - self.samples[0][0] > SAMPLES_KEEP:
                self.samples.popleft()

    def state(self, since: float = 0.0) -> dict[str, Any]:
        with self.lock:
            return {"t": round(self.frame_t, 2), "ok": self.error is None and time.time() - self.frame_t < 5, "error": self.error, "fps": self.fps,
                    "person": round(self.person, 3), "objects": self.objects, "tracks": self.tracks,
                    "samples": [s for s in self.samples if s[0] > since], "poses": [p for p in self.poses if p[0] > since]}

    def jpeg(self) -> bytes | None:
        with self.lock:
            img = self.frame
        if img is None:
            return None
        ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, JPEG_Q])
        return buf.tobytes() if ok else None

    def close(self) -> None:
        self.stop = True


class Streams:
    def __init__(self, detect: Callable[[np.ndarray], list[dict[str, Any]]], pose: Callable[[np.ndarray], list[dict[str, Any]] | None] | None = None) -> None:
        self.detect = detect
        self.pose = pose
        self.ears: dict[str, Any] = {}  # 攝影機 → sound.Listener（有開聲音偵測的）
        self._sound_model = None
        self.cams: dict[str, Cam] = {}
        self.lock = threading.Lock()

    def configure(self, cfg: dict[str, Any]) -> list[str]:
        """{"cams": {"id": {"url": "rtsp://...", "ignore": [[[x, y], ...], ...]}}, "enhance": 夜間畫面增強}"""
        ENHANCE["on"] = cfg.get("enhance") is not False
        want = {}
        for cid, c in (cfg.get("cams") or {}).items():
            if isinstance(c, dict) and str(c.get("url", "")).startswith("rtsp://") and cid.replace("-", "").replace("_", "").isalnum():
                want[cid] = c
        with self.lock:
            for cid in list(self.cams):
                c = want.get(cid)
                if not c or c["url"] != self.cams[cid].url:
                    self.cams.pop(cid).close()
                else:
                    self.cams[cid].ignore = c.get("ignore") or []
                    self.cams[cid].pose_on = bool(c.get("pose"))
            for cid in list(self.ears):  # 聲音：關掉的、換網址的停掉
                c = want.get(cid)
                if not c or not c.get("sound") or c["url"] != self.ears[cid].url:
                    self.ears.pop(cid).close()
            for cid, c in want.items():
                if c.get("sound") and cid not in self.ears:
                    try:
                        from sound import Listener, Model

                        if self._sound_model is None:
                            self._sound_model = Model()
                        self.ears[cid] = Listener(cid, c["url"], self._sound_model)
                    except Exception:  # noqa: BLE001
                        LOG.exception("聲音偵測載入失敗")
            for cid, c in want.items():
                if cid not in self.cams:
                    self.cams[cid] = Cam(cid, c["url"], c.get("ignore") or [], self.detect, self.pose, bool(c.get("pose")))
            return sorted(self.cams)

    def get(self, cid: str) -> Cam | None:
        return self.cams.get(cid)

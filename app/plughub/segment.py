"""點一下就框：在攝影機畫面上點一個東西（門、電梯、櫃子），找出它的邊，變成多邊形。

用 MobileSAM（Apache 2.0；ONNX 版來自 Acly/MobileSAM，MIT），OpenCV 直接跑，不用多裝套件。
- 編碼一張畫面約 4 秒（樹莓派 5），同一台攝影機 60 秒內再點都用同一張，每點一下約 0.5 秒
- 解碼器一次給 4 種大小的候選（一扇門／兩扇門／連牆一起…），由小到大給畫面挑
- 只有點的時候才跑；10 分鐘沒用就把模型放掉（約 200 MB 記憶體）
影像不存檔。
"""
from __future__ import annotations

import threading
import time
from typing import Any

from .camera import MODEL

ENCODER = MODEL.parent / "mobile_sam_image_encoder.onnx"
DECODER = MODEL.parent / "sam_mask_decoder_multi.onnx"
SIZE = 1024  # 編碼器看的長邊
KEEP_EMB = 60  # 秒：同一台攝影機的畫面編碼留多久
IDLE_FREE = 600  # 秒：多久沒用就放掉模型
MIN_AREA = 0.0008  # 太小的（雜訊）不要
MAX_AREA = 0.6  # 幾乎整個畫面的不要
MAX_PTS = 8  # 多邊形最多幾個角（太多不好拖）


def available() -> bool:
    return ENCODER.exists() and DECODER.exists()


def to_poly(mask: Any) -> list[list[float]] | None:
    """二值遮罩 → 0～1 的多邊形（外框凸包再簡化成最多 MAX_PTS 個角）。"""
    import cv2

    h, w = mask.shape[:2]
    cs, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not cs:
        return None
    hull = cv2.convexHull(max(cs, key=cv2.contourArea))
    per = cv2.arcLength(hull, True)
    eps = 0.01
    ap = cv2.approxPolyDP(hull, eps * per, True)
    while len(ap) > MAX_PTS and eps < 0.2:
        eps *= 1.5
        ap = cv2.approxPolyDP(hull, eps * per, True)
    if len(ap) < 3:
        return None
    return [[round(min(1.0, max(0.0, float(p[0][0]) / w)), 4), round(min(1.0, max(0.0, float(p[0][1]) / h)), 4)] for p in ap]


def pick(masks: list[Any], scores: list[float]) -> list[dict[str, Any]]:
    """候選遮罩 → 去掉太小、太大、跟前一個幾乎一樣的，由小到大排。"""
    out: list[dict[str, Any]] = []
    for m, s in sorted(zip(masks, scores), key=lambda x: float(x[0].mean())):
        area = float(m.mean())
        if not MIN_AREA <= area <= MAX_AREA:
            continue
        if out and abs(area - out[-1]["area"]) / max(area, 1e-6) < 0.12:  # 大小差不多：留分數高的
            if s > out[-1]["score"]:
                poly = to_poly(m)
                if poly:
                    out[-1] = {"poly": poly, "area": round(area, 4), "score": round(float(s), 2)}
            continue
        poly = to_poly(m)
        if poly:
            out.append({"poly": poly, "area": round(area, 4), "score": round(float(s), 2)})
    return out


class Segmenter:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._enc = self._dec = None
        self._emb: dict[str, tuple[float, Any, tuple[int, int]]] = {}  # 攝影機 → (時間, 編碼, (高, 寬))
        self._used = 0.0

    def _load(self) -> None:
        if self._enc is None:
            import cv2

            self._enc = cv2.dnn.readNetFromONNX(str(ENCODER))
            self._dec = cv2.dnn.readNetFromONNX(str(DECODER))

    def free_if_idle(self) -> None:
        with self._lock:
            if self._enc is not None and time.time() - self._used > IDLE_FREE:
                self._enc = self._dec = None
                self._emb.clear()

    def has_frame(self, key: str) -> bool:
        e = self._emb.get(key)
        return bool(e and time.time() - e[0] < KEEP_EMB)

    def encode(self, key: str, jpeg: bytes) -> None:
        import cv2
        import numpy as np

        img = cv2.imdecode(np.frombuffer(jpeg, np.uint8), cv2.IMREAD_COLOR)
        if img is None:
            raise ValueError("畫面讀不出來")
        h, w = img.shape[:2]
        s = SIZE / max(h, w)
        small = cv2.cvtColor(cv2.resize(img, (round(w * s), round(h * s))), cv2.COLOR_BGR2RGB).astype(np.float32)
        with self._lock:
            self._load()
            self._enc.setInput(small, "input_image")
            emb = self._enc.forward()
            self._emb[key] = (time.time(), emb, (h, w))
            self._used = time.time()

    def segment(self, key: str, x: float, y: float) -> list[dict[str, Any]]:
        """在 (x, y)（0～1）點一下 → 候選形狀，由小到大。要先 encode。"""
        import numpy as np

        with self._lock:
            t, emb, (h, w) = self._emb[key]
            self._load()
            s = SIZE / max(h, w)
            feed = {
                "image_embeddings": emb,
                "point_coords": np.array([[[x * w * s, y * h * s], [0, 0]]], np.float32),
                "point_labels": np.array([[1, -1]], np.float32),
                "mask_input": np.zeros((1, 1, 256, 256), np.float32),
                "has_mask_input": np.zeros(1, np.float32),
                "orig_im_size": np.array([h, w], np.float32),
            }
            for k, v in feed.items():
                self._dec.setInput(v, k)
            masks, scores = self._dec.forward(["masks", "iou_predictions"])
            self._used = time.time()
        ms = [(masks[0, k] > 0).astype(np.uint8) for k in range(masks.shape[1])]
        return pick(ms, [float(v) for v in scores.ravel()])

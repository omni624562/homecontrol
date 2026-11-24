"""手指手勢（測試中）：用姿勢模型找到手腕，沿著前臂方向把手那一塊裁出來放大，交給 MediaPipe 手部關節模型（Apache 2.0，21 個點）。

回傳每隻手：大概幾像素大、有沒有手（模型的把握）、五根手指哪幾根伸直、看起來是什麼手勢（張開、握拳、比讚、比 YA、比 1、比 3、搖滾、打電話…）。
影像不存檔（只有測試時加 save=1 才把裁下來的小圖存在 /index/handtest，給開發者看）。
"""
from __future__ import annotations

import math
import threading
import time
from pathlib import Path
from typing import Any

import cv2
import numpy as np

MODEL = Path("/models/hand/hand_landmarks_detector.tflite")
DEBUG = Path("/index/handtest")
SIZE = 224
TIPS = (8, 12, 16, 20)  # 食指、中指、無名指、小指的指尖
PIPS = (6, 10, 14, 18)  # 各自的第二關節


def fingers(lm: np.ndarray) -> list[bool]:
    """21 點（x, y）→ [拇指, 食指, 中指, 無名指, 小指] 有沒有伸直。"""
    wrist = lm[0]
    d = lambda i: float(np.linalg.norm(lm[i] - wrist))  # noqa: E731
    out = [float(np.linalg.norm(lm[4] - lm[5])) > float(np.linalg.norm(lm[3] - lm[5])) * 1.2]  # 拇指：指尖離食指根部比關節遠
    out += [d(t) > d(p) * 1.15 for t, p in zip(TIPS, PIPS)]
    return out


def gesture(f: list[bool], lm: np.ndarray) -> str:
    thumb, n = f[0], sum(f[1:])
    if n >= 4:
        return "open"
    if n == 0:
        if thumb and lm[4][1] < lm[0][1] - 0.15 * float(np.linalg.norm(lm[9] - lm[0])):
            return "thumbs_up"
        return "fist" if not thumb else "thumb"
    if f[1] and f[2] and n == 2:
        return "v"
    if f[1] and f[2] and f[3] and n == 3:
        return "three"
    if f[1] and f[4] and n == 2:
        return "rock"
    if thumb and f[4] and n == 1:
        return "call"
    if f[1] and n == 1:
        return "point"
    return f"n{n + int(thumb)}"


class Hands:
    def __init__(self) -> None:
        from ai_edge_litert.interpreter import Interpreter

        self.it = Interpreter(model_path=str(MODEL))
        self.it.allocate_tensors()
        self.inp = self.it.get_input_details()[0]
        outs = {o["name"]: o["index"] for o in self.it.get_output_details()}
        self.o_lm, self.o_pres, self.o_side = outs["Identity"], outs["Identity_1"], outs["Identity_2"]
        self.lock = threading.Lock()

    def analyze(self, img: np.ndarray, people: list[dict[str, Any]], save: bool = False) -> list[dict[str, Any]]:
        H, W = img.shape[:2]
        out = []
        for pi, p in enumerate(people):
            kp = p.get("kp")
            if not kp:
                continue
            for side, (e, w) in (("left", (7, 9)), ("right", (8, 10))):
                if kp[e][2] < 0.3 or kp[w][2] < 0.3:
                    continue
                ex, ey, wx, wy = kp[e][1] * W, kp[e][0] * H, kp[w][1] * W, kp[w][0] * H
                fore = math.hypot(wx - ex, wy - ey)
                if fore < 10:
                    continue
                cx, cy = wx + (wx - ex) * 0.6, wy + (wy - ey) * 0.6  # 手掌中心大概在手腕再往前一點
                half = max(fore * 0.9, 24)
                x0, y0, x1, y1 = int(cx - half), int(cy - half), int(cx + half), int(cy + half)
                crop = np.zeros((y1 - y0, x1 - x0, 3), np.uint8)
                sx0, sy0, sx1, sy1 = max(0, x0), max(0, y0), min(W, x1), min(H, y1)
                if sx1 <= sx0 or sy1 <= sy0:
                    continue
                crop[sy0 - y0:sy1 - y0, sx0 - x0:sx1 - x0] = img[sy0:sy1, sx0:sx1]
                x = cv2.resize(cv2.cvtColor(crop, cv2.COLOR_BGR2RGB), (SIZE, SIZE)).astype(np.float32)[None] / 255.0
                with self.lock:
                    self.it.set_tensor(self.inp["index"], x)
                    self.it.invoke()
                    lm = self.it.get_tensor(self.o_lm).reshape(21, 3)[:, :2]
                    pres = float(self.it.get_tensor(self.o_pres).reshape(-1)[0])
                if pres > 1 or pres < 0:  # 有的版本輸出的是 logit
                    pres = 1 / (1 + math.exp(-pres))
                f = fingers(lm)
                g = gesture(f, lm) if pres >= 0.5 else None
                scale = (x1 - x0) / SIZE
                pts = [[round((x0 + px * scale) / W, 4), round((y0 + py * scale) / H, 4)] for px, py in lm]
                item = {"person": pi, "side": side, "px": int(2 * half), "presence": round(pres, 2), "fingers": f, "gesture": g, "points": pts}
                if save:
                    DEBUG.mkdir(parents=True, exist_ok=True)
                    vis = cv2.resize(crop, (SIZE, SIZE))
                    for px, py in lm:
                        cv2.circle(vis, (int(px), int(py)), 3, (0, 255, 0), -1)
                    cv2.putText(vis, f"{g} {pres:.2f}", (4, 18), 0, 0.55, (0, 255, 255), 2)
                    cv2.imwrite(str(DEBUG / f"{int(time.time() * 10)}_{pi}_{side}.jpg"), vis)
                out.append(item)
        return out

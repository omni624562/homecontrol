"""攝影機的其他判斷：跌倒（MoveNet 姿勢，Apache 2.0）、開門（框出門的位置，跟「門關著」的樣子比）。

都在樹莓派上跑、不存影像。寵物（貓、狗）用的是 camera.Detector 同一個物件辨識模型。
"""
from __future__ import annotations

import base64
import math
import threading
from typing import Any

from .camera import MODEL

POSE_MODEL = MODEL.parent / "movenet_multipose.tflite"
POSE_W = 448  # 姿勢模型的輸入寬度（32 的倍數）
POSE_MIN = 0.15  # 姿勢分數到這裡才看（躺著的人分數本來就比較低；有沒有人已經由物件辨識確認）
UPRIGHT_DEG = 30  # 軀幹跟垂直線的角度：這以下算直的
FLAT_DEG = 60  # 這以上算橫躺
STAND_ASPECT = 1.6  # 身形「高 / 寬」到這裡算站著（坐著大約 1～1.4）
FALL_FROM = 3  # 秒：站著之後這麼快就變成橫躺，才可能是跌倒（慢慢坐下再躺下不算）
FALL_HOLD = 20  # 秒：橫躺超過這麼久沒起來才通知

DOOR_SIZE = 64  # 門的那一塊縮成 64×64 比
DOOR_OPEN = 0.45  # 跟「門關著」最像的那張相似度低於這個 → 門開了
DOOR_CLOSED = 0.65  # 回到這個以上 → 門關了
DOOR_FRAMES = 2  # 連續幾張才算（一張晃動不算）


def torso_deg(kp: list[list[float]]) -> float | None:
    """17 個關節點（y, x, 分數）→ 軀幹（肩膀中點到髖部中點）跟垂直線的角度。"""
    if min(kp[5][2], kp[6][2], kp[11][2], kp[12][2]) < 0.1:
        return None
    sy, sx = (kp[5][0] + kp[6][0]) / 2, (kp[5][1] + kp[6][1]) / 2
    hy, hx = (kp[11][0] + kp[12][0]) / 2, (kp[11][1] + kp[12][1]) / 2
    return math.degrees(math.atan2(abs(hx - sx), abs(hy - sy) + 1e-6))


def posture(p: dict[str, Any]) -> str:
    """一個人的姿勢：stand（站著）、flat（橫躺）、other（坐著、蹲著、看不出來）。"""
    deg = p.get("torso")
    if deg is None:
        return "other"
    if deg >= FLAT_DEG and p["aspect"] < 1.0:
        return "flat"
    if deg <= UPRIGHT_DEG and p["aspect"] >= STAND_ASPECT:
        return "stand"
    return "other"


def fall_track(st: dict[str, Any], people: list[dict[str, Any]], now: float) -> str | None:
    """更新跌倒的狀態，回傳 "fall"（剛判斷跌倒，要通知）或 None。

    st：{"stand": 最後一次看到有人站著, "flat": 從什麼時候開始橫躺（而且是站著之後很快躺下的）, "sent": 這次通知過了沒}
    """
    kinds = [posture(p) for p in people]
    if "stand" in kinds:
        st["stand"] = now
        st["flat"] = None
        st["sent"] = False
        return None
    if "flat" in kinds:
        if st.get("flat") is None:
            # 剛躺下：前幾秒還站著才算（慢慢坐下再躺下不算）
            st["flat"] = now if now - (st.get("stand") or 0) <= FALL_FROM else False
        if st["flat"] and not st.get("sent") and now - st["flat"] >= FALL_HOLD:
            st["sent"] = True
            return "fall"
        return None
    return None  # 坐著、看不出來、被擋住：保持原狀（只有再站起來才算沒事）


class Pose:
    """MoveNet MultiPose：最多 6 個人的 17 個關節點和框。第一次用到才載入。"""

    def __init__(self) -> None:
        self._it = None
        self._lock = threading.Lock()
        self._size: tuple[int, int] | None = None

    def analyze(self, jpeg: bytes) -> list[dict[str, Any]]:
        import io

        import numpy as np
        from PIL import Image

        with self._lock:
            if self._it is None:
                from ai_edge_litert.interpreter import Interpreter

                self._it = Interpreter(model_path=str(POSE_MODEL), num_threads=1)
                self._inp = self._it.get_input_details()[0]
            img = Image.open(io.BytesIO(jpeg))
            img.draft("RGB", (POSE_W * 2, POSE_W * 2))
            img = img.convert("RGB")
            w, h = img.size
            s = POSE_W / max(w, h)
            nw, nh = max(32, int(w * s) // 32 * 32), max(32, int(h * s) // 32 * 32)
            if self._size != (nw, nh):
                self._it.resize_tensor_input(self._inp["index"], [1, nh, nw, 3])
                self._it.allocate_tensors()
                self._size = (nw, nh)
            x = np.asarray(img.resize((nw, nh)), dtype=self._inp["dtype"])[None]
            self._it.set_tensor(self._inp["index"], x)
            self._it.invoke()
            out = self._it.get_tensor(self._it.get_output_details()[0]["index"])[0]
        people = []
        for p in out:
            if float(p[55]) < POSE_MIN:
                continue
            kp = p[:51].reshape(17, 3).tolist()
            y0, x0, y1, x1 = (float(v) for v in p[51:55])
            bw, bh = max(1e-6, (x1 - x0) * w), max(1e-6, (y1 - y0) * h)  # 換回原圖的像素比例
            ank = [k for k in (kp[15], kp[16]) if k[2] >= 0.2]  # 左右腳踝（y, x, 分數）
            ft = (sum(k[1] for k in ank) / len(ank), sum(k[0] for k in ank) / len(ank)) if ank else ((x0 + x1) / 2, y1)
            people.append({"score": float(p[55]), "torso": torso_deg(kp), "aspect": bh / bw,
                           "box": (int(x0 * w), int(y0 * h), int(bw), int(bh)), "foot": (min(1.0, max(0.0, ft[0])), min(1.0, max(0.0, ft[1])))})
        return people


# ---- 開門：框出門的那一塊，跟「門關著」時記住的樣子比（用邊緣比，不怕亮度變化）----

def poly_bbox(poly: list[list[float]]) -> list[float]:
    """多邊形（0～1 的頂點）→ 外框 [x, y, w, h]。"""
    xs, ys = [p[0] for p in poly], [p[1] for p in poly]
    return [min(xs), min(ys), max(xs) - min(xs), max(ys) - min(ys)]


def door_sig(jpeg: bytes, rect: list[float], poly: list[list[float]] | None = None) -> Any:
    """門那一塊的「樣子」：灰階 → 邊緣 → 模糊，縮成 64×64。

    rect 是 0～1 的 [x, y, w, h]；有 poly（多邊形的頂點）就只看多邊形裡面（斜斜的門不會包進牆和地板）。
    """
    import cv2
    import numpy as np

    img = cv2.imdecode(np.frombuffer(jpeg, np.uint8), cv2.IMREAD_GRAYSCALE)
    if img is None:
        raise ValueError("讀不到畫面")
    H, W = img.shape
    if poly:
        rect = poly_bbox(poly)
    x, y, w, h = rect
    x0, y0 = int(max(0, x) * W), int(max(0, y) * H)
    x1, y1 = int(min(1, x + w) * W), int(min(1, y + h) * H)
    if x1 - x0 < 8 or y1 - y0 < 8:
        raise ValueError("框太小了")
    crop = cv2.resize(img[y0:y1, x0:x1], (DOOR_SIZE, DOOR_SIZE), interpolation=cv2.INTER_AREA)
    crop = cv2.equalizeHist(crop)
    edges = cv2.Canny(cv2.GaussianBlur(crop, (3, 3), 0), 50, 150)
    if poly:
        # 多邊形換到 64×64 的座標，外面的邊緣不算
        pts = np.array([[(px * W - x0) / max(1, x1 - x0) * DOOR_SIZE, (py * H - y0) / max(1, y1 - y0) * DOOR_SIZE] for px, py in poly], np.int32)
        m = np.zeros((DOOR_SIZE, DOOR_SIZE), np.uint8)
        cv2.fillPoly(m, [pts], 255)
        edges = cv2.bitwise_and(edges, m)
    return cv2.GaussianBlur(edges.astype(np.float32), (7, 7), 0)


def sig_encode(sig: Any) -> str:
    import numpy as np

    return base64.b64encode(np.clip(sig, 0, 255).astype(np.uint8).tobytes()).decode()


def sig_decode(s: str) -> Any:
    import numpy as np

    return np.frombuffer(base64.b64decode(s), np.uint8).astype(np.float32).reshape(DOOR_SIZE, DOOR_SIZE)


def door_score(sig: Any, refs: list[Any]) -> float:
    """跟每張「門關著」的樣子算相關係數，取最像的（白天、晚上各記一張就好）。"""
    import numpy as np

    best = 0.0
    a = sig - sig.mean()
    na = float(np.linalg.norm(a))
    for r in refs:
        b = r - r.mean()
        nb = float(np.linalg.norm(b))
        if na and nb:
            best = max(best, float((a * b).sum() / (na * nb)))
    return best


def door_track(st: dict[str, Any], score: float) -> str | None:
    """更新門的狀態，回傳 "open"、"close" 或 None。st：{"open": 門開著嗎, "n": 連續幾張跟現在狀態相反}"""
    want = score < DOOR_OPEN if not st.get("open") else score < DOOR_CLOSED
    if want == bool(st.get("open")):
        st["n"] = 0
        return None
    st["n"] = st.get("n", 0) + 1
    if st["n"] < DOOR_FRAMES:
        return None
    st["open"], st["n"] = want, 0
    return "open" if want else "close"

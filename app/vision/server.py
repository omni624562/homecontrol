"""影像模型服務：跑在 Jetson 上。樹莓派把攝影機畫面丟過來，所有用到模型的判斷都在這裡算。

- 認人、認物：YOLOX（Apache 2.0，Megvii），TensorRT FP16，GPU
- 點一下就框：MobileSAM 編碼器 TensorRT FP16（GPU）；有引擎檔就用，沒有就用 OpenCV；解碼器用 OpenCV
- 姿勢（MoveNet）、找臉（YuNet）＋臉的特徵（SFace）：跟樹莓派同一份程式（plughub/vision.py、faces.py）、同一組模型，
  算出來的結果一模一樣（已經登記的臉不用重登）；比對是誰、存家人的臉特徵，還是在樹莓派
- 只有樹莓派能用：每個請求都要帶 token（跟錄影機同一組，VISION_TOKEN）
- 影像只在記憶體裡，不存檔

API（都要 Authorization: Bearer <token>；POST 的 body 都是 JPEG）：
  POST /detect                → {"ms", "w", "h", "objects": [{"cls", "name", "score", "box": [x, y, w, h]（0～1）}]}
  POST /pose                  → {"ms", "people": [{"score", "torso", "aspect", "box", "foot"}]}
  POST /faces                 → {"ms", "faces": [{"w", "score", "clear", "box", "feat": [128 個數字]}]}
  POST /segment?key=&x=&y=    → {"ms", "shapes": [...]}；body 是 JPEG 就重新編碼，空的就用這個 key 60 秒內的編碼（沒有 → 409）
  GET  /status                模型、平均耗時、處理了幾張
"""
from __future__ import annotations

import hmac
import json
import logging
import os
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import cv2
import numpy as np
import tensorrt as trt

try:
    from cuda.bindings import runtime as cudart
except ImportError:  # 舊版 cuda-python
    from cuda import cudart

os.environ.setdefault("PLUGHUB_MODEL", str(Path(os.environ.get("VISION_MODELS", "/models")) / "efficientdet_lite0.tflite"))
from plughub import faces as faces_mod  # noqa: E402  跟樹莓派同一份程式
from plughub import segment as seg_mod  # noqa: E402
from plughub import vision as vision_mod  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
LOG = logging.getLogger("vision")

MODELS = Path(os.environ.get("VISION_MODELS", "/models"))
MODEL = os.environ.get("VISION_MODEL", "yolox_m")
PORT = int(os.environ.get("VISION_PORT", "8210"))
TOKEN = os.environ.get("VISION_TOKEN", "")
SIZE = 640
MIN_SCORE = 0.25  # 低於這個的不回傳
NMS_IOU = 0.45
MAX_BODY = 8 * 1024 * 1024
SAM_H, SAM_W = 576, 1024  # MobileSAM 編碼器引擎的輸入（16:9 的畫面縮到長邊 1024）
COCO = ("person bicycle car motorcycle airplane bus train truck boat traffic_light fire_hydrant stop_sign parking_meter bench bird cat dog horse "
        "sheep cow elephant bear zebra giraffe backpack umbrella handbag tie suitcase frisbee skis snowboard sports_ball kite baseball_bat "
        "baseball_glove skateboard surfboard tennis_racket bottle wine_glass cup fork knife spoon bowl banana apple sandwich orange broccoli "
        "carrot hot_dog pizza donut cake chair couch potted_plant bed dining_table toilet tv laptop mouse remote keyboard cell_phone microwave "
        "oven toaster sink refrigerator book clock vase scissors teddy_bear hair_drier toothbrush").split()


def _ck(res):
    err = res[0]
    if err != cudart.cudaError_t.cudaSuccess:
        raise RuntimeError(f"CUDA 錯誤：{err}")
    return res[1] if len(res) == 2 else res[1:]


class Trt:
    """一個 TensorRT 引擎（固定輸入大小；一次一個請求，用鎖排隊）。"""

    def __init__(self, plan: Path) -> None:
        self.engine = trt.Runtime(trt.Logger(trt.Logger.WARNING)).deserialize_cuda_engine(plan.read_bytes())
        self.ctx = self.engine.create_execution_context()
        self.stream = _ck(cudart.cudaStreamCreate())
        self.bufs: dict[str, tuple[np.ndarray, int, bool]] = {}
        for i in range(self.engine.num_io_tensors):
            n = self.engine.get_tensor_name(i)
            host = np.empty(tuple(self.engine.get_tensor_shape(n)), trt.nptype(self.engine.get_tensor_dtype(n)))
            dev = _ck(cudart.cudaMalloc(host.nbytes))
            self.ctx.set_tensor_address(n, dev)
            self.bufs[n] = (host, dev, self.engine.get_tensor_mode(n) == trt.TensorIOMode.INPUT)
        self.inp = next(n for n, b in self.bufs.items() if b[2])
        self.out = next(n for n, b in self.bufs.items() if not b[2])
        self.lock = threading.Lock()

    def infer(self, x: np.ndarray) -> np.ndarray:
        with self.lock:
            hin, din, _ = self.bufs[self.inp]
            hout, dout, _ = self.bufs[self.out]
            np.copyto(hin, x.reshape(hin.shape))
            _ck(cudart.cudaMemcpyAsync(din, hin.ctypes.data, hin.nbytes, cudart.cudaMemcpyKind.cudaMemcpyHostToDevice, self.stream))
            self.ctx.execute_async_v3(self.stream)
            _ck(cudart.cudaMemcpyAsync(hout.ctypes.data, dout, hout.nbytes, cudart.cudaMemcpyKind.cudaMemcpyDeviceToHost, self.stream))
            _ck(cudart.cudaStreamSynchronize(self.stream))
            return hout.copy()


def build(onnx: Path, plan: Path, *extra: str) -> Path:
    if not plan.exists():
        LOG.info("第一次用 %s：轉成 TensorRT 引擎（要好幾分鐘）", onnx.name)
        subprocess.run(["/usr/src/tensorrt/bin/trtexec", f"--onnx={onnx}", f"--saveEngine={plan}", "--fp16", *extra], check=True, capture_output=True)
    return plan


class Detector:
    """YOLOX：80 類物件。"""

    def __init__(self, name: str) -> None:
        self.trt = Trt(build(MODELS / f"{name}.onnx", MODELS / f"{name}.fp16.engine"))
        g = []
        for s in (8, 16, 32):  # YOLOX 的格子：每格的位置和大小
            n = SIZE // s
            yy, xx = np.meshgrid(np.arange(n), np.arange(n), indexing="ij")
            g.append(np.stack([xx.ravel(), yy.ravel(), np.full(n * n, s)], 1))
        self.grid = np.concatenate(g).astype(np.float32)

    def detect(self, img: np.ndarray) -> list[dict]:
        h, w = img.shape[:2]
        r = min(SIZE / h, SIZE / w)
        pad = np.full((SIZE, SIZE, 3), 114, np.uint8)
        pad[: int(h * r), : int(w * r)] = cv2.resize(img, (int(w * r), int(h * r)), interpolation=cv2.INTER_LINEAR)
        out = self.trt.infer(np.ascontiguousarray(pad.transpose(2, 0, 1)[None], dtype=np.float32))[0]  # (8400, 85)
        xy = (out[:, :2] + self.grid[:, :2]) * self.grid[:, 2:3]
        wh = np.exp(out[:, 2:4]) * self.grid[:, 2:3]
        cls = out[:, 5:].argmax(1)
        score = out[:, 4] * out[np.arange(len(out)), 5 + cls]
        keep = score >= MIN_SCORE
        xy, wh, cls, score = xy[keep], wh[keep], cls[keep], score[keep]
        boxes = np.concatenate([xy - wh / 2, wh], 1) / r
        objs = []
        if len(score):
            idx = cv2.dnn.NMSBoxesBatched(boxes.tolist(), score.tolist(), cls.tolist(), MIN_SCORE, NMS_IOU)
            for i in np.array(idx).ravel()[:100]:
                bx, by, bw, bh = boxes[i]
                objs.append({"cls": int(cls[i]), "name": COCO[int(cls[i])], "score": round(float(score[i]), 3),
                             "box": [round(max(0.0, float(bx) / w), 4), round(max(0.0, float(by) / h), 4), round(float(bw) / w, 4), round(float(bh) / h, 4)]})
        return sorted(objs, key=lambda o: -o["score"])


class Segmenter(seg_mod.Segmenter):
    """MobileSAM：編碼器有 TensorRT 引擎就用 GPU，不然跟樹莓派一樣用 OpenCV；解碼器用 OpenCV。"""

    def __init__(self) -> None:
        super().__init__()
        plan = MODELS / f"sam_encoder_{SAM_H}x{SAM_W}.fp16.engine"
        self.gpu: Trt | None = None
        try:
            self.gpu = Trt(build(seg_mod.ENCODER, plan, f"--shapes=input_image:{SAM_H}x{SAM_W}x3"))
        except Exception as err:  # noqa: BLE001
            LOG.warning("MobileSAM 編碼器沒辦法用 GPU，改用 OpenCV：%s", err)

    def free_if_idle(self) -> None:  # 這台記憶體夠：模型一直留著
        pass

    def encode(self, key: str, jpeg: bytes) -> None:
        img = cv2.imdecode(np.frombuffer(jpeg, np.uint8), cv2.IMREAD_COLOR)
        if img is None:
            raise ValueError("不是 JPEG")
        h, w = img.shape[:2]
        if self.gpu is None or round(h * SAM_W / w) != SAM_H:  # 不是 16:9：用 OpenCV（任何大小都可以）
            return super().encode(key, jpeg)
        small = cv2.cvtColor(cv2.resize(img, (SAM_W, SAM_H)), cv2.COLOR_BGR2RGB).astype(np.float32)
        emb = self.gpu.infer(small)
        with self._lock:
            self._emb[key] = (time.time(), emb, (h, w))
            self._used = time.time()


class Stat:
    def __init__(self) -> None:
        self.count: dict[str, int] = {}
        self.ms: dict[str, float] = {}

    def add(self, k: str, ms: float) -> None:
        self.count[k] = self.count.get(k, 0) + 1
        self.ms[k] = self.ms.get(k, 0.0) + ms

    def public(self) -> dict:
        return {k: {"count": n, "avg_ms": round(self.ms[k] / n, 1)} for k, n in self.count.items()}


detector: Detector | None = None
pose = vision_mod.Pose()
faces = faces_mod.Engine()
segmenter: Segmenter | None = None
stat = Stat()


def _decode(jpeg: bytes) -> np.ndarray:
    img = cv2.imdecode(np.frombuffer(jpeg, np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError("不是 JPEG")
    return img


def handle(path: str, q: dict[str, str], body: bytes) -> tuple[int, dict]:
    t = time.perf_counter()
    if path == "/detect":
        if detector is None:
            return 503, {"error": "模型還在載入"}
        img = _decode(body)
        out = {"w": img.shape[1], "h": img.shape[0], "objects": detector.detect(img)}
    elif path == "/pose":
        out = {"people": pose.analyze(body)}
    elif path == "/faces":
        found = faces.analyze(body)
        out = {"faces": [{**f, "feat": [round(float(v), 6) for v in f["feat"]]} for f in found]}
    elif path == "/segment":
        if segmenter is None:
            return 503, {"error": "模型還在載入"}
        key = q.get("key") or ""
        try:
            x, y = float(q["x"]), float(q["y"])
        except (KeyError, ValueError):
            return 400, {"error": "要給 x、y"}
        if body:
            segmenter.encode(key, body)
        elif not segmenter.has_frame(key):
            return 409, {"error": "要先給畫面"}
        out = {"shapes": segmenter.segment(key, min(1.0, max(0.0, x)), min(1.0, max(0.0, y)))}
    else:
        return 404, {"error": "沒有這個"}
    ms = (time.perf_counter() - t) * 1000
    stat.add(path.strip("/"), ms)
    return 200, {"ms": round(ms, 1), **out}


class Handler(BaseHTTPRequestHandler):
    server_version = "vision"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt: str, *args) -> None:
        pass

    def _json(self, code: int, obj: dict) -> None:
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _auth(self) -> bool:
        got = (self.headers.get("Authorization") or "").removeprefix("Bearer ").strip()
        if not TOKEN or not hmac.compare_digest(TOKEN, got):
            self._json(401, {"error": "token 不對"})
            return False
        return True

    def do_GET(self) -> None:  # noqa: N802
        if not self._auth():
            return
        if self.path == "/status":
            self._json(200, {"model": MODEL, "ready": detector is not None and segmenter is not None,
                             "sam_gpu": bool(segmenter and segmenter.gpu), "stats": stat.public()})
            return
        self._json(404, {"error": "沒有這個"})

    def do_POST(self) -> None:  # noqa: N802
        data = self.rfile.read(min(int(self.headers.get("Content-Length") or 0), MAX_BODY))
        if not self._auth():
            return
        u = urlparse(self.path)
        try:
            code, obj = handle(u.path, {k: v[0] for k, v in parse_qs(u.query).items()}, data)
        except ValueError as err:
            code, obj = 400, {"error": str(err)}
        except Exception as err:  # noqa: BLE001
            LOG.exception("處理 %s 失敗", u.path)
            code, obj = 500, {"error": str(err)[:200]}
        self._json(code, obj)


def main() -> None:
    global detector, segmenter
    if not TOKEN:
        raise SystemExit("要給 VISION_TOKEN")
    srv = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    LOG.info("影像模型服務：port %s，載入 %s…", PORT, MODEL)
    detector = Detector(MODEL)
    blank = cv2.imencode(".jpg", np.zeros((1080, 1920, 3), np.uint8))[1].tobytes()
    detector.detect(_decode(blank))  # 暖機
    pose.analyze(blank)
    faces.analyze(blank)
    segmenter = Segmenter()
    LOG.info("準備好了（MobileSAM 編碼器：%s）", "GPU" if segmenter.gpu else "OpenCV")
    threading.Event().wait()


if __name__ == "__main__":
    main()

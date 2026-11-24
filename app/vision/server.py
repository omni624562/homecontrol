"""GPU 物件辨識服務：跑在 Jetson 上，樹莓派把攝影機畫面丟過來，回傳看到什麼。

- 模型：YOLOX（Apache 2.0，Megvii），COCO 80 類；TensorRT FP16 引擎（第一次啟動時用 trtexec 從 ONNX 轉，之後直接載入）
- 只有樹莓派能用：每個請求都要帶 token（跟錄影機同一組，VISION_TOKEN）
- 影像只在記憶體裡，不存檔

API（都要 Authorization: Bearer <token>）：
  POST /detect   body = JPEG → {"ms", "w", "h", "objects": [{"cls", "name", "score", "box": [x, y, w, h]（0～1）}]}
  GET  /status   模型、平均耗時、處理了幾張
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

import cv2
import numpy as np
import tensorrt as trt
try:
    from cuda.bindings import runtime as cudart
except ImportError:  # 舊版 cuda-python
    from cuda import cudart

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


class Engine:
    """一個 TensorRT 引擎（一次一張；用鎖排隊）。"""

    def __init__(self, name: str) -> None:
        onnx, plan = MODELS / f"{name}.onnx", MODELS / f"{name}.fp16.engine"
        if not plan.exists():
            LOG.info("第一次用 %s：轉成 TensorRT 引擎（要好幾分鐘）", name)
            subprocess.run(["/usr/src/tensorrt/bin/trtexec", f"--onnx={onnx}", f"--saveEngine={plan}", "--fp16"], check=True, capture_output=True)
        logger = trt.Logger(trt.Logger.WARNING)
        self.engine = trt.Runtime(logger).deserialize_cuda_engine(plan.read_bytes())
        self.ctx = self.engine.create_execution_context()
        self.stream = _ck(cudart.cudaStreamCreate())
        self.bufs = {}
        for i in range(self.engine.num_io_tensors):
            n = self.engine.get_tensor_name(i)
            shape = tuple(self.engine.get_tensor_shape(n))
            dtype = trt.nptype(self.engine.get_tensor_dtype(n))
            host = np.empty(shape, dtype)
            dev = _ck(cudart.cudaMalloc(host.nbytes))
            self.ctx.set_tensor_address(n, dev)
            mode = self.engine.get_tensor_mode(n)
            self.bufs[n] = (host, dev, mode == trt.TensorIOMode.INPUT)
        self.inp = next(n for n, b in self.bufs.items() if b[2])
        self.out = next(n for n, b in self.bufs.items() if not b[2])
        self.lock = threading.Lock()
        self.count, self.total_ms = 0, 0.0
        g = []
        for s in (8, 16, 32):  # YOLOX 的格子：每格的位置和大小
            n = SIZE // s
            yy, xx = np.meshgrid(np.arange(n), np.arange(n), indexing="ij")
            g.append(np.stack([xx.ravel(), yy.ravel(), np.full(n * n, s)], 1))
        self.grid = np.concatenate(g).astype(np.float32)

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

    def detect(self, jpeg: bytes) -> dict:
        t = time.perf_counter()
        img = cv2.imdecode(np.frombuffer(jpeg, np.uint8), cv2.IMREAD_COLOR)
        if img is None:
            raise ValueError("不是 JPEG")
        h, w = img.shape[:2]
        r = min(SIZE / h, SIZE / w)
        pad = np.full((SIZE, SIZE, 3), 114, np.uint8)
        pad[: int(h * r), : int(w * r)] = cv2.resize(img, (int(w * r), int(h * r)), interpolation=cv2.INTER_LINEAR)
        x = np.ascontiguousarray(pad.transpose(2, 0, 1)[None], dtype=np.float32)
        out = self.infer(x)[0]  # (8400, 85)：cx, cy, w, h, 有沒有東西, 80 類
        xy = (out[:, :2] + self.grid[:, :2]) * self.grid[:, 2:3]
        wh = np.exp(out[:, 2:4]) * self.grid[:, 2:3]
        cls = out[:, 5:].argmax(1)
        score = out[:, 4] * out[np.arange(len(out)), 5 + cls]
        keep = score >= MIN_SCORE
        xy, wh, cls, score = xy[keep], wh[keep], cls[keep], score[keep]
        boxes = np.concatenate([xy - wh / 2, wh], 1) / r  # 回到原圖的 x, y, w, h
        objs = []
        if len(score):
            idx = cv2.dnn.NMSBoxesBatched(boxes.tolist(), score.tolist(), cls.tolist(), MIN_SCORE, NMS_IOU)
            for i in np.array(idx).ravel()[:100]:
                bx, by, bw, bh = boxes[i]
                objs.append({"cls": int(cls[i]), "name": COCO[int(cls[i])], "score": round(float(score[i]), 3),
                             "box": [round(max(0.0, float(bx) / w), 4), round(max(0.0, float(by) / h), 4), round(float(bw) / w, 4), round(float(bh) / h, 4)]})
        ms = (time.perf_counter() - t) * 1000
        self.count += 1
        self.total_ms += ms
        return {"ms": round(ms, 1), "w": w, "h": h, "objects": sorted(objs, key=lambda o: -o["score"])}


engine: Engine | None = None


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
            e = engine
            self._json(200, {"model": MODEL, "ready": e is not None, "count": e.count if e else 0,
                             "avg_ms": round(e.total_ms / e.count, 1) if e and e.count else None})
            return
        self._json(404, {"error": "沒有這個"})

    def do_POST(self) -> None:  # noqa: N802
        n = int(self.headers.get("Content-Length") or 0)
        data = self.rfile.read(min(n, MAX_BODY))
        if not self._auth():
            return
        if self.path != "/detect":
            self._json(404, {"error": "沒有這個"})
            return
        if engine is None:
            self._json(503, {"error": "模型還在載入"})
            return
        try:
            self._json(200, engine.detect(data))
        except ValueError as err:
            self._json(400, {"error": str(err)})


def main() -> None:
    global engine
    if not TOKEN:
        raise SystemExit("要給 VISION_TOKEN")
    srv = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    LOG.info("辨識服務：port %s，載入 %s…", PORT, MODEL)
    engine = Engine(MODEL)
    engine.detect(cv2.imencode(".jpg", np.zeros((360, 640, 3), np.uint8))[1].tobytes())  # 先跑一次暖機
    LOG.info("準備好了")
    threading.Event().wait()


if __name__ == "__main__":
    main()

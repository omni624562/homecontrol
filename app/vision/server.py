"""影像模型服務：跑在 Jetson 上。樹莓派把攝影機畫面丟過來，所有用到模型的判斷都在這裡算。

- 認人、認物：YOLOX（Apache 2.0，Megvii），TensorRT FP16，GPU
- 點一下就框：MobileSAM 編碼器 TensorRT FP16（GPU）；解碼器用 onnxruntime（很輕，CPU 就夠；這台的 OpenCV 4.8 讀不了這兩個模型）
- 姿勢：RTMO-s（Apache 2.0，OpenMMLab），onnxruntime GPU（TensorRT 轉不過它的後處理）；從上往下拍也抓得到人。
  輸出跟樹莓派的 MoveNet（plughub/vision.py）同一個格式；RTMO 載入失敗就用 MoveNet
- 找臉：YuNet（MIT）用 onnxruntime GPU，原始解析度切成 640×640 的小塊找（樹莓派是整張縮一半），小臉、遠的臉抓得到
- 臉的特徵：SFace（Apache 2.0），跟樹莓派同一個模型、同一個對齊方法（OpenCV），已經登記的臉不用重登；
  比對是誰、存家人的臉特徵，還是在樹莓派。GPU 找臉載入失敗就整個用樹莓派那份程式（plughub/faces.py）
- 只有樹莓派能用：每個請求都要帶 token（跟錄影機同一組，VISION_TOKEN）
- 影像只在記憶體裡，不存檔

API（都要 Authorization: Bearer <token>；POST 的 body 都是 JPEG）：
  POST /detect                → {"ms", "w", "h", "objects": [{"cls", "name", "score", "box": [x, y, w, h]（0～1）}]}
  POST /pose                  → {"ms", "people": [{"score", "torso", "aspect", "box", "foot"}]}
  POST /faces                 → {"ms", "faces": [{"w", "score", "clear", "box", "feat": [128 個數字]}]}
  POST /segment?key=&x=&y=    → {"ms", "shapes": [...]}；body 是 JPEG 就重新編碼，空的就用這個 key 60 秒內的編碼（沒有 → 409）
  GET  /status                模型、平均耗時、處理了幾張、每台串流的狀況
  PUT  /config                {"cams": {"id": {"url": "rtsp://...", "ignore": [...]}}}：直接看哪些攝影機的影片（stream.py）
  GET  /cams/{id}/state?since=   最新的物件、追蹤中的人、since 之後每一張的腳的位置
  GET  /cams/{id}/frame.jpg      最新一張畫面
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
from stream import Streams  # noqa: E402

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


def build(onnx: Path, plan: Path, *extra: str, fp16: bool = True) -> Path:
    if not plan.exists():
        LOG.info("第一次用 %s：轉成 TensorRT 引擎（要好幾分鐘）", onnx.name)
        subprocess.run(["/usr/src/tensorrt/bin/trtexec", f"--onnx={onnx}", f"--saveEngine={plan}", *(["--fp16"] if fp16 else []), *extra],
                       check=True, capture_output=True)
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
    """MobileSAM：編碼器 TensorRT FP32（GPU；FP16 算出來的特徵不對，實測過）；解碼器 onnxruntime。
    輸入固定 16:9，其他比例先補黑邊。啟動時跟 CPU 版比一次，GPU 的結果不對就改用 CPU（約 3 秒）。"""

    def __init__(self) -> None:
        super().__init__()
        import onnxruntime as ort

        self.ort = ort.InferenceSession(str(seg_mod.DECODER), providers=GPU)
        self.cpu = ort.InferenceSession(str(seg_mod.ENCODER), providers=["CPUExecutionProvider"])
        self.gpu: Trt | None = None
        try:
            self.gpu = Trt(build(seg_mod.ENCODER, MODELS / f"sam_encoder_{SAM_H}x{SAM_W}.fp32.engine", f"--shapes=input_image:{SAM_H}x{SAM_W}x3", fp16=False))
            test = np.ascontiguousarray(np.tile(np.linspace(0, 255, SAM_W, dtype=np.float32)[None, :, None], (SAM_H, 1, 3)))
            a, b = self.gpu.infer(test), self.cpu.run(None, {"input_image": test})[0]
            diff = float(np.abs(a - b).mean() / (np.abs(b).mean() + 1e-6))
            if not diff < 0.05:
                LOG.warning("MobileSAM 的 GPU 結果跟 CPU 差太多（%.2f），改用 CPU", diff)
                self.gpu = None
        except Exception as err:  # noqa: BLE001
            LOG.warning("MobileSAM 編碼器沒辦法用 GPU，改用 CPU：%s", err)
            self.gpu = None

    def free_if_idle(self) -> None:  # 這台記憶體夠：模型一直留著
        pass

    def encode(self, key: str, jpeg: bytes) -> None:
        img = cv2.imdecode(np.frombuffer(jpeg, np.uint8), cv2.IMREAD_COLOR)
        if img is None:
            raise ValueError("不是 JPEG")
        h, w = img.shape[:2]
        s = min(SAM_W / w, SAM_H / h)
        canvas = np.zeros((SAM_H, SAM_W, 3), np.uint8)  # 不是 16:9 就補黑邊（點的座標照長邊縮放，跟 SAM 的做法一樣）
        canvas[: round(h * s), : round(w * s)] = cv2.resize(img, (round(w * s), round(h * s)))
        x = cv2.cvtColor(canvas, cv2.COLOR_BGR2RGB).astype(np.float32)
        emb = self.gpu.infer(x) if self.gpu else self.cpu.run(None, {"input_image": x})[0]
        with self._lock:
            self._emb[key] = (time.time(), emb, (h, w, s))
            self._used = time.time()

    def segment(self, key: str, x: float, y: float) -> list[dict]:
        with self._lock:
            _, emb, (h, w, s) = self._emb[key]
            masks, scores = self.ort.run(["masks", "iou_predictions"], {
                "image_embeddings": emb,
                "point_coords": np.array([[[x * w * s, y * h * s], [0, 0]]], np.float32),
                "point_labels": np.array([[1, -1]], np.float32),
                "mask_input": np.zeros((1, 1, 256, 256), np.float32),
                "has_mask_input": np.zeros(1, np.float32),
                "orig_im_size": np.array([h, w], np.float32),
            })
            self._used = time.time()
        ms = [(masks[0, k] > 0).astype(np.uint8) for k in range(masks.shape[1])]
        return seg_mod.pick(ms, [float(v) for v in scores.ravel()])


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
GPU = ["CUDAExecutionProvider", "CPUExecutionProvider"]
POSE_MIN = 0.3  # RTMO：人的分數至少這樣


class RtmoPose:
    """RTMO：一次找出所有人和 17 個關節點（COCO 順序，跟 MoveNet 一樣）。"""

    def __init__(self) -> None:
        import onnxruntime as ort

        self.s = ort.InferenceSession(str(MODELS / "rtmo_s.onnx"), providers=GPU)
        self.lock = threading.Lock()

    def analyze(self, jpeg: bytes) -> list[dict]:
        img = _decode(jpeg)
        h, w = img.shape[:2]
        r = min(640 / h, 640 / w)
        pad = np.full((640, 640, 3), 114, np.uint8)
        pad[: int(h * r), : int(w * r)] = cv2.resize(img, (int(w * r), int(h * r)))
        with self.lock:
            dets, kps = self.s.run(None, {"input": np.ascontiguousarray(pad.transpose(2, 0, 1)[None], dtype=np.float32)})
        people = []
        for b, kp in zip(dets[0], kps[0]):
            if float(b[4]) < POSE_MIN:
                continue
            x0, y0, x1, y1 = (float(v) / r for v in b[:4])
            k = [[float(p[1]) / r / h, float(p[0]) / r / w, float(p[2])] for p in kp]  # → (y, x, 分數)，0～1，跟 MoveNet 一樣
            bw, bh = max(1e-6, x1 - x0), max(1e-6, y1 - y0)
            ank = [q for q in (k[15], k[16]) if q[2] >= 0.3]
            ft = (sum(q[1] for q in ank) / len(ank), sum(q[0] for q in ank) / len(ank)) if ank else ((x0 + x1) / 2 / w, y1 / h)
            people.append({"score": round(float(b[4]), 3), "torso": vision_mod.torso_deg(k), "aspect": bh / bw,
                           "box": (int(x0), int(y0), int(bw), int(bh)), "foot": (min(1.0, max(0.0, ft[0])), min(1.0, max(0.0, ft[1])))})
        return people


class FaceGpu:
    """YuNet 找臉（GPU，切塊、原始解析度）＋ SFace 特徵（OpenCV）。輸出跟 plughub/faces.Engine.analyze 一樣。"""

    TILE = 640
    MIN_SCORE = 0.7

    def __init__(self) -> None:
        import onnxruntime as ort

        self.det = ort.InferenceSession(str(faces_mod.DET_MODEL), providers=GPU)
        self.rec = cv2.FaceRecognizerSF.create(str(faces_mod.REC_MODEL), "")
        self.lock = threading.Lock()

    def _tiles(self, w: int, h: int) -> list[tuple[int, int]]:
        def starts(n: int) -> list[int]:
            if n <= self.TILE:
                return [0]
            k = -(-(n - 128) // (self.TILE - 128))  # 每塊重疊 128 像素：邊上的臉不會被切掉
            return [round(i * (n - self.TILE) / (k - 1)) for i in range(k)] if k > 1 else [0]
        return [(x, y) for y in starts(h) for x in starts(w)]

    def _decode(self, outs: dict, ox: int, oy: int) -> list[list[float]]:
        faces = []
        for st in (8, 16, 32):
            n = self.TILE // st
            cls, obj = outs[f"cls_{st}"][0, :, 0], outs[f"obj_{st}"][0, :, 0]
            score = np.sqrt(np.clip(cls, 0, 1) * np.clip(obj, 0, 1))
            for i in np.nonzero(score >= self.MIN_SCORE)[0]:
                r, c = divmod(int(i), n)
                b, k = outs[f"bbox_{st}"][0, i], outs[f"kps_{st}"][0, i]
                cx, cy, bw, bh = (c + b[0]) * st, (r + b[1]) * st, np.exp(b[2]) * st, np.exp(b[3]) * st
                pts = [((c + k[2 * j]) * st + ox, (r + k[2 * j + 1]) * st + oy) for j in range(5)]
                faces.append([cx - bw / 2 + ox, cy - bh / 2 + oy, bw, bh, *[v for p in pts for v in p], float(score[i])])
        return faces

    def analyze(self, jpeg: bytes) -> list[dict]:
        img = _decode(jpeg)
        h, w = img.shape[:2]
        found: list[list[float]] = []
        names = [o.name for o in self.det.get_outputs()]
        with self.lock:
            for ox, oy in self._tiles(w, h):
                tile = np.zeros((self.TILE, self.TILE, 3), np.uint8)
                part = img[oy:oy + self.TILE, ox:ox + self.TILE]
                tile[: part.shape[0], : part.shape[1]] = part
                outs = dict(zip(names, self.det.run(None, {"input": np.ascontiguousarray(tile.transpose(2, 0, 1)[None], dtype=np.float32)})))
                found += self._decode(outs, ox, oy)
        if not found:
            return []
        keep = cv2.dnn.NMSBoxes([f[:4] for f in found], [f[14] for f in found], self.MIN_SCORE, 0.3)
        out = []
        for i in np.array(keep).ravel():
            f = np.array(found[i], np.float32)
            feat = faces_mod._norm(self.rec.feature(self.rec.alignCrop(img, f)))
            wpx, score = float(f[2]), float(f[14])
            out.append({"w": wpx, "score": score, "clear": wpx >= faces_mod.CLEAR_W and score >= faces_mod.CLEAR_SCORE, "feat": feat,
                        "box": tuple(int(x) for x in f[:4])})
        return out


face_gpu: FaceGpu | None = None
pose = vision_mod.Pose()  # MoveNet：RTMO 不能用時的備案
rtmo: RtmoPose | None = None
faces = faces_mod.Engine()
segmenter: Segmenter | None = None
streams: Streams | None = None
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
        out = {"people": (rtmo or pose).analyze(body)}
    elif path == "/faces":
        found = (face_gpu or faces).analyze(body)
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
        u = urlparse(self.path)
        if u.path == "/status":
            cams = {cid: {k: v for k, v in c.state(time.time()).items() if k in ("ok", "error", "fps", "t")} for cid, c in (streams.cams.items() if streams else [])}
            self._json(200, {"model": MODEL, "pose": "rtmo-gpu" if rtmo else "movenet-cpu", "faces": "yunet-gpu" if face_gpu else "opencv", "ready": detector is not None and segmenter is not None,
                             "sam": "gpu" if segmenter and segmenter.gpu else "cpu" if segmenter else None, "stats": stat.public(), "streams": cams})
            return
        parts = u.path.strip("/").split("/")
        if len(parts) == 3 and parts[0] == "cams" and streams:
            cam = streams.get(parts[1])
            if not cam:
                self._json(404, {"error": "沒有在看這台"})
                return
            if parts[2] == "state":
                try:
                    since = float((parse_qs(u.query).get("since") or ["0"])[0])
                except ValueError:
                    since = 0.0
                self._json(200, cam.state(since))
                return
            if parts[2] == "frame.jpg":
                data = cam.jpeg()
                if not data:
                    self._json(404, {"error": "還沒有畫面"})
                    return
                self.send_response(200)
                self.send_header("Content-Type", "image/jpeg")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
                return
        self._json(404, {"error": "沒有這個"})

    def do_PUT(self) -> None:  # noqa: N802
        data = self.rfile.read(min(int(self.headers.get("Content-Length") or 0), MAX_BODY))
        if not self._auth():
            return
        if urlparse(self.path).path != "/config" or streams is None:
            self._json(404 if streams else 503, {"error": "沒有這個" if streams else "模型還在載入"})
            return
        try:
            cfg = json.loads(data or b"{}")
        except ValueError:
            self._json(400, {"error": "不是 JSON"})
            return
        self._json(200, {"ok": True, "cams": streams.configure(cfg)})

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
    global detector, segmenter, streams
    if not TOKEN:
        raise SystemExit("要給 VISION_TOKEN")
    srv = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    LOG.info("影像模型服務：port %s，載入 %s…", PORT, MODEL)
    detector = Detector(MODEL)
    blank = cv2.imencode(".jpg", np.zeros((1080, 1920, 3), np.uint8))[1].tobytes()
    detector.detect(_decode(blank))  # 暖機
    streams = Streams(detector.detect)
    global rtmo
    try:
        rtmo = RtmoPose()
        rtmo.analyze(blank)
    except Exception:  # noqa: BLE001
        LOG.exception("RTMO 載入失敗，姿勢改用 MoveNet")
        rtmo = None
        pose.analyze(blank)
    global face_gpu
    try:
        face_gpu = FaceGpu()
        face_gpu.analyze(blank)
    except Exception:  # noqa: BLE001
        LOG.exception("GPU 找臉載入失敗，改用 OpenCV")
        face_gpu = None
        faces.analyze(blank)
    try:
        segmenter = Segmenter()
    except Exception:  # noqa: BLE001  點一下就框不能用，其他照常（樹莓派會自己算）
        LOG.exception("MobileSAM 載入失敗")
    LOG.info("準備好了（點一下就框：%s）", "GPU" if segmenter and segmenter.gpu else "CPU" if segmenter else "不能用")
    threading.Event().wait()


if __name__ == "__main__":
    main()

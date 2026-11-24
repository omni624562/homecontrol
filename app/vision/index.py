"""半夜重看前一天的錄影：每台攝影機的人、狗、包包…框出來記住，算成「長什麼樣子」的數字，給摘要和打字找錄影用。

- 錄影是錄影機（app/recorder）存的 1 分鐘一段 MP4；這裡只解關鍵影格（Jetson 硬體解碼，一分鐘的影片 0.6 秒），每 2 張取 1 張
- 每張：YOLOX 找東西 → 會動的東西（人、狗、貓、包包、行李箱、腳踏車…）裁下來，SigLIP 2（Apache 2.0，多語言）算特徵
  同一個地方一直放著的東西（同類、框幾乎一樣）2 分鐘內只算一次
- 存在 /index/<攝影機>/<YYYYMMDD>.npz（時間、類別、分數、框、特徵 FP16），保留 KEEP_DAYS 天
- 摘要：有人出現的時段（中間斷不到 VISIT_GAP 秒算同一次）、每類東西出現幾次
- 找：關鍵字先對到類別（人、狗…，很準），其餘的描述用 SigLIP 排名（顏色、穿著；從上往下拍的小人比較不準）
影像不存檔；特徵是數字，看不出原本的畫面。
"""
from __future__ import annotations

import json
import logging
import threading
import time
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any, Callable

import cv2
import numpy as np

LOG = logging.getLogger("vision.index")
REC = Path("/rec")
OUT = Path("/index")
SIGLIP = Path("/models/siglip2")
KEEP_DAYS = 8
RUN_AT = 2  # 半夜 2 點開始
EVERY_KEY = 2  # 每幾張關鍵影格看一張（約 2.4 秒一張）
MIN_SCORE = 0.45
PERSON_MIN = 0.55  # 人：跟即時判斷「有人」同一個門檻（床上的被子 0.49 不算）
VISIT_GAP = 20  # 秒：人不見這麼久才算這次結束
VISIT_MIN = 2  # 至少幾張看到人才算一次「有人來」
STATIC_S = 600  # 秒：同一個地方一直放著的東西（同類、框幾乎一樣），多久才再算一次特徵
TEXT_IDLE = 600  # 秒：文字模型多久沒用就放掉（1 GB 多）
DYNAMIC = {"person", "dog", "cat", "bird", "backpack", "handbag", "suitcase", "umbrella", "bicycle", "motorcycle", "car", "truck",
           "sports_ball", "skateboard"}  # 會移動、會被帶進帶出的東西（椅子、瓶子、書這些家裡本來就有的不記）
# 中文關鍵字 → 物件類別（找的時候先篩這個）
WORDS = {"人": "person", "男": "person", "女": "person", "小孩": "person", "外送": "person", "快遞": "person", "郵差": "person",
         "狗": "dog", "貓": "cat", "鳥": "bird", "背包": "backpack", "包包": "handbag", "手提包": "handbag", "提袋": "handbag",
         "行李箱": "suitcase", "雨傘": "umbrella", "傘": "umbrella", "腳踏車": "bicycle", "單車": "bicycle", "機車": "motorcycle",
         "摩托車": "motorcycle", "汽車": "car", "車子": "car", "卡車": "truck", "球": "sports_ball", "滑板": "skateboard",
         }
# 「東西多了」時，多的是什麼（英文描述 SigLIP 比較準；名稱給人看）
ITEMS = {"包裹": ["a cardboard box", "a delivery package", "a parcel on the floor"], "袋子": ["a plastic bag", "a shopping bag", "a paper bag"],
         "垃圾袋": ["a garbage bag"], "外送餐點": ["a food delivery bag"], "鞋子": ["a pair of shoes", "shoes on the floor"],
         "雨傘": ["an umbrella"], "推車": ["a baby stroller", "a shopping cart", "a hand truck"], "腳踏車": ["a bicycle"],
         "空的": ["an empty floor", "a tiled floor", "an empty corridor", "a wall"]}
ITEM_MARGIN = 0.01  # 要比「空的」明顯像才說是什麼（實測：電風扇被看成包裹只差 0.007，紙盒差 0.026）
NAMES = {"person": "人", "dog": "狗", "cat": "貓", "bird": "鳥", "backpack": "背包", "handbag": "包包", "suitcase": "行李箱", "umbrella": "雨傘",
         "bicycle": "腳踏車", "motorcycle": "機車", "car": "汽車", "truck": "卡車"}


def _iou(a, b) -> float:
    iw = max(0.0, min(a[0] + a[2], b[0] + b[2]) - max(a[0], b[0]))
    ih = max(0.0, min(a[1] + a[3], b[1] + b[3]) - max(a[1], b[1]))
    inter = iw * ih
    return inter / (a[2] * a[3] + b[2] * b[3] - inter + 1e-9)


def seg_start(p: Path) -> float | None:
    try:
        return datetime.strptime(p.stem, "%Y%m%d-%H%M%S").timestamp()
    except ValueError:
        return None


def visits(times: np.ndarray, cls: np.ndarray) -> list[dict[str, Any]]:
    """有人的時間點 → 一次一次的「有人來」（中間斷不到 VISIT_GAP 秒算同一次）。"""
    ts = np.sort(times[cls == "person"])
    out: list[dict[str, Any]] = []
    for t in ts:
        if out and t - out[-1]["end"] <= VISIT_GAP:
            out[-1]["end"] = float(t)
            out[-1]["n"] += 1
        else:
            out.append({"start": float(t), "end": float(t), "n": 1})
    return out


class Index:
    def __init__(self, detect: Callable[[np.ndarray], list[dict[str, Any]]], gpu: list[str]) -> None:
        import onnxruntime as ort

        self.detect = detect
        self.gpu = gpu
        self.vision = ort.InferenceSession(str(SIGLIP / "vision_model_fp16.onnx"), providers=gpu)
        self.text = None
        self.text_used = 0.0
        self._labels: dict[str, np.ndarray] | None = None
        self.lock = threading.Lock()
        self.status: dict[str, Any] = {"running": False, "last": None, "error": None}
        from tokenizers import Tokenizer

        self.tok = Tokenizer.from_file(str(SIGLIP / "tokenizer.json"))
        threading.Thread(target=self._loop, daemon=True).start()

    # ---- 特徵 ----
    def _img_emb(self, crops: list[np.ndarray]) -> np.ndarray:
        x = np.stack([((cv2.resize(cv2.cvtColor(c, cv2.COLOR_BGR2RGB), (224, 224)).astype(np.float32) / 255.0 - 0.5) / 0.5).transpose(2, 0, 1) for c in crops])
        e = self.vision.run(["pooler_output"], {"pixel_values": x})[0].astype(np.float32)
        return (e / np.linalg.norm(e, axis=1, keepdims=True)).astype(np.float16)

    def _txt_emb(self, q: str) -> np.ndarray:
        import onnxruntime as ort

        with self.lock:
            if self.text is None:
                self.text = ort.InferenceSession(str(SIGLIP / "text_model_fp16.onnx"), providers=["CPUExecutionProvider"])  # GPU 記憶體留給別的
            self.text_used = time.time()
            ids = self.tok.encode(q.lower()).ids[:64]
            e = self.text.run(["pooler_output"], {"input_ids": np.array([ids + [0] * (64 - len(ids))], np.int64)})[0][0].astype(np.float32)
        return e / np.linalg.norm(e)

    # ---- 多了什麼東西（「東西多了」的區域）----
    def classify(self, img: np.ndarray, box: list[float]) -> dict[str, Any]:
        """區域裡多的是什麼：跟每種東西的描述比，最像的比「空地板」還像才算（不然就是看不出來）。"""
        h, w = img.shape[:2]
        x, y, bw, bh = box
        x0, y0, x1, y1 = int(max(0, x) * w), int(max(0, y) * h), int(min(1, x + bw) * w), int(min(1, y + bh) * h)
        if x1 - x0 < 8 or y1 - y0 < 8:
            return {"label": None}
        e = self._img_emb([img[y0:y1, x0:x1]])[0].astype(np.float32)
        if self._labels is None:
            self._labels = {name: np.stack([self._txt_emb(t) for t in texts]) for name, texts in ITEMS.items()}
        sc = {name: float((te @ e).max()) for name, te in self._labels.items()}
        best = max((k for k in sc if k != "空的"), key=lambda k: sc[k])
        label = best if sc[best] > sc["空的"] + ITEM_MARGIN else None
        return {"label": label, "scores": {k: round(v, 3) for k, v in sorted(sc.items(), key=lambda kv: -kv[1])}}

    # ---- 分析一天 ----
    def run_day(self, day: date, cams: list[str] | None = None) -> dict[str, Any]:
        done = {}
        for d in sorted(REC.iterdir()) if REC.is_dir() else []:
            if not d.is_dir() or (cams and d.name not in cams):
                continue
            segs = sorted(p for p in d.glob(f"{day:%Y%m%d}-*.mp4"))
            if segs:
                done[d.name] = self._index_cam(d.name, day, segs)
        return done

    def _index_cam(self, cam: str, day: date, segs: list[Path]) -> int:
        t0 = time.time()
        rows_t, rows_c, rows_s, rows_b, embs = [], [], [], [], []
        recent: list[tuple[float, str, list[float]]] = []  # 最近算過特徵的（時間、類別、框）：一直放著的東西不重複算
        for p in segs:
            start = seg_start(p)
            if start is None:
                continue
            cap = cv2.VideoCapture(f"filesrc location={p} ! qtdemux ! h264parse ! nvv4l2decoder skip-frames=2 ! nvvidconv ! "
                                   "video/x-raw,format=BGRx ! videoconvert ! video/x-raw,format=BGR ! appsink sync=false", cv2.CAP_GSTREAMER)
            k = 0
            while True:
                ok, img = cap.read()
                if not ok:
                    break
                k += 1
                if k % EVERY_KEY:
                    continue
                t = start + cap.get(cv2.CAP_PROP_POS_MSEC) / 1000 if cap.get(cv2.CAP_PROP_POS_MSEC) > 0 else start + k * 1.2
                h, w = img.shape[:2]
                crops, meta = [], []
                for o in self.detect(img):
                    if o["name"] not in DYNAMIC or o["score"] < (PERSON_MIN if o["name"] == "person" else MIN_SCORE):
                        continue
                    b = o["box"]
                    if o["name"] != "person" and any(c == o["name"] and t - rt < STATIC_S and _iou(rb, b) > 0.85 for rt, c, rb in recent):
                        continue
                    x0, y0, x1, y1 = int(b[0] * w), int(b[1] * h), int((b[0] + b[2]) * w), int((b[1] + b[3]) * h)
                    if x1 - x0 < 8 or y1 - y0 < 8:
                        continue
                    crops.append(img[max(0, y0):y1, max(0, x0):x1])
                    meta.append((t, o["name"], o["score"], b))
                    recent.append((t, o["name"], b))
                if crops:
                    embs.append(self._img_emb(crops))
                    for t_, c_, s_, b_ in meta:
                        rows_t.append(t_), rows_c.append(c_), rows_s.append(s_), rows_b.append(b_)
                recent = [r for r in recent if t - r[0] < STATIC_S]
            cap.release()
        out = OUT / cam
        out.mkdir(parents=True, exist_ok=True)
        np.savez_compressed(out / f"{day:%Y%m%d}.npz", t=np.array(rows_t, np.float64), cls=np.array(rows_c, dtype="U16"),
                            score=np.array(rows_s, np.float32), box=np.array(rows_b, np.float32).reshape(-1, 4),
                            emb=np.concatenate(embs) if embs else np.zeros((0, 768), np.float16))
        LOG.info("%s %s：%d 段、%d 個東西、%.0f 秒", cam, day, len(segs), len(rows_t), time.time() - t0)
        return len(rows_t)

    @staticmethod
    def _complete(cam: str, day: date, end: float) -> bool:
        """那天分析過、而且是那天結束之後才分析的（當天先分析的只有前半天，要重做）。"""
        p = OUT / cam / f"{day:%Y%m%d}.npz"
        return p.exists() and p.stat().st_mtime >= end

    # ---- 讀 ----
    def _load(self, cam: str, day: date) -> dict[str, np.ndarray] | None:
        p = OUT / cam / f"{day:%Y%m%d}.npz"
        if not p.exists():
            return None
        with np.load(p) as z:
            return {k: z[k] for k in z.files}

    def summary(self, day: date) -> dict[str, Any]:
        cams = {}
        for d in sorted(OUT.iterdir()) if OUT.is_dir() else []:
            z = self._load(d.name, day)
            if z is None:
                continue
            v = [x for x in visits(z["t"], z["cls"]) if x["n"] >= VISIT_MIN]  # 只有一張看到人的不算（扶手上掛的東西常被認成人）
            counts = {}
            for c in set(z["cls"].tolist()) - {"person"}:
                if c in NAMES:
                    counts[c] = len(visits(z["t"][z["cls"] == c], np.array(["person"] * int((z["cls"] == c).sum()))))
            cams[d.name] = {"visits": v, "counts": counts}
        return {"day": f"{day:%Y-%m-%d}", "cams": cams, "indexed": bool(cams)}

    def search(self, q: str, days: int = 7, cam: str | None = None, limit: int = 12) -> dict[str, Any]:
        q = (q or "").strip()[:80]
        if not q:
            return {"hits": []}
        want = sorted({c for w, c in WORDS.items() if w in q})
        te = self._txt_emb(q)
        hits = []
        today = date.today()
        for d in sorted(OUT.iterdir()) if OUT.is_dir() else []:
            if cam and d.name != cam:
                continue
            for i in range(days + 1):
                z = self._load(d.name, today - timedelta(days=i))
                if z is None or not len(z["t"]):
                    continue
                m = np.isin(z["cls"], want) if want else np.ones(len(z["t"]), bool)
                if not m.any():
                    continue
                sc = z["emb"][m].astype(np.float32) @ te
                for j, s in zip(np.nonzero(m)[0], sc):
                    hits.append((float(s), d.name, float(z["t"][j]), str(z["cls"][j]), z["box"][j].tolist()))
        hits.sort(reverse=True)
        out: list[dict[str, Any]] = []
        for s, c, t, cl, b in hits:  # 同一台、30 秒內的算同一筆
            if any(h["cam"] == c and abs(h["t"] - t) < 30 for h in out):
                continue
            out.append({"cam": c, "t": round(t, 1), "cls": cl, "box": [round(v, 4) for v in b], "score": round(s, 3)})
            if len(out) >= limit:
                break
        return {"hits": out, "classes": want}

    # ---- 排程 ----
    def _loop(self) -> None:
        while True:
            try:
                self._catch_up()
                with self.lock:
                    if self.text is not None and time.time() - self.text_used > TEXT_IDLE:
                        self.text = None
            except Exception as err:  # noqa: BLE001
                self.status["error"] = str(err)[:200]
                LOG.exception("分析錄影失敗")
            time.sleep(300)

    def _catch_up(self) -> None:
        """半夜 2 點後：前幾天還沒分析的（錄影還在的）補做；太舊的刪掉。"""
        now = datetime.now()
        for d in OUT.iterdir() if OUT.is_dir() else []:
            for f in d.glob("*.npz"):
                try:
                    if (now - datetime.strptime(f.stem, "%Y%m%d")).days > KEEP_DAYS:
                        f.unlink()
                except ValueError:
                    pass
        if now.hour < RUN_AT:
            return
        for i in range(KEEP_DAYS, 0, -1):
            day = (now - timedelta(days=i)).date()
            end = datetime.combine(day + timedelta(days=1), datetime.min.time()).timestamp() + 120
            todo = [d.name for d in REC.iterdir() if d.is_dir() and any(d.glob(f"{day:%Y%m%d}-*.mp4")) and not self._complete(d.name, day, end)] if REC.is_dir() else []
            if todo:
                self.status.update(running=True, day=f"{day}")
                self.run_day(day, todo)
                self.status.update(running=False, last=f"{day}", error=None)

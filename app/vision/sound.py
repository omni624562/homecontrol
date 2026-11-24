"""聽攝影機的聲音：煙霧／火災警報、玻璃破掉、有人大叫呼救、狗一直叫。YAMNet（Apache 2.0，Google；MediaPipe 版 tflite），Jetson CPU 一段約 5 毫秒。

- 每台一條 RTSP 只拿聲音（GStreamer：μ-law → 16 kHz 單聲道）；每 0.5 秒看最近 0.975 秒
- 平常聲音不存；只有偵測到時，存那一刻前後各 10 秒（WAV，/index/sounds/<攝影機>/<時間>.wav，留 7 天）
- 同一種聲音 2 分鐘內只算一次
"""
from __future__ import annotations

import csv
import logging
import subprocess
import threading
import time
import wave
from collections import deque
from pathlib import Path
from typing import Any

import numpy as np

LOG = logging.getLogger("vision.sound")
MODEL = Path("/models/yamnet/yamnet.tflite")
LABELS = Path("/models/yamnet/yamnet_class_map.csv")
OUT = Path("/index/sounds")
SR = 16000
WIN = 15600  # 0.975 秒
HOP = 0.5
KEEP_S = 25  # 記憶體裡留幾秒（事件前 10 秒 + 等事件後 10 秒）
CLIP = 10
COOLDOWN = 120
KEEP_DAYS = 7
# 種類：(YAMNet 的類別名稱, 門檻, 連續幾次才算)
GROUPS: dict[str, tuple[list[str], float, int]] = {
    "alarm": (["Smoke detector, smoke alarm", "Fire alarm"], 0.3, 3),
    "glass": (["Glass", "Shatter"], 0.35, 1),
    "scream": (["Screaming", "Yell", "Shout"], 0.4, 2),
    "dog": (["Bark", "Dog"], 0.3, 1),  # 狗：2 分鐘裡叫超過四成的時間才算「一直叫」（見 _dog）
}
DOG_SPAN = 120
DOG_RATIO = 0.4


class Model:
    def __init__(self) -> None:
        from ai_edge_litert.interpreter import Interpreter

        self.it = Interpreter(model_path=str(MODEL))
        self.it.allocate_tensors()
        self.inp = self.it.get_input_details()[0]
        self.out = self.it.get_output_details()[0]
        names = [r[2] for r in list(csv.reader(LABELS.open()))[1:]]
        self.idx = {g: [names.index(n) for n in ns if n in names] for g, (ns, _, _) in GROUPS.items()}
        self.lock = threading.Lock()

    def scores(self, wav: np.ndarray) -> dict[str, float]:
        with self.lock:
            self.it.set_tensor(self.inp["index"], wav.astype(np.float32).reshape(self.inp["shape"]))
            self.it.invoke()
            sc = self.it.get_tensor(self.out["index"]).reshape(-1)
        return {g: float(sc[ix].max()) if ix else 0.0 for g, ix in self.idx.items()}


class Listener:
    def __init__(self, cid: str, url: str, model: Model) -> None:
        self.id, self.url, self.model = cid, url, model
        self.stop = False
        self.buf: deque = deque(maxlen=int(KEEP_S * SR))
        self.lock = threading.Lock()
        self.events: deque = deque()  # (t, 種類, 分數)
        self.hits: dict[str, int] = {g: 0 for g in GROUPS}
        self.last: dict[str, float] = {}
        self.dog: deque = deque()  # (t, 有沒有叫)
        self.error: str | None = None
        self.proc: subprocess.Popen | None = None
        threading.Thread(target=self._run, daemon=True).start()

    def _run(self) -> None:
        delay = 5
        while not self.stop:
            started = time.time()
            cmd = ["gst-launch-1.0", "-q", "rtspsrc", f"location={self.url}", "protocols=tcp", "latency=200", "!", "rtppcmudepay", "!", "mulawdec", "!",
                   "audioconvert", "!", "audioresample", "!", f"audio/x-raw,format=F32LE,rate={SR},channels=1", "!", "fdsink", "fd=1"]
            try:
                self.proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
                assert self.proc.stdout
                pending = np.zeros(0, np.float32)
                step = int(HOP * SR)
                while not self.stop:
                    chunk = self.proc.stdout.read(step * 4)
                    if not chunk:
                        break
                    a = np.frombuffer(chunk, np.float32)
                    with self.lock:
                        self.buf.extend(a)
                    pending = np.concatenate([pending, a])
                    if len(pending) >= step and len(self.buf) >= WIN:
                        pending = pending[step:]
                        with self.lock:
                            w = np.array(list(self.buf)[-WIN:], np.float32)
                        self._check(self.model.scores(w), time.time())
                self.error = "聲音串流中斷" if not self.stop else None
            except Exception as err:  # noqa: BLE001
                self.error = str(err)[:200]
                LOG.exception("%s 聽聲音失敗", self.id)
            finally:
                if self.proc and self.proc.poll() is None:
                    self.proc.kill()
            if self.stop:
                break
            delay = 5 if time.time() - started > 120 else min(60, delay * 2)
            time.sleep(delay)

    def _check(self, sc: dict[str, float], now: float) -> None:
        for g, (_, thr, need) in GROUPS.items():
            if g == "dog":
                self._dog(sc[g] >= thr, now, sc[g])
                continue
            self.hits[g] = self.hits[g] + 1 if sc[g] >= thr else 0
            if self.hits[g] >= need:
                self._fire(g, sc[g], now)

    def _dog(self, barking: bool, now: float, score: float) -> None:
        self.dog.append((now, barking))
        while self.dog and now - self.dog[0][0] > DOG_SPAN:
            self.dog.popleft()
        if len(self.dog) >= DOG_SPAN / HOP * 0.9 and sum(b for _, b in self.dog) / len(self.dog) >= DOG_RATIO:
            self._fire("dog", score, now)

    def _fire(self, g: str, score: float, now: float) -> None:
        if g in self.last and now - self.last[g] < COOLDOWN:
            return
        self.last[g] = now
        self.hits[g] = 0
        t = round(now, 1)
        with self.lock:
            self.events.append((t, g, round(score, 2)))
            while self.events and now - self.events[0][0] > 600:
                self.events.popleft()
        threading.Thread(target=self._save, args=(t,), daemon=True).start()
        LOG.info("%s 聽到 %s（%.2f）", self.id, g, score)

    def _save(self, t: float) -> None:
        """事件後 10 秒，把前後各 10 秒存成 WAV。"""
        time.sleep(CLIP)
        with self.lock:
            a = np.array(list(self.buf)[-int(2 * CLIP * SR):], np.float32)
        d = OUT / self.id
        d.mkdir(parents=True, exist_ok=True)
        with wave.open(str(d / f"{int(t)}.wav"), "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(SR)
            w.writeframes((np.clip(a, -1, 1) * 32767).astype(np.int16).tobytes())
        for f in d.glob("*.wav"):
            try:
                if time.time() - int(f.stem) > KEEP_DAYS * 86400:
                    f.unlink()
            except ValueError:
                pass

    def recent(self, since: float) -> list:
        with self.lock:
            return [e for e in self.events if e[0] > since]

    def close(self) -> None:
        self.stop = True
        if self.proc and self.proc.poll() is None:
            self.proc.kill()


def clip_path(cid: str, t: int) -> Path | None:
    p = OUT / cid / f"{int(t)}.wav"
    return p if cid.replace("-", "").replace("_", "").isalnum() and p.exists() else None

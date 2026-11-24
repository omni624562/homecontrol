"""攝影機錄影機：跑在 Jetson 上，全天錄、保留幾天，給樹莓派剪出某個時間前後的影片。

- 每台攝影機一個 ffmpeg：RTSP 串流原封不動存成 1 分鐘一段的 MP4（-c copy，不重新壓縮，幾乎不吃 CPU；不錄聲音）
- 全部錄影留 keep.all 天；「有事的時段」（樹莓派送來的事件前後，存在 /data/windows.json）留 keep.event 天
- 硬碟剩不到 MIN_FREE_GB 時：先從最舊的「沒事的」刪，還不夠才刪有事的
- 只有樹莓派能用：每個請求都要帶 token（樹莓派用 PUT /config 設定攝影機時一起給；第一次由 RECORDER_TOKEN 環境變數決定）
- 攝影機帳密只存在 /data/config.json（600），API 不會回傳

API（都要 Authorization: Bearer <token>）：
  PUT /config          {"cams": {"id": "rtsp://..."}}：要錄哪些攝影機
  GET /status          每台在不在錄、最舊／最新一段、硬碟空間
  GET /clip?cam=&start=&end=   （秒，epoch）剪出那段 MP4，最長 MAX_CLIP 秒
  GET /frame?cam=&t=&w=        那個時間點的一張畫面（JPEG，寬 w，預設 640）
"""
from __future__ import annotations

import hmac
import json
import logging
import os
import re
import shutil
import subprocess
import tempfile
import threading
import time
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
LOG = logging.getLogger("recorder")

DATA = Path(os.environ.get("RECORDER_DATA", "/data"))
REC = Path(os.environ.get("RECORDER_DIR", "/rec"))
PORT = int(os.environ.get("RECORDER_PORT", "8200"))
KEEP_DAYS = float(os.environ.get("RECORDER_KEEP_DAYS", "7"))  # 樹莓派沒設定時：全部留幾天
WINDOWS = DATA / "windows.json"
win_lock = threading.Lock()


def keep_days(cfg: dict) -> tuple[float, float]:
    k = cfg.get("keep") or {}
    a = min(30.0, max(1.0, float(k.get("all") or KEEP_DAYS)))
    return a, min(90.0, max(a, float(k.get("event") or a)))


def load_windows() -> dict[str, list[list[float]]]:
    try:
        return json.loads(WINDOWS.read_text("utf-8"))
    except (FileNotFoundError, ValueError):
        return {}


def merge_windows(old: dict[str, list[list[float]]], new: dict[str, list[list[float]]], since: float) -> dict[str, list[list[float]]]:
    """有事的時段：新舊合併、重疊的接起來，太舊的丟掉。"""
    out = {}
    for cam in set(old) | set(new):
        ws = sorted([w[:2] for w in (old.get(cam) or []) + (new.get(cam) or []) if len(w) >= 2 and w[1] >= since and w[1] > w[0]])
        merged: list[list[float]] = []
        for a, b in ws:
            if merged and a <= merged[-1][1]:
                merged[-1][1] = max(merged[-1][1], b)
            else:
                merged.append([float(a), float(b)])
        if merged:
            out[cam] = merged
    return out


def in_window(ws: list[list[float]], t: float) -> bool:
    """這一段（t 開始、SEG 秒）有沒有碰到有事的時段。"""
    return any(a < t + SEG and b > t for a, b in ws)
MIN_FREE_GB = float(os.environ.get("RECORDER_MIN_FREE_GB", "50"))
SEG = 60  # 秒：一段多長
MAX_CLIP = 300  # 秒：一次最多剪多長
NAME = re.compile(r"^(\d{8}-\d{6})\.mp4$")
CAM_ID = re.compile(r"^[\w-]{1,40}$")


def load_cfg() -> dict:
    try:
        return json.loads((DATA / "config.json").read_text("utf-8"))
    except FileNotFoundError:
        return {}


def save_cfg(cfg: dict) -> None:
    DATA.mkdir(parents=True, exist_ok=True)
    tmp = DATA / "config.tmp"
    tmp.write_text(json.dumps(cfg), "utf-8")
    os.chmod(tmp, 0o600)
    tmp.replace(DATA / "config.json")


def seg_start(p: Path) -> float | None:
    m = NAME.match(p.name)
    return datetime.strptime(m.group(1), "%Y%m%d-%H%M%S").timestamp() if m else None


def segments(cam: str) -> list[tuple[float, Path]]:
    d = REC / cam
    if not d.is_dir():
        return []
    out = [(t, p) for p in d.iterdir() if (t := seg_start(p)) is not None]
    return sorted(out)


class Cam:
    """一台攝影機的 ffmpeg：斷了就重開（等待時間慢慢拉長，最多 60 秒）。"""

    def __init__(self, cid: str, url: str) -> None:
        self.id, self.url = cid, url
        self.proc: subprocess.Popen | None = None
        self.started = 0.0
        self.error: str | None = None
        self.stop = False
        self.thread = threading.Thread(target=self._run, daemon=True)
        self.thread.start()

    def _run(self) -> None:
        delay = 5
        while not self.stop:
            d = REC / self.id
            d.mkdir(parents=True, exist_ok=True)
            cmd = ["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-rtsp_transport", "tcp", "-timeout", "15000000",
                   "-i", self.url, "-map", "0:v:0", "-an", "-c", "copy",
                   "-f", "segment", "-segment_time", str(SEG), "-segment_atclocktime", "1", "-reset_timestamps", "1",
                   "-segment_format_options", "movflags=+faststart", "-strftime", "1", str(d / "%Y%m%d-%H%M%S.mp4")]
            self.started = time.time()
            try:
                self.proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
                _, err = self.proc.communicate()
                msg = (err or b"").decode(errors="replace").strip().splitlines()
                self.error = (msg[-1] if msg else f"ffmpeg 結束（{self.proc.returncode}）").replace(self.url, "攝影機")[:200]
            except Exception as e:  # noqa: BLE001
                self.error = str(e)[:200]
            if self.stop:
                break
            LOG.warning("%s 錄影中斷：%s", self.id, self.error)
            delay = 5 if time.time() - self.started > 120 else min(60, delay * 2)
            time.sleep(delay)

    def close(self) -> None:
        self.stop = True
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()

    def status(self) -> dict:
        segs = segments(self.id)
        newest = segs[-1][0] if segs else None
        # 最新一段的檔案 2 分鐘內還在變大：在錄
        live = bool(segs) and time.time() - segs[-1][1].stat().st_mtime < 120
        return {"recording": live, "oldest": segs[0][0] if segs else None, "newest": newest, "count": len(segs), "error": None if live else self.error}


cams: dict[str, Cam] = {}
lock = threading.Lock()


def apply(cfg: dict) -> None:
    with lock:
        want = {k: v for k, v in (cfg.get("cams") or {}).items() if CAM_ID.match(k) and str(v).startswith("rtsp://")}
        for cid in list(cams):
            if cid not in want or cams[cid].url != want[cid]:
                cams.pop(cid).close()
        for cid, url in want.items():
            if cid not in cams:
                cams[cid] = Cam(cid, url)


def cleanup() -> None:
    """沒事的超過 keep.all 天刪掉、有事的超過 keep.event 天刪掉；硬碟不夠時先刪最舊的沒事的。"""
    while True:
        try:
            prune()
        except Exception:  # noqa: BLE001
            LOG.exception("清理失敗")
        time.sleep(300)


def prune(now: float | None = None) -> None:
    now = now or time.time()
    all_d, ev_d = keep_days(load_cfg())
    with win_lock:
        wins = merge_windows(load_windows(), {}, now - ev_d * 86400)
    plain, kept = [], []
    for d in REC.iterdir() if REC.is_dir() else []:
        if not d.is_dir():
            continue
        ws = wins.get(d.name) or []
        for t, p in segments(d.name):
            age = now - t
            event = in_window(ws, t)
            if age > ev_d * 86400 or (age > all_d * 86400 and not event):
                p.unlink(missing_ok=True)
            else:
                (kept if event else plain).append((t, p))
    order = sorted(plain) + sorted(kept)  # 硬碟不夠：先刪沒事的
    while order and shutil.disk_usage(REC).free < MIN_FREE_GB * 1e9:
        order.pop(0)[1].unlink(missing_ok=True)


def usage() -> dict:
    """錄影用了多少：全部、其中「只因為有事才留著」（超過 keep.all 天）的。"""
    all_d, _ = keep_days(load_cfg())
    now = time.time()
    total = old = 0
    for d in REC.iterdir() if REC.is_dir() else []:
        if d.is_dir():
            for t, p in segments(d.name):
                try:
                    n = p.stat().st_size
                except FileNotFoundError:
                    continue
                total += n
                if now - t > all_d * 86400:
                    old += n
    return {"rec_gb": round(total / 1e9, 1), "event_gb": round(old / 1e9, 1)}


def make_clip(cam: str, start: float, end: float) -> Path | None:
    """把 [start, end] 用到的那幾段接起來剪好（不重新壓縮；起點會對齊到前一個關鍵畫面）。"""
    segs = segments(cam)
    use = [(t, p) for i, (t, p) in enumerate(segs) if t < end and (segs[i + 1][0] if i + 1 < len(segs) else t + SEG * 2) > start]
    if not use:
        return None
    first = use[0][0]
    tmpd = Path(tempfile.mkdtemp(prefix="clip-"))
    lst = tmpd / "list.txt"
    lst.write_text("".join(f"file '{p}'\n" for _, p in use), "utf-8")
    out = tmpd / "clip.mp4"
    cmd = ["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", str(lst),
           "-ss", f"{max(0.0, start - first):.2f}", "-t", f"{end - start:.2f}", "-c", "copy", "-movflags", "+faststart", str(out)]
    r = subprocess.run(cmd, capture_output=True, timeout=60)
    if r.returncode != 0 or not out.exists() or out.stat().st_size == 0:
        LOG.warning("剪不出來：%s", r.stderr.decode(errors="replace")[-300:])
        shutil.rmtree(tmpd, ignore_errors=True)
        return None
    return out


def make_frame(cam: str, t: float, width: int = 640) -> bytes | None:
    """t 那一刻的畫面（找搜尋結果的縮圖用）。"""
    segs = segments(cam)
    seg = None
    for i, (st, p) in enumerate(segs):
        nxt = segs[i + 1][0] if i + 1 < len(segs) else st + SEG * 2
        if st <= t < nxt:
            seg = (st, p)
            break
    if not seg:
        return None
    cmd = ["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-ss", f"{max(0.0, t - seg[0]):.2f}", "-i", str(seg[1]),
           "-frames:v", "1", "-vf", f"scale={width}:-2", "-q:v", "4", "-f", "image2", "-c:v", "mjpeg", "pipe:1"]
    r = subprocess.run(cmd, capture_output=True, timeout=20)
    return r.stdout if r.returncode == 0 and r.stdout else None


class Handler(BaseHTTPRequestHandler):
    server_version = "recorder"

    def log_message(self, fmt: str, *args) -> None:  # 不記網址（裡面可能有 token 以外的東西也不想留）
        pass

    def _auth(self) -> bool:
        token = load_cfg().get("token") or os.environ.get("RECORDER_TOKEN") or ""
        got = (self.headers.get("Authorization") or "").removeprefix("Bearer ").strip()
        if not token or not hmac.compare_digest(token, got):
            self._json(401, {"error": "token 不對"})
            return False
        return True

    def _json(self, code: int, obj: dict) -> None:
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802
        if not self._auth():
            return
        u = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(u.query).items()}
        if u.path == "/status":
            du = shutil.disk_usage(REC)
            with lock:
                st = {cid: c.status() for cid, c in cams.items()}
            all_d, ev_d = keep_days(load_cfg())
            self._json(200, {"cams": st, "disk": {"free_gb": round(du.free / 1e9, 1), "total_gb": round(du.total / 1e9, 1), **usage()},
                             "keep_days": all_d, "keep": {"all": all_d, "event": ev_d}})
            return
        if u.path == "/clip":
            try:
                cam, start, end = q["cam"], float(q["start"]), float(q["end"])
            except (KeyError, ValueError):
                self._json(400, {"error": "要給 cam、start、end"})
                return
            if not CAM_ID.match(cam) or end <= start or end - start > MAX_CLIP:
                self._json(400, {"error": f"時間不對（最長 {MAX_CLIP} 秒）"})
                return
            out = make_clip(cam, start, end)
            if not out:
                self._json(404, {"error": "這段時間沒有錄到"})
                return
            try:
                data = out.read_bytes()
            finally:
                shutil.rmtree(out.parent, ignore_errors=True)
            self.send_response(200)
            self.send_header("Content-Type", "video/mp4")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        if u.path == "/frame":
            try:
                cam, t, width = q["cam"], float(q["t"]), min(1920, max(160, int(q.get("w") or 640)))
            except (KeyError, ValueError):
                self._json(400, {"error": "要給 cam、t"})
                return
            data = make_frame(cam, t, width) if CAM_ID.match(cam) else None
            if not data:
                self._json(404, {"error": "那個時間沒有錄到"})
                return
            self.send_response(200)
            self.send_header("Content-Type", "image/jpeg")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        self._json(404, {"error": "沒有這個"})

    def do_PUT(self) -> None:  # noqa: N802
        if not self._auth():
            return
        if urlparse(self.path).path != "/config":
            self._json(404, {"error": "沒有這個"})
            return
        try:
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
        except ValueError:
            self._json(400, {"error": "不是 JSON"})
            return
        cfg = load_cfg()
        cfg["cams"] = {k: v for k, v in (body.get("cams") or {}).items() if CAM_ID.match(str(k)) and str(v).startswith("rtsp://")}
        if isinstance(body.get("keep"), dict):
            cfg["keep"] = {"all": float(body["keep"].get("all") or KEEP_DAYS), "event": float(body["keep"].get("event") or KEEP_DAYS)}
        if isinstance(body.get("windows"), dict):  # 有事的時段：{"cam": [[開始, 結束], ...]}
            new = {k: [[float(a), float(b)] for a, b in v[:2000]] for k, v in body["windows"].items() if CAM_ID.match(str(k)) and isinstance(v, list)}
            _, ev_d = keep_days(cfg)
            with win_lock:
                w = merge_windows(load_windows(), new, time.time() - ev_d * 86400)
                tmp = DATA / "windows.tmp"
                tmp.write_text(json.dumps(w), "utf-8")
                tmp.replace(WINDOWS)
        if not cfg.get("token"):
            cfg["token"] = os.environ.get("RECORDER_TOKEN", "")
        save_cfg(cfg)
        apply(cfg)
        self._json(200, {"ok": True, "cams": sorted(cfg["cams"])})


def main() -> None:
    REC.mkdir(parents=True, exist_ok=True)
    apply(load_cfg())
    threading.Thread(target=cleanup, daemon=True).start()
    LOG.info("錄影機啟動：port %s，保留 %s", PORT, keep_days(load_cfg()))
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()

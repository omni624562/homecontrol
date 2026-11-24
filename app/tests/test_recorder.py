"""錄影機：樹莓派這邊的設定、剪片段 API，和錄影機服務本身（不用真的 ffmpeg）。"""
from __future__ import annotations

import importlib.util
import json
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

from plughub import recorder as rec_mod


def test_rtsp_url_quotes_password():
    url = rec_mod.rtsp_url({"host": "10.0.2.5", "user": "admin", "pwd": "p@ss:/w"})
    assert url == "rtsp://admin:p%40ss%3A%2Fw@10.0.2.5:88/videoMain"


def test_push_only_enabled_and_only_when_changed(tmp_path):
    settings = {"recorder_url": "http://10.0.2.99:8200"}
    r = rec_mod.Recorder(tmp_path / "secrets.json", lambda: settings)
    calls = []
    r._req = lambda method, path, body=None, timeout=10: calls.append((method, path, body)) or b'{"cams": {}}'
    cams = [{"id": "a", "host": "h", "user": "u", "pwd": "p", "enabled": True}, {"id": "b", "host": "h2", "enabled": False}]
    r.refresh(cams)
    r.refresh(cams)
    puts = [c for c in calls if c[0] == "PUT"]
    assert len(puts) == 1 and list(puts[0][2]["cams"]) == ["a"]
    assert r.public()["ok"] and "token" not in json.dumps(r.public()) and "rtsp" not in json.dumps(r.public())
    tok = r.token()
    assert tok == r.token() and json.loads((tmp_path / "secrets.json").read_text())["recorder_token"] == tok


def _client(app_module):
    from fastapi.testclient import TestClient

    c = TestClient(app_module.app, base_url="http://hub:8100")
    token, dev = app_module.auth.pair(app_module.auth.new_code())
    c.cookies.set("plughub_token", token)
    return c, dev


def test_recorder_api_and_clip(app_module, monkeypatch, tmp_path):
    hub = app_module.hub
    hub.cameras.list = [{"id": "g", "name": "大門口", "host": "x", "enabled": True}]
    c, dev = _client(app_module)
    other, _ = _client(app_module)
    hub.cameras.viewers = [dev["id"]]
    monkeypatch.setattr(app_module, "CLIP_DIR", tmp_path / "clips")
    assert other.get("/api/recorder").status_code == 403
    assert c.get("/api/recorder").json() == {"configured": False}
    assert c.get("/api/cameras/g/clip.mp4", params={"t": 1}).status_code == 404  # 還沒設定
    assert c.put("/api/recorder", json={"url": "http://8.8.8.8:8200"}).status_code == 400
    monkeypatch.setattr(hub.recorder, "refresh", lambda cams: None)
    assert c.put("/api/recorder", json={"url": "http://10.0.2.99:8200/"}).json()["url"] == "http://10.0.2.99:8200"
    got = []
    monkeypatch.setattr(hub.recorder, "clip", lambda cam, start, end: got.append((cam, start, end)) or b"mp4data")
    t = time.time() - 600
    assert other.get("/api/cameras/g/clip.mp4", params={"t": t}).status_code == 403
    r = c.get("/api/cameras/g/clip.mp4", params={"t": t, "before": 5, "after": 15})
    assert r.status_code == 200 and r.content == b"mp4data" and r.headers["content-type"] == "video/mp4"
    assert got == [("g", t - 5, t + 15)]
    c.get("/api/cameras/g/clip.mp4", params={"t": t, "before": 5, "after": 15})
    assert len(got) == 1  # 剪過的暫存起來
    assert c.get("/api/cameras/g/clip.mp4", params={"t": time.time()}).status_code == 425  # 還在錄


def _service(tmp_path, monkeypatch):
    spec = importlib.util.spec_from_file_location("recorder_svc", Path(__file__).parent.parent / "recorder" / "recorder.py")
    svc = importlib.util.module_from_spec(spec)
    monkeypatch.setenv("RECORDER_DATA", str(tmp_path / "data"))
    monkeypatch.setenv("RECORDER_DIR", str(tmp_path / "rec"))
    monkeypatch.setenv("RECORDER_TOKEN", "sekret")
    spec.loader.exec_module(svc)
    return svc


def test_service_segments_and_auth(tmp_path, monkeypatch):
    svc = _service(tmp_path, monkeypatch)
    d = tmp_path / "rec" / "g"
    d.mkdir(parents=True)
    for n in ["20261124-100000.mp4", "20261124-100100.mp4", "junk.txt"]:
        (d / n).write_bytes(b"x")
    segs = svc.segments("g")
    assert [p.name for _, p in segs] == ["20261124-100000.mp4", "20261124-100100.mp4"] and segs[1][0] - segs[0][0] == 60
    monkeypatch.setattr(svc, "apply", lambda cfg: None)  # 不真的開 ffmpeg
    srv = svc.ThreadingHTTPServer(("127.0.0.1", 0), svc.Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{srv.server_address[1]}"

    def call(method, path, token, body=None):
        req = urllib.request.Request(base + path, method=method, data=json.dumps(body).encode() if body else None, headers={"Authorization": f"Bearer {token}"})
        try:
            with urllib.request.urlopen(req, timeout=5) as r:
                return r.status, json.loads(r.read())
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read())

    try:
        assert call("GET", "/status", "wrong")[0] == 401
        code, body = call("PUT", "/config", "sekret", {"cams": {"g": "rtsp://u:p@h/videoMain", "bad id!": "rtsp://x", "h": "http://no"}})
        assert code == 200 and body["cams"] == ["g"]
        cfg = json.loads((tmp_path / "data" / "config.json").read_text())
        assert cfg["token"] == "sekret" and (tmp_path / "data" / "config.json").stat().st_mode & 0o777 == 0o600
        assert call("GET", "/clip?cam=g&start=10&end=5", "sekret")[0] == 400
        assert call("GET", "/clip?cam=g&start=0&end=1000", "sekret")[0] == 400  # 太長
    finally:
        srv.shutdown()


def test_gpu_normalize_and_fallback(app_module, monkeypatch, tmp_path):
    from plughub import camera, gpu

    sc = gpu.normalize([{"name": "person", "score": gpu.GPU_PERSON_ON}, {"name": "cat", "score": 0.9}, {"name": "bench", "score": 0.8}])
    assert abs(sc["person"] - camera.PERSON_ON) < 1e-9 and sc["cat"] == 0.7 and sc["dog"] == 0.0
    settings = {}
    g = gpu.GpuVision(lambda: settings, lambda: "tok")
    assert g.detect(b"j") is None and g.public() == {"configured": False}
    settings["vision_url"] = "http://127.0.0.1:9"  # 沒人聽：失敗、1 分鐘內不再試
    assert g.detect(b"j") is None and g.error
    t0 = g._fail_at
    assert g.detect(b"j") is None and g._fail_at == t0

    # 攝影機：GPU 有回就用 GPU 的分數，沒有就用樹莓派的模型
    cams = camera.Cameras(tmp_path)
    cam = {"id": "c", "host": "x", "enabled": True}
    monkeypatch.setattr(camera, "snapshot", lambda c: b"jpeg")
    monkeypatch.setattr(cams.detector, "scores", lambda j: {"person": 0.0, "cat": 0.0, "dog": 0.0})
    cams.remote = lambda j: {"scores": {"person": 0.9, "cat": 0, "dog": 0}, "objects": [{"name": "person", "score": 0.95}]}
    cams.check(cam, 1)
    assert cams.state["c"]["engine"] == "gpu" and cams.state["c"]["recent"] == [0.9]
    cams.remote = lambda j: None
    cams.check(cam, 2)
    assert cams.state["c"]["engine"] == "cpu" and cams.state["c"]["recent"][-1] == 0.0


def test_vision_api(app_module):
    hub = app_module.hub
    c, dev = _client(app_module)
    hub.cameras.viewers = [dev["id"]]
    assert c.get("/api/vision").json()["configured"] is False
    assert c.put("/api/vision", json={"url": "http://example.com:1"}).status_code == 400
    assert c.put("/api/vision", json={"url": "http://10.0.2.99:8210"}).json()["url"] == "http://10.0.2.99:8210"
    assert c.put("/api/vision", json={"url": ""}).json()["configured"] is False


def test_pose_faces_go_to_gpu_then_fallback(app_module, monkeypatch):
    import numpy as np

    hub = app_module.hub
    monkeypatch.setattr(hub.pose, "analyze", lambda j: [{"score": 0.3, "torso": 5, "aspect": 2, "box": (1, 2, 3, 4), "foot": (0.1, 0.9)}])
    monkeypatch.setattr(hub.face_engine, "analyze", lambda j: ["local"])
    # 沒設定 Jetson：用樹莓派的
    monkeypatch.setattr(hub.gpu, "_settings", lambda: {})
    assert hub.analyze_pose(b"j")[0]["score"] == 0.3 and hub.analyze_faces(b"j") == ["local"]
    # 有 Jetson：用 Jetson 的；格式換回原本的
    monkeypatch.setattr(hub.gpu, "_settings", lambda: {"vision_url": "http://10.0.2.99:8210"})
    replies = {"/pose": {"people": [{"score": 0.8, "torso": 3, "aspect": 2.5, "box": [5, 6, 7, 8], "foot": [0.5, 0.6]}]},
               "/faces": {"faces": [{"w": 80, "score": 0.9, "clear": True, "box": [1, 2, 3, 4], "feat": [0.5] * 128}]}}
    monkeypatch.setattr(hub.gpu, "_post", lambda path, body, timeout=3, soft=(): replies.get(path))
    p = hub.analyze_pose(b"j")
    assert p[0]["foot"] == (0.5, 0.6) and p[0]["box"] == (5, 6, 7, 8)
    f = hub.analyze_faces(b"j")
    assert isinstance(f[0]["feat"], np.ndarray) and f[0]["feat"].shape == (128,)
    # 姿勢沒抓到人、但物件辨識框到人：用框的底部中間當腳
    replies["/pose"] = {"people": []}
    got = hub.analyze_pose(b"notjpeg", [{"name": "person", "score": 0.9, "box": [0.2, 0.1, 0.2, 0.5]}, {"name": "person", "score": 0.3, "box": [0, 0, 1, 1]}])
    assert len(got) == 1 and got[0]["foot"] == (0.30000000000000004, 0.6) and got[0]["torso"] is None
    # Jetson 掛了：用樹莓派的
    monkeypatch.setattr(hub.gpu, "_post", lambda path, body, timeout=3, soft=(): None)
    assert hub.analyze_pose(b"j")[0]["score"] == 0.3 and hub.analyze_faces(b"j") == ["local"]


def test_segment_prefers_gpu(app_module, monkeypatch):
    from plughub import camera as cam_mod

    hub = app_module.hub
    hub.cameras.list = [{"id": "g", "name": "大門口", "host": "x", "enabled": True}]
    c, dev = _client(app_module)
    hub.cameras.viewers = [dev["id"]]
    monkeypatch.setattr(app_module.segment_mod, "available", lambda: True)
    monkeypatch.setattr(cam_mod, "snapshot", lambda cam: b"jpeg")
    monkeypatch.setattr(hub.gpu, "_settings", lambda: {"vision_url": "http://10.0.2.99:8210"})
    calls = []
    state = {"has": False}

    def seg(key, x, y, jpeg):
        calls.append(jpeg)
        if jpeg:
            state["has"] = True
        return [{"poly": [[0, 0], [1, 0], [1, 1]], "area": 0.2, "score": 0.9}] if state["has"] else "need"

    monkeypatch.setattr(hub.gpu, "segment", seg)
    app_module._seg_sent.clear()
    assert c.post("/api/cameras/g/segment", json={"x": 0.5, "y": 0.5}).json()["shapes"][0]["area"] == 0.2
    c.post("/api/cameras/g/segment", json={"x": 0.4, "y": 0.4})
    assert calls == [b"jpeg", None]  # 第二次不用再送畫面
    state["has"] = False  # Jetson 重開了：要求重送
    c.post("/api/cameras/g/segment", json={"x": 0.4, "y": 0.4})
    assert calls[-2:] == [None, b"jpeg"]

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


def test_push_only_enabled_cams(tmp_path):
    settings = {"recorder_url": "http://10.0.2.99:8200"}
    r = rec_mod.Recorder(tmp_path / "secrets.json", lambda: settings)
    calls = []
    r._req = lambda method, path, body=None, timeout=10: calls.append((method, path, body)) or b'{"cams": {}}'
    cams = [{"id": "a", "host": "h", "user": "u", "pwd": "p", "enabled": True}, {"id": "b", "host": "h2", "enabled": False}]
    r.refresh(cams)
    r.refresh(cams)
    puts = [c for c in calls if c[0] == "PUT"]
    assert len(puts) == 2 and list(puts[0][2]["cams"]) == ["a"] and puts[0][2]["keep"] == {"all": 3, "event": 30}  # 每分鐘送（有事的時段會變）
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
        assert "cams" not in cfg and "u:p@" not in (tmp_path / "data" / "config.json").read_text()  # 含帳密的網址只放記憶體
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


def test_stream_mode_uses_jetson_state(app_module, monkeypatch, tmp_path):
    from plughub import camera

    cams = camera.Cameras(tmp_path)
    cam = {"id": "c", "host": "x", "enabled": True}
    monkeypatch.setattr(camera, "snapshot", lambda c: (_ for _ in ()).throw(AssertionError("不該跟攝影機要畫面")))
    cams.stream = lambda cid: {"scores": {"person": 0.9, "cat": 0, "dog": 0}, "objects": [], "jpeg": b"frame",
                               "tracks": [{"id": 1, "box": [0.1, 0.1, 0.1, 0.3], "foot": [0.15, 0.4], "score": 0.8}], "samples": [[1.0, [[1, 0.1, 0.4]]]]}
    cams.check(cam, 1)
    st = cams.state["c"]
    assert st["engine"] == "stream" and cams.frames["c"] == b"frame" and st["tracks"][0]["id"] == 1
    cams.stream = lambda cid: None  # 串流不正常：改回自己抓畫面
    monkeypatch.setattr(camera, "snapshot", lambda c: b"snap")
    cams.remote = None
    monkeypatch.setattr(cams.detector, "scores", lambda j: {"person": 0.0, "cat": 0.0, "dog": 0.0})
    cams.check(cam, 2)
    assert cams.state["c"]["engine"] == "cpu" and cams.frames["c"] == b"snap" and cams.state["c"]["tracks"] is None


def test_stream_samples_feed_lines(app_module, monkeypatch):
    import asyncio

    hub = app_module.hub
    fired = []
    monkeypatch.setattr(hub, "_zone_fire", lambda cam, item, label, act, now, jpeg=None: fired.append(label))
    cam = {"id": "c", "name": "門口", "host": "x", "enabled": True, "zones": [],
           "lines": [{"id": "l1", "name": "樓梯口", "a": [0.5, 0.0], "b": [0.5, 1.0], "in": {}, "out": {}}]}
    # 一個人從左走到右，中間只有 Jetson 的樣本（樹莓派每秒一張的畫面裡人都在同一邊）
    st = {"engine": "stream", "samples": [[1.0, [[1, 0.40, 0.5]]], [1.2, [[1, 0.46, 0.5]]], [1.4, [[1, 0.54, 0.5]]], [1.6, [[1, 0.60, 0.5]]]]}
    asyncio.run(hub._zones_check(cam, st, b"j", 2.0, [], True))
    assert len(fired) == 1 and "樓梯口" in fired[0]
    people = hub._track_people([{"id": 3, "box": [0.1, 0.2, 0.1, 0.4], "foot": [0.15, 0.6], "score": 0.8}])
    assert people[0]["foot"] == (0.15, 0.6) and people[0]["torso"] is None


def test_build_summary():
    from datetime import date, datetime

    from plughub.summary import build_summary

    d = date(2026, 11, 23)
    ts = lambda h, m: datetime(2026, 11, 23, h, m).timestamp()  # noqa: E731
    cams = [{"id": "g", "name": "大門口", "role": "entry"}]
    log = [{"id": "a", "t": ts(9, 0), "camera": "大門口", "kind": "zone", "name": "電梯開了"},
           {"id": "b", "t": ts(9, 5), "camera": "大門口", "kind": "zone", "name": "電梯開了"},
           {"id": "c", "t": ts(14, 12), "camera": "大門口", "kind": "zone", "name": "門口地板多了東西", "thumb": True},
           {"id": "d", "t": ts(20, 0), "camera": "大門口", "kind": "stranger"},
           {"id": "e", "t": datetime(2026, 11, 24, 1, 0).timestamp(), "camera": "大門口", "kind": "stranger"}]  # 隔天：不算
    vis = {"cams": {"g": {"visits": [{"start": ts(3, 12), "end": ts(3, 13)}, {"start": ts(22, 40), "end": ts(22, 43)}, {"start": ts(10, 0), "end": ts(10, 0)}],
                          "counts": {"dog": 1}}}}
    s = build_summary(d, cams, log, vis)
    c = s["cams"][0]
    assert c["counts"]["電梯開了"] == 2 and c["counts"]["陌生人"] == 1 and c["counts"]["有人來"] == 3 and c["counts"]["狗"] == 1
    assert [h["kind"] for h in c["highlights"]] == ["night", "object", "stranger", "linger"]
    assert s["indexed"] and build_summary(d, cams, log, None)["cams"][0]["indexed"] is False
    assert sum(c["hours"]) == 7 and c["hours"][9] == 2 and c["hours"][3] == 1


def test_summary_and_search_api(app_module, monkeypatch):
    hub = app_module.hub
    hub.cameras.list = [{"id": "g", "name": "大門口", "host": "x", "enabled": True}]
    c, dev = _client(app_module)
    hub.cameras.viewers = [dev["id"]]
    monkeypatch.setattr(hub.gpu, "summary", lambda day: None)
    r = c.get("/api/summary", params={"day": "2026-11-23"}).json()
    assert r["day"] == "2026-11-23" and r["cams"][0]["name"] == "大門口"
    assert c.get("/api/summary", params={"day": "bad"}).status_code == 400
    monkeypatch.setattr(hub.gpu, "search", lambda q, days, cam: {"hits": [{"cam": "g", "t": 1.0, "cls": "person", "box": [0, 0, 1, 1], "score": 0.1}, {"cam": "gone", "t": 2.0}], "classes": ["person"]})
    r = c.get("/api/recordings/search", params={"q": "穿紅衣服的人"}).json()
    assert len(r["hits"]) == 1 and r["hits"][0]["name"] == "大門口"
    monkeypatch.setattr(hub.gpu, "search", lambda q, days, cam: None)
    assert c.get("/api/recordings/search", params={"q": "狗"}).status_code == 503


def test_repeats_counts_same_stranger():
    import numpy as np

    from plughub import reid

    rng = np.random.default_rng(0)
    a, b, fam = (rng.normal(size=768) for _ in range(3))
    near = lambda v: v + rng.normal(size=768) * 0.15  # noqa: E731  同一個人換個角度
    r = reid.Repeats()
    t0 = 1795488000.0  # 某天早上
    r.add_family(fam, t0)
    assert r.add_visit(near(fam), t0 + 60) is None and not r.unknown  # 跟今天的家人一樣：不算
    assert r.add_visit(near(a), t0 + 100) is None
    assert r.add_visit(b, t0 + 200) is None  # 另一個人
    assert r.add_visit(near(a), t0 + 300) is None
    hit = r.add_visit(near(a), t0 + 400)
    assert hit and len(hit["times"]) == 3
    assert r.add_visit(near(a), t0 + 500) is None  # 只講一次
    assert r.add_visit(near(a), t0 + 86400) is None and len(r.unknown) == 1  # 隔天重算
    assert reid.family_moved({"dad": {"since": t0}}, t0 + 200, t0 + 250) and not reid.family_moved({"dad": {"since": t0}}, t0 + 1000, t0 + 1100)


def test_visit_end_notifies_third_time(app_module, monkeypatch):
    import numpy as np

    hub = app_module.hub
    sent = []
    monkeypatch.setattr(hub.notifier, "send", lambda *a, **k: sent.append(a))
    hub.cameras.list = [{"id": "g", "name": "大門口", "host": "x", "enabled": True, "role": "entry"}]
    hub._presence = {}
    hub.repeats = __import__("sys").modules["plughub.reid"].Repeats()
    e = np.ones(768, np.float32)
    now = 1795488000.0
    for i in range(3):
        hub._visit_end("g", {"start": now + i * 600, "known": set(), "maybe": set(), "app": [e, e]}, now + i * 600 + 30)
    assert len(sent) == 1 and "第 3 次" in sent[0][0]
    st = [x for x in hub.face_log.items if x["kind"] == "stranger" and "今天第 3 次出現" in (x.get("name") or "")]
    assert st and st[-1]["t"] == round(now + 1200)  # 寫他來的時間（不是走了以後），影片才看得到人
    # 家人手機剛進出：不算
    hub.repeats = __import__("sys").modules["plughub.reid"].Repeats()
    hub._presence = {"mom": {"home": True, "since": now + 10}}
    for i in range(3):
        hub._visit_end("g", {"start": now + i * 100, "known": set(), "maybe": set(), "app": [e, e]}, now + i * 100 + 30)
    assert len(sent) == 1


def test_stream_poses_detect_fall(app_module, monkeypatch):
    import asyncio

    from plughub import vision

    hub = app_module.hub
    sent = []
    monkeypatch.setattr(hub.notifier, "send", lambda *a, **k: sent.append(a))
    monkeypatch.setattr(hub.face_engine, "thumb", lambda *a, **k: b"")
    hub._falls = {}
    cam = {"id": "r", "name": "客廳", "host": "x", "enabled": True, "fall": True, "zones": [], "lines": []}
    stand = {"score": 0.9, "torso": 5, "aspect": 2.5, "box": [1, 2, 3, 4], "foot": [0.5, 0.9]}
    flat = {"score": 0.9, "torso": 80, "aspect": 0.5, "box": [1, 2, 3, 4], "foot": [0.5, 0.9]}
    # 站著 → 0.8 秒後躺下（每秒一張的話可能只看到「躺著」，不知道是突然倒下）→ 一直沒起來
    poses = [[100.0, [stand]], [100.4, [stand]], [100.8, [flat]]] + [[100.8 + i, [flat]] for i in range(1, vision.FALL_HOLD + 2)]
    for t, p in poses:
        asyncio.run(hub._fall_check(cam, b"j", t, [{**x, "box": tuple(x["box"]), "foot": tuple(x["foot"])} for x in p]))
    assert sent and "跌倒" in sent[0][0]


def test_object_zone_names_item_and_taken(app_module, monkeypatch):
    import asyncio

    import numpy as np

    hub = app_module.hub
    fired = []
    monkeypatch.setattr(hub, "_zone_fire", lambda cam, item, label, act, now, jpeg=None: fired.append((label, act.get("notify"))))
    vis = __import__("sys").modules["plughub.vision"]
    zl = __import__("sys").modules["plughub.zones"]
    monkeypatch.setattr(vis, "door_sig", lambda jpeg, rect, poly=None: np.ones((4, 4), np.float32))
    monkeypatch.setattr(vis, "door_score", lambda sig, refs: 0.1)
    monkeypatch.setattr(vis, "is_night", lambda jpeg: False)
    events = iter(["more", "less"])
    monkeypatch.setattr(zl, "object_track", lambda *a, **k: next(events, None))
    monkeypatch.setattr(hub, "_zone_learn", lambda *a, **k: None)
    monkeypatch.setattr(hub.gpu, "classify", lambda jpeg, box: "包裹")
    z = {"id": "z", "name": "門口地板", "kind": "object", "poly": [[0, 0], [1, 0], [1, 1]], "refs": ["x"], "_refs": ["r"], "act": {"notify": "always", "taken": False}}
    cam = {"id": "g", "name": "大門口", "zones": [z], "lines": []}
    st = {}
    asyncio.run(hub._zones_check(cam, st, b"j", 1000.0, [], False))
    asyncio.run(hub._zones_check(cam, st, b"j", 1000.0 + 4 * 3600 + 28 * 60, [], False))
    assert fired[0] == ("門口地板多了一個包裹", "always")
    assert fired[1][0] == "門口地板的包裹被拿走了（放了 4 小時 28 分）" and fired[1][1] == "off"  # 被拿走不通知（只記紀錄）


def test_service_prune_keeps_event_windows(tmp_path, monkeypatch):
    import os
    from datetime import datetime

    svc = _service(tmp_path, monkeypatch)
    (tmp_path / "data").mkdir(exist_ok=True)
    svc.save_cfg({"keep": {"all": 3, "event": 30}})
    d = tmp_path / "rec" / "g"
    d.mkdir(parents=True)
    now = datetime(2026, 12, 20, 12, 0).timestamp()
    def seg(days_ago, minute):
        t = now - days_ago * 86400 + minute * 60
        p = d / (datetime.fromtimestamp(t).strftime("%Y%m%d-%H%M%S") + ".mp4")
        p.write_bytes(b"x")
        return t, p
    recent = seg(1, 0)
    old_plain = seg(5, 0)
    old_event_t, old_event = seg(5, 10)
    too_old_t, too_old = seg(40, 0)
    svc.WINDOWS.write_text(__import__("json").dumps({"g": [[old_event_t + 20, old_event_t + 30], [too_old_t, too_old_t + 30]]}))
    monkeypatch.setattr(svc.shutil, "disk_usage", lambda p: os.statvfs_result if False else type("U", (), {"free": 10**15})())
    svc.prune(now)
    assert recent[1].exists() and old_event.exists()
    assert not old_plain[1].exists() and not too_old.exists()
    assert svc.merge_windows({"g": [[1, 5]]}, {"g": [[4, 9], [20, 30]]}, 0) == {"g": [[1.0, 9.0], [20.0, 30.0]]}
    assert svc.keep_days({"keep": {"all": 5, "event": 2}}) == (5.0, 5.0)  # 有事的不會比全部短


def test_event_windows_and_keep_api(app_module, monkeypatch):
    import time as _t

    hub = app_module.hub
    hub.cameras.list = [{"id": "g", "name": "大門口", "host": "x", "enabled": True}]
    hub.face_log.items = [{"id": "a", "t": _t.time() - 100, "camera": "大門口", "kind": "zone"}, {"id": "b", "t": _t.time() - 5 * 86400, "camera": "大門口", "kind": "zone"}]
    monkeypatch.setattr(hub.gpu, "summary", lambda day: {"cams": {"g": {"visits": [{"start": 1000.0, "end": 1010.0}]}}})
    w = hub._event_windows()
    assert len(w["g"]) == 3 and [940.0, 1070.0] in w["g"]  # 紀錄一筆（太舊的不送）＋兩天的有人來
    c, dev = _client(app_module)
    hub.cameras.viewers = [dev["id"]]
    app_module.store.data["settings"]["recorder_url"] = "http://10.0.2.99:8200"
    monkeypatch.setattr(hub.recorder, "refresh", lambda cams, windows=None: None)
    r = c.put("/api/recorder", json={"keep_all": 7, "keep_event": 5}).json()
    assert r["keep"] == {"all": 7, "event": 7}


def test_empty_off(app_module, monkeypatch):
    import asyncio

    hub = app_module.hub
    sent, switched = [], []
    monkeypatch.setattr(hub.notifier, "send", lambda *a, **k: sent.append(a))

    async def sw(pid):
        switched.append(pid)

    monkeypatch.setattr(hub, "_empty_switch", sw)
    monkeypatch.setattr(hub, "_spawn", lambda coro: asyncio.run(coro))
    plug = type("P", (), {"id": "tv", "online": True, "is_on": True})()
    monkeypatch.setattr(hub, "plugs", {"tv": plug})
    monkeypatch.setattr(hub, "name", lambda p: "電視")
    cam = {"id": "r", "name": "客廳", "empty_off": {"on": True, "plugs": ["tv"], "min": 30, "quiet": "", "ask": False}}
    hub.cameras.state["r"] = {"person": False, "seen": 1000.0, "ok": True}
    hub._empty_off(cam, 1000.0 + 29 * 60)
    assert not switched
    hub._empty_off(cam, 1000.0 + 31 * 60)
    assert switched == ["tv"] and "關掉了電視" in hub.face_log.items[-1]["name"] and not sent
    hub._empty_off(cam, 1000.0 + 40 * 60)
    assert switched == ["tv"]  # 只關一次（手動再打開不會馬上又被關）
    hub.cameras.state["r"]["person"] = True  # 有人回來：重新算
    hub._empty_off(cam, 1000.0 + 41 * 60)
    hub.cameras.state["r"].update(person=False, seen=5000.0)
    # 先問：先傳 LINE，5 分鐘後才關；按了不要關就不關
    cam["empty_off"]["ask"] = True
    hub._empty_off(cam, 5000.0 + 31 * 60)
    assert len(sent) == 1 and "5 分鐘後" in sent[0][0] and switched == ["tv"]
    hub.empty_cancel("r")
    hub._empty_off(cam, 5000.0 + 40 * 60)
    assert switched == ["tv"]


def test_empty_off_api(app_module):
    hub = app_module.hub
    hub.cameras.list = [{"id": "r", "name": "客廳", "host": "x", "enabled": True}]
    c, dev = _client(app_module)
    hub.cameras.viewers = [dev["id"]]
    r = c.put("/api/cameras/r", json={"empty_off": {"on": True, "plugs": ["nope"], "min": 1, "quiet": "bad", "ask": 1}}).json()["cameras"][0]
    assert r["empty_off"] == {"on": True, "plugs": [], "min": 5, "ask": True, "quiet": ""}
    assert c.post("/api/cameras/r/empty-off/cancel").status_code == 200


def test_stillness_rules():
    from datetime import date, datetime

    from plughub import stillness as S

    t = [{"id": 1, "box": [0.5, 0.5, 0.1, 0.3]}]
    assert S.moved({}, t)  # 新出現
    assert not S.moved({1: [0.5, 0.5, 0.1, 0.3]}, t)
    assert S.moved({1: [0.45, 0.5, 0.1, 0.3]}, t)  # 走動
    assert S.moved({1: [0.5, 0.5, 0.1, 0.4]}, t)  # 站起來／坐下
    p = lambda torso, x=100: {"box": [x, 100, 50, 200], "torso": torso}  # noqa: E731
    assert not S.pose_moved([[0, [p(10)]], [1, [p(12)]]])
    assert S.pose_moved([[0, [p(10)]], [1, [p(40)]]])  # 彎腰
    today = date(2026, 12, 10)
    assert S.threshold({}, today) == (120, None, 0)
    days = {"2026-12-09": 40, "2026-12-08": 50, "2026-12-07": 30, "2026-12-01": 999}
    assert S.threshold(days, today) == (80, 40, 3)  # 中位數 40 × 2
    assert S.threshold({"2026-12-09": 10, "2026-12-08": 10, "2026-12-07": 10}, today)[0] == 60  # 至少 60
    assert S.in_window(datetime(2026, 12, 10, 8), "07:00-22:00") and not S.in_window(datetime(2026, 12, 10, 23), "07:00-22:00")
    S.record_gap(days, datetime(2026, 12, 10, 9), 25)
    assert days["2026-12-10"] == 25 and "2026-12-01" in days


def test_still_check_alerts(app_module, monkeypatch):
    hub = app_module.hub
    sent = []
    monkeypatch.setattr(hub.notifier, "send", lambda *a, **k: sent.append(a))
    monkeypatch.setattr(hub, "people_report", lambda: [{"id": "a", "home": True}])
    st = __import__("sys").modules["plughub.stillness"]
    monkeypatch.setattr(st, "in_window", lambda when, w: True)
    cam = {"id": "r", "name": "IN_HOUSE", "still": {"on": True, "window": "07:00-22:00", "min": 60}}
    hub._still = {}
    hub.cameras.state["r"] = {"engine": "stream", "tracks": [{"id": 1, "box": [0.5, 0.5, 0.1, 0.3]}], "poses": []}
    hub._still_check(cam, 1000.0)  # 新出現：有動
    hub._still_check(cam, 1000.0 + 59 * 60)
    assert not sent
    hub._still_check(cam, 1000.0 + 61 * 60)
    assert len(sent) == 1 and "沒看到人走動" in sent[0][0] and sent[0][2] == "urgent"
    hub._still_check(cam, 1000.0 + 90 * 60)
    assert len(sent) == 1  # 只講一次
    hub.cameras.state["r"]["tracks"] = [{"id": 1, "box": [0.3, 0.5, 0.1, 0.3]}]  # 動了
    hub._still_check(cam, 1000.0 + 91 * 60)
    assert hub.cameras.state["r"]["still_info"]["gap"] == 0


def _stream_mod():
    spec = importlib.util.spec_from_file_location("stream_svc", Path(__file__).parent.parent / "vision" / "stream.py")
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


def _kp(lw, rw, le=None, re=None):
    """站著的人：鼻子 0.2、肩 0.3、髖 0.6；左肩在畫面右邊（面對攝影機）。lw/rw/le/re = (y, x)。"""
    k = [[0.0, 0.0, 0.0] for _ in range(17)]
    k[0] = [0.2, 0.5, 0.9]
    k[5], k[6] = [0.3, 0.56, 0.9], [0.3, 0.44, 0.9]
    k[11], k[12] = [0.6, 0.55, 0.9], [0.6, 0.45, 0.9]
    k[7] = [*(le or (0.4, 0.58)), 0.9]
    k[8] = [*(re or (0.4, 0.42)), 0.9]
    k[9], k[10] = [*lw, 0.9], [*rw, 0.9]
    return k


def test_gesture_classify():
    m = _stream_mod()
    assert m.gesture(_kp((0.5, 0.58), (0.5, 0.42))) is None  # 手放下
    assert m.gesture(_kp((0.1, 0.6), (0.5, 0.42), le=(0.2, 0.6))) == "one_up"
    assert m.gesture(_kp((0.1, 0.6), (0.1, 0.4), le=(0.2, 0.6), re=(0.2, 0.4))) == "both_up"
    assert m.gesture(_kp((0.4, 0.46), (0.4, 0.54))) == "cross"  # 左手腕跑到右邊
    assert m.gesture(_kp((0.4, 0.54), (0.4, 0.46))) is None  # 沒交叉
    k = _kp((0.1, 0.6), (0.5, 0.42))
    k[9][2] = 0.1
    assert m.gesture(k) is None  # 手腕看不清楚


def test_arm_gestures_removed(app_module, monkeypatch):
    m = _stream_mod()
    cam = m.Cam.__new__(m.Cam)
    cam.lock = __import__("threading").Lock()
    cam.g_cur, cam.g_fired, cam.g_events, cam.g_hand, cam.hands = (None, 0.0, 0.0), False, m.deque(), None, lambda img, people: []
    up = [{"box": [0, 0, 10, 20], "kp": _kp((0.1, 0.6), (0.5, 0.42), le=(0.2, 0.6))}]
    for i in range(12):  # 舉手 4 秒：不再算手勢
        cam._gesture(up, 100 + i * 0.4, img=object())
    assert not cam.g_events
    hub = app_module.hub
    hub.store.data["settings"]["gestures"] = {"on": True, "cam": "r", "map": {"one_up": {"type": "plug", "id": "lamp"}, "f_open": {"type": "off", "id": None}}}
    c, dev = _client(app_module)
    hub.cameras.viewers = [dev["id"]]
    assert list(c.get("/api/gestures").json()["map"]) == ["f_open"]  # 舊的舉手設定清掉
    assert c.put("/api/gestures", json={"on": True, "cam": None, "map": {"one_up": {"type": "off"}}}).json()["map"] == {}

def test_drop_strip_ghost(app_module):
    hub = app_module.hub
    Plug = __import__("sys").modules["plughub.hub"].Plug
    hub.plugs["40ae30fc3be5"] = Plug("40ae30fc3be5", "40:AE:30:FC:3B:E5", "TP-LINK_Power Strip_3BE5", "KP303", "10.0.2.248", online=False)
    hub.store.data["plugs"]["40ae30fc3be5"] = {"name": None}
    hub.store.data["plug_order"] = ["x", "40ae30fc3be5"]
    hub._drop_ghost("40ae30fc3be5")
    assert "40ae30fc3be5" not in hub.plugs and "40ae30fc3be5" not in hub.store.data["plugs"] and hub.store.data["plug_order"] == ["x"]
    hub._drop_ghost("nope")  # 沒有的話不出錯


def test_claude_vision_gating(app_module, monkeypatch):
    import asyncio

    hub = app_module.hub
    cv = hub.claude
    monkeypatch.setattr(type(hub.assistant), "configured", property(lambda self: True))
    monkeypatch.setattr(hub.assistant, "status", lambda: {"cap": 5.0, "month_usd": 0.0, "model": "claude-haiku-5-5"})
    hub.store.data["settings"]["claude_vision"] = {"on": False, "cams": ["g"]}
    assert not cv.allowed("describe", "g")  # 總開關關著：完全不送
    hub.store.data["settings"]["claude_vision"] = {"on": True, "cams": ["g"]}
    assert cv.allowed("describe", "g") and not cv.allowed("describe", "r") and not cv.allowed("second", "g")  # 預設：second 關
    monkeypatch.setattr(hub.assistant, "status", lambda: {"cap": 5.0, "month_usd": 5.1, "model": "x"})
    assert not cv.allowed("describe", "g")  # 到上限
    called = []

    async def fake_create(*a, **k):
        called.append(k)
    monkeypatch.setattr(cv, "allowed", lambda f, c=None: False)
    assert asyncio.run(cv.look("describe", "g", [b"j"], "q")) is None and not called


def test_describe_and_second_opinion(app_module, monkeypatch):
    import asyncio

    hub = app_module.hub
    sent = []
    monkeypatch.setattr(hub.notifier, "send", lambda *a, **k: sent.append(a))
    asked = []

    async def look(feature, cam_id, jpegs, prompt, max_tokens=400):
        asked.append((feature, len(jpegs)))
        return "一位穿藍色外套的人把紙箱放在門口後離開" if feature == "describe" else "看起來是坐在沙發上"

    monkeypatch.setattr(hub.claude, "look", look)
    monkeypatch.setattr(hub.claude, "allowed", lambda f, c=None: True)
    monkeypatch.setattr(hub, "_entry_frames", lambda e: [b"a", b"b"])
    entry = hub.face_log.add({"camera": "大門口", "kind": "zone", "name": "門口地板多了一個包裹", "sim": None})
    asyncio.run(hub._describe_entry({"id": "g"}, entry, ("大門口：門口地板多了一個包裹", "14:12")))
    assert entry["desc"].startswith("一位穿藍色外套") and sent[-1] == ("大門口：門口地板多了一個包裹", "14:12・一位穿藍色外套的人把紙箱放在門口後離開")
    monkeypatch.setattr(hub, "_spawn", lambda coro: asyncio.run(coro))
    hub._second_opinion({"id": "r", "name": "IN_HOUSE"}, "可能有人跌倒", b"jpeg")
    assert sent[-1] == ("IN_HOUSE：Claude 看了", "看起來是坐在沙發上") and asked[-1] == ("second", 1)
    # Claude 失敗：照原本的通知送
    async def fail(*a, **k):
        return None
    monkeypatch.setattr(hub.claude, "look", fail)
    asyncio.run(hub._describe_entry({"id": "g"}, {"id": "x", "name": "電梯開了"}, ("大門口：電梯開了", "09:00")))
    assert sent[-1] == ("大門口：電梯開了", "09:00")


def test_claude_vision_api_and_ask_tools(app_module, monkeypatch):
    hub = app_module.hub
    hub.cameras.list = [{"id": "g", "name": "大門口", "host": "x", "enabled": True, "role": "entry"}, {"id": "r", "name": "IN_HOUSE", "host": "y", "enabled": True}]
    c, dev = _client(app_module)
    hub.cameras.viewers = [dev["id"]]
    r = c.put("/api/claude-vision", json={"on": True, "cams": ["g", "nope"], "second": True}).json()
    assert r["on"] and r["cams"] == ["g"] and r["second"] and r["describe"]
    monkeypatch.setattr(type(hub.assistant), "configured", property(lambda self: True))
    monkeypatch.setattr(hub.assistant, "status", lambda: {"cap": 5.0, "month_usd": 0.0, "model": "claude-haiku-5-5"})
    names = [t.name for t in hub.assistant._tools([])]
    assert "look_camera" in names and "search_recordings" in names
    c.put("/api/claude-vision", json={"on": False})
    assert "look_camera" not in [t.name for t in hub.assistant._tools([])]  # 總開關關：問家裡看不到攝影機


def _sound_mod():
    spec = importlib.util.spec_from_file_location("sound_svc", Path(__file__).parent.parent / "vision" / "sound.py")
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


def test_sound_listener_rules(monkeypatch):
    m = _sound_mod()
    ear = m.Listener.__new__(m.Listener)
    ear.id, ear.lock, ear.events, ear.last, ear.dog = "r", __import__("threading").Lock(), m.deque(), {}, m.deque()
    ear.hits = {g: 0 for g in m.GROUPS}
    monkeypatch.setattr(m.threading, "Thread", lambda target, args=(), daemon=None: type("T", (), {"start": lambda self: None})())
    quiet = {"alarm": 0.0, "glass": 0.0, "scream": 0.0, "dog": 0.0}
    ear._check({**quiet, "alarm": 0.8}, 100.0)
    ear._check({**quiet, "alarm": 0.8}, 100.5)
    assert not ear.events  # 警報要連續 3 次（1.5 秒）
    ear._check({**quiet, "alarm": 0.8}, 101.0)
    assert [e[1] for e in ear.events] == ["alarm"]
    for i in range(3):
        ear._check({**quiet, "alarm": 0.8}, 102.0 + i * 0.5)
    assert len(ear.events) == 1  # 2 分鐘內只算一次
    ear._check({**quiet, "glass": 0.6}, 103.0)
    assert ear.events[-1][1] == "glass"  # 玻璃一次就算
    for i in range(int(m.DOG_SPAN / m.HOP)):  # 狗叫了一半的時間、超過 2 分鐘
        ear._check({**quiet, "dog": 0.5 if i % 2 else 0.0}, 200.0 + i * m.HOP)
    assert ear.events[-1][1] == "dog"


def test_sound_events_hub(app_module, monkeypatch):
    hub = app_module.hub
    sent = []
    monkeypatch.setattr(hub.notifier, "send", lambda *a, **k: sent.append(a))
    hub._sound_seen = {}
    cam = {"id": "r", "name": "IN_HOUSE", "sound": {"on": True, "alarm": "urgent", "glass": "urgent", "scream": "urgent", "dog": "off"}}
    hub.cameras.state["r"] = {"sounds": [[1000.0, "alarm", 0.8], [1001.0, "dog", 0.5]]}
    hub._sound_events(cam)
    assert len(sent) == 1 and "煙霧" in sent[0][0] and sent[0][2] == "urgent"
    assert [x["kind"] for x in hub.face_log.items[-2:]] == ["sound", "sound"] and hub.face_log.items[-2]["sound_t"] == 1000
    hub.cameras.state["r"]["sounds"] = [[1000.0, "alarm", 0.8]]  # 同一個事件再來一次：不重複
    hub._sound_events(cam)
    assert len(sent) == 1


def test_night_enhance():
    import numpy as np

    m = _stream_mod()
    dark = np.full((90, 160, 3), 30, np.uint8)
    dark[40:50, 70:90] = 60
    bright = np.zeros((90, 160, 3), np.uint8)
    bright[..., 1] = 180
    bright[..., 2] = 120
    assert m.is_dark(dark) and not m.is_dark(bright)
    out = m.enhance(dark)
    assert out.mean() > dark.mean() and m.enhance(bright) is bright  # 亮的不動
    m.ENHANCE["on"] = False
    assert m.enhance(dark) is dark
    m.ENHANCE["on"] = True


def test_activity_store(tmp_path):
    from datetime import date, datetime

    from plughub.activity import GW, Activity

    a = Activity(tmp_path)
    t = datetime(2026, 11, 25, 9, 30).timestamp()  # 週三
    a.add("r", t, [(0.5, 0.5)], 0.2)
    a.add("r", t + 1, [(0.5, 0.5), (0.0, 0.99)], 0.2)
    a.add("r", t + 2, [], 0.2)  # 沒人不記
    a.add_presence("r", datetime(2026, 11, 18, 9, 0).timestamp(), 1.0)  # 上週三
    today = date(2026, 11, 25)
    assert a.summary("r", "today", today)["days"] == 1
    raw = a.data["r"]["2026-11-25"]
    assert abs(raw["h"][9] - 0.4) < 1e-9 and raw["g"][9 * GW + 16] == 2 and raw["g"][17 * GW] == 1
    assert a.days("week", today) == ["2026-11-23", "2026-11-24", "2026-11-25"]
    assert a.days("lastweek_same", today) == ["2026-11-16", "2026-11-17", "2026-11-18"]
    assert a.summary("r", "lastweek_same", today)["days"] == 1
    a.maybe_save(force=True)
    assert Activity(tmp_path).data["r"]["2026-11-25"]["g"][9 * GW + 16] == 2


def test_activity_api(app_module, monkeypatch):
    import time as _t

    hub = app_module.hub
    hub.cameras.list = [{"id": "r", "name": "IN_HOUSE", "host": "x", "enabled": True, "room": "lr"}]
    c, dev = _client(app_module)
    hub.cameras.viewers = [dev["id"]]
    hub.activity.data = {}
    hub.activity.add("r", _t.time(), [(0.5, 0.5)], 0.2)
    r = c.get("/api/activity", params={"range": "today"}).json()
    assert r["rooms"]["lr"]["seconds"] == 0 and r["cams"]["r"]["grid"][9 * 32 + 16] == 1
    assert c.get("/api/activity", params={"range": "compare"}).json()["range"] == "compare"


def test_visitors_group_and_name(tmp_path):
    import numpy as np

    from plughub.visitors import Visitors

    rng = np.random.default_rng(1)
    a, b = rng.normal(size=768), rng.normal(size=768)
    near = lambda v: v + rng.normal(size=768) * 0.15  # noqa: E731
    vs = Visitors(tmp_path)
    t0 = 1795488000.0
    for i in range(3):
        vs.add("g", t0 + i * 86400, near(a), b"jpg")
    vs.add("g", t0 + 3600, b, None)
    gs = vs.groups()
    assert len(gs) == 1 and gs[0]["count"] == 3 and len(gs[0]["thumbs"]) == 3  # b 只來一次：不列
    n = vs.name_group(gs[0]["id"], "清潔阿姨")
    assert n["name"] == "清潔阿姨" and not vs.groups() and len(vs.visits) == 1
    assert not list(tmp_path.glob("faces_thumbs/visitor_*.jpg"))  # 分好的小圖刪掉
    assert vs.match_named(near(a))["name"] == "清潔阿姨" and vs.match_named(b) is None
    vs.prune(t0 + 9 * 86400)
    assert not vs.visits  # 7 天後刪
    assert Visitors(tmp_path).named[0]["name"] == "清潔阿姨"


def test_visit_end_uses_named_regular(app_module, monkeypatch):
    import numpy as np

    hub = app_module.hub
    sent = []
    monkeypatch.setattr(hub.notifier, "send", lambda *a, **k: sent.append(a))
    hub.cameras.list = [{"id": "g", "name": "大門口", "host": "x", "enabled": True, "role": "entry"}]
    hub._presence = {}
    hub.visitors.visits, hub.visitors.named = [], [{"id": "n1", "name": "清潔阿姨", "emb": [1.0] * 768, "n": 3}]
    e = np.ones(768, np.float32)
    hub._visit_end("g", {"start": 1795488000.0, "known": set(), "maybe": set(), "app": [e, e]}, 1795488030.0)
    g = [x for x in hub.face_log.items if x["kind"] == "guest" and x.get("name") == "清潔阿姨"]
    assert g and g[-1]["t"] == 1795488000 and not hub.visitors.visits
    hub.visitors.named = []
    hub._visit_end("g", {"start": 1795488100.0, "known": set(), "maybe": set(), "app": [e, e]}, 1795488130.0)
    assert len(hub.visitors.visits) == 1  # 沒取名字：記下來等分群


def test_ask_offers_enable_button_when_off(app_module, monkeypatch):
    import asyncio

    hub = app_module.hub
    hub.cameras.list = [{"id": "g", "name": "大門口", "host": "x", "enabled": True, "role": "entry"}]
    monkeypatch.setattr(type(hub.assistant), "configured", property(lambda self: True))
    monkeypatch.setattr(hub.assistant, "status", lambda: {"cap": 5.0, "month_usd": 0.0, "model": "claude-haiku-5-5"})
    hub.store.data["settings"]["claude_vision"] = {"on": False}
    actions = []
    tools = {t.name: t for t in hub.assistant._tools(actions)}
    assert "propose_camera_vision" in tools and "look_camera" not in tools
    assert "還沒打開" in hub.assistant._camera_note() and "大門口" in hub.assistant._camera_note()
    asyncio.run(tools["propose_camera_vision"].call({}))
    assert actions[0]["kind"] == "vision_on"
    c, dev = _client(app_module)
    hub.cameras.viewers = [dev["id"]]
    r = c.put("/api/claude-vision", json={"on": True}).json()
    assert r["on"] and r["cams"] == ["g"]  # 按了「打開」：先開門口的


def test_gestures_live_pose(app_module):
    import time as _t

    hub = app_module.hub
    hub.cameras.list = [{"id": "r", "name": "IN_HOUSE", "host": "x", "enabled": True}]
    c, dev = _client(app_module)
    hub.cameras.viewers = [dev["id"]]
    c.put("/api/gestures", json={"on": True, "cam": "r", "map": {}})
    kp = [[0.5, 0.5, 0.9]] * 17
    hub.cameras.state["r"] = {"engine": "stream", "pose_last": {"t": _t.time(), "people": [{"kp": kp, "box": [1, 2, 3, 4], "torso": 5}]}}
    r = c.get("/api/gestures").json()
    assert r["live"] and r["people"][0]["kp"] == kp
    hub.cameras.state["r"]["pose_last"]["t"] = _t.time() - 10  # 太舊：不畫
    assert c.get("/api/gestures").json()["people"] == []


def test_finger_gestures_hold_and_filter(app_module, monkeypatch):
    import asyncio

    m = _stream_mod()
    cam = m.Cam.__new__(m.Cam)
    cam.lock = __import__("threading").Lock()
    cam.g_cur, cam.g_fired, cam.g_events, cam.g_hand = (None, 0.0, 0.0), False, m.deque(), None
    still = [{"box": [0, 0, 10, 20], "kp": _kp((0.5, 0.58), (0.5, 0.42))}]  # 手放下：沒有舉手的手勢
    reply = {"h": [{"px": 190, "presence": 0.97, "gesture": "open", "points": []}]}
    cam.hands = lambda img, people: reply["h"]
    for i in range(6):  # 每 0.4 秒，維持 2 秒（要 1 秒就夠）
        cam._gesture(still, 100 + i * 0.4, img=object())
    assert [e[1] for e in cam.g_events] == ["f_open"]
    cam.g_cur, cam.g_fired, cam.g_events = (None, 0.0, 0.0), False, m.deque()
    reply["h"] = [{"px": 50, "presence": 0.7, "gesture": "open", "points": []}]  # 別人的小手：不算
    for i in range(10):
        cam._gesture(still, 200 + i * 0.4, img=object())
    assert not cam.g_events

    hub = app_module.hub
    toggled = []

    async def gp(pid, on):
        toggled.append((pid, on))

    monkeypatch.setattr(hub, "_gesture_power", gp)
    monkeypatch.setattr(hub, "_spawn", lambda coro: asyncio.run(coro))
    plug = type("P", (), {"id": "lamp", "online": True, "is_on": True})()
    monkeypatch.setattr(hub, "plugs", {"lamp": plug})
    monkeypatch.setattr(hub, "name", lambda p: "客廳燈")
    hub.store.data["settings"]["gestures"] = {"on": True, "cam": "r", "map": {"f_open": {"type": "plug_on", "id": "lamp"}, "f_fist": {"type": "plug_off", "id": "lamp"}}}
    hub._face_cool = {}
    hub._gesture_t = 0.0
    hub.cameras.state["r"] = {"gestures": [[1.0, "f_open"], [2.0, "f_fist"]]}
    hub._gesture_events({"id": "r", "name": "IN_HOUSE"}, 1000.0)
    assert toggled == [("lamp", True), ("lamp", False)]  # 張開＝開（就算已經開著）、握拳＝關
    assert "手勢（握拳）：關掉客廳燈" in hub.face_log.items[-1]["name"]
    hub._face_cool = {}
    hub.cameras.state["r"] = {"gestures": [[1.0, "f_open"], [2.0, "f_fist"]]}  # 快、慢兩條路都拿到同一筆：不重複
    hub._gesture_events({"id": "r", "name": "IN_HOUSE"}, 1030.0)
    assert len(toggled) == 2

    cam_list = [{"id": "r", "name": "IN_HOUSE", "enabled": True}]
    monkeypatch.setattr(hub.cameras, "list", cam_list)
    monkeypatch.setattr(type(hub.gpu), "url", property(lambda s: "http://x"))
    monkeypatch.setattr(hub.gpu, "gestures", lambda cid, since: [[3.0, "f_open"]])
    hub._face_cool = {}
    later = []
    monkeypatch.setattr(hub, "_spawn", later.append)
    asyncio.run(hub._gesture_tick())  # 快的那條路：直接處理
    asyncio.run(later[0])
    assert toggled[-1] == ("lamp", True) and hub._gesture_t == 3.0


def test_more_finger_gestures():
    import numpy as np

    spec = importlib.util.spec_from_file_location("hands_svc", Path(__file__).parent.parent / "vision" / "hands.py")
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    lm = np.zeros((21, 2), np.float32)
    lm[9] = [0, -40]
    for f, name in (([False, True, True, True, False], "three"), ([False, True, False, False, True], "rock"), ([True, False, False, False, True], "call"),
                    ([False, True, True, False, False], "v"), ([False, True, False, False, False], "point"), ([True, True, True, True, True], "open")):
        assert m.gesture(f, lm) == name, (f, name)


def test_face_log_inserts_late_items_in_order(tmp_path):
    from plughub.faces import FaceLog

    import time

    b = round(time.time()) - 100
    log = FaceLog(tmp_path)
    log.add({"t": b, "kind": "zone"})
    log.add({"t": b + 30, "kind": "zone"})
    log.add({"t": b + 10, "kind": "stranger"})  # 人走了才記：照來的時間排
    assert [x["t"] - b for x in log.items] == [0, 10, 30]


def test_home_door_visit_counts_as_family(app_module, monkeypatch):
    import numpy as np

    from plughub import zones as zl

    door = [[0.0732, 0.2342], [0.1331, 0.2178], [0.2206, 0.5864], [0.155, 0.611]]  # 大門口的「大門」
    assert zl.near((0.22, 0.52), door, 0.06) and not zl.near((0.5, 0.8), door, 0.06)

    hub = app_module.hub
    sent = []
    monkeypatch.setattr(hub.notifier, "send", lambda *a, **k: sent.append(a))
    cam = {"id": "g", "name": "大門口", "host": "x", "enabled": True, "role": "entry", "zones": [{"id": "door", "name": "大門", "kind": "door", "poly": door}]}
    hub.cameras.list = [cam]
    hub._presence = {}
    hub.visitors.visits, hub.visitors.named = [], []
    monkeypatch.setattr(hub, "people_report", lambda: [{"id": "mom", "home": True}])
    e = np.ones(768, np.float32)
    stairs, at_door = [(0.6, 0.85)], [(0.21, 0.55)]

    def visit(start, path):
        return {"start": start, "known": set(), "maybe": set(), "app": [e, e], "feet": [(start + i * 0.2, p) for i, p in enumerate(path)]}

    now = 1795488000.0
    hub.repeats = __import__("sys").modules["plughub.reid"].Repeats()
    for i in range(3):  # 從樓梯上來、走進家門：家人
        hub._visit_end("g", visit(now + i * 600, [stairs] * 10 + [at_door] * 10), now + i * 600 + 30)
    assert not sent and not hub.visitors.visits
    hub.repeats = __import__("sys").modules["plughub.reid"].Repeats()
    for i in range(3):  # 送貨：樓梯上來、站在門口、又從樓梯走：照樣算陌生人
        hub._visit_end("g", visit(now + i * 600, [stairs] * 10 + [at_door] * 20 + [stairs] * 10), now + i * 600 + 30)
    assert len(sent) == 1 and len(hub.visitors.visits) == 3
    monkeypatch.setattr(hub, "people_report", lambda: [{"id": "mom", "home": False}])
    hub.visitors.visits = []
    hub._visit_end("g", visit(now + 5000, [stairs] * 5 + [at_door] * 5), now + 5030)  # 家裡沒人、有人走進家門：不能當家人
    assert len(hub.visitors.visits) == 1

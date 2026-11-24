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
    assert hub.face_log.items[-1]["kind"] == "stranger" and "今天第 3 次出現" in hub.face_log.items[-1]["name"]
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


def test_gesture_hold_and_actions(app_module, monkeypatch):
    m = _stream_mod()
    cam = m.Cam.__new__(m.Cam)
    cam.lock = __import__("threading").Lock()
    cam.g_cur, cam.g_fired, cam.g_events = (None, 0.0, 0.0), False, m.deque()
    up = [{"box": [0, 0, 10, 20], "kp": _kp((0.1, 0.6), (0.5, 0.42), le=(0.2, 0.6))}]
    for i in range(9):  # 每 0.4 秒一次，舉 3.2 秒
        cam._gesture(up, 100 + i * 0.4)
    assert [e[1] for e in cam.g_events] == ["one_up"]
    cam._gesture(up, 104.0)
    assert len(cam.g_events) == 1  # 放下前不重複

    hub = app_module.hub
    toggled = []

    async def gp(pid, on):
        toggled.append((pid, on))

    monkeypatch.setattr(hub, "_gesture_power", gp)
    monkeypatch.setattr(hub, "_spawn", lambda coro: __import__("asyncio").run(coro))
    plug = type("P", (), {"id": "lamp", "online": True, "is_on": False})()
    monkeypatch.setattr(hub, "plugs", {"lamp": plug})
    monkeypatch.setattr(hub, "name", lambda p: "客廳燈")
    hub.store.data["settings"]["gestures"] = {"on": True, "cam": "r", "map": {"one_up": {"type": "plug", "id": "lamp"}}}
    hub._face_cool = {}
    c = {"id": "r", "name": "IN_HOUSE"}
    hub.cameras.state["r"] = {"gestures": [[1.0, "one_up"], [2.0, "both_up"]]}
    hub._gesture_events(c, 1000.0)
    assert toggled == [("lamp", True)] and "手勢（舉一隻手）：打開客廳燈" in hub.face_log.items[-1]["name"]
    hub.cameras.state["r"]["gestures"] = [[3.0, "one_up"]]
    hub._gesture_events(c, 1005.0)
    assert len(toggled) == 1  # 10 秒內只算一次

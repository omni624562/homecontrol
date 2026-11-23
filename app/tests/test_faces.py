"""認臉：三種判斷、挑登記用的臉、家人回家動作、要出門提醒、陌生人通知、登記、API（用假的辨識引擎）。"""
from __future__ import annotations

import asyncio
import sys
import time
from datetime import datetime

import numpy as np

from plughub import faces


def vec(i: int, noise: float = 0.0, seed: int = 0) -> np.ndarray:
    v = np.zeros(128, dtype=np.float32)
    v[i] = 1.0
    if noise:
        v += np.random.default_rng(seed).normal(0, noise, 128).astype(np.float32)
    return v / np.linalg.norm(v)


def face(feat, w=120, score=0.95):
    return {"w": w, "score": score, "clear": w >= faces.CLEAR_W and score >= faces.CLEAR_SCORE, "feat": feat, "box": (10, 10, w, w)}


def test_classify():
    assert faces.classify(face(vec(0)), ("dad", 0.7)) == ("known", "dad", 0.7)
    assert faces.classify(face(vec(0)), ("dad", 0.2)) == ("stranger", None, 0.2)
    assert faces.classify(face(vec(0), w=30), ("dad", 0.2)) == ("unclear", None, 0.2)  # 臉太小：不能說是陌生人


def test_gallery_match_and_pick(tmp_path):
    g = faces.Gallery(tmp_path)
    g.set("dad", "爸爸", "family", [vec(0), vec(0, 0.05, 1)])
    g.set("g-1", "阿姨", "guest", [vec(5)], notify=False)
    pid, sim = g.match(vec(0, 0.05, 2))
    assert pid == "dad" and sim > 0.5
    assert g.match(vec(9))[1] < faces.MATCH
    assert faces.Gallery(tmp_path).public()[1] == {"id": "g-1", "name": "阿姨", "kind": "guest", "samples": 1, "at": g.people["g-1"]["at"], "notify": False}
    cands = [(1.0, vec(0)), (0.9, vec(0)), (0.8, vec(1)), (0.5, vec(2))]
    picked = faces.pick_samples(cands, 3)
    assert len(picked) == 3 and float(np.dot(picked[0], picked[1])) < 0.97  # 一模一樣的不重複收


def test_face_log_prunes(tmp_path):
    log = faces.FaceLog(tmp_path)
    old = log.add({"kind": "stranger"}, b"jpg")
    assert log.thumb_path(old["id"]) is not None and log.thumb_path("../x") is None
    log.items[0]["t"] -= faces.LOG_KEEP_S + 1
    log.add({"kind": "family", "name": "爸爸"})
    assert [x["kind"] for x in log.items] == ["family"] and log.thumb_path(old["id"]) is None


class FakeEngine:
    def __init__(self):
        self.next: list = []

    def analyze(self, jpeg):
        return self.next

    @staticmethod
    def thumb(jpeg, box, size=160):
        return b"thumb"


def _hub(app_module, monkeypatch, role="entry"):
    hub = app_module.hub
    sent, ran, power = [], [], []
    monkeypatch.setattr(hub.notifier, "send", lambda *a, **k: sent.append(a))
    monkeypatch.setattr(hub, "_presence_scene", lambda sid, why: ran.append((sid, why)))
    hub.spawned = []
    monkeypatch.setattr(hub, "_spawn", lambda coro: hub.spawned.append(coro))

    async def fake_power(pid, on, force=False):
        power.append((pid, on))

    async def fake_timer(pid, sec):
        power.append((pid, "timer", sec))

    monkeypatch.setattr(hub, "set_power", fake_power)
    monkeypatch.setattr(hub, "set_timer", fake_timer)
    monkeypatch.setattr(hub, "changed", lambda: asyncio.sleep(0))
    hub.face_engine = FakeEngine()
    hub.cameras.list = [{"id": "gate", "name": "大門口", "host": "10.0.0.6", "enabled": True, "alert": True, "faces": True, "role": role, "room": None, "light": None}]
    hub.cameras.state["gate"] = {"person": True}
    hub.store.data["people"] = [{"id": "dad", "name": "爸爸", "macs": []}, {"id": "mom", "name": "媽媽", "macs": []}]
    hub.gallery.people = {}
    hub.gallery.set("dad", "爸爸", "family", [vec(0)])
    return hub, sent, ran, power


def tick(hub, faces_now, now):
    hub.cameras.frames = {"gate": b"jpeg"}
    hub.face_engine.next = faces_now
    asyncio.run(hub._face_tick(hub.cameras.list, now))
    while hub.spawned:
        asyncio.run(hub.spawned.pop(0))


def test_family_arrival_runs_slot_scene(app_module, monkeypatch):
    hub, sent, ran, _ = _hub(app_module, monkeypatch)
    monkeypatch.setattr(hub.store, "scene", lambda sid: {"id": sid, "name": sid} if sid else None)
    hub.store.data["settings"]["face_actions"] = {"dad": {"day": "s-day", "night": "s-night", "late": None, "notify": True}}
    monkeypatch.setattr(hub, "face_slot", lambda when=None: "night")
    now = time.time()
    hub._presence = {"dad": {"home": False, "since": now - 9999}, "mom": {"home": False, "since": now - 9999}}
    tick(hub, [face(vec(0, 0.02, 3))], now)  # 很像：不用等手機
    assert ran and ran[0][0] == "s-night" and "爸爸" in ran[0][1]
    assert hub.face_log.items[-1]["kind"] == "family"
    tick(hub, [face(vec(0, 0.02, 4))], now + 5)  # 同一次不重複
    assert len(ran) == 1
    # 沒設這個時段的情境、但有開「回家時通知」：只通知
    hub._visits.clear()
    hub._face_cool.clear()
    monkeypatch.setattr(hub, "face_slot", lambda when=None: "late")
    tick(hub, [face(vec(0, 0.02, 5))], now + 10)
    assert len(ran) == 1 and "爸爸回到家了" in sent[-1][0]


def test_weak_match_waits_for_phone(app_module, monkeypatch):
    hub, sent, ran, _ = _hub(app_module, monkeypatch)
    hub.store.data["settings"]["face_actions"] = {"dad": {"notify": True}}
    now = time.time()
    hub._presence = {"dad": {"home": False, "since": now - 9999}, "mom": {"home": False, "since": now - 9999}}
    weak = vec(0) * 0.42 + vec(7) * np.sqrt(1 - 0.42 ** 2)  # 相似度 0.42：像，但不夠確定
    tick(hub, [face(weak.astype(np.float32))], now)
    assert sent == [] and "dad" in hub._visits["gate"]["maybe"]
    hub._presence["dad"] = {"home": True, "since": now}  # 手機連上了 → 就是他
    tick(hub, [face(weak.astype(np.float32))], now + 3)
    assert "爸爸回到家了" in sent[-1][0]


def test_leave_reminder_when_last_one(app_module, monkeypatch):
    hub, sent, _, _ = _hub(app_module, monkeypatch)
    import types
    hub.plugs["tv"] = types.SimpleNamespace(id="tv", online=True, is_on=True, kasa_name="電視", rssi=None, device_key="tv", offline_since=None)
    hub.store.meta("tv")
    now = time.time()
    hub._presence = {"dad": {"home": True, "since": now - 3600}, "mom": {"home": False, "since": now - 3600}}
    tick(hub, [face(vec(0))], now)
    assert "爸爸要出門了嗎" in sent[-1][0] and "電視" in sent[-1][1]


def test_stranger_at_gate_needs_linger_and_wakes_light_at_night(app_module, monkeypatch):
    hub, sent, _, power = _hub(app_module, monkeypatch)
    import types
    hub.plugs["lamp"] = types.SimpleNamespace(id="lamp", online=True, is_on=False, kasa_name="門口燈", rssi=None, device_key="lamp", offline_since=None)
    hub.cameras.list[0]["light"] = "lamp"
    monkeypatch.setattr(hub, "face_slot", lambda when=None: "late")
    now = time.time()
    hub._presence = {"dad": {"home": True, "since": now - 3600}, "mom": {"home": True, "since": now - 3600}}
    tick(hub, [face(vec(20))], now)
    tick(hub, [face(vec(20))], now + 10)
    assert sent == []  # 還不到 30 秒：路人經過
    tick(hub, [face(vec(20))], now + faces_linger(app_module))
    assert sent and "半夜" in sent[-1][0] and sent[-1][2] == "urgent"
    assert ("lamp", True) in power and ("lamp", "timer", 300) in power
    item = hub.face_log.items[-1]
    assert item["kind"] == "stranger" and item["thumb"]


def faces_linger(app_module):
    return sys.modules["plughub.hub"].FACE_LINGER


def test_room_camera_stranger_only_logged_when_home(app_module, monkeypatch):
    hub, sent, _, _ = _hub(app_module, monkeypatch, role="room")
    monkeypatch.setattr(hub, "face_slot", lambda when=None: "day")
    now = time.time()
    hub._presence = {"dad": {"home": True, "since": now - 3600}, "mom": {"home": False, "since": now - 3600}}
    tick(hub, [face(vec(20))], now)
    tick(hub, [face(vec(20))], now + 1)
    assert sent == [] and hub.face_log.items[-1]["kind"] == "stranger"


def test_enroll_collects_only_single_clear_face(app_module, monkeypatch):
    hub, _, _, _ = _hub(app_module, monkeypatch)
    hub.cameras.state["gate"] = {"person": False}
    now = time.time()
    hub.enroll_start("mom", "媽媽", "family", "gate")
    tick(hub, [face(vec(3)), face(vec(4))], now)  # 兩張臉：不收
    assert hub.enroll_status()["count"] == 0
    for i in range(4):
        tick(hub, [face(vec(3, 0.2, i))], now + i)
    hub.enroll["until"] = 0
    tick(hub, [], now + 10)
    assert hub.enroll is None and hub.enroll_result["ok"] and len(hub.gallery.people["mom"]["feats"]) >= 3


def test_faces_api_requires_camera_permission(app_module, monkeypatch):
    from fastapi.testclient import TestClient

    c = TestClient(app_module.app, base_url="http://hub:8100")
    token, dev = app_module.auth.pair(app_module.auth.new_code())
    c.cookies.set("plughub_token", token)
    assert c.get("/api/faces").status_code == 403
    app_module.hub.cameras.viewers = [dev["id"]]
    app_module.hub.cameras.list = [{"id": "gate", "name": "大門口", "host": "x", "enabled": True}]
    app_module.store.data["people"] = [{"id": "dad", "name": "爸爸", "macs": []}]
    r = c.get("/api/faces").json()
    assert r["family"][0] == {"id": "dad", "name": "爸爸", "kind": "family", "samples": 0, "at": None}
    r = c.post("/api/faces/enroll", json={"camera": "gate", "name": "清潔阿姨"}).json()
    assert r["enroll"]["name"] == "清潔阿姨" and r["enroll"]["pid"].startswith("g-")
    assert c.delete("/api/faces/enroll").json()["enroll"] is None
    monkeypatch.setattr(app_module.store, "scene", lambda sid: {"id": sid} if sid == "s1" else None)
    r = c.put("/api/faces/actions", json={"dad": {"night": "s1", "day": "nope", "notify": True}, "ghost": {"day": "s1"}}).json()
    assert r["actions"] == {"dad": {"night": "s1", "day": None, "notify": True}}
    assert c.get("/api/faces/log/abc.jpg").status_code == 404

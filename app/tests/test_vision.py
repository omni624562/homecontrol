"""寵物、跌倒、開門：判斷邏輯和 hub 的處理（用假的模型，不連攝影機）。"""
from __future__ import annotations

import asyncio
import time

import numpy as np
import pytest

from plughub import camera, vision


def person(deg, aspect):
    return {"score": 0.4, "torso": deg, "aspect": aspect, "box": (10, 10, 50, 100)}


STAND, SIT, FLAT = person(8, 2.5), person(10, 1.2), person(80, 0.5)


def test_posture():
    assert vision.posture(STAND) == "stand"
    assert vision.posture(SIT) == "other"  # 坐著軀幹也是直的，但身形不高
    assert vision.posture(FLAT) == "flat"
    assert vision.posture({"torso": None, "aspect": 1}) == "other"


def test_fall_needs_quick_drop_and_hold():
    st: dict = {}
    assert vision.fall_track(st, [STAND], 0) is None
    assert vision.fall_track(st, [FLAT], 2) is None  # 2 秒內從站著變躺下
    assert vision.fall_track(st, [SIT], 10) is None  # 中間看不清楚：不算沒事
    assert vision.fall_track(st, [FLAT], 2 + vision.FALL_HOLD) == "fall"
    assert vision.fall_track(st, [FLAT], 40) is None  # 只講一次
    assert vision.fall_track(st, [STAND], 50) is None and st["flat"] is None


def test_lying_down_slowly_is_not_a_fall():
    st: dict = {}
    vision.fall_track(st, [STAND], 0)
    vision.fall_track(st, [SIT], 2)
    vision.fall_track(st, [SIT], 8)
    assert vision.fall_track(st, [FLAT], 12) is None  # 坐了一陣子才躺下（沙發）
    assert vision.fall_track(st, [FLAT], 60) is None


def test_door_track_hysteresis():
    st: dict = {}
    assert vision.door_track(st, 0.9) is None
    assert vision.door_track(st, 0.3) is None  # 一張不算
    assert vision.door_track(st, 0.3) == "open"
    assert vision.door_track(st, 0.55) is None  # 介於中間：還算開著
    assert vision.door_track(st, 0.8) is None
    assert vision.door_track(st, 0.8) == "close"


def test_door_score_with_real_images():
    cv2 = pytest.importorskip("cv2")
    rng = np.random.default_rng(0)
    closed = np.full((240, 320, 3), 120, np.uint8)
    cv2.rectangle(closed, (100, 40), (220, 230), (40, 40, 40), 4)  # 門框
    cv2.line(closed, (160, 40), (160, 230), (60, 60, 60), 3)  # 門板中線
    jpg = lambda im: cv2.imencode(".jpg", im)[1].tobytes()  # noqa: E731
    rect = [0.28, 0.12, 0.45, 0.85]
    ref = vision.door_sig(jpg(closed), rect)
    darker = (closed * 0.6).astype(np.uint8)  # 天色暗一點：還是關著
    opened = closed.copy()
    cv2.rectangle(opened, (104, 44), (216, 226), (200, 200, 200), -1)  # 門打開：裡面一片亮
    cv2.line(opened, (120, 60), (205, 200), (20, 20, 20), 6)
    opened = cv2.add(opened, rng.integers(0, 30, opened.shape, dtype=np.uint8))
    refs = [vision.sig_decode(vision.sig_encode(ref))]
    assert vision.door_score(vision.door_sig(jpg(darker), rect), refs) > vision.DOOR_CLOSED
    assert vision.door_score(vision.door_sig(jpg(opened), rect), refs) < vision.DOOR_OPEN


def test_pet_track():
    st: dict = {}
    camera.pet_track(st, {"cat": 0.5, "dog": 0.0}, 0)
    assert "pet_new" not in st
    camera.pet_track(st, {"cat": 0.6, "dog": 0.1}, 1)
    assert st.pop("pet_new") == ["cat"] and st["pets"]["cat"]["here"]
    camera.pet_track(st, {"cat": 0.0, "dog": 0.0}, 1 + camera.PET_HOLD)
    assert not st["pets"]["cat"]["here"]


def _hub(app_module, monkeypatch):
    hub = app_module.hub
    sent, ran = [], []
    monkeypatch.setattr(hub.notifier, "send", lambda *a, **k: sent.append(a))
    monkeypatch.setattr(hub, "_presence_scene", lambda sid, why: ran.append((sid, why)))
    hub.spawned = []
    monkeypatch.setattr(hub, "_spawn", lambda coro: (hub.spawned.append(coro), coro.close()))
    monkeypatch.setattr(hub, "changed", lambda: asyncio.sleep(0))
    hub.cameras.list = [{"id": "c", "name": "客廳", "host": "x", "enabled": True, "faces": False, "fall": True, "pets": True, "role": "room",
                         "zones": [{"id": "door", "name": "大門", "kind": "door", "poly": [[0, 0], [1, 0], [1, 1], [0, 1]], "refs": ["x"], "_refs": ["ref"],
                                    "act": {"notify": "away", "scene": "s-light", "dark": True}}]}]
    hub.cameras.state["c"] = {"person": True}
    hub.store.data["people"] = [{"id": "dad", "name": "爸爸", "macs": []}]
    return hub, sent, ran


def test_door_open_when_away_waits_then_alerts(app_module, monkeypatch):
    hub, sent, ran = _hub(app_module, monkeypatch)
    vis = __import__("sys").modules["plughub.vision"]
    scores = iter([0.2, 0.2])
    monkeypatch.setattr(vis, "door_sig", lambda jpeg, rect, poly=None: np.zeros((4, 4), np.float32))
    monkeypatch.setattr(vis, "door_score", lambda sig, refs: next(scores))
    monkeypatch.setattr(vis, "is_night", lambda jpeg: True)
    monkeypatch.setattr(hub, "is_dark", lambda: True)
    now = time.time()
    hub._presence = {"dad": {"home": False, "since": now - 9999}}
    cam = hub.cameras.list[0]
    st = hub.cameras.state["c"]
    asyncio.run(hub._zones_check(cam, st, b"j", now, [], False))
    asyncio.run(hub._zones_check(cam, st, b"j", now + 1, [], False))
    assert st["zones"]["door"]["open"] and ran and ran[0][0] == "s-light" and st["night"] is True
    assert hub.face_log.items[-1]["kind"] == "zone" and any("大門開了" in k for k in hub._zone_pending)
    hub._zone_pending_check(now + 60)
    assert sent == []
    hub._zone_pending_check(now + 1 + camera.ARRIVE_WAIT)
    assert "大門開了" in sent[-1][0] and sent[-1][2] == "urgent"


def test_pet_and_fall_logged(app_module, monkeypatch):
    hub, sent, _ = _hub(app_module, monkeypatch)
    cam = hub.cameras.list[0]
    hub._pet_seen(cam, "cat", 0)
    hub._pet_seen(cam, "cat", 5)  # 10 分鐘內不重複記
    assert [x["name"] for x in hub.face_log.items if x["kind"] == "pet"] == ["貓"] and sent == []
    poses = iter([[STAND], [FLAT], [FLAT]])
    monkeypatch.setattr(hub.pose, "analyze", lambda jpeg: next(poses))
    monkeypatch.setattr(hub.face_engine, "thumb", lambda jpeg, box, size=160: b"t")
    asyncio.run(hub._fall_check(cam, b"j", 100))
    asyncio.run(hub._fall_check(cam, b"j", 101))
    assert sent == []
    asyncio.run(hub._fall_check(cam, b"j", 101 + vision.FALL_HOLD))
    assert "跌倒" in sent[-1][0] and sent[-1][2] == "urgent" and hub.face_log.items[-1]["kind"] == "fall"


def test_door_zone_remember_api(app_module, monkeypatch):
    from fastapi.testclient import TestClient

    c = TestClient(app_module.app, base_url="http://hub:8100")
    token, dev = app_module.auth.pair(app_module.auth.new_code())
    c.cookies.set("plughub_token", token)
    hub = app_module.hub
    hub.cameras.list = [{"id": "c", "name": "客廳", "host": "x", "enabled": True,
                         "zones": [{"id": "d", "name": "電梯", "kind": "door", "poly": [[0.1, 0.1], [0.4, 0.1], [0.4, 0.7]], "act": {"notify": "off"}}]}]
    assert c.post("/api/cameras/c/zones/d/ref").status_code == 403
    hub.cameras.viewers = [dev["id"]]
    vis = __import__("sys").modules["plughub.vision"]
    monkeypatch.setattr(__import__("sys").modules["plughub.camera"], "snapshot", lambda cam: b"jpeg")
    monkeypatch.setattr(vis, "door_sig", lambda jpeg, rect, poly=None: np.ones((4, 4), np.float32))
    night = {"v": False}
    monkeypatch.setattr(vis, "is_night", lambda jpeg: night["v"])
    r = c.post("/api/cameras/c/zones/d/ref").json()
    assert (r["day"], r["night"], r["refs"], r["is_night"]) == (1, 0, 1, False)
    night["v"] = True
    r = c.post("/api/cameras/c/zones/d/ref").json()
    z = r["cameras"][0]["zones"][0]
    assert r["is_night"] and r["night"] == 1 and z["day"] == 1 and z["night"] == 1 and r["cameras"][0]["night"] is True


def test_door_poly_only_looks_inside():
    cv2 = pytest.importorskip("cv2")
    img = np.full((240, 320, 3), 120, np.uint8)
    cv2.line(img, (60, 40), (60, 200), (20, 20, 20), 4)  # 門框（在多邊形裡）
    jpg = lambda im: cv2.imencode(".jpg", im)[1].tobytes()  # noqa: E731
    poly = [[0.1, 0.1], [0.3, 0.15], [0.3, 0.85], [0.1, 0.9]]
    ref = vision.door_sig(jpg(img), [0, 0, 1, 1], poly)
    outside = img.copy()
    cv2.circle(outside, (95, 200), 6, (250, 250, 250), -1)  # 多邊形外框裡、但在多邊形外面的東西變了（右下角）
    assert vision.door_score(vision.door_sig(jpg(outside), [0, 0, 1, 1], poly), [ref]) > 0.9


def test_zone_event_saves_frames(app_module, monkeypatch):
    import cv2

    hub, sent, ran = _hub(app_module, monkeypatch)
    hub_mod = __import__("sys").modules["plughub.hub"]
    cam_mod = __import__("sys").modules["plughub.camera"]
    monkeypatch.setattr(hub_mod, "CLIP_GAP", 0)
    ok, buf = cv2.imencode(".jpg", np.full((720, 1280, 3), 128, np.uint8))
    jpeg = buf.tobytes()
    monkeypatch.setattr(cam_mod, "snapshot", lambda c: jpeg)
    cam = hub.cameras.list[0]
    z = cam["zones"][0]

    async def run():
        hub._zone_fire(cam, z, "大門開了", {}, time.time(), jpeg)
        assert hub.spawned
        await hub._zone_clip(cam, hub.face_log.items[-1], z)  # _spawn 在 _hub 裡換成不執行：這裡自己跑

    asyncio.run(run())
    item = hub.face_log.items[-1]
    assert item["thumb"] and item["frames"] == hub_mod.CLIP_MORE
    first = hub.face_log.thumb_path(item["id"]).read_bytes()
    assert cv2.imdecode(np.frombuffer(first, np.uint8), cv2.IMREAD_COLOR).shape[1] == hub_mod.CLIP_W
    assert hub.face_log.thumb_path(f"{item['id']}_{hub_mod.CLIP_MORE}")
    assert hub.face_log.thumb_path("../x") is None
    hub.face_log.prune(now=time.time() + 8 * 86400)  # 7 天後：圖也刪掉
    assert hub.face_log.thumb_path(f"{item['id']}_1") is None

"""網路攝影機認人：狀態判斷、房間動靜、沒人在家的通知、API（不連真的攝影機）。"""
from __future__ import annotations

import json
import sys
import time

from plughub import camera


def test_track_needs_two_hits_and_holds():
    st: dict = {}
    assert camera.track(st, 0.8, 0) is None  # 一張不算
    assert camera.track(st, 0.1, 1) is None
    assert camera.track(st, 0.7, 2) == "on"  # 最近 3 張有 2 張
    assert st["person"] and st["since"] == 2
    assert camera.track(st, 0.1, 10) is None  # 還沒過 15 秒
    assert camera.track(st, 0.1, 2 + camera.HOLD) == "off"
    assert not st["person"]


def test_cameras_public_hides_password(tmp_path):
    (tmp_path / "cameras.json").write_text(json.dumps({"cameras": [{"id": "a", "name": "客廳", "host": "10.0.0.5", "user": "u", "pwd": "秘密", "room": "r1"}]}), "utf-8")
    cams = camera.Cameras(tmp_path)
    pub = cams.public()
    assert "pwd" not in pub[0] and "user" not in pub[0] and pub[0]["enabled"] and pub[0]["alert"]
    cams.state["a"] = {"person": True}
    assert cams.rooms_with_person() == {"r1": ["客廳"]}
    cams.list[0]["enabled"] = False
    assert cams.rooms_with_person() == {}


def test_check_scores_and_errors(tmp_path, monkeypatch):
    cams = camera.Cameras(tmp_path)
    cam = {"id": "a", "host": "10.0.0.5", "name": "門口"}
    scores = iter([0.9, 0.9])
    monkeypatch.setattr(camera, "snapshot", lambda c: b"\xff\xd8jpeg")
    monkeypatch.setattr(cams.detector, "person_score", lambda jpg: next(scores))
    assert cams.check(cam, 0) is None
    assert cams.check(cam, 1) == "on"

    def boom(c):
        raise RuntimeError("帳號或密碼不對")

    monkeypatch.setattr(camera, "snapshot", boom)
    assert cams.check(cam, 2) == "off"  # 連不上：當作人走了
    st = cams.state["a"]
    assert st["ok"] is False and st["error"] == "帳號或密碼不對"
    assert cams.check(cam, 3) is None  # 30 秒內不再試


def _hub(app_module, monkeypatch):
    hub = app_module.hub
    sent = []
    monkeypatch.setattr(hub.notifier, "send", lambda *a, **k: sent.append(a))
    hub.cameras.list = [{"id": "c1", "name": "客廳攝影機", "host": "10.0.0.5", "room": "r1", "enabled": True, "alert": True}]
    return hub, sent


def test_room_motion_includes_camera(app_module, monkeypatch):
    hub, _ = _hub(app_module, monkeypatch)
    v = hub.room_motion()["r1"]  # 沒看到人也在清單裡（動靜規則才選得到這間）
    assert v["score"] == 0 and v["cover"] >= 1 and v["person"] is False
    hub.cameras.state["c1"] = {"person": True}
    v = hub.room_motion()["r1"]
    assert v["score"] >= 1.0 and v["camera"] == ["客廳攝影機"] and v["person"] is True


def test_camera_alert_only_when_everyone_away(app_module, monkeypatch):
    hub, sent = _hub(app_module, monkeypatch)
    cam = hub.cameras.list[0]
    hub.store.data["people"] = [{"id": "x", "name": "X", "macs": []}]
    hub._presence["x"] = {"home": True, "since": 1.0}
    hub._camera_seen(cam, time.time())
    assert sent == []
    hub._presence["x"] = {"home": False, "since": 1.0}
    hub._camera_seen(cam, time.time())
    hub._camera_seen(cam, time.time())  # 10 分鐘內不重複
    assert len(sent) == 1 and "攝影機看到人" in sent[0][0] and sent[0][2] == "urgent"
    cam["alert"] = False
    hub._cam_alert.clear()
    hub._camera_seen(cam, time.time())
    assert len(sent) == 1


def test_api_cameras(app_module, monkeypatch):
    from fastapi.testclient import TestClient

    c = TestClient(app_module.app, base_url="http://hub:8100")
    token, _ = app_module.auth.pair(app_module.auth.new_code())
    c.cookies.set("plughub_token", token)
    cam_mod = sys.modules["plughub.camera"]

    def fake_info(cam):
        if cam["pwd"] != "ok":
            raise RuntimeError("帳號或密碼不對")
        return {"model": "Z2", "name": "IN_HOUSE"}

    monkeypatch.setattr(cam_mod, "dev_info", fake_info)
    assert c.post("/api/cameras", json={"host": "10.0.0.5", "user": "u", "pwd": "bad"}).status_code == 400
    r = c.post("/api/cameras", json={"host": "10.0.0.5", "user": "u", "pwd": "ok"})
    assert r.status_code == 200
    cam = r.json()["camera"]
    assert cam["name"] == "IN_HOUSE" and cam["model"] == "Z2" and "pwd" not in cam
    app_module.store.data["floorplan"] = {"rooms": [{"id": "r1", "name": "客廳"}]}
    r = c.put(f"/api/cameras/{cam['id']}", json={"room": "r1", "alert": False})
    got = r.json()["cameras"][0]
    assert got["room"] == "r1" and got["alert"] is False
    assert c.put(f"/api/cameras/{cam['id']}", json={"room": "nope"}).json()["cameras"][0]["room"] is None
    saved = json.loads((app_module.store.dir / "cameras.json").read_text("utf-8"))
    assert saved["cameras"][0]["pwd"] == "ok"
    assert "pwd" not in json.dumps(c.get("/api/cameras").json())
    assert c.delete(f"/api/cameras/{cam['id']}").json()["cameras"] == []

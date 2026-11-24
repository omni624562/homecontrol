"""區域和線：有人／逗留、東西多了／不見了、經過線的方向，以及觸發後的通知和情境。"""
from __future__ import annotations

import asyncio
import time

import numpy as np

from plughub import zones

SQ = [[0.2, 0.2], [0.6, 0.2], [0.6, 0.8], [0.2, 0.8]]


def test_inside():
    assert zones.inside((0.4, 0.5), SQ)
    assert not zones.inside((0.7, 0.5), SQ)
    tri = [[0, 0], [1, 0], [0, 1]]
    assert zones.inside((0.2, 0.2), tri) and not zones.inside((0.8, 0.8), tri)


def test_area_enter_linger_leave():
    st: dict = {}
    assert zones.area_track(st, True, 0, 30) == ["enter"]
    assert zones.area_track(st, True, 10, 30) == []
    assert zones.area_track(st, True, 31, 30) == ["linger"]
    assert zones.area_track(st, True, 40, 30) == []  # 逗留只講一次
    assert zones.area_track(st, False, 42, 30) == []  # 才離開 2 秒
    assert zones.area_track(st, False, 40 + zones.AREA_LEAVE, 30) == ["leave"]


def test_object_learns_then_detects_more_and_less():
    st: dict = {}
    assert zones.object_track(st, None, 100, 0, False) is None
    assert zones.object_track(st, None, 100, zones.OBJ_LEARN, False) == "learn"
    st["base_e"] = 100.0
    assert zones.object_track(st, 0.9, 100, 100, False) is None
    assert zones.object_track(st, 0.2, 140, 200, False) is None  # 剛變
    assert zones.object_track(st, 0.2, 140, 250, True) is None  # 有人經過：先不判斷
    assert zones.object_track(st, 0.2, 140, 260, False) is None
    assert zones.object_track(st, 0.2, 140, 200 + zones.OBJ_HOLD, False) == "more"
    st["base_e"] = 140.0
    zones.object_track(st, 0.2, 90, 1000, False)
    assert zones.object_track(st, 0.2, 90, 1000 + zones.OBJ_HOLD, False) == "less"


def test_line_direction_and_gap():
    line = {"a": [0.5, 0.0], "b": [0.5, 1.0]}  # 直線、由上往下畫：左手邊是畫面右邊
    st: dict = {}
    assert zones.line_track(st, line, [(0.4, 0.5)], 0) == []
    assert zones.line_track(st, line, [(0.6, 0.5)], 0.4) == ["in"]  # 由左走到右（箭頭那邊）
    assert zones.line_track(st, line, [(0.4, 0.5)], 1) == ["out"]
    assert zones.line_track(st, line, [(0.6, 0.5)], 2) == []  # 20 秒內同方向不重複
    assert zones.line_track(st, line, [(0.95, 0.05)], 3) == []  # 跳太遠：不是同一個人
    st2: dict = {}
    zones.line_track(st2, line, [(0.45, 0.5), (0.1, 0.1)], 0)
    assert zones.line_track(st2, line, [(0.55, 0.52), (0.12, 0.1)], 1) == ["in"]


def _hub(app_module, monkeypatch):
    hub = app_module.hub
    sent, ran = [], []
    monkeypatch.setattr(hub.notifier, "send", lambda *a, **k: sent.append(a))
    monkeypatch.setattr(hub, "_presence_scene", lambda sid, why: ran.append((sid, why)))
    monkeypatch.setattr(hub, "_spawn", lambda coro: coro.close())
    monkeypatch.setattr(hub, "is_dark", lambda: True)
    hub.cameras.list = [{"id": "g", "name": "大門口", "host": "x", "enabled": True,
                         "zones": [{"id": "z1", "name": "家門前", "kind": "area", "poly": SQ, "linger": 0, "act": {"notify": "always", "scene": "s1", "dark": True}}],
                         "lines": [{"id": "l1", "name": "樓梯口", "a": [0.5, 0.0], "b": [0.5, 1.0], "in": {"notify": "away"}, "out": {"notify": "off"}}]}]
    hub.cameras.state["g"] = {"person": True}
    hub.store.data["people"] = [{"id": "dad", "name": "爸爸", "macs": []}]
    return hub, sent, ran


def test_area_zone_fires_scene_and_notify(app_module, monkeypatch):
    hub, sent, ran = _hub(app_module, monkeypatch)
    cam, st = hub.cameras.list[0], hub.cameras.state["g"]
    asyncio.run(hub._zones_check(cam, st, b"j", 100, [{"foot": (0.8, 0.5)}], True))
    assert sent == [] and ran == []  # 在區域外
    asyncio.run(hub._zones_check(cam, st, b"j", 101, [{"foot": (0.3, 0.5)}], True))
    assert ran == [("s1", "大門口：家門前有人")] and "家門前有人" in sent[-1][0]
    assert hub.face_log.items[-1]["kind"] == "zone"


def test_line_in_when_away_waits_for_family(app_module, monkeypatch):
    hub, sent, _ = _hub(app_module, monkeypatch)
    cam, st = hub.cameras.list[0], hub.cameras.state["g"]
    now = time.time()
    hub._presence = {"dad": {"home": False, "since": now - 9999}}
    asyncio.run(hub._zones_check(cam, st, b"j", now, [{"foot": (0.9, 0.95)}], True))
    asyncio.run(hub._zones_check(cam, st, b"j", now + 1, [{"foot": (0.4, 0.5)}], True))
    asyncio.run(hub._zones_check(cam, st, b"j", now + 2, [{"foot": (0.6, 0.5)}], True))
    assert any("樓梯口：回來" in k for k in hub._zone_pending)
    hub._zone_pending_check(now + 60)
    assert not [x for x in sent if "樓梯口" in x[0]]
    hub._zone_pending_check(now + 2 + 180)
    assert "樓梯口：回來" in sent[-1][0] and sent[-1][2] == "urgent"


def test_object_zone_learns_and_reports(app_module, monkeypatch):
    hub, sent, _ = _hub(app_module, monkeypatch)
    cam, st = hub.cameras.list[0], hub.cameras.state["g"]
    cam["zones"] = [{"id": "z2", "name": "門口地板", "kind": "object", "poly": SQ, "act": {"notify": "always"}}]
    cam["lines"] = []
    vis = __import__("sys").modules["plughub.vision"]
    sigs = {"now": np.ones((64, 64), np.float32)}
    monkeypatch.setattr(vis, "door_sig", lambda jpeg, rect, poly=None: sigs["now"])
    monkeypatch.setattr(hub, "_zone_frame", lambda jpeg, item: b"t")
    asyncio.run(hub._zones_check(cam, st, b"j", 0, [], False))
    asyncio.run(hub._zones_check(cam, st, b"j", 61, [], False))
    assert len(cam["zones"][0]["refs"]) == 1  # 沒人、穩定 60 秒：自己記住正常的樣子
    rng = np.random.default_rng(1)
    sigs["now"] = (rng.random((64, 64)) * 3).astype(np.float32)  # 變很多（邊緣量變多）
    asyncio.run(hub._zones_check(cam, st, b"j", 100, [], False))
    asyncio.run(hub._zones_check(cam, st, b"j", 100 + 120, [], False))
    assert "門口地板多了東西" in sent[-1][0] and hub.face_log.items[-1]["thumb"]
    assert len(cam["zones"][0]["refs"]) == 2  # 變了之後的樣子也記起來（包裹放著不會一直講）


def test_zones_and_lines_api(app_module):
    from fastapi.testclient import TestClient

    c = TestClient(app_module.app, base_url="http://hub:8100")
    token, dev = app_module.auth.pair(app_module.auth.new_code())
    c.cookies.set("plughub_token", token)
    hub = app_module.hub
    hub.cameras.list = [{"id": "g", "name": "大門口", "host": "x", "enabled": True}]
    assert c.put("/api/cameras/g/zones", json={"zones": []}).status_code == 403
    hub.cameras.viewers = [dev["id"]]
    r = c.put("/api/cameras/g/zones", json={"zones": [{"name": "家門前", "kind": "area", "poly": SQ, "linger": 30, "act": {"notify": "away", "scene": "nope"}},
                                                     {"name": "壞的", "kind": "bogus", "poly": SQ}]}).json()["cameras"][0]
    assert len(r["zones"]) == 1 and r["zones"][0]["linger"] == 30 and r["zones"][0]["act"] == {"notify": "away", "scene": None, "dark": False, "taken": True}
    r = c.put("/api/cameras/g/lines", json={"lines": [{"name": "樓梯口", "a": [0.1, 0.5], "b": [0.9, 0.5], "in": {"notify": "always"}}, {"a": [0.1, 0.1], "b": [0.11, 0.1]}]}).json()["cameras"][0]
    assert len(r["lines"]) == 1 and r["lines"][0]["in"]["notify"] == "always" and r["lines"][0]["out"]["notify"] == "off"

"""功能使用統計、設定進度清單。"""
from __future__ import annotations

from datetime import date

from plughub.usage import Usage


def test_usage_counts_and_summary(tmp_path):
    u = Usage(tmp_path)
    d = date(2026, 11, 23)
    assert u.hit("page:map", today=d)
    u.hit("page:map", today=d)
    u.hit("page:life", today=date(2026, 10, 1))
    assert not u.hit("bad key", today=d)
    assert not u.hit("page:" + "x" * 80, today=d)
    s = u.summary(today=d)
    assert s["items"]["page:map"] == {"d7": 2, "d30": 2, "all": 2, "last": "2026-11-23"}
    assert s["items"]["page:life"]["d30"] == 0 and s["items"]["page:life"]["all"] == 1
    assert s["since"] == "2026-10-01"
    u.save()
    assert Usage(tmp_path).summary(today=d)["items"]["page:map"]["all"] == 2


def test_usage_throttle(tmp_path):
    u = Usage(tmp_path)
    assert u.hit("view:camera", every=300)
    assert not u.hit("view:camera", every=300)
    assert u.hit("notify:有人")  # 中文分類也收


def test_notify_key():
    from plughub.hub import _notify_key

    assert _notify_key("大門口：有人") == "有人"
    assert _notify_key("🚨 澆水 2 號：關不掉") == "關不掉"
    assert _notify_key("家庭中控卡住了") == "家庭中控卡住了"


def _client(app_module):
    from fastapi.testclient import TestClient

    c = TestClient(app_module.app, base_url="http://hub:8100")
    token, _ = app_module.auth.pair(app_module.auth.new_code())
    c.cookies.set("plughub_token", token)
    return c


def test_usage_api_counts_pages_and_actions(app_module):
    c = _client(app_module)
    hub = app_module.hub
    hub.usage.days = {}
    r = c.post("/api/usage", json={"keys": ["page:map", "page:map", "api:fake", 3]}).json()
    assert r["count"] == 2  # 畫面只能回報 page:
    c.put("/api/setup/skip", json={"id": "faces", "skip": True})  # 統計本身、設定進度不算
    c.put("/api/settings", json={"long_on_hours": 10})
    items = c.get("/api/usage").json()["items"]
    assert items["page:map"]["d7"] == 2
    assert "api:fake" not in items and "api:setup_skip" not in items and "api:usage_hit" not in items
    assert any(k.startswith("api:") for k in items)  # 改設定有記到


def test_notifier_counts(app_module, monkeypatch):
    hub = app_module.hub
    hub.usage.days = {}
    monkeypatch.setattr(hub.notifier, "_token", lambda: "")
    hub.notifier.send("大門口：有人", "x")
    assert "notify:有人" in hub.usage.summary()["items"]


def test_setup_checklist(app_module):
    c = _client(app_module)
    hub = app_module.hub
    hub.cameras.list = [{"id": "g", "name": "大門口", "host": "x", "enabled": True, "role": "entry", "door": {"rect": [0, 0, 1, 1], "refs": [1]}},
                        {"id": "r", "name": "客廳", "host": "y", "enabled": True, "role": "room", "room": None}]
    items = {i["id"]: i for i in c.get("/api/setup").json()["items"]}
    assert not items["cam_door"]["done"] and "大門口" in items["cam_door"]["hint"]
    assert not items["cam_room"]["done"] and "客廳" in items["cam_room"]["hint"]
    assert {"line", "people", "rooms", "map", "scene", "schedule", "backup", "faces", "cam_view"} <= set(items)
    hub.cameras.list[0]["door"]["refs"] = [1, 2]
    hub.cameras.list[1]["room"] = "r1"
    items = {i["id"]: i for i in c.get("/api/setup").json()["items"]}
    assert items["cam_door"]["done"] and items["cam_room"]["done"]
    items = {i["id"]: i for i in c.put("/api/setup/skip", json={"id": "faces", "skip": True}).json()["items"]}
    assert items["faces"]["skipped"]
    items = {i["id"]: i for i in c.put("/api/setup/skip", json={"id": "faces", "skip": False}).json()["items"]}
    assert not items["faces"]["skipped"]

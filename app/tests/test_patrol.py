"""Claude 巡家：設定、到時間才巡、有事才通知、建議關的插座要真的開著。用假的 Claude，不連網路。"""
from __future__ import annotations

import asyncio
import sys
from datetime import datetime
from types import SimpleNamespace

import pytest


class FakeClient:
    reply: dict = {}
    seen: list = []

    def __init__(self, **kw):
        self.messages = self

    async def create(self, **kw):
        FakeClient.seen.append(kw)
        usage = SimpleNamespace(input_tokens=1000, output_tokens=100, cache_creation_input_tokens=0, cache_read_input_tokens=0)
        return SimpleNamespace(usage=usage, content=[SimpleNamespace(type="tool_use", name="report", input=FakeClient.reply)])


@pytest.fixture
def hub(app_module, monkeypatch):
    h = app_module.hub
    hubmod = sys.modules["plughub.hub"]
    h.plugs["k"] = hubmod.Plug(id="k", device_key="k", kasa_name="廚房電源", model="HS103", host="10.0.0.9", is_on=True, online=True)
    h.plugs["off"] = hubmod.Plug(id="off", device_key="off", kasa_name="立燈", model="HS103", host="10.0.0.8", is_on=False, online=True)
    monkeypatch.setattr(type(h.assistant), "configured", property(lambda self: True))
    monkeypatch.setattr(h.assistant, "_secrets", lambda: {"anthropic_api_key": "sk-ant-x"})
    monkeypatch.setattr(sys.modules["plughub.patrol"].anthropic, "AsyncAnthropic", FakeClient)
    sent = []
    monkeypatch.setattr(h.notifier, "send", lambda t, m, p="default": sent.append((t, m)))
    h._sent = sent
    FakeClient.seen = []
    return h


def test_settings_validation(hub):
    p = hub.patrol
    s = p.set({"on": True, "time": "21:45", "items": ["plugs", "nope"], "extra": "x" * 500, "notify": "always"})
    assert s["on"] and s["time"] == "21:45" and s["items"] == ["plugs"] and len(s["extra"]) == 300 and s["notify"] == "always"
    with pytest.raises(ValueError):
        p.set({"time": "25:00"})


def test_due_once_a_day(hub):
    p = hub.patrol
    p.set({"on": True, "time": "22:30"})
    assert not p.due(datetime(2026, 11, 27, 22, 0))
    assert p.due(datetime(2026, 11, 27, 22, 31))
    hub.store.data["patrol_ran"] = "2026-11-27"
    assert not p.due(datetime(2026, 11, 27, 23, 0))
    p.set({"on": False})
    hub.store.data["patrol_ran"] = None
    assert not p.due(datetime(2026, 11, 27, 23, 0))


def test_issue_notifies_with_offers(hub):
    hub.patrol.set({"on": True, "items": ["plugs", "people"], "extra": "廚房電源 10 點後還開著要提醒我"})
    FakeClient.reply = {"issue": True, "text": "廚房電源還開著（3 小時）。", "turn_off_plug_ids": ["k", "off", "ghost"]}
    last = asyncio.run(hub.patrol.run())
    assert last["issue"] and last["notified"] and last["offers"] == [{"id": "k", "name": "廚房電源"}]  # 關著的、不存在的不放
    assert hub._sent and "廚房電源" in hub._sent[0][1]
    ask = FakeClient.seen[0]["messages"][0]["content"]
    assert "廚房電源" in ask and "另外交代" in ask and "camera_events_today" not in ask  # 沒勾攝影機就不送
    assert FakeClient.seen[0]["tool_choice"]["name"] == "report"


def test_quiet_when_fine(hub):
    hub.patrol.set({"on": True, "notify": "issue"})
    FakeClient.reply = {"issue": False, "text": "今天一切正常。"}
    last = asyncio.run(hub.patrol.run())
    assert not last["notified"] and hub._sent == []
    assert hub.store.data["patrol_last"]["text"] == "今天一切正常。"


def test_error_is_recorded(hub, monkeypatch):
    monkeypatch.setattr(hub.assistant, "status", lambda: {"cap": 1.0, "month_usd": 2.0, "model": "claude-haiku-5-5"})
    last = asyncio.run(hub.patrol.run())
    assert "上限" in last["error"] and hub._sent == []


def test_api(app_module, hub):
    from fastapi.testclient import TestClient

    c = TestClient(app_module.app, base_url="http://hub:8100")
    token, _ = app_module.auth.pair(app_module.auth.new_code())
    c.cookies.set("plughub_token", token)
    assert c.put("/api/patrol", json={"time": "9"}).status_code == 400
    assert c.put("/api/patrol", json={"on": True}).json()["on"] is True
    FakeClient.reply = {"issue": False, "text": "一切正常"}
    r = c.post("/api/patrol/run").json()
    assert r["last"]["text"] == "一切正常" and "plugs" in r["items_all"]

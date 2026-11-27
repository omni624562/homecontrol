"""Claude 從習慣建議自動化：建議要通過 propose_* 檢查、拒絕過的不再出現、每週一次。用假的 Claude。"""
from __future__ import annotations

import asyncio
import sys
from datetime import datetime

import pytest


CALLS: list = []
SEEN: list = []


def fake_ask(calls):
    async def ask(model, tools, content):
        SEEN.append(content)
        by = {t.name: t for t in tools}
        for name, params in calls:
            try:
                await by[name].call(params)
            except Exception:  # noqa: BLE001  參數錯：真的 Claude 會看到錯誤再修
                pass
    return ask


@pytest.fixture
def hub(app_module, monkeypatch):
    h = app_module.hub
    hubmod = sys.modules["plughub.hub"]
    h.plugs["k"] = hubmod.Plug(id="k", device_key="k", kasa_name="廚房電源", model="HS103", host="10.0.0.9", is_on=False, online=True)
    h.store.data["people"] = [{"id": "dad", "name": "阿爸", "macs": []}]
    h.store.data["arrive_rules"] = []
    monkeypatch.setattr(type(h.assistant), "configured", property(lambda self: True))
    monkeypatch.setattr(h.assistant, "_secrets", lambda: {"anthropic_api_key": "sk-ant-x"})
    SEEN.clear()
    return h


GOOD = ("propose_schedule", {"time_hhmm": "07:10", "days": [0, 1, 2, 3, 4], "action": "on", "plug_ids": ["k"], "duration_minutes": 30,
                             "reason": "過去 4 週的平日有 17 天在 07:05～07:20 打開"})


def test_run_validates_and_keeps_reason(hub, monkeypatch):
    monkeypatch.setattr(hub.ideas, "_ask", fake_ask([GOOD,
                        ("propose_arrive_rule", {"who": "dad", "plug_ids": ["k"], "when": "dark", "reason": "12 次"}),
                        ("propose_schedule", {"time_hhmm": "07:10", "days": [1], "action": "on", "plug_ids": ["nope"]}),
                        ("propose_motion_rule", {"room_id": "x", "plug_id": "k"})]))
    st = asyncio.run(hub.ideas.run())
    assert [x["kind"] for x in st["items"]] == ["schedule", "arrive"]  # 插座 ID 錯、房間不存在的被擋下
    s = st["items"][0]
    assert "平日" in s["label"] and "廚房電源" in s["label"] and s["reason"].startswith("過去 4 週") and s["body"]["duration_s"] == 1800
    assert "manual_switches" in SEEN[0] and st["items"][1]["reason"] == "12 次"
    assert hub.store.data["arrive_rules"] == []  # 只是草稿


def test_dismissed_never_again(hub, app_module, monkeypatch):
    from fastapi.testclient import TestClient

    monkeypatch.setattr(hub.ideas, "_ask", fake_ask([GOOD]))
    st = asyncio.run(hub.ideas.run())
    c = TestClient(app_module.app, base_url="http://hub:8100")
    token, _ = app_module.auth.pair(app_module.auth.new_code())
    c.cookies.set("plughub_token", token)
    assert c.post(f"/api/ideas/{st['items'][0]['id']}/dismiss").json()["items"] == []
    st = asyncio.run(hub.ideas.run())
    assert st["items"] == []  # 一樣的建議不再出現
    assert "07:10" in SEEN[-1]  # 拒絕過的有告訴 Claude
    assert c.post("/api/ideas/x/nope").status_code == 404


def test_due_weekly(hub):
    i = hub.ideas
    assert i.due(datetime(2026, 11, 25, 10, 0))  # 從來沒做過：馬上做一次
    hub.store.data["claude_ideas"] = {"week": "2026-W47"}  # 上週做過
    assert not i.due(datetime(2026, 11, 28, 21, 0))  # 星期六
    assert not i.due(datetime(2026, 11, 29, 19, 0))  # 星期日還沒 8 點
    assert i.due(datetime(2026, 11, 29, 20, 5))
    hub.store.data["claude_ideas"]["week"] = "2026-W48"
    hub.store.data["settings"]["claude_ideas"] = False
    assert not i.due(datetime(2026, 11, 29, 20, 5))


def test_error_recorded(hub, monkeypatch):
    monkeypatch.setattr(hub.assistant, "status", lambda: {"cap": 1.0, "month_usd": 3.0, "model": "claude-haiku-5-5"})
    assert "上限" in asyncio.run(hub.ideas.run())["error"]

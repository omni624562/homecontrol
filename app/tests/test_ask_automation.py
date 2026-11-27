"""問家裡用說的建自動化：回家規則、動靜規則的草稿（按了「建立」才加上去）。"""
from __future__ import annotations

import asyncio
import sys


def _setup(app_module):
    hub = app_module.hub
    hubmod = sys.modules["plughub.hub"]
    hub.plugs["p1"] = hubmod.Plug(id="p1", device_key="p1", kasa_name="客廳立燈", model="HS103", host="10.0.0.9", is_on=False, online=True)
    hub.store.data["people"] = [{"id": "dad", "name": "阿爸", "macs": []}]
    hub.store.data["floorplan"] = {"rooms": [{"id": "r1", "name": "書房", "x": 0, "y": 0, "w": 10, "h": 10}]}
    hub.store.data["arrive_rules"] = []
    actions: list = []
    return hub, actions, {t.name: t for t in hub.assistant._tools(actions)}


def test_propose_arrive_and_motion(app_module):
    from fastapi.testclient import TestClient

    hub, actions, tools = _setup(app_module)
    got = asyncio.run(tools["get_automations"].call({}))
    assert "dad" in str(got) and "r1" in str(got)
    r = asyncio.run(tools["propose_arrive_rule"].call({"who": "dad", "plug_ids": ["p1"], "when": "dark"}))
    assert "草稿" in str(r)
    a = actions[-1]
    assert a["kind"] == "arrive" and "阿爸回家、天黑後" in a["label"] and "客廳立燈" in a["label"]
    assert hub.store.data["arrive_rules"] == []  # 草稿：還沒建
    assert "沒有這位家人" in str(asyncio.run(tools["propose_arrive_rule"].call({"who": "nobody", "plug_ids": ["p1"]})))
    assert "start、end" in str(asyncio.run(tools["propose_arrive_rule"].call({"plug_ids": ["p1"], "when": "range"})))

    asyncio.run(tools["propose_motion_rule"].call({"room_id": "r1", "plug_id": "p1", "off_minutes": 10}))
    m = actions[-1]
    assert m["kind"] == "motion" and "書房有動靜" in m["label"] and "10 分鐘" in m["label"]
    assert "沒有這個房間" in str(asyncio.run(tools["propose_motion_rule"].call({"room_id": "x", "plug_id": "p1"})))

    # 使用者按「建立」：前端照草稿的 body 呼叫原本的 API
    c = TestClient(app_module.app, base_url="http://hub:8100")
    token, _ = app_module.auth.pair(app_module.auth.new_code())
    c.cookies.set("plughub_token", token)
    assert c.post("/api/arrive-rules", json=a["body"]).status_code == 200
    rule = hub.store.data["arrive_rules"][0]
    assert rule["who"] == "dad" and rule["when"] == "dark" and rule["plugs"] == ["p1"]
    cur = c.get("/api/motion-rules").json()["rules"]
    assert c.put("/api/motion-rules", json={"rules": [*cur, m["body"]]}).status_code == 200
    assert hub.store.data["motion_rules"][0]["off_min"] == 10

    # 改舊的回家規則
    asyncio.run(tools["propose_arrive_rule"].call({"who": "dad", "plug_ids": ["p1"], "when": "range", "start": "19:00", "end": "23:00",
                                                    "rule_id": rule["id"]}))
    e = actions[-1]
    assert e["rule_id"] == rule["id"] and e["label"].startswith("修改回家規則")
    assert c.put(f"/api/arrive-rules/{rule['id']}", json=e["body"]).json()["rules"][0]["start"] == "19:00"

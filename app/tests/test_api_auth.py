"""API 要先配對：沒配對的裝置不能開關、改設定。"""

import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def client(app_module):
    # 不用 with：不跑 lifespan（不找插座、不開背景工作）
    return TestClient(app_module.app, base_url="http://hub:8100")


def test_unpaired_is_rejected(client):
    for method, path in [("GET", "/api/state"), ("POST", "/api/off"), ("PUT", "/api/settings"),
                         ("POST", "/api/assistant/chat"), ("GET", "/matterbridge"), ("POST", "/api/auth/code")]:
        r = client.request(method, path, json={})
        assert r.status_code == 401, (method, path)
        assert r.json()["unpaired"] is True


def test_open_endpoints(client):
    r = client.get("/api/auth")
    assert r.status_code == 200 and r.json()["paired"] is False
    r = client.get("/api/health")
    assert r.status_code == 200 and r.json()["ok"] is True
    # 網頁本身不用配對（才能顯示配對畫面）
    assert client.get("/").status_code == 200


def test_pair_flow(app_module, client):
    code = app_module.auth.new_code()
    r = client.post("/api/auth/pair", json={"code": "999999" if code != "999999" else "000000"})
    assert r.status_code == 403
    r = client.post("/api/auth/pair", json={"code": code, "name": "測試"})
    assert r.status_code == 200
    assert "plughub_token" in r.cookies
    cookie = r.headers["set-cookie"].lower()
    assert "httponly" in cookie and "samesite=strict" in cookie
    assert client.get("/api/auth").json()["paired"] is True
    devices = client.get("/api/auth/devices").json()["devices"]
    assert [d["name"] for d in devices] == ["測試"] and devices[0]["current"]
    # 移除自己之後就不能用了
    assert client.delete(f"/api/auth/devices/{devices[0]['id']}").status_code == 200
    assert client.get("/api/auth/devices").status_code == 401


def test_bearer_token(app_module, client):
    token, _ = app_module.auth.pair(app_module.auth.new_code())
    client.cookies.clear()
    r = client.post("/api/auth/code", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 200 and len(r.json()["code"]) == 6


def test_cross_site_post_blocked(app_module, client):
    token, _ = app_module.auth.pair(app_module.auth.new_code())
    client.cookies.set("plughub_token", token)
    r = client.post("/api/auth/code", headers={"Origin": "http://evil.example"})
    assert r.status_code == 403
    r = client.post("/api/auth/code", headers={"Origin": "http://hub:8100"})
    assert r.status_code == 200


def test_send_code_rate_limited(app_module, client, monkeypatch):
    sent = []
    monkeypatch.setattr(app_module.hub.notifier, "send", lambda *a, **k: sent.append(a))
    assert client.post("/api/auth/send-code").status_code == 200
    assert client.post("/api/auth/send-code").status_code == 429
    assert len(sent) == 1 and sent[0][0] == "配對碼"


def test_local_needs_no_pairing(app_module, client, monkeypatch):
    """樹莓派本機（Matterbridge 外掛、nginx）不用配對。"""
    monkeypatch.setattr(app_module, "_is_local", lambda request: True)
    assert client.post("/api/auth/code").status_code == 200


def test_family_phone_needs_no_pairing(app_module, client, monkeypatch):
    """「誰在家」登記的家人手機、勾了「不用配對」的平板，自動認得。"""
    macs = {"testclient": None}
    monkeypatch.setattr(app_module, "_mac_of", lambda ip: macs.get(ip))
    assert client.get("/api/auth/devices").status_code == 401

    app_module.store.data["people"] = [{"id": "m", "name": "媽媽", "macs": ["AA:BB:CC:00:00:01"]}]
    macs["testclient"] = "AA:BB:CC:00:00:01"
    assert client.get("/api/auth").json()["paired"] is True
    r = client.get("/api/auth/devices").json()
    assert r["trusted"] == [{"mac": "AA:BB:CC:00:00:01", "name": "媽媽的手機", "online": False, "current": True}]

    macs["testclient"] = "AA:BB:CC:00:00:02"  # 客人的手機
    assert client.get("/api/auth/devices").status_code == 401
    app_module.store.data["net_devices"]["AA:BB:CC:00:00:02"] = {"label": "客廳平板", "trusted": True}
    assert client.get("/api/auth/devices").status_code == 200


def test_arp_lookup(app_module, tmp_path, monkeypatch):
    arp = tmp_path / "arp"
    arp.write_text(
        "IP address       HW type     Flags       HW address            Mask     Device\n"
        "10.0.2.50        0x1         0x2         aa:bb:cc:dd:ee:ff     *        eth0\n"
        "10.0.2.51        0x1         0x0         00:00:00:00:00:00     *        eth0\n"
    )
    real_open = open
    monkeypatch.setattr("builtins.open", lambda p, *a, **k: real_open(arp if p == "/proc/net/arp" else p, *a, **k))
    assert app_module._arp_mac("10.0.2.50") == "AA:BB:CC:DD:EE:FF"
    assert app_module._arp_mac("10.0.2.51") is None


def test_home_layout(app_module, client):
    token, _ = app_module.auth.pair(app_module.auth.new_code())
    client.cookies.set("plughub_token", token)
    app_module.store.data["rooms"] = [{"id": "a", "name": "A"}, {"id": "b", "name": "B"}]
    put = lambda lay: client.put("/api/settings", json={"home_layout": lay})  # noqa: E731
    # 不認得的區域、重複的、超過欄數的都丟掉
    assert put({"3": [["b", "x", "b"], ["_none"], [], ["a"]], "1": [["a"]], "99": [["a"]]}).status_code == 200
    assert app_module.store.data["settings"]["home_layout"] == {"3": [["b"], ["_none"], []]}
    put({"4": [["a"], ["b"], [], []]})
    assert set(app_module.store.data["settings"]["home_layout"]) == {"3", "4"}
    put({"3": None})  # 這個欄數恢復自動排列
    assert set(app_module.store.data["settings"]["home_layout"]) == {"4"}
    put(None)
    assert "home_layout" not in app_module.store.data["settings"]


def test_home_side(app_module, client):
    token, _ = app_module.auth.pair(app_module.auth.new_code())
    client.cookies.set("plughub_token", token)
    assert client.put("/api/settings", json={"home_side": ["next", "x", "people", "next"]}).status_code == 200
    assert app_module.store.data["settings"]["home_side"] == ["next", "people", "ask", "energy"]
    client.put("/api/settings", json={"home_side": None})
    assert "home_side" not in app_module.store.data["settings"]


def test_floorplan_room_shape(app_module, client):
    token, _ = app_module.auth.pair(app_module.auth.new_code())
    client.cookies.set("plughub_token", token)
    L = [[0, 0], [200, 0], [200, 100], [100, 100], [100, 200], [0, 200]]  # L 形
    r = client.put("/api/floorplan", json={"w": 1000, "h": 600, "rooms": [
        {"id": "a", "name": "A", "x": 5, "y": 5, "w": 50, "h": 50, "pts": L},
        {"id": "b", "name": "B", "x": 300, "y": 0, "w": 100, "h": 100, "pts": [[0, 0], [1, 1], [2, 2], [3, 3]]},  # 四個點 = 長方形，不存
    ]})
    assert r.status_code == 200
    a, b = r.json()["rooms"]
    assert a["pts"] == L and (a["x"], a["y"], a["w"], a["h"]) == (0, 0, 200, 200)
    assert "pts" not in b and b["w"] == 100


def test_floorplan_walls_doors(app_module, client):
    token, _ = app_module.auth.pair(app_module.auth.new_code())
    client.cookies.set("plughub_token", token)
    r = client.put("/api/floorplan", json={
        "walls": [{"id": "w1", "x1": 0, "y1": 0, "x2": 300, "y2": 0}, "壞的"],
        "doors": [{"id": "d1", "wall": "w1", "t": 0.5, "w": 75, "flip": 2}, {"id": "d2", "wall": "沒有這道牆", "t": 0.5, "w": 75},
                  {"id": "n1", "wall": "w1", "t": 0.2, "w": 100, "kind": "fwin"}, {"id": "n2", "wall": "w1", "t": 0.8, "w": 60, "kind": "亂寫"}],
    })
    assert r.status_code == 200
    fp = r.json()
    assert [x["id"] for x in fp["walls"]] == ["w1"]
    assert fp["doors"] == [{"id": "d1", "wall": "w1", "t": 0.5, "w": 75, "flip": 2},
                           {"id": "n1", "wall": "w1", "t": 0.2, "w": 100, "flip": 0, "kind": "fwin"},
                           {"id": "n2", "wall": "w1", "t": 0.8, "w": 60, "flip": 0}]

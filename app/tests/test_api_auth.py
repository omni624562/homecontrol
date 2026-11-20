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

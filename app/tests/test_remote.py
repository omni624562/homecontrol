"""在外面用：外面來的連線只認「在外面也能用」的配對裝置；配對只能在家做。"""

import pytest
from fastapi.testclient import TestClient

from plughub import remote as remotemod
from plughub.router import read_forwards

REAL = remotemod.is_outside
OUT = ("203.0.113.9", 5555)  # 文件用的範例 IP 不算 global，下面把它當外面
HOME = ("10.0.2.50", 5555)


@pytest.fixture(autouse=True)
def fake_outside(monkeypatch, request):
    if "app_module" not in request.fixturenames:
        return
    mod = request.getfixturevalue("app_module").remotemod
    monkeypatch.setattr(mod, "is_outside", lambda h, *a: h == OUT[0] or REAL(h, lambda: set()))


@pytest.fixture
def sent(app_module, monkeypatch):
    got = []
    monkeypatch.setattr(app_module.hub.notifier, "send", lambda title, text, *a, **k: got.append((title, text)))
    return got


def mk(app_module, addr):
    async def app(scope, receive, send):  # 假裝連線從 addr 來
        await app_module.app({**scope, "client": addr}, receive, send)
    return TestClient(app, base_url="https://hub:8443")


def test_is_outside():
    real = REAL
    assert real("8.8.8.8") and real("::ffff:8.8.8.8")
    for h in ("10.0.2.5", "192.168.1.2", "127.0.0.1", "100.100.1.1", "fe80::1", "fd00::1", "testclient", None):
        assert not real(h), h
    assert real("2001:4860::1", lambda: set())
    assert not real("2001:4860::1", lambda: {"2001486000000000"})


def test_outside_needs_remote_flag(app_module, sent):
    token, dev = app_module.auth.pair(app_module.auth.new_code(), "手機")
    c = mk(app_module, OUT)
    c.cookies.set("plughub_token", token)
    r = c.get("/api/state")
    assert r.status_code == 401 and r.json()["outside"] is True
    assert c.get("/api/auth").json() == {"paired": False, "outside": True, "device": None, "can_send": False, "locked_for": 0}
    assert sent and "被擋下" in sent[-1][1]
    # 在家照常
    h = mk(app_module, HOME)
    h.cookies.set("plughub_token", token)
    assert h.get("/api/auth/devices").status_code == 200
    assert h.patch(f"/api/auth/devices/{dev['id']}", json={"remote": True}).status_code == 200
    sent.clear()
    assert c.get("/api/auth").json()["paired"] is True
    assert c.get("/api/auth/devices").status_code == 200
    assert len(sent) == 1 and "從外面的網路" in sent[0][1]
    d = next(x for x in h.get("/api/auth/devices").json()["devices"] if x["id"] == dev["id"])
    assert d["remote"] is True and d["last_remote"]["ip"] == OUT[0]
    # 同一個地方再來不再通知
    c.get("/api/auth/devices")
    assert len(sent) == 1
    # 總開關關掉就都不行
    assert h.put("/api/remote", json={"on": False}).json()["on"] is False
    assert c.get("/api/auth/devices").status_code == 401
    h.put("/api/remote", json={"on": True})


def test_outside_cannot_pair(app_module):
    code = app_module.auth.new_code()
    c = mk(app_module, OUT)
    r = c.post("/api/auth/pair", json={"code": code})
    assert r.status_code == 403 and r.json()["outside"] is True
    assert c.post("/api/auth/send-code").status_code == 403
    assert c.get("/api/health").status_code == 200


def test_trusted_mac_not_used_outside(app_module, monkeypatch):
    monkeypatch.setattr(app_module, "_trusted", lambda r: {"id": "mac:x", "name": "家人手機", "trusted": True})
    assert mk(app_module, HOME).get("/api/auth/devices").status_code == 200
    assert mk(app_module, OUT).get("/api/auth/devices").status_code == 401


def test_status_from_router(app_module, monkeypatch):
    r = app_module.hub.router
    monkeypatch.setattr(r, "wan", {"ddns": "home.example.net", "forwards": read_forwards(
        "<443>443>10.0.2.42>443>TCP><x>9443>10.0.2.77>8443>TCP>")})
    monkeypatch.setattr(app_module.remote, "local_ips", lambda: ["10.0.2.77", "127.0.0.1"])
    monkeypatch.setattr(app_module.remote, "https_port", 8443)
    s = app_module.remote.status({"names": ["home.example.net"], "until": "2027-01-01"})
    assert s["url"] == "https://home.example.net:9443" and s["forward"]["ext"] == "9443" and s["cert_ok"]
    assert app_module._tls_names() == ["home.example.net"]


def test_tls_includes_name(tmp_path):
    from plughub import tls
    tls.ensure(tmp_path, ips=["10.0.2.77"], names=["home.example.net"])
    assert "home.example.net" in tls.info(tmp_path)["names"]

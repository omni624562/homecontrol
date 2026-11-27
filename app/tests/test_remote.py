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


def _issue(host, self_signed=False):
    import datetime as dt
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.x509.oid import NameOID, ExtendedKeyUsageOID
    now = dt.datetime.now(dt.timezone.utc)
    ca_key = ec.generate_private_key(ec.SECP256R1())
    ca_name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Test Root"), x509.NameAttribute(NameOID.ORGANIZATION_NAME, "Test CA")])
    ca = (x509.CertificateBuilder().subject_name(ca_name).issuer_name(ca_name).public_key(ca_key.public_key())
          .serial_number(1).not_valid_before(now - dt.timedelta(days=1)).not_valid_after(now + dt.timedelta(days=30))
          .add_extension(x509.BasicConstraints(ca=True, path_length=None), critical=True)
          .add_extension(x509.KeyUsage(digital_signature=True, key_cert_sign=True, crl_sign=True, content_commitment=False, key_encipherment=False,
                                       data_encipherment=False, key_agreement=False, encipher_only=False, decipher_only=False), critical=True)
          .add_extension(x509.SubjectKeyIdentifier.from_public_key(ca_key.public_key()), critical=False)
          .sign(ca_key, hashes.SHA256()))
    key = ec.generate_private_key(ec.SECP256R1())
    signer = key if self_signed else ca_key
    leaf = (x509.CertificateBuilder().subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, host)]))
            .issuer_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, host)]) if self_signed else ca_name)
            .public_key(key.public_key()).serial_number(2)
            .not_valid_before(now - dt.timedelta(days=1)).not_valid_after(now + dt.timedelta(days=20))
            .add_extension(x509.SubjectAlternativeName([x509.DNSName(host)]), critical=False)
            .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
            .add_extension(x509.AuthorityKeyIdentifier.from_issuer_public_key(signer.public_key()), critical=False)
            .sign(signer, hashes.SHA256()))
    pem = serialization.Encoding.PEM
    chain = leaf.public_bytes(pem) + (b"" if self_signed else ca.public_bytes(pem))
    return chain, key.private_bytes(pem, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()), ca


def test_public_cert(tmp_path):
    from plughub import tls
    chain, key, ca = _issue("home.example.net")
    info = tls.check_public(chain, key, "home.example.net", trust=[ca])
    assert info["issuer"] == "Test CA" and info["names"] == ["home.example.net"]
    with pytest.raises(ValueError):
        tls.check_public(chain, key, "other.example.net", trust=[ca])
    _, other_key, _ = _issue("home.example.net")
    with pytest.raises(ValueError):
        tls.check_public(chain, other_key, "home.example.net", trust=[ca])
    ss_chain, ss_key, _ = _issue("home.example.net", self_signed=True)
    with pytest.raises(ValueError):
        tls.check_public(ss_chain, ss_key, "home.example.net", trust=[ca])
    assert tls.save_public(tmp_path, chain, key, "home.example.net", trust=[ca]) is True
    assert tls.save_public(tmp_path, chain, key, "home.example.net", trust=[ca]) is False
    assert oct(tls.public_paths(tmp_path)["key"].stat().st_mode & 0o777) == "0o600"
    sw = tls.SniSwitch()
    assert sw.load(tmp_path, "home.example.net", trust=[ca])["until"]
    assert sw.names == {"home.example.net"} and sw.ctx is not None
    assert sw.load(tmp_path, "home.example.net", trust=[]) is None and sw.ctx is None

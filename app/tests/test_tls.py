"""家裡專用的 HTTPS 憑證：產生、IP 變了重簽、快到期重簽、根憑證不變、下載。"""
from __future__ import annotations

import datetime as dt

from cryptography import x509

from plughub import tls


def _san(p):
    cert = x509.load_pem_x509_certificate(p["crt"].read_bytes())
    san = cert.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
    return cert, sorted(str(x) for x in san.get_values_for_type(x509.IPAddress))


def test_ensure_creates_and_reissues(tmp_path):
    p = tls.ensure(tmp_path, ips=["10.0.2.77"])
    ca1 = p["ca_crt"].read_bytes()
    cert, ips = _san(p)
    assert ips == ["10.0.2.77", "127.0.0.1"]
    ca = x509.load_pem_x509_certificate(ca1)
    assert cert.issuer == ca.subject
    assert oct(p["ca_key"].stat().st_mode & 0o777) == "0o600" and oct(p["key"].stat().st_mode & 0o777) == "0o600"
    serial = cert.serial_number
    tls.ensure(tmp_path, ips=["10.0.2.77"])
    assert _san(p)[0].serial_number == serial  # 沒變：不重簽
    tls.ensure(tmp_path, ips=["10.0.2.77", "10.8.0.1"])  # 多了 VPN 的 IP：重簽，根憑證不變
    assert _san(p)[1] == ["10.0.2.77", "10.8.0.1", "127.0.0.1"] and p["ca_crt"].read_bytes() == ca1
    later = dt.datetime.now(dt.timezone.utc) + dt.timedelta(days=tls.CERT_DAYS - 30)
    old = _san(p)[0].serial_number
    tls.ensure(tmp_path, ips=["10.0.2.77", "10.8.0.1"], now=later)  # 快到期：重簽
    assert _san(p)[0].serial_number != old
    info = tls.info(tmp_path)
    assert info["ready"] and "10.8.0.1" in info["ips"] and len(info["fingerprint"].split(":")) == 32


def test_ca_download_is_open(app_module, data_dir):
    from fastapi.testclient import TestClient

    tls.ensure(data_dir, ips=["10.0.2.77"])
    c = TestClient(app_module.app, base_url="http://hub:8100")
    r = c.get("/api/tls/ca.crt")  # 沒配對也能下載
    assert r.status_code == 200 and r.content.startswith(b"-----BEGIN CERTIFICATE-----") and b"PRIVATE" not in r.content
    assert c.get("/api/tls").status_code == 401  # 狀態要配對
    token, _ = app_module.auth.pair(app_module.auth.new_code())
    c.cookies.set("plughub_token", token)
    j = c.get("/api/tls").json()
    assert j["ready"] and j["secure"] is False and j["port"] == 8443

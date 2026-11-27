"""家裡專用的 HTTPS：樹莓派自己當憑證機構（根憑證），再簽一張給家庭中控用的伺服器憑證。

- 瀏覽器只在 HTTPS 下讓網頁開鏡頭、麥克風；每台要用的電腦、手機把根憑證裝一次就好。
- 根憑證的私鑰只在樹莓派上（data/tls/ca.key，600 權限），不會傳出去；下載的只有根憑證本身（公開的）。
- 伺服器憑證包含樹莓派現在的 IP（家裡網路、VPN）和名稱；IP 變了、快到期（60 天內）就自動重簽。
- 原本的 http://…:8100 照常可用（還沒裝憑證的裝置不受影響）。
"""
from __future__ import annotations

import datetime as dt
import fcntl
import hashlib
import ipaddress
import logging
import os
import socket
import struct
from pathlib import Path
from typing import Any

_LOGGER = logging.getLogger(__name__)

CA_DAYS = 3650  # 根憑證 10 年
CERT_DAYS = 825  # 伺服器憑證：Apple 對自己裝的根憑證簽的伺服器憑證上限是 825 天
RENEW_DAYS = 60
SKIP_IF = ("lo", "docker", "br-", "veth")


def local_ips() -> list[str]:
    """這台樹莓派的 IPv4（家裡網路、Wi-Fi、VPN；不含 Docker 的虛擬網卡）。"""
    out = []
    try:
        names = sorted(os.listdir("/sys/class/net"))
    except OSError:
        names = []
    for name in names:
        if name.startswith(SKIP_IF):
            continue
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
                raw = fcntl.ioctl(s.fileno(), 0x8915, struct.pack("256s", name[:15].encode()))  # SIOCGIFADDR
            out.append(socket.inet_ntoa(raw[20:24]))
        except OSError:
            continue  # 這張網卡沒有 IPv4（例如沒連上的 Wi-Fi）
    return out


def wanted_names(ips: list[str] | None = None, names: list[str] | None = None) -> tuple[list[str], list[str]]:
    """憑證要包含的 IP 和名稱（names：從外面連的網址，例如路由器的 DDNS 名稱）。"""
    host = socket.gethostname()
    ips = sorted(set((ips if ips is not None else local_ips()) + ["127.0.0.1"]))
    dns = sorted({host, f"{host}.local", "localhost", *(n for n in names or [] if n)})
    return ips, dns


def _paths(d: Path) -> dict[str, Path]:
    return {"ca_key": d / "ca.key", "ca_crt": d / "ca.crt", "key": d / "server.key", "crt": d / "server.crt"}


def _write(path: Path, data: bytes, secret: bool = False) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_bytes(data)
    os.chmod(tmp, 0o600 if secret else 0o644)
    tmp.replace(path)


def ensure(data_dir: Path, ips: list[str] | None = None, now: dt.datetime | None = None, names: list[str] | None = None) -> dict[str, Path]:
    """確定根憑證和伺服器憑證都在、都有效、包含現在的 IP；需要就產生或重簽。回傳檔案路徑。"""
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID

    d = data_dir / "tls"
    d.mkdir(parents=True, exist_ok=True)
    p = _paths(d)
    now = now or dt.datetime.now(dt.timezone.utc)
    pem = serialization.Encoding.PEM
    nokey = serialization.NoEncryption()

    # 根憑證（沒有才做；做了就一直用，不然每台裝過的裝置都要重裝）
    if not (p["ca_key"].exists() and p["ca_crt"].exists()):
        key = ec.generate_private_key(ec.SECP256R1())
        name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, f"家庭中控 本機憑證 ({socket.gethostname()})"),
                          x509.NameAttribute(NameOID.ORGANIZATION_NAME, "家庭中控")])
        ca = (x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key())
              .serial_number(x509.random_serial_number())
              .not_valid_before(now - dt.timedelta(days=1)).not_valid_after(now + dt.timedelta(days=CA_DAYS))
              .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
              .add_extension(x509.KeyUsage(digital_signature=True, key_cert_sign=True, crl_sign=True, content_commitment=False, key_encipherment=False,
                                           data_encipherment=False, key_agreement=False, encipher_only=False, decipher_only=False), critical=True)
              .add_extension(x509.SubjectKeyIdentifier.from_public_key(key.public_key()), critical=False)
              .sign(key, hashes.SHA256()))
        _write(p["ca_key"], key.private_bytes(pem, serialization.PrivateFormat.PKCS8, nokey), secret=True)
        _write(p["ca_crt"], ca.public_bytes(pem))
        _write(p["crt"], b"")  # 舊的伺服器憑證作廢
        _LOGGER.info("產生了家裡專用的根憑證")
    ca_key = serialization.load_pem_private_key(p["ca_key"].read_bytes(), None)
    ca = x509.load_pem_x509_certificate(p["ca_crt"].read_bytes())

    # 伺服器憑證：沒有、快到期、或 IP／名稱變了就重簽
    ip_list, dns = wanted_names(ips, names)
    reason = None
    try:
        cur = x509.load_pem_x509_certificate(p["crt"].read_bytes())
        san = cur.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
        have_ips = sorted(str(x) for x in san.get_values_for_type(x509.IPAddress))
        have_dns = sorted(san.get_values_for_type(x509.DNSName))
        if cur.not_valid_after_utc - now < dt.timedelta(days=RENEW_DAYS):
            reason = "快到期了"
        elif not set(ip_list) <= set(have_ips) or not set(dns) <= set(have_dns):
            reason = "IP 或名稱變了"
        elif cur.issuer != ca.subject:
            reason = "根憑證換了"
    except Exception:  # noqa: BLE001
        reason = "還沒有"
    if reason:
        key = ec.generate_private_key(ec.SECP256R1())
        cert = (x509.CertificateBuilder()
                .subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, ip_list[0] if ip_list else "家庭中控")]))
                .issuer_name(ca.subject).public_key(key.public_key()).serial_number(x509.random_serial_number())
                .not_valid_before(now - dt.timedelta(days=1)).not_valid_after(now + dt.timedelta(days=CERT_DAYS))
                .add_extension(x509.SubjectAlternativeName([x509.DNSName(n) for n in dns] + [x509.IPAddress(ipaddress.ip_address(i)) for i in ip_list]), critical=False)
                .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
                .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
                .add_extension(x509.KeyUsage(digital_signature=True, key_encipherment=False, content_commitment=False, data_encipherment=False,
                                             key_agreement=False, key_cert_sign=False, crl_sign=False, encipher_only=False, decipher_only=False), critical=True)
                .add_extension(x509.AuthorityKeyIdentifier.from_issuer_public_key(ca_key.public_key()), critical=False)
                .sign(ca_key, hashes.SHA256()))
        _write(p["key"], key.private_bytes(pem, serialization.PrivateFormat.PKCS8, nokey), secret=True)
        _write(p["crt"], cert.public_bytes(pem))
        _LOGGER.info("重新簽了 HTTPS 憑證（%s）：%s", reason, "、".join(ip_list + dns))
    return p


def info(data_dir: Path) -> dict[str, Any]:
    """給設定頁看的：根憑證的指紋（裝的時候可以對照）、伺服器憑證的期限和包含的位址。"""
    from cryptography import x509
    from cryptography.hazmat.primitives import serialization

    p = _paths(data_dir / "tls")
    if not p["ca_crt"].exists() or not p["crt"].exists():
        return {"ready": False}
    ca = x509.load_pem_x509_certificate(p["ca_crt"].read_bytes())
    cur = x509.load_pem_x509_certificate(p["crt"].read_bytes())
    san = cur.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
    fp = hashlib.sha256(ca.public_bytes(serialization.Encoding.DER)).hexdigest().upper()
    return {"ready": True, "fingerprint": ":".join(fp[i:i + 2] for i in range(0, len(fp), 2)),
            "ca_until": ca.not_valid_after_utc.date().isoformat(), "until": cur.not_valid_after_utc.date().isoformat(),
            "ips": [str(x) for x in san.get_values_for_type(x509.IPAddress)], "names": san.get_values_for_type(x509.DNSName)}


# ---- 公開憑證（路由器用 Let's Encrypt 幫 DDNS 名稱申請的）----
# 從外面用 DDNS 網址連時給這張：手機不用裝根憑證，也能裝成 App。家裡用 IP 連照舊給自己簽的。


def public_paths(data_dir: Path) -> dict[str, Path]:
    d = data_dir / "tls"
    return {"crt": d / "public.crt", "key": d / "public.key"}


SYSTEM_CA = "/etc/ssl/certs/ca-certificates.crt"


def check_public(chain_pem: bytes, key_pem: bytes, host: str, now: dt.datetime | None = None, trust: list[Any] | None = None) -> dict[str, Any]:
    """確認是公開憑證機構簽給這個網址的、還沒過期、私鑰對得上；不對就丟 ValueError。
    （路由器沒開 Let's Encrypt 時那張是自己簽的，不能用）"""
    from cryptography import x509
    from cryptography.hazmat.primitives import serialization
    from cryptography.x509.verification import PolicyBuilder, Store

    now = now or dt.datetime.now(dt.timezone.utc)
    try:
        chain = x509.load_pem_x509_certificates(chain_pem)
        cert = chain[0]
        key = serialization.load_pem_private_key(key_pem, None)
    except Exception as err:  # noqa: BLE001
        raise ValueError(f"看不懂憑證或私鑰：{err}") from err
    try:
        roots = trust if trust is not None else x509.load_pem_x509_certificates(Path(SYSTEM_CA).read_bytes())
        PolicyBuilder().store(Store(roots)).time(now.replace(tzinfo=None)).build_server_verifier(x509.DNSName(host)).verify(cert, chain[1:])
    except Exception as err:  # noqa: BLE001
        raise ValueError(f"不是公開憑證機構簽給 {host} 的有效憑證：{err}") from err
    names = cert.extensions.get_extension_for_class(x509.SubjectAlternativeName).value.get_values_for_type(x509.DNSName)
    pub = serialization.PublicFormat.SubjectPublicKeyInfo
    if key.public_key().public_bytes(serialization.Encoding.DER, pub) != cert.public_key().public_bytes(serialization.Encoding.DER, pub):
        raise ValueError("私鑰跟憑證對不上")
    org = cert.issuer.get_attributes_for_oid(x509.NameOID.ORGANIZATION_NAME)
    return {"names": names, "until": cert.not_valid_after_utc.date().isoformat(), "issuer": org[0].value if org else cert.issuer.rfc4514_string()}


def save_public(data_dir: Path, chain_pem: bytes, key_pem: bytes, host: str, trust: list[Any] | None = None) -> bool:
    """檢查過才存（私鑰 600）；跟現在的一樣就不動。回傳有沒有換。"""
    check_public(chain_pem, key_pem, host, trust=trust)
    p = public_paths(data_dir)
    p["crt"].parent.mkdir(parents=True, exist_ok=True)
    try:
        if p["crt"].read_bytes() == chain_pem and p["key"].read_bytes() == key_pem:
            return False
    except OSError:
        pass
    _write(p["key"], key_pem, secret=True)
    _write(p["crt"], chain_pem)
    return True


def public_info(data_dir: Path, host: str | None, trust: list[Any] | None = None) -> dict[str, Any] | None:
    p = public_paths(data_dir)
    if not host or not p["crt"].exists():
        return None
    try:
        return check_public(p["crt"].read_bytes(), p["key"].read_bytes(), host, trust=trust)
    except (OSError, ValueError):
        return None


class SniSwitch:
    """連線時看要的網址（SNI）：是公開憑證上的名稱就換成公開憑證，其他照舊。"""

    def __init__(self) -> None:
        self.ctx = None
        self.names: set[str] = set()

    def load(self, data_dir: Path, host: str | None, trust: list[Any] | None = None) -> dict[str, Any] | None:
        import ssl

        info = public_info(data_dir, host, trust)
        if not info:
            self.ctx, self.names = None, set()
            return None
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.minimum_version = ssl.TLSVersion.TLSv1_2
        p = public_paths(data_dir)
        ctx.load_cert_chain(str(p["crt"]), str(p["key"]))
        self.ctx, self.names = ctx, {n.lower() for n in info["names"]}
        return info

    def attach(self, base) -> None:
        def pick(sock, name, _ctx):
            if name and self.ctx is not None and name.lower() in self.names:
                sock.context = self.ctx
        base.sni_callback = pick

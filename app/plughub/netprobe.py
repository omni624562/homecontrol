"""看不出是什麼的網路裝置：在家裡網路裡直接問它一下（網頁標題、伺服器名稱、加密憑證上的公司），猜是什麼東西。

只讀不寫：不登入、不送帳密，只連家裡網段的位址，不連外面。
"""
from __future__ import annotations

import asyncio
import ipaddress
import re
import ssl
from typing import Any

from cryptography import x509
from cryptography.x509.oid import NameOID

# (關鍵字, 顯示的名字, 種類)；依序比對，先中先贏；名字裡的 {v} 換成找到的廠牌
RULES: list[tuple[str, str, str]] = [
    (r"foscam", "Foscam 攝影機", "camera"),
    (r"hikvision", "海康攝影機", "camera"),
    (r"dahua", "大華攝影機", "camera"),
    (r"reolink", "Reolink 攝影機", "camera"),
    (r"tapo|tp-link.*(cam|c\d{3})", "TP-Link 攝影機", "camera"),
    (r"\b(ip ?cam|ipcamera|network camera|webcam|nvr|dvr)\b", "網路攝影機", "camera"),
    (r"synology|diskstation", "Synology NAS", "nas"),
    (r"qnap", "QNAP NAS", "nas"),
    (r"\b(hp|hewlett)\b.*(printer|laserjet|officejet|deskjet)|laserjet|officejet|deskjet", "HP 印表機", "printer"),
    (r"epson", "Epson 印表機", "printer"),
    (r"canon", "Canon 印表機", "printer"),
    (r"brother", "Brother 印表機", "printer"),
    (r"printer|\bipp\b|cups", "印表機", "printer"),
    (r"philips hue|hue bridge", "Philips Hue 橋接器", "network"),
    (r"openwrt|luci|routeros|mikrotik|ubiquiti|unifi", "網路設備", "network"),
]

PORTS_HTTP = (80, 88, 8080)
TIMEOUT = 4


def raw_name(n: str | None) -> bool:
    """路由器給的名字看不懂（沒有、MAC、android-dhcp-12、MSFT 5.0…）——和畫面上的 isRawName 一樣。"""
    return not n or bool(re.match(r"^([0-9a-f]{2}:){5}[0-9a-f]{2}$", n, re.I)) or bool(re.match(r"^(android-dhcp|dhcpcd|msft|espressif|unknown)", n, re.I))


def _private(ip: str) -> bool:
    try:
        return ipaddress.ip_address(ip).is_private
    except ValueError:
        return False


async def _cert_org(ip: str) -> str | None:
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    try:
        _, w = await asyncio.wait_for(asyncio.open_connection(ip, 443, ssl=ctx), TIMEOUT)
    except (OSError, asyncio.TimeoutError, ssl.SSLError):
        return None
    try:
        der = w.get_extra_info("ssl_object").getpeercert(binary_form=True)
        if not der:
            return None
        subj = x509.load_der_x509_certificate(der).subject
        vals = [a.value for oid in (NameOID.ORGANIZATION_NAME, NameOID.COMMON_NAME) for a in subj.get_attributes_for_oid(oid)]
        return " ".join(str(v) for v in vals)[:120] or None
    except Exception:  # noqa: BLE001
        return None
    finally:
        w.close()


async def _http(ip: str, port: int) -> str | None:
    """回傳「伺服器名稱 網頁標題」，連不上就 None。"""
    try:
        r, w = await asyncio.wait_for(asyncio.open_connection(ip, port), TIMEOUT)
    except (OSError, asyncio.TimeoutError):
        return None
    try:
        w.write(f"GET / HTTP/1.0\r\nHost: {ip}\r\nUser-Agent: home-hub\r\n\r\n".encode())
        await w.drain()
        data = b""
        while len(data) < 16384:
            chunk = await asyncio.wait_for(r.read(4096), TIMEOUT)
            if not chunk:
                break
            data += chunk
    except (OSError, asyncio.TimeoutError):
        pass
    finally:
        w.close()
    text = data.decode("utf-8", "replace")
    server = re.search(r"^server:\s*(.+)$", text, re.I | re.M)
    title = re.search(r"<title[^>]*>([^<]{1,80})", text, re.I)
    out = " ".join(x.group(1).strip() for x in (server, title) if x)
    return out or None


async def probe(ip: str) -> dict[str, Any] | None:
    """{guess, kind, seen}；什麼都問不到就 None。seen 是問到的原文（給設定頁看，不傳出去）。"""
    if not _private(ip):
        return None
    parts = await asyncio.gather(_cert_org(ip), *(_http(ip, p) for p in PORTS_HTTP))
    seen = " | ".join(p for p in parts if p)
    if not seen:
        return None
    low = seen.lower()
    for pat, name, kind in RULES:
        if re.search(pat, low):
            return {"guess": name, "kind": kind, "seen": seen[:200]}
    return {"guess": None, "kind": None, "seen": seen[:200]}

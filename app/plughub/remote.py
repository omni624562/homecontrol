"""在外面用（不用 VPN）：路由器把外部的連接埠轉到樹莓派的 HTTPS，這裡決定外面來的連線誰能用。

在外面看不到手機的 MAC（MAC 出了家裡的網路就沒了），所以改用「在家核准過的裝置」：
- 從家裡以外的網路來的連線，只認配對時給的通行證，而且那台要打開「在外面也能用」
- 配對只能在家做（外面輸入配對碼、要配對碼一律拒絕）；Wi-Fi 自動認得的家人手機到了外面不算數
- 某台第一次從沒看過的網路連進來，傳通知；已配對但還沒核准的裝置想從外面連，也通知一次
- 網址、轉送的埠從路由器讀（只讀，不改路由器）
"""
from __future__ import annotations

import ipaddress
import logging
import time
from typing import TYPE_CHECKING, Any, Callable

if TYPE_CHECKING:
    from .auth import Auth
    from .hub import Hub

_LOGGER = logging.getLogger(__name__)
NOTIFY_GAP = 6 * 3600  # 同一台最多 6 小時通知一次
SEEN_MAX = 30
SAVE_GAP = 300


def _own_v6_prefixes() -> set[str]:
    """樹莓派自己的 IPv6 /64（同一個 /64 的是家裡的裝置）。"""
    out = set()
    try:
        with open("/proc/net/if_inet6", encoding="ascii") as f:
            for line in f:
                h = line.split()[0]
                ip = ipaddress.IPv6Address(int(h, 16))
                if ip.is_global:
                    out.add(h[:16])
    except (OSError, ValueError, IndexError):
        pass
    return out


def is_outside(host: str | None, own_v6: Callable[[], set[str]] = _own_v6_prefixes) -> bool:
    """這個來源 IP 是不是家裡以外的網路。私人網段、本機、VPN（CGNAT 100.64/10）都算家裡。"""
    if not host:
        return False
    try:
        ip = ipaddress.ip_address(host.split("%")[0])
    except ValueError:
        return False
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped:
        ip = ip.ipv4_mapped
    if not ip.is_global:
        return False
    if isinstance(ip, ipaddress.IPv6Address):
        return f"{int(ip):032x}"[:16] not in own_v6()
    return True


def net_of(host: str) -> str:
    """「同一個地方」：IPv4 前兩段、IPv6 前 48 位元。"""
    ip = ipaddress.ip_address(host.split("%")[0])
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped:
        ip = ip.ipv4_mapped
    prefix = 16 if ip.version == 4 else 48
    return str(ipaddress.ip_network(f"{ip}/{prefix}", strict=False))


class Remote:
    def __init__(self, hub: "Hub", auth: "Auth", https_port: int, local_ips: Callable[[], list[str]], clock=time.time) -> None:
        self.hub = hub
        self.auth = auth
        self.https_port = https_port
        self.local_ips = local_ips
        self.clock = clock
        self._blocked: dict[str, float] = {}  # 裝置 id → 上次通知「想從外面連」

    @property
    def cfg(self) -> dict[str, Any]:
        return {"on": True, "host": None, **(self.hub.store.data["settings"].get("remote") or {})}

    def set(self, body: dict[str, Any]) -> dict[str, Any]:
        c = self.cfg
        if "on" in body:
            c["on"] = bool(body["on"])
        self.hub.store.data["settings"]["remote"] = c
        self.hub.store.save()
        return self.status()

    # ---- 網址（從路由器讀）----

    def sync_host(self) -> str | None:
        """路由器的 DDNS 名稱記下來（重開機時還沒連上路由器也知道，憑證要用）。"""
        c = self.cfg
        got = self.hub.router.wan.get("ddns")
        if got and got != c["host"]:
            c["host"] = got
            self.hub.store.data["settings"]["remote"] = c
            self.hub.store.save()
        return c["host"]

    def forward(self) -> dict[str, Any] | None:
        """路由器上轉到這台 HTTPS 的那條規則。"""
        mine = set(self.local_ips())
        for r in self.hub.router.wan.get("forwards") or []:
            if r["ip"] in mine and str(r["port"]) == str(self.https_port) and r.get("proto", "TCP").upper() in ("TCP", "BOTH"):
                return r
        return None

    def status(self, cert: dict[str, Any] | None = None) -> dict[str, Any]:
        host = self.sync_host()
        fw = self.forward()
        url = None
        if host and fw:
            url = f"https://{host}" + ("" if str(fw["ext"]) == "443" else f":{fw['ext']}")
        cert = cert or {}
        return {"on": self.cfg["on"], "host": host, "router_read": "forwards" in self.hub.router.wan,
                "forward": {"ext": fw["ext"], "ip": fw["ip"], "port": fw["port"]} if fw else None,
                "url": url, "https_port": self.https_port,
                "cert_ok": bool(host and host in (cert.get("names") or [])), "cert_until": cert.get("until")}

    # ---- 外面來的連線 ----

    def allow(self, device: dict[str, Any] | None, host: str) -> bool:
        """外面來的：總開關打開、通行證對、這台打開了「在外面也能用」。"""
        if not device:
            return False
        if not self.cfg["on"] or not device.get("remote"):
            self._notify_blocked(device)
            return False
        self._seen(device, host)
        return True

    def _notify_blocked(self, device: dict[str, Any]) -> None:
        now = self.clock()
        if now - self._blocked.get(device["id"], 0) < NOTIFY_GAP:
            return
        self._blocked[device["id"]] = now
        why = "「在外面用」關著" if not self.cfg["on"] else "這台還沒打開「在外面也能用」"
        self.hub.notifier.send("有裝置想從外面連", f"「{device['name']}」從外面連進來，被擋下了（{why}）。是你的話到設定 → 在外面用 打開")

    def _seen(self, device: dict[str, Any], host: str) -> None:
        now = self.clock()
        net = net_of(host)
        seen = device.setdefault("remote_seen", [])
        first = not device.get("last_remote")
        dirty = now - (device.get("last_remote") or {}).get("t", 0) > SAVE_GAP
        device["last_remote"] = {"t": round(now), "ip": host}
        if net not in seen:
            seen.append(net)
            del seen[:-SEEN_MAX]
            dirty = True
            if first or now - device.get("remote_notified", 0) >= NOTIFY_GAP:
                device["remote_notified"] = round(now)
                self.hub.notifier.send("從外面連進來", f"「{device['name']}」從外面的網路（{host}）連進家庭中控。不是你的話到設定 → 在外面用 關掉它")
                _LOGGER.info("「%s」從外面連進來：%s", device["name"], host)
        if dirty:
            self.auth.save()

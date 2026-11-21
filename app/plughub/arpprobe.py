"""直接問手機「你在嗎」：從樹莓派送 ARP 詢問，看那台手機（MAC 要對）有沒有回答。

iPhone 螢幕關著時幾乎不跟路由器講話，路由器的清單會以為它離線；
但 ARP 是網路最底層的詢問，睡著的手機（或幫它代答的路由器）通常還是會回。
只有回答的 MAC 跟登記的一樣才算，IP 被別台拿走也不會誤判。

需要 CAP_NET_RAW（Docker 預設就有）和 network_mode: host。只送給家裡區網的 IP。
"""

from __future__ import annotations

import ipaddress
import logging
import os
import select
import socket
import struct
import time

_LOGGER = logging.getLogger(__name__)
ETH_P_ARP = 0x0806


def _mac_bytes(mac: str) -> bytes:
    return bytes.fromhex(mac.replace(":", "").replace("-", ""))


def _route_iface(ip: str) -> str | None:
    """哪張網卡的子網路包含這個 IP（/proc/net/route）。"""
    target = int(ipaddress.IPv4Address(ip))
    best: tuple[int, str] | None = None
    try:
        with open("/proc/net/route") as f:
            next(f)
            for line in f:
                p = line.split()
                dest, mask = (socket.ntohl(int(p[1], 16)), socket.ntohl(int(p[7], 16)))
                if mask and target & mask == dest and int(p[2], 16) == 0:  # 直連（沒有閘道）
                    if best is None or mask > best[0]:
                        best = (mask, p[0])
    except (OSError, ValueError, StopIteration):
        return None
    return best[1] if best else None


def _own_ip(ip: str) -> str:
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
        s.connect((ip, 9))
        return s.getsockname()[0]


def frame(src_mac: bytes, src_ip: str, dst_mac: bytes, dst_ip: str) -> bytes:
    eth = dst_mac + src_mac + struct.pack("!H", ETH_P_ARP)
    arp = struct.pack("!HHBBH6s4s6s4s", 1, 0x0800, 6, 4, 1, src_mac, socket.inet_aton(src_ip),
                      b"\x00" * 6, socket.inet_aton(dst_ip))
    return eth + arp


def is_reply(pkt: bytes, mac: bytes, ip: str) -> bool:
    if len(pkt) < 42 or pkt[12:14] != b"\x08\x06":
        return False
    op, sha, spa = struct.unpack("!H6s4s", pkt[20:32])
    return op == 2 and sha == mac and spa == socket.inet_aton(ip)


def probe(ip: str, mac: str, timeout: float = 2.0, tries: int = 3) -> bool:
    """這個 IP 上是不是那台 MAC 的裝置（有沒有回 ARP）。不能用（沒權限、不在區網）就回 False。"""
    try:
        addr = ipaddress.IPv4Address(ip)
        iface = _route_iface(ip)
        if not addr.is_private or not iface:
            return False
        with open(f"/sys/class/net/{iface}/address") as f:
            src_mac = _mac_bytes(f.read().strip())
        src_ip = _own_ip(ip)
        want = _mac_bytes(mac)
        with socket.socket(socket.AF_PACKET, socket.SOCK_RAW, socket.htons(ETH_P_ARP)) as s:
            s.bind((iface, 0))
            end = time.monotonic() + timeout
            for i in range(tries):
                # 先問那台 MAC（單播），再廣播問一次（有些路由器會幫睡著的手機代答）
                s.send(frame(src_mac, src_ip, want if i % 2 == 0 else b"\xff" * 6, ip))
                step = min(end, time.monotonic() + timeout / tries)
                while (left := step - time.monotonic()) > 0:
                    r, _, _ = select.select([s], [], [], left)
                    if r and is_reply(s.recv(128), want, ip):
                        return True
                if time.monotonic() >= end:
                    break
    except PermissionError:
        _LOGGER.debug("沒有 CAP_NET_RAW，不能直接問手機")
    except (OSError, ValueError) as err:
        _LOGGER.debug("ARP 詢問 %s 失敗：%s", ip, err)
    return False


if __name__ == "__main__":  # python -m plughub.arpprobe IP MAC
    import sys

    print("在" if probe(sys.argv[1], sys.argv[2]) else "沒回應", os.getpid())

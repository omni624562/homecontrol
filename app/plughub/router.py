"""讀 ASUS 路由器（AiMesh）的連線裝置清單：誰連在哪一台、哪個頻段、訊號多強。

用 SSH 金鑰登入路由器，開一條一直連著的連線，路由器那邊跑一個小迴圈：
- 每 4 秒：主路由器上每個 Wi-Fi 裝置的即時訊號強度（wl assoclist / rssi）
- 每 12 秒：/tmp/clientlist.json（主路由器＋節點的所有裝置，節點的資料大約 10～20 秒更新一次）
- 每 2 分鐘：裝置名稱、廠商（/jffs/nmp_cl_json.js）、AiMesh 節點清單、在路由器上自訂的名稱

只讀，不會改路由器任何設定。資料只留在樹莓派上。
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from typing import Any, Callable

_LOGGER = logging.getLogger(__name__)

KEY = os.environ.get("PLUGHUB_ROUTER_KEY", "/keys/router")
LIVE_EVERY = 4  # 秒

# 在路由器上跑的迴圈（BusyBox sh）
SCRIPT = r"""
IFS_=""
for b in 0 1 2 3; do
  for i in $(nvram get wl${b}_vifs) wl$b; do
    wl -i $i ssid >/dev/null 2>&1 || continue
    s=$(nvram get ${i}_ssid)
    IFS_="$IFS_ $i"
    echo "I $i $b $s"
  done
done
n=0
while true; do
  echo "@T $(date +%s)"
  for i in $IFS_; do
    for m in $(wl -i $i assoclist 2>/dev/null | awk '{print $2}'); do
      echo "R $i $m $(wl -i $i rssi $m 2>/dev/null)"
    done
  done
  if [ $((n % 3)) -eq 0 ]; then echo "@L $(tr -d '\n' < /tmp/clientlist.json)"; fi
  if [ $((n % 15)) -eq 0 ]; then
    for i in $IFS_; do
      for m in $(wl -i $i assoclist 2>/dev/null | awk '{print $2}'); do
        echo "T $m $(wl -i $i sta_info $m 2>/dev/null | awk '/tx total bytes|rx data bytes/{s+=$NF} END{printf "%.0f", s}')"
      done
    done
  fi
  if [ $((n % 30)) -eq 0 ]; then
    echo "@N $(tr -d '\n' < /jffs/nmp_cl_json.js)"
    echo "@D $(nvram get cfg_device_list)"
    echo "@C $(nvram get custom_clientlist)"
  fi
  echo "@E"
  n=$((n + 1))
  sleep 4
done
"""


def band_name(key: str) -> str:
    k = key.upper()
    if k.startswith("2G") or k == "0":
        return "2.4G"
    if k.startswith("5G") or k in ("1", "2"):
        return "5G"
    if k.startswith("6G") or k == "3":
        return "6G"
    return ""


def norm(mac: str) -> str:
    return mac.strip().upper()


class Router:
    def __init__(self, cfg: Callable[[], dict[str, Any]], known_hosts: str, on_update: Callable[[str], None]) -> None:
        self._cfg = cfg
        self._known_hosts = known_hosts
        self._on_update = on_update
        self.ok = False
        self.error: str | None = None
        self.updated = 0.0
        self.nodes: list[dict[str, Any]] = []  # [{mac, model, ip, main}]
        self.clients: dict[str, dict[str, Any]] = {}  # MAC → {mac, node, band, ssid, rssi, ip, wired, seen}
        self.names: dict[str, dict[str, Any]] = {}  # MAC → {name, vendor, custom}
        self.ifaces: dict[str, dict[str, str]] = {}  # wl0.1 → {band, ssid}
        self.traffic: dict[str, int] = {}  # MAC → 累計位元組（下載＋上傳），每分鐘讀一次；hub 讀完會清掉
        self._proc: asyncio.subprocess.Process | None = None

    @property
    def configured(self) -> bool:
        c = self._cfg()
        return bool(c.get("host") and c.get("user")) and os.path.exists(KEY)

    def main_mac(self) -> str | None:
        return next((n["mac"] for n in self.nodes if n["main"]), None)

    async def run(self) -> None:
        delay = 5
        while True:
            if not self.configured:
                self.ok = False
                self.error = "還沒設定" if os.path.exists(KEY) else "找不到登入路由器的金鑰"
                await asyncio.sleep(30)
                continue
            started = time.monotonic()
            try:
                await self._session()
            except asyncio.CancelledError:
                await self._kill()
                raise
            except Exception as err:  # noqa: BLE001
                self.error = str(err)[:200]
                _LOGGER.warning("路由器連線中斷：%s", err)
            self.ok = False
            self._on_update("status")
            await self._kill()
            delay = 5 if time.monotonic() - started > 120 else min(300, delay * 2)
            await asyncio.sleep(delay)

    async def _kill(self) -> None:
        p, self._proc = self._proc, None
        if p and p.returncode is None:
            p.kill()
            try:
                await p.wait()
            except Exception:  # noqa: BLE001
                pass

    async def _session(self) -> None:
        c = self._cfg()
        self._proc = await asyncio.create_subprocess_exec(
            "ssh", "-T", "-i", KEY, "-p", str(int(c.get("port") or 22)),
            "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes", "-o", "ConnectTimeout=10",
            "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3",
            "-o", "StrictHostKeyChecking=accept-new", "-o", f"UserKnownHostsFile={self._known_hosts}",
            f"{c['user']}@{c['host']}", SCRIPT,
            stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            limit=8 * 1024 * 1024,
        )
        out = self._proc.stdout
        assert out is not None
        live: dict[str, tuple[str, int]] = {}
        while True:
            try:
                raw = await asyncio.wait_for(out.readline(), 60)
            except asyncio.TimeoutError as err:
                raise RuntimeError("路由器超過 60 秒沒有回應") from err
            if not raw:
                err = (await self._proc.stderr.read()).decode(errors="replace").strip() if self._proc.stderr else ""
                if "Permission denied" in err:
                    raise RuntimeError("路由器不接受金鑰（帳號名稱或授權金鑰不對）")
                raise RuntimeError(err.splitlines()[-1] if err else "連線結束")
            line = raw.decode(errors="replace").rstrip("\n")
            tag, _, rest = line.partition(" ")
            try:
                if tag == "I":
                    i, b, *s = rest.split(" ")
                    self.ifaces[i] = {"band": band_name(b), "ssid": " ".join(s)}
                elif tag == "@T":
                    live = {}
                elif tag == "R":
                    i, mac, rssi = rest.split(" ")
                    live[norm(mac)] = (i, int(rssi))
                elif tag == "T":
                    mac, total = rest.split(" ")
                    if total.isdigit():
                        self.traffic[norm(mac)] = int(total)
                elif tag == "@L":
                    self._read_list(json.loads(rest or "{}"))
                elif tag == "@N":
                    self._read_names(json.loads(rest or "{}"))
                elif tag == "@D":
                    self._read_nodes(rest)
                elif tag == "@C":
                    self._read_custom(rest)
                elif tag == "@E":
                    self._apply_live(live)
                    if not self.ok:
                        self.ok, self.error = True, None
                        _LOGGER.info("已連上路由器")
                    self.updated = time.time()
                    self._on_update("tick")
            except (ValueError, KeyError) as err:
                _LOGGER.debug("看不懂路由器的這行：%s（%s）", line[:80], err)

    def _apply_live(self, live: dict[str, tuple[str, int]]) -> None:
        now = time.time()
        main = self.main_mac()
        for mac, (i, rssi) in live.items():
            c = self.clients.setdefault(mac, {"mac": mac})
            info = self.ifaces.get(i, {})
            c.update(node=main or c.get("node"), band=info.get("band", ""), ssid=info.get("ssid") or None,
                     wired=False, seen=now)
            if rssi < 0:
                c["rssi"] = rssi
                c["live"] = now

    def _read_list(self, data: dict[str, Any]) -> None:
        now = time.time()
        main = self.main_mac()
        # 節點用網路線接回主路由器時，連節點 Wi-Fi 的裝置也會出現在主路由器的「有線」清單裡（從網路線那頭過來）。
        # 同一份清單裡只要在哪個 Wi-Fi 頻段看到，就以 Wi-Fi 為準；主路由器 Wi-Fi 的即時資料也算。
        wireless = {norm(mac) for bands in data.values() for bkey, members in (bands or {}).items()
                    if not bkey.startswith("wired") for mac in (members or {})}
        for node, bands in data.items():
            node = norm(node)
            for bkey, members in (bands or {}).items():
                wired = bkey.startswith("wired")
                for mac, info in (members or {}).items():
                    mac = norm(mac)
                    if wired and (mac in wireless or now - self.clients.get(mac, {}).get("live", 0) < 15):
                        continue
                    c = self.clients.setdefault(mac, {"mac": mac})
                    # 主路由器的 Wi-Fi 裝置有即時資料（每 4 秒），不要被比較舊的清單蓋掉
                    if node == main and not wired and now - c.get("live", 0) < 15:
                        c["seen"] = now
                        continue
                    if node != c.get("node") or wired != c.get("wired"):
                        c["ssid"] = None
                    c.update(node=node, band="" if wired else band_name(bkey), wired=wired, seen=now)
                    if info.get("ip"):
                        c["ip"] = info["ip"]
                    try:
                        r = int(info.get("rssi"))
                        if r < 0:
                            c["rssi"] = r
                            c["list"] = now
                    except (TypeError, ValueError):
                        pass

    def _read_names(self, data: dict[str, Any]) -> None:
        for mac, info in data.items():
            if not isinstance(info, dict):
                continue
            n = self.names.setdefault(norm(mac), {})
            n["name"] = info.get("name") or None
            n["vendor"] = info.get("vendor") or None

    def _read_nodes(self, raw: str) -> None:
        nodes = []
        host = self._cfg().get("host")
        for part in raw.split("<"):
            f = part.split(">")
            if len(f) >= 3 and f[2]:
                nodes.append({"mac": norm(f[2]), "model": f[0], "ip": f[1], "main": f[1] == host})
        if nodes:
            self.nodes = nodes

    def _read_custom(self, raw: str) -> None:
        for part in raw.split("<"):
            f = part.split(">")
            if len(f) >= 2 and f[0] and f[1]:
                self.names.setdefault(norm(f[1]), {})["custom"] = f[0]

    def name_of(self, mac: str) -> str:
        n = self.names.get(mac, {})
        return n.get("custom") or n.get("name") or mac

    def online(self, mac: str, within: float = 90) -> bool:
        c = self.clients.get(mac)
        return bool(c and time.time() - c.get("seen", 0) < within)

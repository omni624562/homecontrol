"""讀 ASUS 路由器（AiMesh）的連線裝置清單：誰連在哪一台、哪個頻段、訊號多強。

用 SSH 金鑰登入路由器，開一條一直連著的連線，路由器那邊跑一個小迴圈：
- 每 4 秒：主路由器上每個 Wi-Fi 裝置的即時訊號強度（wl assoclist / rssi）
- 每 12 秒：/tmp/clientlist.json（主路由器＋節點的所有裝置，節點的資料大約 10～20 秒更新一次）
- 每 2 分鐘：裝置名稱、廠商（/jffs/nmp_cl_json.js）、AiMesh 節點清單、在路由器上自訂的名稱、DDNS 名稱和連接埠轉送規則（給「在外面用」看）

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
    echo "@W $(nvram get ddns_enable_x) $(nvram get ddns_hostname_x)"
    echo "@V $(nvram get vts_enable_x) $(nvram get vts_rulelist)"
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


def mlo_links(mac: str, info: dict[str, Any]) -> set[str]:
    """nmp_cl_json 裡 Wi-Fi 7 裝置各頻段的 link MAC（mlo_2G_mac、mlo_5G_mac、mlo_6G_mac…）。

    mlo_all_mac 不用：路由器常把別台的 MAC 留在裡面（例如虛擬機的那筆列著筆電的 MAC）。
    """
    main = norm(mac)
    links = {norm(str(v)) for k, v in info.items()
             if k.startswith("mlo_") and k.endswith("_mac") and k != "mlo_all_mac" and v and str(v).count(":") == 5}
    links.discard(main)
    return links


def read_forwards(raw: str) -> list[dict[str, Any]]:
    """虛擬伺服器（連接埠轉送）規則：<名稱>外部埠>內部IP>內部埠>協定>…"""
    out = []
    for part in raw.split("<"):
        f = part.split(">")
        if len(f) >= 5 and f[1] and f[2]:
            out.append({"name": f[0], "ext": f[1], "ip": f[2], "port": f[3] or f[1], "proto": f[4]})
    return out


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
        self.wan: dict[str, Any] = {}  # {ddns: 名稱或 None, forwards: [{name, ext, ip, port, proto}]}（只讀）
        self.clients: dict[str, dict[str, Any]] = {}  # MAC → {mac, node, band, ssid, rssi, ip, wired, seen}
        self.names: dict[str, dict[str, Any]] = {}  # MAC → {name, vendor, custom}
        # Wi-Fi 7（MLO）的手機：每個頻段的連線用另一個 MAC（link），路由器管理頁顯示的是主 MAC（MLD）。
        # 即時資料只看得到 link MAC，這裡記 link → 主 MAC，全部算到主 MAC 上。
        self.alias: dict[str, str] = {}
        self._conflicts: dict[str, list[str]] = {}
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
                    live[self.canon(mac)] = (i, int(rssi))
                elif tag == "T":
                    mac, total = rest.split(" ")
                    if total.isdigit():
                        self.traffic[self.canon(mac)] = int(total)
                elif tag == "@L":
                    self._read_list(json.loads(rest or "{}"))
                elif tag == "@N":
                    self._read_names(json.loads(rest or "{}"))
                elif tag == "@D":
                    self._read_nodes(rest)
                elif tag == "@C":
                    self._read_custom(rest)
                elif tag == "@W":
                    on, _, host = rest.partition(" ")
                    self.wan["ddns"] = host.strip() if on == "1" and host.strip() else None
                elif tag == "@V":
                    on, _, rules = rest.partition(" ")
                    self.wan["forwards"] = read_forwards(rules) if on == "1" else []
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
            mac = self.canon(mac)  # 剛連上時對照表比即時資料晚到
            c = self.clients.setdefault(mac, {"mac": mac})
            info = self.ifaces.get(i, {})
            c.update(node=main or c.get("node"), band=info.get("band", ""), ssid=info.get("ssid") or None,
                     wired=False, seen=now, wifi_at=now)
            if rssi < 0:
                c["rssi"] = rssi
                c["live"] = now

    def _read_list(self, data: dict[str, Any]) -> None:
        now = time.time()
        main = self.main_mac()
        # 節點用網路線接回主路由器時，連節點 Wi-Fi 的裝置也會出現在主路由器的「有線」清單裡（從網路線那頭過來）。
        # 同一份清單裡只要在哪個 Wi-Fi 頻段看到，就以 Wi-Fi 為準；主路由器 Wi-Fi 的即時資料也算。
        wireless = {self.canon(mac) for bands in data.values() for bkey, members in (bands or {}).items()
                    if not bkey.startswith("wired") for mac in (members or {})}
        for node, bands in data.items():
            node = norm(node)
            for bkey, members in (bands or {}).items():
                wired = bkey.startswith("wired")
                for mac, info in (members or {}).items():
                    mac = self.canon(mac)
                    if wired and mac in wireless:
                        continue
                    c = self.clients.setdefault(mac, {"mac": mac})
                    # 只在有線清單裡、但 10 分鐘內在 Wi-Fi 上看過：還是連著（節點那邊這一輪沒列到），維持 Wi-Fi
                    if wired and now - c.get("wifi_at", 0) < 600:
                        c["seen"] = now
                        continue
                    if not wired:
                        c["wifi_at"] = now
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

    def canon(self, mac: str) -> str:
        m = norm(mac)
        return self.alias.get(m, m)

    def _read_names(self, data: dict[str, Any]) -> None:
        claims: dict[str, set[str]] = {}
        for mac, info in data.items():
            if not isinstance(info, dict):
                continue
            n = self.names.setdefault(norm(mac), {})
            n["name"] = info.get("name") or None
            n["vendor"] = info.get("vendor") or None
            for link in mlo_links(mac, info):
                claims.setdefault(link, set()).add(norm(mac))
        # 只接受「只有一台說是它的」、而且自己不是另一台裝置的 link MAC
        keys = {norm(m) for m in data}
        alias, conflicts = {}, {}
        for link, mains in claims.items():
            if len(mains) == 1 and link not in keys:
                alias[link] = next(iter(mains))
            else:
                conflicts[link] = sorted(mains)
        for link, mains in conflicts.items():
            if self._conflicts.get(link) != mains:
                _LOGGER.info("Wi-Fi 7 對照有衝突，不合併：%s 被 %s 認領", link, "、".join(mains))
        self._conflicts = conflicts
        self.alias = alias
        for link, main in self.alias.items():
            old = self.clients.pop(link, None)
            if old:
                c = self.clients.setdefault(main, {"mac": main})
                if old.get("seen", 0) > c.get("seen", 0):
                    c.update({k: v for k, v in old.items() if k not in ("mac", "ip")})
            if link in self.traffic:
                self.traffic.setdefault(main, self.traffic.pop(link))

    async def read_files(self, paths: list[str], timeout: float = 20) -> list[str]:
        """用同一把金鑰讀路由器上的幾個檔案（只讀，不改任何東西）。讀不到的是空字串。"""
        import shlex

        c = self._cfg()
        sep = "@@PLUGHUB-EOF@@"
        cmd = "; ".join(f"cat {shlex.quote(x)} 2>/dev/null; echo; echo {sep}" for x in paths)
        proc = await asyncio.create_subprocess_exec(
            "ssh", "-T", "-i", KEY, "-p", str(int(c.get("port") or 22)),
            "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes", "-o", "ConnectTimeout=10",
            "-o", "StrictHostKeyChecking=accept-new", "-o", f"UserKnownHostsFile={self._known_hosts}",
            f"{c['user']}@{c['host']}", cmd,
            stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
        )
        try:
            out, _ = await asyncio.wait_for(proc.communicate(), timeout)
        except asyncio.TimeoutError:
            proc.kill()
            raise RuntimeError("路由器沒有回應")
        parts = out.decode(errors="replace").split(sep + "\n")
        return [x.strip() for x in parts[:len(paths)]] + [""] * (len(paths) - len(parts[:len(paths)]))

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

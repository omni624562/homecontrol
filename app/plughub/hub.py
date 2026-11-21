"""插座的偵測、狀態、控制、用電累計、夜間排程和通知。

- 每 60 秒用廣播在區網找一次插座，新插座自動加入，換了 IP 也會跟著更新
- 每 POLL_SECONDS 秒更新所有插座的狀態（同時進行，每台有逾時）
- 多孔排插（HS107、KP303）的每一孔各算一個插座
- 有計量的插座用它自己的累計用電；沒有計量但填了瓦數的，用「開著的時間 × 瓦數」估算
"""

from __future__ import annotations

import asyncio
import calendar
import contextvars
import json
import logging
import os
import time
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from typing import Any, Callable

from kasa import Device, Discover, Module

from . import anomaly, arpprobe, habits, locate, native, netprobe, sun, tariff
from .sensing import INTERVAL as SENSE_INTERVAL, SAVE_EVERY as SENSE_SAVE_EVERY, Sensing
from .notify import Notifier
from .daysoff import DaysOff
from .alerts import Alerts, quake_age_h
from .backup import Backup
from .watchdog import Watchdog
from .localinfo import LocalInfo
from .weather import Weather
from .router import Router
from .store import Store

_LOGGER = logging.getLogger(__name__)

# 版本（Docker 建置時由 deploy.sh 帶入 git describe）
APP_VERSION = os.environ.get("PLUGHUB_VERSION") or "dev"

# 這次開關是誰做的（記在開關紀錄裡）：API 進來的會設成 app／matter，其他（排程、情境、定時）是 auto
SOURCE: contextvars.ContextVar[str] = contextvars.ContextVar("source", default="auto")
NET_OUTAGE_SECONDS = 90  # 同一個 Wi-Fi 的插座全部斷線多久才算路由器出問題

POLL_SECONDS = 5
PROBE_EVERY = 60  # 路由器多久沒看到家人的手機，就由樹莓派直接問（ARP）
PROBE_MAX_AGE = 24 * 3600  # 超過一天沒看到的就不問了
PRESENCE_LOG_MAX = 50
# 名稱有這些字的插座，第一次看到時自動設「最長開啟 10 分鐘」（之後可以在 App 改）
WATER_WORDS = ("澆水", "灑水", "water", "sprinkler", "抽水", "水泵")
DEFAULT_MAX_ON = 600  # 秒
# 名稱有這些字的插座第一次出現時預設「高風險」：沒人在家就馬上關
RISKY_WORDS = ("電暖", "暖氣", "暖爐", "熨斗", "電熱", "烤箱", "電烤", "吹風", "捲髮", "電磁爐", "快煮壺", "熱水壺", "heater", "iron", "oven")


def fmt_secs(sec: float) -> str:
    """600 → 「10 分鐘」、90 → 「1 分 30 秒」、45 → 「45 秒」。"""
    sec = int(round(sec))
    h, m, s = sec // 3600, sec % 3600 // 60, sec % 60
    parts = [f"{h} 小時" if h else "", f"{m} 分" if m else "", f"{s} 秒" if s else ""]
    text = " ".join(x for x in parts if x) or "0 秒"
    return text + "鐘" if text.endswith("分") and not h else text
SCHEDULE_GRACE = 10  # 排程最多晚幾秒還會補執行
DISCOVER_SECONDS = 60
DEVICE_TIMEOUT = 4
# 插座自己的倒數關閉（保險）：比樹莓派晚這幾秒，平常由樹莓派先關（才會發通知）；
# 樹莓派當機、斷電時，插座時間到也會自己關
FAILSAFE_GRACE = 5
FAILSAFE_RETRY = 30  # 設定失敗（插座沒回應）多久後再試
OFFLINE_NOTIFY_MINUTES = 10
OVERLOAD_SECONDS = 60
STANDBY_MIN_WATTS = 0.2


@dataclass
class Plug:
    id: str
    device_key: str  # 所屬裝置（MAC）
    kasa_name: str
    model: str
    host: str
    child_index: int | None = None
    is_on: bool | None = None
    online: bool = False
    power: float | None = None  # 目前功率（W），只有計量插座有
    energy_total: float | None = None  # 插座本身的累計用電（kWh）
    offline_since: float | None = None
    overload_since: float | None = None
    last_tick: float | None = None
    # 插座本身的資訊（整台插座共用；排插的每個孔都一樣）
    led: bool | None = None
    rssi: int | None = None
    cloud: bool | None = None


@dataclass
class DeviceEntry:
    device: Device
    plugs: list[str] = field(default_factory=list)
    failures: int = 0


class Locked(Exception):
    """插座鎖定了，不能開關。"""


class Hub:
    def __init__(self, store: Store, notifier: Notifier) -> None:
        self.store = store
        self.notifier = notifier
        self.backup = Backup(store.dir, lambda title, msg: notifier.send(title, msg, "high"))
        self.watchdog = Watchdog(store.dir, notifier.send_sync)
        self._home_loc: tuple[float, float] | None = None  # 選定的家裡位置（見 location()）
        self.devices: dict[str, DeviceEntry] = {}  # MAC → 裝置
        self.plugs: dict[str, Plug] = {}
        self.version = 0
        # Google Home 串接（Matterbridge 外掛回報的配對狀態）
        self.matter: dict[str, Any] | None = None
        self.matter_seen = 0.0
        self._changed = asyncio.Condition()
        self._tasks: list[asyncio.Task] = []
        self._schedule_done: dict[str, str] = {}  # 排程 ID（或「ID:restore」）→ 最後執行的「日期 時間」
        self._bg: set[asyncio.Task] = set()
        self._timers_busy = False
        self._failsafe: dict[str, float] = {}  # 插座 ID → 已經寫進插座的關閉時間（0 = 已清除）
        self._failsafe_retry: dict[str, float] = {}
        # 插座內建排程／離家模式的同步狀態
        self.native: dict[str, dict[str, Any]] = {}  # 插座 ID → {"ok", "msg", "schedule", "away", "at"}
        self._native_dirty = True
        self._native_last = 0.0
        self._native_rules: dict[str, list[dict[str, Any]]] = {}  # 插座 ID → 寫進插座的排程規則（含 ID）
        # 插座自己記錄的使用時間（每天、每月的分鐘數），每 30 分鐘讀一次
        self._usage: dict[str, dict[str, dict[str, int]]] = {}
        self._usage_at = 0.0
        # 插座的使用紀錄存一份在樹莓派上：重開之後用電頁、問家裡馬上有資料
        self._usage_file = store.dir / "usage_cache.json"
        try:
            cached = json.loads(self._usage_file.read_text("utf-8"))
            self._usage = cached["plugs"]  # 先用上次的；_usage_at 留 0，啟動後幾秒內就會向插座重讀
        except Exception:  # noqa: BLE001
            pass
        self.sensing = Sensing()
        self.locator = locate.Locator(self.store.data.setdefault("locate", {}))
        self._sense_path = store.dir / "sensing.json.gz"
        self.sensing.load(self._sense_path)
        self._sense_saved = time.monotonic()
        # 每台插座的 Wi-Fi、韌體（裝置 MAC → {...}）
        self.dev_info: dict[str, dict[str, Any]] = {}
        self._lease_busy = False
        self._timer_failed: set[str] = set()  # 定時關閉失敗、已經通知過的插座
        self._offline_notified: set[str] = set()
        self._state_known: set[str] = set()  # 讀過開關狀態的插座（第一次讀到的不算「被按了」）
        self._outage: dict[str, dict[str, Any]] = {}  # SSID → 正在斷線的紀錄
        self.habits: list[dict[str, Any]] = []
        self.habit_days = 0
        self._habits_at = 0.0
        self._overload_notified: set[str] = set()
        self._last_flush = time.monotonic()
        self._discovering = False
        self._dirty = False  # store 有沒寫回的變動
        # 路由器：連線裝置、新裝置通知、誰在家
        self.router = Router(lambda: self.store.data["settings"].get("router") or {},
                             str(store.dir / "router_known_hosts"), self._on_router)
        self._router_sig: Any = None
        self._probe_at = 0.0  # 上次直接問家人手機（ARP）的時間
        self._probe_busy = False
        self._router_since = 0.0  # 這次連上路由器的時間（剛連上時資料不完整，先不判斷「出門」）
        self._router_fed: dict[str, float] = {}  # MAC → 上次餵給 Wi-Fi 感測的讀數時間
        self._home_since: float | None = None  # 有人回家的時間（用來判斷這次出門結束了沒）
        # 網路用量：MAC → 上次讀到的累計位元組（主路由器的 Wi-Fi 裝置）；每天的用量存在 store["net_usage"]
        self._traffic_last: dict[str, int] = {}
        # 放假日、天氣（排程的「國定假日不執行」「下雨不執行」）
        self.weather = Weather(store.dir / "secrets.json")
        self.daysoff = DaysOff(store.dir, self.weather)
        self.alerts = Alerts(store.dir, self.weather.key, self.weather.air_key)
        self.local = LocalInfo(store.dir, lambda: store.data["settings"].setdefault("local", {}),
                               lambda: (self.weather.county, self.weather.town),
                               lambda title, msg: self.notifier.send(title, msg))
        self.local.no_pickup = self.daysoff.garbage_off
        self._calendar_at = 0.0
        self._alerts_busy = False
        self._today = date.today()
        self.sched_skipped: dict[str, str] = {}  # 排程 ID → 今天為什麼沒執行
        store.sched_skip = self.skip_days  # 寫進插座的備援規則也要跳過那幾天
        self._presence: dict[str, dict[str, Any]] = store.data.setdefault("presence_state", {})
        # 舊資料：第一次讀路由器時記下的裝置還沒標「seed」
        known = store.data["net_devices"]
        if known and not any("seed" in v for v in known.values()):
            first = min(v.get("first", 0) for v in known.values())
            for v in known.values():
                if abs(v.get("first", 0) - first) < 5:
                    v["seed"] = True
        # 執行中的資料（插座清單、網路裝置、通知紀錄…）存在主機上：重開後先載入，再向各裝置拿最新的
        self._runtime_file = store.dir / "runtime.json"
        self._runtime_sig = ""
        self._restored: dict[str, str] = {}  # 上次看過、這次還沒找到的插座：裝置 MAC → IP
        self._load_runtime()

    # ---- 重開後還在的資料 ----

    def _runtime(self) -> dict[str, Any]:
        return {
            "plugs": [{"id": p.id, "device_key": p.device_key, "kasa_name": p.kasa_name, "model": p.model, "host": p.host,
                       "child_index": p.child_index, "led": p.led, "rssi": p.rssi, "cloud": p.cloud,
                       "offline_since": p.offline_since} for p in self.plugs.values()],
            "dev_info": self.dev_info,
            "native": self.native,
            "schedule_done": self._schedule_done,
            "sched_skipped": {"day": self._today.isoformat(), "items": self.sched_skipped},
            "timer_failed": sorted(self._timer_failed),
            "offline_notified": sorted(self._offline_notified),
            "overload_notified": sorted(self._overload_notified),
            "outage": self._outage,
            "traffic_last": self._traffic_last,
            "habits": self.habits,
            "habit_days": self.habit_days,
            "matter": self.matter,
            "router": {"nodes": self.router.nodes, "clients": self.router.clients, "updated": self.router.updated},
            "local": self.local.dump(),
            "home_loc": list(self._home_loc) if self._home_loc else None,
        }

    def _load_runtime(self) -> None:
        try:
            d = json.loads(self._runtime_file.read_text("utf-8"))
        except Exception:  # noqa: BLE001
            return
        try:
            now = time.time()
            for x in d.get("plugs", []):
                # 還沒連上之前先當作連不上（開關狀態不知道）；找到之後會換成真的
                self.plugs[x["id"]] = Plug(x["id"], x["device_key"], x["kasa_name"], x["model"], x["host"], x.get("child_index"),
                                           online=False, offline_since=x.get("offline_since") or now,
                                           led=x.get("led"), rssi=x.get("rssi"), cloud=x.get("cloud"))
                self._restored[x["device_key"]] = x["host"]
            self.dev_info = d.get("dev_info") or {}
            self.native = d.get("native") or {}
            self._schedule_done = d.get("schedule_done") or {}
            skipped = d.get("sched_skipped") or {}
            if skipped.get("day") == self._today.isoformat():
                self.sched_skipped = skipped.get("items") or {}
            self._timer_failed = set(d.get("timer_failed") or [])
            self._offline_notified = set(d.get("offline_notified") or [])
            self._overload_notified = set(d.get("overload_notified") or [])
            self._outage = d.get("outage") or {}
            self._traffic_last = {k: int(v) for k, v in (d.get("traffic_last") or {}).items()}
            self.habits = d.get("habits") or []
            self._home_loc = tuple(d["home_loc"]) if d.get("home_loc") else None
            self.habit_days = d.get("habit_days") or 0
            if d.get("matter"):
                self.matter = d["matter"]
                self.matter_seen = time.monotonic() - 45  # 外掛 45 秒內沒回報就當作沒在執行
            r = d.get("router") or {}
            self.router.nodes = r.get("nodes") or []
            self.router.clients = r.get("clients") or {}
            self.router.updated = r.get("updated") or 0.0
            self.local.load(d.get("local") or {})
            _LOGGER.info("載入上次的資料：%d 個插座、%d 台網路裝置", len(self.plugs), len(self.router.clients))
        except Exception:  # noqa: BLE001
            _LOGGER.exception("載入上次的資料失敗，當作第一次啟動")

    async def _save_runtime(self) -> None:
        """有變才寫（少寫 SD 卡）；每分鐘檢查一次，關機時也寫。"""
        try:
            text = json.dumps(self._runtime(), ensure_ascii=False, default=str)
        except Exception:  # noqa: BLE001
            _LOGGER.exception("整理要保存的資料失敗")
            return
        # 訊號強度、看到的時間每次都不一樣：不拿來判斷有沒有變，但最久 10 分鐘還是寫一次
        sig = str(len(text) // 64) + str(sorted(p.id + str(p.online) for p in self.plugs.values()))
        if sig == self._runtime_sig and time.time() - getattr(self, "_runtime_at", 0) < 600:
            return
        self._runtime_sig, self._runtime_at = sig, time.time()
        tmp = self._runtime_file.with_suffix(".tmp")
        await asyncio.to_thread(tmp.write_text, text, "utf-8")
        tmp.replace(self._runtime_file)

    async def forget(self, plug_id: str) -> None:
        """移除連不上的插座（整台一起：排插的每個孔）。"""
        key = self.plugs[plug_id].device_key
        entry = self.devices.pop(key, None)
        if entry is not None:
            await _quiet_disconnect(entry.device)
        for pid in [p.id for p in self.plugs.values() if p.device_key == key]:
            self.plugs.pop(pid, None)
        self._restored.pop(key, None)
        self._runtime_sig = ""
        await self._save_runtime()
        await self.changed()

    def _entry(self, plug: Plug) -> DeviceEntry:
        entry = self.devices.get(plug.device_key)
        if entry is None:
            raise TimeoutError(f"{self.name(plug)} 連不上")
        return entry

    # ---- 生命週期 ----

    async def start(self) -> None:
        reason = self.watchdog.after_restart()
        if reason:
            self.notifier.send("家庭中控已經恢復", f"剛剛{reason}，已經自動重新啟動")
        self.watchdog.start()
        await self.discover()
        self._default_scenes()
        self._tasks = [
            asyncio.create_task(self._loop(self.discover, DISCOVER_SECONDS)),
            asyncio.create_task(self._loop(self.poll, POLL_SECONDS)),
            asyncio.create_task(self._schedule_loop()),
            asyncio.create_task(self._loop(self._native_tick, 5)),
            asyncio.create_task(self._loop(self._save_runtime, 60)),
            asyncio.create_task(self._loop(self._sense_tick, SENSE_INTERVAL)),
            asyncio.create_task(self._loop(self._local_tick, 15)),
            asyncio.create_task(self.router.run()),
            asyncio.create_task(self._loop(self._probe_tick, 120)),
        ]

    async def stop(self) -> None:
        self.watchdog.stop()
        for task in self._tasks:
            task.cancel()
        self.store.energy.flush()
        self._save_sensing()
        self._runtime_sig = ""
        await self._save_runtime()
        for entry in self.devices.values():
            try:
                await entry.device.disconnect()
            except Exception:  # noqa: BLE001
                pass

    async def _loop(self, func: Callable, seconds: float) -> None:
        while True:
            await asyncio.sleep(seconds)
            try:
                await func()
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001
                _LOGGER.exception("%s 失敗", func.__name__)

    # ---- 通知前端 ----

    async def changed(self) -> None:
        async with self._changed:
            self.version += 1
            self._changed.notify_all()

    async def wait_change(self, version: int, timeout: float) -> int:
        async with self._changed:
            try:
                await asyncio.wait_for(
                    self._changed.wait_for(lambda: self.version != version), timeout
                )
            except asyncio.TimeoutError:
                pass
            return self.version

    # ---- 偵測 ----

    async def discover(self) -> None:
        if self._discovering:
            return
        self._discovering = True
        try:
            found = await Discover.discover(discovery_timeout=4)
        finally:
            self._discovering = False
        # 上次看過、廣播沒找到的插座：直接用上次的 IP 再試一次
        seen = {d.mac for d in found.values()}
        missing = {k: h for k, h in self._restored.items() if k not in self.devices and k not in seen and h not in found}

        async def direct(host: str) -> None:
            try:
                dev = await asyncio.wait_for(Discover.discover_single(host, discovery_timeout=3), 5)
                if dev is not None:
                    found[host] = dev
            except Exception:  # noqa: BLE001
                pass

        if missing:
            await asyncio.gather(*(direct(h) for h in missing.values()))
        added = False
        for host, device in found.items():
            key = device.mac
            entry = self.devices.get(key)
            if entry and entry.device.host == host:
                await _quiet_disconnect(device)
                continue
            try:
                await asyncio.wait_for(device.update(), DEVICE_TIMEOUT)
            except Exception as err:  # noqa: BLE001
                _LOGGER.warning("連不上 %s：%s", host, err)
                continue
            if entry:  # 換了 IP
                await _quiet_disconnect(entry.device)
                entry.device = device
                for pid in entry.plugs:
                    self.plugs[pid].host = host
                continue
            if not _is_plug(device):
                await _quiet_disconnect(device)
                continue
            entry = DeviceEntry(device)
            self.devices[key] = entry
            if device.children:
                for i, child in enumerate(device.children):
                    pid = _plug_id(child.device_id)
                    entry.plugs.append(pid)
                    self.plugs[pid] = Plug(pid, key, child.alias or f"{device.alias} {i + 1}", device.model, host, i)
            else:
                pid = _plug_id(device.mac)
                entry.plugs.append(pid)
                self.plugs[pid] = Plug(pid, key, device.alias, device.model, host)
            self._read(entry)
            added = True
            self._restored.pop(key, None)
            _LOGGER.info("找到插座 %s（%s，%s）", device.alias, device.model, host)
        if added:
            await self.changed()

    # ---- 更新狀態 ----

    def _set_is_on(self, plug: Plug, on: bool) -> None:
        on_since = self.store.data["on_since"]
        if on and plug.id not in on_since:
            on_since[plug.id] = time.time()
            self._dirty = True
        if on:
            self._cap_on_time(plug.id)
        elif not on and (plug.id in on_since or plug.id in self.store.data["timers"]):
            on_since.pop(plug.id, None)
            self.store.data["timers"].pop(plug.id, None)  # 關掉了，定時就不用了
            self._dirty = True
        plug.is_on = on

    async def poll(self) -> None:
        await asyncio.gather(*(self._poll_one(e) for e in list(self.devices.values())))
        self._accrue()
        self._check_alerts()
        self._default_max_on()
        for pid, plug in self.plugs.items():
            if plug.is_on:
                self._cap_on_time(pid)
        if self._dirty:
            self._dirty = False
            self.store.save()
        if time.monotonic() - self._last_flush > 60:
            self.store.energy.flush()
            self._last_flush = time.monotonic()
        await self.changed()

    async def _poll_one(self, entry: DeviceEntry) -> None:
        try:
            await asyncio.wait_for(entry.device.update(), DEVICE_TIMEOUT)
            entry.failures = 0
            self._read(entry)
        except Exception:  # noqa: BLE001
            entry.failures += 1
            # 連續失敗 3 次才算離線，偶爾一次逾時不算
            if entry.failures >= 3:
                for pid in entry.plugs:
                    plug = self.plugs[pid]
                    if plug.online:
                        plug.online = False
                        plug.offline_since = time.time()
                        plug.power = None

    def _read(self, entry: DeviceEntry) -> None:
        device = entry.device
        for pid in entry.plugs:
            plug = self.plugs[pid]
            source = device.children[plug.child_index] if plug.child_index is not None else device
            now_on = bool(source.is_on)
            if pid in self._state_known and plug.online and now_on != plug.is_on:
                self._log_switch(plug, now_on, "button")
            self._state_known.add(pid)
            self._set_is_on(plug, now_on)
            # 「開了多久」用插座自己記錄的（樹莓派重開也不會歸零）
            try:
                since = getattr(source, "on_since", None)
                if source.is_on and since is not None:
                    ts = since.timestamp()
                    if abs(self.store.data["on_since"].get(plug.id, 0) - ts) > 90:
                        self.store.data["on_since"][plug.id] = ts
                        self._dirty = True
            except Exception:  # noqa: BLE001
                pass
            plug.kasa_name = source.alias or plug.kasa_name
            plug.online = True
            plug.offline_since = None
            try:
                led = device.modules.get("Led")
                plug.led = bool(led.led) if led is not None else None
                feats = device.features
                plug.rssi = int(feats["rssi"].value) if "rssi" in feats else None
                plug.cloud = bool(feats["cloud_connection"].value) if "cloud_connection" in feats else None
            except Exception:  # noqa: BLE001
                pass
            energy = source.modules.get(Module.Energy)
            if energy is not None:
                plug.power = _float(getattr(energy, "current_consumption", None))
                plug.energy_total = _float(getattr(energy, "consumption_total", None))

    # ---- 用電 ----

    def _accrue(self) -> None:
        now = time.time()
        today = date.today().isoformat()
        for plug in self.plugs.values():
            last, plug.last_tick = plug.last_tick, now
            if last is None or not plug.online:
                continue
            hours = min(now - last, 5 * POLL_SECONDS) / 3600
            meta = self.store.meta(plug.id)
            if plug.power is not None:
                watts = plug.power
                if plug.is_on:  # 待機有沒有變高：記每天開著時的最低功率
                    self.store.energy.add_floor(today, plug.id, plug.power)
            elif meta.watts and plug.is_on:
                watts = meta.watts
            else:
                continue
            self.store.energy.add(today, plug.id, watts * hours / 1000)

    def watts(self, plug: Plug) -> float | None:
        """插座目前的功率：有計量用實際值，否則用估算瓦數。"""
        if plug.power is not None:
            return plug.power
        meta = self.store.meta(plug.id)
        if meta.watts:
            return meta.watts if plug.is_on else 0.0
        return None

    def mode(self, plug: Plug) -> str:
        if plug.power is not None:
            return "metered"
        if self.store.meta(plug.id).watts:
            return "estimated"
        return "switch"

    def is_standby(self, plug: Plug) -> bool:
        threshold = self.store.data["settings"]["standby_watts"]
        return bool(
            plug.online and plug.is_on and plug.power is not None
            and STANDBY_MIN_WATTS < plug.power < threshold
            and not self.store.meta(plug.id).keep_on
        )

    def _log_switch(self, plug: Plug, on: bool, source: str) -> None:
        try:
            self.store.energy.log_switch(time.time(), plug.id, on, source)
        except Exception as err:  # noqa: BLE001
            _LOGGER.debug("開關紀錄沒有寫入：%s", err)

    # ---- 排程建議 ----

    def refresh_habits(self) -> None:
        self._habits_at = time.time()
        first = self.store.energy.first_switch()
        events = self.store.energy.switches(time.time() - (habits.LOOKBACK + 1) * 86400)
        dismissed = set(self.store.data["settings"].get("habit_dismissed", []))
        sugg = habits.suggest(events, self._covered, self._sun_min,
                              date.fromtimestamp(first) if first else None, date.today())
        self.habits = [s for s in sugg if s["key"] not in dismissed and s["plug"] in self.plugs]
        self.habit_days = (date.today() - date.fromtimestamp(first)).days if first else 0

    def _covered(self, pid: str, on: bool, minute: int, days: list[int]) -> bool:
        """已經有排程（家庭中控的、或插座裡 Kasa App 設的）在差不多的時間做這件事。"""
        today = date.today()
        for x in self.store.schedules:
            if not x.get("enabled"):
                continue
            if x["action"] == "scene":
                sc = self.store.scene(x.get("scene") or "")
                act = (sc or {}).get("actions", {}).get(pid)
                if act != ("on" if on else "off"):
                    continue
            elif x["action"] != ("on" if on else "off") or pid not in x.get("plugs", []):
                continue
            t = self.sched_time(x, today)
            if t and abs(int(t[:2]) * 60 + int(t[3:5]) - minute) <= 30 and set(x["days"]) & set(days):
                return True
        for r in (self.native.get(pid) or {}).get("kasa", []):
            if r.get("enable") and bool(r.get("sact")) == on and abs(int(r.get("smin", -999)) - minute) <= 30:
                return True
        return False

    # ---- 通知 ----

    def _check_net(self, now: float) -> None:
        """同一個 Wi-Fi 的插座（至少 2 台）全部斷線 = 多半是路由器或 Wi-Fi 的問題，記下來並通知一次。"""
        by_ssid: dict[str, list[DeviceEntry]] = {}
        for key, entry in self.devices.items():
            ssid = self.dev_info.get(key, {}).get("ssid")
            if ssid:
                by_ssid.setdefault(ssid, []).append(entry)
        for ssid, entries in by_ssid.items():
            if len(entries) < 2:
                continue
            plugs = [self.plugs[e.plugs[0]] for e in entries if e.plugs]
            down = all(not p.online for p in plugs)
            cur = self._outage.get(ssid)
            if down:
                start = min((p.offline_since or now) for p in plugs)
                if cur is None and now - start >= NET_OUTAGE_SECONDS:
                    self._outage[ssid] = {"ssid": ssid, "start": start, "end": None, "devices": len(plugs)}
                    self.notifier.send("Wi-Fi 可能斷了", f"連「{ssid}」的 {len(plugs)} 台插座同時斷線，可能是路由器的問題", "high")
            elif cur is not None:
                cur["end"] = now
                events = self.store.data["net_events"]
                events.append(cur)
                del events[:-30]
                self._dirty = True
                del self._outage[ssid]
                self.notifier.send("Wi-Fi 恢復了", f"「{ssid}」的插座又連得上了，斷了大約 {max(1, round((now - cur['start']) / 60))} 分鐘")

    def _check_alerts(self) -> None:
        now = time.time()
        settings = self.store.data["settings"]
        self._check_net(now)
        down_ssids = set(self._outage)
        for plug in self.plugs.values():
            name = self.name(plug)
            # 整個 Wi-Fi 斷了就不再一台一台通知
            if not plug.online and self.dev_info.get(plug.device_key, {}).get("ssid") in down_ssids:
                self._offline_notified.add(plug.id)
                continue
            # 斷線超過 10 分鐘
            if not plug.online and plug.offline_since and now - plug.offline_since > OFFLINE_NOTIFY_MINUTES * 60:
                if plug.id not in self._offline_notified:
                    self._offline_notified.add(plug.id)
                    self.notifier.send("插座連不上", f"{name} 已經斷線超過 {OFFLINE_NOTIFY_MINUTES} 分鐘")
            elif plug.online and plug.id in self._offline_notified:
                self._offline_notified.discard(plug.id)
                self.notifier.send("插座恢復連線", f"{name} 又連得上了")
            # 功率過高持續 1 分鐘
            if plug.power is not None and plug.power > settings["overload_watts"]:
                plug.overload_since = plug.overload_since or now
                if now - plug.overload_since > OVERLOAD_SECONDS and plug.id not in self._overload_notified:
                    self._overload_notified.add(plug.id)
                    self.notifier.send("插座功率過高", f"{name}：{plug.power:.0f} W", priority="high")
            else:
                plug.overload_since = None
                self._overload_notified.discard(plug.id)

    # ---- 控制 ----

    async def set_power(self, plug_id: str, on: bool, force: bool = False) -> None:
        """開關插座。鎖定的插座要 force 才能動（只有使用者在裝置詳細裡明確操作、或定時到了）。"""
        if not force and self.store.meta(plug_id).protect == "lock":
            raise Locked(self.name(self.plugs[plug_id]))
        plug = self.plugs[plug_id]
        entry = self._entry(plug)
        target = entry.device.children[plug.child_index] if plug.child_index is not None else entry.device
        await asyncio.wait_for(target.turn_on() if on else target.turn_off(), DEVICE_TIMEOUT)
        if plug.is_on != on:
            self._log_switch(plug, on, SOURCE.get())
        self._set_is_on(plug, on)
        try:
            await asyncio.wait_for(entry.device.update(), DEVICE_TIMEOUT)
            self._read(entry)
        except Exception:  # noqa: BLE001
            pass
        await self.changed()

    async def turn_off(self, room: str | None = None, standby_only: bool = False,
                       night_only: bool = False, remember: str | None = None) -> list[str]:
        """關閉插座（常開的不關）；remember 有給就記住關了哪些，之後可以 restore。"""
        targets = []
        for plug in self.plugs.values():
            meta = self.store.meta(plug.id)
            if not plug.online or not plug.is_on or meta.keep_on:
                continue
            if room is not None and meta.room != room:
                continue
            if night_only and not meta.night:
                continue
            if standby_only and not self.is_standby(plug):
                continue
            targets.append(plug.id)
        results = await asyncio.gather(*(self.set_power(pid, False) for pid in targets), return_exceptions=True)
        done = [pid for pid, r in zip(targets, results) if not isinstance(r, Exception)]
        if remember:
            self.store.data["remembered"][remember] = done
            self.store.save()
        return done

    async def turn_on(self, room: str, remember: str | None = None) -> list[str]:
        """打開一個房間裡關著的插座；remember 有給就記住，之後 restore 會把它們關回去。"""
        targets = [
            plug.id for plug in self.plugs.values()
            if plug.online and not plug.is_on and self.store.meta(plug.id).room == room
            and not self.store.meta(plug.id).max_on_s  # 澆水這類不會被「整間打開」打開
        ]
        results = await asyncio.gather(*(self.set_power(pid, True) for pid in targets), return_exceptions=True)
        done = [pid for pid, r in zip(targets, results) if not isinstance(r, Exception)]
        if remember:
            self.store.data["remembered"][remember] = {pid: False for pid in done}
            self.store.save()
        return done

    async def restore(self, remember: str) -> list[str]:
        """恢復 remember 記住的狀態。

        清單 = 被關掉的插座，打開還關著的；字典 = {插座: 原本開著嗎}，改回原本的樣子。
        """
        saved = self.store.data["remembered"].pop(remember, [])
        self.store.save()
        wanted = saved if isinstance(saved, dict) else {pid: True for pid in saved}
        targets = {pid: on for pid, on in wanted.items() if pid in self.plugs and self.plugs[pid].is_on is not on}
        await asyncio.gather(*(self.set_power(pid, on) for pid, on in targets.items()), return_exceptions=True)
        return list(targets)

    # ---- 定時關閉 ----

    async def set_timer(self, plug_id: str, seconds: float) -> None:
        if not self.plugs[plug_id].is_on:
            await self.set_power(plug_id, True)
        self.store.data["timers"][plug_id] = time.time() + seconds
        self._cap_on_time(plug_id)  # 不能超過最長開啟時間
        self.store.save()
        await self.changed()

    async def cancel_timer(self, plug_id: str) -> None:
        if self.store.data["timers"].pop(plug_id, None) is not None:
            self.store.save()
            await self.changed()

    # ---- 最長開啟時間（防呆）----

    def _default_max_on(self) -> None:
        """新看到的澆水類插座，預設最長開 10 分鐘（每個插座只預設一次，使用者改掉就不再動）。"""
        seen = self.store.data.setdefault("max_on_defaulted", [])
        for pid, plug in self.plugs.items():
            if pid in seen:
                continue
            seen.append(pid)
            self._dirty = True
            meta = self.store.meta(pid)
            name = self.name(plug).lower()
            if meta.max_on_s is None and not meta.keep_on and any(w in name for w in WATER_WORDS):
                meta.max_on_s = DEFAULT_MAX_ON
                _LOGGER.info("%s 預設最長開啟 %s", self.name(plug), fmt_secs(DEFAULT_MAX_ON))
            if not meta.keep_on and any(w in name for w in RISKY_WORDS):
                meta.risky = True
                _LOGGER.info("%s 預設為高風險電器", self.name(plug))

    def _cap_on_time(self, plug_id: str) -> None:
        """有設最長開啟時間的插座：確保有定時，而且不會晚於「打開的時間 + 最長時間」。"""
        limit_s = self.store.meta(plug_id).max_on_s
        if not limit_s:
            return
        timers = self.store.data["timers"]
        limit = self.store.data["on_since"].get(plug_id, time.time()) + limit_s
        if timers.get(plug_id) is None or timers[plug_id] > limit:
            timers[plug_id] = limit
            self._dirty = True

    # ---- 插座自己的倒數關閉（保險）----

    def _sync_failsafes(self) -> None:
        """有最長開啟時間的插座開著時，把關閉時間也寫進插座本身；關掉後清除。"""
        now = time.time()
        timers = self.store.data["timers"]
        for pid, plug in self.plugs.items():
            # 有定時（包括最長開啟時間）的都寫進插座：樹莓派停掉也會關
            want = timers.get(pid, 0.0) if (plug.is_on and plug.online) else 0.0
            have = self._failsafe.get(pid)
            if have is None and not want:
                continue  # 從來沒寫過，也不需要
            if have is not None and abs(have - want) < 1:
                continue
            if now < self._failsafe_retry.get(pid, 0):
                continue
            self._failsafe[pid] = want  # 先記下，避免同一秒重複送
            self._spawn(self._write_failsafe(pid, want))

    async def _write_failsafe(self, plug_id: str, deadline: float) -> None:
        plug = self.plugs.get(plug_id)
        entry = self.devices.get(plug.device_key) if plug else None
        dev = entry.device if entry else None
        if dev is None or not hasattr(dev, "sys_info"):  # 只有 Kasa（IOT）插座有這個功能
            return
        ctx = {}
        if plug.child_index is not None:  # 排插的孔：要用插座回報的原始 ID
            ctx = {"context": {"child_ids": [dev.sys_info["children"][plug.child_index]["id"]]}}
        try:
            await asyncio.wait_for(dev.protocol.query({**ctx, "count_down": {"delete_all_rules": {}}}), DEVICE_TIMEOUT)
            if deadline:
                delay = max(1, round(deadline - time.time() + FAILSAFE_GRACE))
                res = await asyncio.wait_for(dev.protocol.query({**ctx, "count_down": {"add_rule": {
                    "enable": 1, "delay": delay, "act": 0, "name": "homehub-failsafe"}}}), DEVICE_TIMEOUT)
                err = res.get("count_down", {}).get("add_rule", {}).get("err_code", 0)
                if err:
                    raise RuntimeError(f"插座回應錯誤 {err}")
                _LOGGER.info("%s 插座自己的倒數關閉：%d 秒後", self.name(plug), delay)
            self._failsafe_retry.pop(plug_id, None)
        except Exception as err:  # noqa: BLE001
            _LOGGER.warning("%s 設定插座倒數失敗，%d 秒後再試：%s", self.name(plug), FAILSAFE_RETRY, err)
            self._failsafe.pop(plug_id, None)
            self._failsafe_retry[plug_id] = time.time() + FAILSAFE_RETRY

    # ---- 插座本身的功能：內建排程、離家模式、指示燈、使用時間、重新啟動、雲端 ----

    def mark_native(self) -> None:
        """排程、情境、插座設定、離家模式變了：下一輪把規則重新寫進插座。"""
        self._native_dirty = True

    async def _native_tick(self) -> None:
        # 有變動就同步；沒變動也每 30 分鐘核對一次（插座重開、被 Kasa App 改過）
        if self._native_dirty or time.time() - self._native_last >= 1800:
            self._native_dirty = False
            self._native_last = time.time()
            await self.native_sync()
        await self._lease()
        await self._calendar_tick()
        if time.time() - self._usage_at >= 1800:
            await self.refresh_usage()
        if time.time() - self._habits_at >= 600:
            try:
                self.refresh_habits()
            except Exception as err:  # noqa: BLE001
                _LOGGER.warning("排程建議算不出來：%s", err)

    async def _local_tick(self) -> None:
        """垃圾車、停水停電（要先知道在哪個縣市、鄉鎮：從氣象署那邊來）。"""
        if self.weather.town and await self.local.refresh(self.location()):
            await self.changed()

    async def refresh_usage(self) -> None:
        self._usage_at = time.time()
        for pid, plug in list(self.plugs.items()):
            if not plug.online:
                continue
            entry = self.devices.get(plug.device_key)
            if entry is None or not native.supported(entry.device):
                continue
            try:
                self._usage[pid] = await native.usage_history(entry.device, native.context(entry.device, plug.child_index))
            except Exception as err:  # noqa: BLE001
                _LOGGER.debug("讀 %s 使用時間失敗：%s", self.name(plug), err)
        try:
            tmp = self._usage_file.with_suffix(".tmp")
            tmp.write_text(json.dumps({"at": self._usage_at, "plugs": self._usage}), "utf-8")
            tmp.replace(self._usage_file)
        except Exception as err:  # noqa: BLE001
            _LOGGER.debug("存使用紀錄失敗：%s", err)

    def find_anomalies(self, today: date | None = None) -> list[dict[str, Any]]:
        """用電異常（anomaly.py）：每個插座跟它自己平常比。"""
        today = today or date.today()
        since = (today - timedelta(days=anomaly.RECENT_DAYS + anomaly.BASE_DAYS + 1)).isoformat()
        per_plug, first = self.store.energy.per_plug(since)
        found = anomaly.daily_rise(per_plug, today, first) + anomaly.standby_rise(self.store.energy.floors(since), today)
        out = []
        for item in found:
            plug = self.plugs.get(item["plug"])
            if plug is None:
                continue
            metered = self.mode(plug) != "switch"
            out.append({**item, "name": self.name(plug), "text": anomaly.describe(item, self.name(plug), metered)})
        self.anomalies = out
        return out

    def _check_anomalies(self, now: float, sent: dict[str, float]) -> None:
        """每天早上 9 點後查一次；同一個電器同一種異常 7 天內只講一次。"""
        dt = datetime.now()
        day_key = f"anomaly-day:{dt.date().isoformat()}"
        if dt.hour < 9 or day_key in sent:
            return
        sent[day_key] = now
        news = []
        for item in self.find_anomalies():
            key = f"anomaly:{item['plug']}:{item['kind']}"
            if now - sent.get(key, 0) >= 7 * 86400:
                sent[key] = now
                news.append(item["text"])
        if news and (self.store.data["settings"].get("remind") or {}).get("anomaly", True):
            self.notifier.send("用電和平常不一樣", "\n".join(news[:4]))

    def energy_report(self) -> dict[str, Any]:
        """用電 dashboard：插座自己記錄的開機時間 × 瓦數（估算）。

        本月至今、月底預估、上個月同期、今天；近 30 天、近 12 個月；依房間；各裝置（含每天時數）；值得注意的事。
        """
        today = date.today()
        household = self.store.data["settings"]["household_monthly_kwh"]
        price = tariff.price(household, today)
        days = [(today - timedelta(days=29 - i)).isoformat() for i in range(30)]
        months: list[str] = []
        y, m = today.year, today.month
        for _ in range(12):
            months.insert(0, f"{y:04d}-{m:02d}")
            y, m = (y - 1, 12) if m == 1 else (y, m - 1)
        this_month, last_month = months[-1], months[-2]
        month_days = calendar.monthrange(today.year, today.month)[1]
        # 上個月同期：插座的每日紀錄只留大約 30 天，所以用上個月整月 × 天數比例
        lm_year, lm_month = int(last_month[:4]), int(last_month[5:])
        lm_len = calendar.monthrange(lm_year, lm_month)[1]
        same_ratio = min(today.day, lm_len) / lm_len
        mtd_days = [f"{today.year:04d}-{today.month:02d}-{d:02d}" for d in range(1, today.day + 1)]

        tot_days = {d: {"kwh": 0.0, "hours": 0.0} for d in days}
        tot_months = {mm: {"kwh": 0.0, "hours": 0.0, "cost": 0.0} for mm in months}
        rooms: dict[str, float] = {}
        plugs = []
        mtd_kwh = same_kwh = 0.0
        for plug in self.ordered():
            meta = self.store.meta(plug.id)
            use = self._usage.get(plug.id)
            watts = meta.watts
            kw = (watts or 0) / 1000
            room = self.store.room(meta.room)
            if use is None:
                plugs.append({"id": plug.id, "name": self.name(plug), "watts": watts, "known": False})
                continue
            for d in days:
                minutes = use["days"].get(d, 0)
                tot_days[d]["hours"] += minutes / 60
                tot_days[d]["kwh"] += minutes / 60 * kw
            for mm in months:
                minutes = use["months"].get(mm, 0)
                kwh = minutes / 60 * kw
                tot_months[mm]["hours"] += minutes / 60
                tot_months[mm]["kwh"] += kwh
                tot_months[mm]["cost"] += kwh * tariff.price(household, date(int(mm[:4]), int(mm[5:]), 1))
            month_min = sum(use["days"].get(d, 0) for d in mtd_days) or use["months"].get(this_month, 0)
            same_min = use["months"].get(last_month, 0) * same_ratio
            month_kwh = month_min / 60 * kw
            mtd_kwh += month_kwh
            same_kwh += same_min / 60 * kw
            name = room["name"] if room else "還沒分區域"
            rooms[name] = rooms.get(name, 0.0) + month_kwh
            # 最近 7 個「完整的」天（不算今天）和再之前 21 天
            last7 = [use["days"].get(d, 0) for d in days[-8:-1]]
            prev21 = [use["days"].get(d, 0) for d in days[-29:-8]]
            plugs.append({
                "id": plug.id, "name": self.name(plug), "watts": watts, "known": True,
                "room": name,
                "today_min": use["days"].get(today.isoformat(), 0),
                "month_min": month_min,
                "same_min": round(same_min),
                "month_kwh": round(month_kwh, 3),
                "month_cost": round(month_kwh * price, 1),
                "avg7_h": round(sum(last7) / 7 / 60, 1),
                "avg21_h": round(sum(prev21) / max(1, len(prev21)) / 60, 1),
                "days": [use["days"].get(d, 0) for d in days],
                "months": [use["months"].get(mm, 0) for mm in months],
            })

        # 值得注意的事（依每月影響的金額排序，最多 4 則）
        insights = []
        for pl in plugs:
            if not pl.get("known"):
                continue
            monthly_cost = pl["avg7_h"] * 30 * (pl["watts"] or 0) / 1000 * price
            if pl["avg7_h"] >= 20:
                insights.append({"kind": "always", "plug": pl["id"], "weight": monthly_cost,
                                 "text": f"{pl['name']} 幾乎整天開著" + (f"，每月約 ${monthly_cost:.0f}" if pl["watts"] else "")})
            elif pl["avg7_h"] >= 2 and pl["avg7_h"] >= pl["avg21_h"] * 1.5 + 1:
                more = (pl["avg7_h"] - pl["avg21_h"]) / max(pl["avg21_h"], 0.1) * 100
                insights.append({"kind": "rise", "plug": pl["id"], "weight": monthly_cost,
                                 "text": f"{pl['name']} 最近 7 天平均每天開 {pl['avg7_h']:g} 小時，"
                                         + (f"比之前多 {more:.0f}%" if pl["avg21_h"] >= 0.5 else "之前幾乎沒開")})
        insights.sort(key=lambda x: -x["weight"])
        insights = insights[:4]
        # 用電異常放最前面（有計量的是實際用電，沒有的是開的時間）
        anomalies = getattr(self, "anomalies", None)
        if anomalies is None:
            anomalies = self.find_anomalies()
        insights = [{"kind": "anomaly", "plug": a["plug"], "weight": 0, "text": a["text"]} for a in anomalies[:3]] + insights
        unset = [pl["name"] for pl in plugs if not pl["watts"]]
        if unset:
            insights.append({"kind": "unset", "plug": None, "weight": 0,
                             "text": f"{len(unset)} 個裝置沒設瓦數，沒算進電費：{'、'.join(unset[:3])}{'…' if len(unset) > 3 else ''}"})

        projected = mtd_kwh / max(today.day, 1) * month_days
        return {
            "price": price,
            "season": "夏月" if tariff.is_summer(today) else "非夏月",
            "day_of_month": today.day,
            "month_days": month_days,
            "today": {"kwh": round(tot_days[days[-1]]["kwh"], 3), "hours": round(tot_days[days[-1]]["hours"], 1)},
            "month": {"kwh": round(mtd_kwh, 2), "cost": round(mtd_kwh * price, 1)},
            "projected": {"kwh": round(projected, 1), "cost": round(projected * price, 0)},
            "same_period": {"kwh": round(same_kwh, 2), "cost": round(same_kwh * tariff.price(household, date(lm_year, lm_month, 1)), 1)},
            "last_month": {k: round(v, 2) for k, v in tot_months[last_month].items()},
            "days": [{"day": d, **{k: round(v, 3) for k, v in tot_days[d].items()}} for d in days],
            "months": [{"month": mm, **{k: round(v, 2) for k, v in tot_months[mm].items()}} for mm in months],
            "rooms": sorted(({"name": k, "kwh": round(v, 2)} for k, v in rooms.items()), key=lambda r: -r["kwh"]),
            "plugs": plugs,
            "insights": insights,
            "unset": len(unset),
            "updated": self._usage_at,
        }

    async def _lease(self) -> None:
        """樹莓派在線：快到時間的「打開」規則先停用，過了再啟用（插座只在樹莓派離線時才動作）。"""
        if self._lease_busy:
            return
        self._lease_busy = True
        try:
            now = datetime.now()
            for pid, rules in self._native_rules.items():
                plug = self.plugs.get(pid)
                if not plug or not plug.online:
                    continue
                for rule in rules:
                    want = native.lease_enabled(rule, now, self._sun_min)
                    if bool(rule.get("enable")) == want:
                        continue
                    dev, ctx = self._target(pid)
                    try:
                        await native.set_rule_enabled(dev, ctx, rule, want)
                        _LOGGER.info("%s 插座的排程規則 %02d:%02d %s", self.name(plug), rule["smin"] // 60, rule["smin"] % 60,
                                     "恢復啟用" if want else "暫停（由樹莓派執行）")
                    except Exception as err:  # noqa: BLE001
                        _LOGGER.warning("%s 調整插座規則失敗：%s", self.name(plug), err)
        finally:
            self._lease_busy = False

    async def native_sync(self) -> None:
        for key, entry in list(self.devices.items()):
            dev = entry.device
            if not native.supported(dev) or not entry.plugs:
                continue
            pids = [pid for pid in entry.plugs if self.plugs[pid].online]
            if not pids:
                continue
            try:
                skew = await native.clock_skew(dev)
            except Exception as err:  # noqa: BLE001
                for pid in pids:
                    self.native[pid] = {"ok": False, "msg": f"讀不到插座時鐘：{err}", "at": time.time()}
                self._native_dirty = True
                continue
            clock_ok = skew <= native.CLOCK_TOLERANCE
            await self._device_info(key, dev)
            for pid in pids:
                plug = self.plugs[pid]
                ctx = native.context(dev, plug.child_index)
                rules = native.schedule_rules(self.store, pid) if clock_ok else []
                away = native.away_rule(self.store, pid) if clock_ok else None
                try:
                    known = self.store.data.setdefault("native_rules", {}).get(pid, {})
                    done = await native.sync_rules(dev, ctx, rules, away, known)
                    self._native_rules[pid] = done.pop("rules")
                    self.store.data["native_rules"][pid] = done.pop("known")
                    self._dirty = True
                    msg = "" if clock_ok else f"插座時鐘差了 {int(skew)} 秒，先不寫排程"
                    self.native[pid] = {"ok": clock_ok, "msg": msg, **done, "at": time.time()}
                except Exception as err:  # noqa: BLE001
                    _LOGGER.warning("%s 同步插座規則失敗：%s", self.name(plug), err)
                    self.native[pid] = {"ok": False, "msg": str(err), "at": time.time()}
                    self._native_dirty = True  # 下一輪再試
        self.store.save()  # 寫進插座的規則記錄要馬上存（辨認自己的規則靠它）
        self._dirty = False
        await self.changed()

    def _backup_status(self, sched: dict[str, Any]) -> dict[str, Any]:
        """這個排程寫進插座（備援）的狀況：幾個插座寫好了，沒寫的原因。"""
        if sched.get("backup") is False or not sched.get("enabled"):
            return {"total": 0, "ok": 0, "issues": []}
        total = ok = 0
        issues: list[dict[str, str]] = []
        rules: list[list] = []  # 實際寫進插座的內容（含自動加的關閉），給畫面顯示
        for pid in native.schedule_plugs(self.store, sched):
            plug = self.plugs.get(pid)
            want = native.schedule_rules(self.store, pid, [sched])
            if plug is None or not want:
                if plug is not None and self.store.meta(pid).protect == "lock":
                    total += 1
                    issues.append({"plug": self.name(plug), "reason": "裝置已鎖定，不寫進插座"})
                continue
            total += 1
            for act, opt, val, wday in want:
                item = [act, opt, val, list(wday)]
                if item not in rules:
                    rules.append(item)
            info = self.native.get(pid)
            written = {(r["sact"], r["opt"], r["val"], tuple(r["wday"])) for r in self._native_rules.get(pid, [])}
            if all(rule in written for rule in want):
                ok += 1
            elif not plug.online:
                issues.append({"plug": self.name(plug), "reason": "插座離線"})
            elif info and not info.get("ok"):
                issues.append({"plug": self.name(plug), "reason": info.get("msg") or "寫入失敗"})
            elif self._native_dirty or info is None:
                issues.append({"plug": self.name(plug), "reason": "同步中", "pending": "1"})
            else:
                issues.append({"plug": self.name(plug), "reason": "插座的規則滿了"})
        return {"total": total, "ok": ok, "issues": issues, "rules": rules}

    async def _device_info(self, key: str, dev: Any) -> None:
        """Wi-Fi 名稱、加密、韌體版本；新韌體每 12 小時查一次（要連著 TP-Link 雲端）。"""
        info = self.dev_info.setdefault(key, {})
        si = getattr(dev, "sys_info", {}) or {}
        info.update(fw=si.get("sw_ver", "").split(" ")[0], hw=si.get("hw_ver"), model=si.get("model", "").split("(")[0])
        try:
            info.update(await native.network(dev))
        except Exception as err:  # noqa: BLE001
            _LOGGER.debug("讀 Wi-Fi 資訊失敗：%s", err)
        try:
            info["cloud_bound"] = await native.cloud_bound(dev)
        except Exception:  # noqa: BLE001
            pass
        if time.time() - info.get("fw_checked", 0) >= 12 * 3600:
            try:
                info["fw_updates"] = await native.firmware_updates(dev)
                info["fw_check"] = "ok"
            except Exception:  # noqa: BLE001
                info["fw_updates"] = []
                info["fw_check"] = "unavailable"  # 斷開雲端後就查不到
            info["fw_checked"] = time.time()

    async def set_kasa_away(self, plug_id: str, smin: int, emin: int, wday: list[int], enable: bool | None) -> None:
        """Kasa App 設的離家模式：enable=None 表示刪除。"""
        dev, ctx = self._target(plug_id)
        if enable is None:
            await native.delete_foreign_away(dev, ctx, smin, emin, wday)
        else:
            await native.set_foreign_away(dev, ctx, smin, emin, wday, enable)
        info = self.native.get(plug_id) or {}
        rules = info.get("kasa_away", [])
        for r in list(rules):
            if [r["smin"], r["emin"], r["wday"]] == [smin, emin, list(wday)]:
                if enable is None:
                    rules.remove(r)
                else:
                    r["enable"] = 1 if enable else 0
        self.mark_native()
        await self.changed()

    # ---- Wi-Fi 感測（實驗）----

    async def _sense_tick(self) -> None:
        if not self.store.data["settings"].get("sensing", True):
            return
        devs = {k: e.device for k, e in self.devices.items() if native.supported(e.device) and any(self.plugs[p].online for p in e.plugs)}
        await self.sensing.sample(devs)
        # 每過一分鐘：把上一分鐘的摘要存進長期紀錄（30 天）
        minute = int(time.time() // 60) * 60
        last = getattr(self, "_sense_minute", minute)
        if minute > last:
            try:
                self.store.energy.add_sense(self.sensing.minute_summary(last))
            except Exception as err:  # noqa: BLE001
                _LOGGER.warning("Wi-Fi 感測的每分鐘摘要沒有存到：%s", err)
        self._sense_minute = minute
        if time.monotonic() - self._sense_saved >= SENSE_SAVE_EVERY:
            await asyncio.to_thread(self._save_sensing)

    def _save_sensing(self) -> None:
        self._sense_saved = time.monotonic()
        try:
            self.sensing.save(self._sense_path)
        except Exception as err:  # noqa: BLE001
            _LOGGER.warning("Wi-Fi 感測資料沒有存到：%s", err)

    SENSE_RANGES = {"24h": (86400, 1800), "7d": (7 * 86400, 4 * 3600), "30d": (30 * 86400, 86400)}

    def sensing_history(self, rng: str) -> dict[str, Any]:
        """長期紀錄：24 小時（每 30 分一格）、7 天（每 4 小時）、30 天（每天）。"""
        span, bucket = self.SENSE_RANGES[rng]
        rep = self.sensing_report(60)
        names = {d["key"]: d["name"] for d in rep["devices"]}
        now = time.time()
        if rng == "30d":  # 每天一格：從當地的午夜開始算
            start = datetime.combine(date.today() - timedelta(days=29), datetime.min.time()).timestamp()
        else:
            start = (now // bucket + 1) * bucket - span
        n = int(span // bucket)
        data = self.store.energy.sense_buckets(int(start), bucket)
        devices = []
        for d in rep["devices"]:
            per = data.get(d["key"], {})
            cols = [{"rssi": round(per[i][0], 1) if i in per else None, "motion": per[i][1] if i in per else None} for i in range(n)]
            devices.append({**d, "cols": cols})
        first = self.store.energy.sense_first()
        return {**rep, "range": rng, "bucket": bucket, "start": start, "minutes": n, "devices": devices,
                "since": first, "names": names}

    def sensing_report(self, minutes: int = 60) -> dict[str, Any]:
        """每台插座（排插算一台）一列：用它的孔的名稱表示。"""
        names = {k: "、".join(self.name(self.plugs[p]) for p in e.plugs) for k, e in self.devices.items()}
        for mac, d in self.store.data["net_devices"].items():
            if d.get("map") and mac not in names:
                names[mac] = d.get("label") or self.router.name_of(mac)
        rep = self.sensing.report(names, minutes)
        rep["devices"] = [d for d in rep["devices"] if d["key"] in names]
        rep["net"] = self.net_report()
        rep["enabled"] = bool(self.store.data["settings"].get("sensing", True))
        return rep

    # ---- 路由器：連線裝置、新裝置通知、誰在家 ----

    def _on_router(self, kind: str) -> None:
        now = time.time()
        if kind == "status" or not self.router.ok:
            self._router_since = 0.0
            self._spawn(self.changed())
            return
        if not self._router_since:
            self._router_since = now
        self._router_sense(now)
        self._router_locate()
        self._router_traffic()
        changed = self._router_new_devices(now)
        changed = self._router_presence(now) or changed
        self._check_left_on(now)
        sig = (self.router.ok, frozenset(m for m in self.router.clients if self.router.online(m)))
        if changed or sig != self._router_sig:
            self._router_sig = sig
            self._spawn(self.changed())

    def _router_sense(self, now: float) -> None:
        """放到訊號地圖的裝置（電視、電腦…）：路由器量到的訊號強度也拿來偵測動靜。"""
        if not self.store.data["settings"].get("sensing", True):
            return
        for mac, d in self.store.data["net_devices"].items():
            if not d.get("map") or mac in self.devices:
                continue
            c = self.router.clients.get(mac)
            if not c or c.get("rssi") is None:
                continue
            at = max(c.get("live", 0), c.get("list", 0))
            if at > self._router_fed.get(mac, 0):
                self._router_fed[mac] = at
                self.sensing.add(mac, c["rssi"], at)

    def _router_locate(self) -> None:
        """家人的手機：路由器的新讀數交給「在哪個房間」（教房間時也從這裡收指紋）。"""
        for p in self.store.data["people"]:
            for mac in p["macs"]:
                c = self.router.clients.get(mac)
                if not c or c.get("wired") or not self.router.online(mac):
                    continue
                at = max(c.get("live", 0), c.get("list", 0))
                if self.locator.feed(mac, at, c.get("node"), c.get("rssi")) and mac in self.locator.training:
                    self._dirty = True

    def locate_rooms(self) -> list[dict[str, str]]:
        """可以教的房間：訊號地圖上畫的房間（比較完整），沒畫就用插座的房間。同名的加編號。"""
        # 同一個房間代碼用插座房間的名字（地圖上的名字可能沒改到）；地圖上沒畫的插座房間也列進來
        fp = (self.store.data.get("floorplan") or {}).get("rooms") or []
        plug_rooms = {r["id"]: r["name"] for r in self.store.data["rooms"]}
        src = [{"id": r["id"], "name": plug_rooms.get(r["id"], r["name"])} for r in fp]
        src += [{"id": i, "name": n} for i, n in plug_rooms.items() if i not in {r["id"] for r in src}]
        seen: dict[str, int] = {}
        for r in src:
            seen[r["name"]] = seen.get(r["name"], 0) + 1
            if seen[r["name"]] > 1 or sum(x["name"] == r["name"] for x in src) > 1:
                r["name"] = f"{r['name']} {seen[r['name']]}"
        return src

    def person_where(self, p: dict[str, Any]) -> dict[str, Any] | None:
        est = self.locator.estimate_any(p["macs"])
        if not est:
            return None
        names = {r["id"]: r["name"] for r in self.locate_rooms()}
        return {**est, "name": names.get(est["room"]) if est["room"] else None,
                "top": [{**t, "name": names.get(t["room"], "?")} for t in est["top"]]}

    def _router_traffic(self) -> None:
        """每台裝置今天用了多少網路（下載＋上傳）。路由器的計數器在裝置重新連線時會歸零。"""
        stats = self.router.traffic
        if not stats:
            return
        day = date.today().isoformat()
        usage = self.store.data.setdefault("net_usage", {})
        today = usage.setdefault(day, {})
        for mac, total in stats.items():
            last = self._traffic_last.get(mac)
            self._traffic_last[mac] = total
            if last is None:
                continue
            delta = total - last if total >= last else total
            if delta > 0:
                today[mac] = today.get(mac, 0) + delta
        self.router.traffic = {}
        for d in [d for d in usage if d < (date.today() - timedelta(days=8)).isoformat()]:
            del usage[d]
        self._dirty = True

    def _check_left_on(self, now: float) -> None:
        """大家都出門 10 分鐘後，還有電器開著：通知（或直接關掉）。常開的、「出門」情境裡設成不動的不算。

        同一次出門，同一個電器只講一次：手機 Wi-Fi 睡著又醒來（短暫「回家」）、樹莓派重開都不會再講；
        有人真的在家待滿 15 分鐘，才算這次出門結束。講過哪些存在樹莓派上。
        """
        people = self.people_report()
        cfg = self.store.data["settings"].get("presence") or {}
        mode = cfg.get("left_on", "notify")
        notice = self.store.data.setdefault("away_notice", {"plugs": [], "at": 0})
        if not people:
            return
        if any(p.get("home") is None for p in people):  # 剛開機還不知道誰在家
            return
        if any(p.get("home") for p in people):
            if self._home_since is None:
                self._home_since = now
            if now - self._home_since >= 900 and (notice["plugs"] or notice.get("risky")):
                notice.update(plugs=[], risky=[], at=0)
                self._dirty = True
            return
        self._home_since = None
        # 高風險電器（電暖器、熨斗…）：大家一出門就關，不等 10 分鐘（設定裡可以改成只通知）
        self._risky_left_on(cfg, notice)
        if mode == "none":
            return
        since = max((p.get("since") or 0) for p in people)
        if now - since < 600:
            return
        # 「出門」情境裡設成「不動」的，代表出門時本來就要讓它開著
        away = self.store.scene(cfg.get("away_scene") or "") or {}
        keep = {pid for pid, act in (away.get("actions") or {}).items() if act == "keep"}
        on = [p for p in self.ordered() if p.online and p.is_on and not self.store.meta(p.id).keep_on
              and p.id not in keep and p.id not in notice["plugs"] and p.id not in notice.get("risky", [])]
        if not on:
            return
        notice.update(plugs=sorted(set(notice["plugs"]) | {p.id for p in on}), at=now)
        self._dirty = True
        names = "、".join(self.name(p) for p in on[:8]) + (f" 等 {len(on)} 個" if len(on) > 8 else "")
        if mode == "off":
            async def go() -> None:
                SOURCE.set("auto")
                results = await asyncio.gather(*(self.set_power(p.id, False) for p in on), return_exceptions=True)
                done = sum(1 for r in results if not isinstance(r, Exception))
                self.notifier.send("沒人在家，已經關掉電器", f"關了 {done} 個：{names}")
                await self.changed()

            self._spawn(go())
        else:
            self.notifier.send("沒人在家，但還有電器開著", f"{names}。要關的話打開家庭中控（或把「沒人在家時」設成自動關閉）", "high")

    def _risky_left_on(self, cfg: dict[str, Any], notice: dict[str, Any]) -> None:
        """大家都出門了，高風險電器還開著：關掉（或只通知），緊急通知。同一次出門每個只處理一次。"""
        handled = notice.setdefault("risky", [])
        on = [p for p in self.ordered() if p.online and p.is_on and self.store.meta(p.id).risky
              and not self.store.meta(p.id).keep_on and p.id not in handled]
        if not on:
            return
        notice["risky"] = sorted(set(handled) | {p.id for p in on})
        self._dirty = True
        names = "、".join(self.name(p) for p in on)
        if cfg.get("risky_off", True) is False:
            self.notifier.send("⚠️ 沒人在家，高風險電器還開著", f"{names}，請盡快關掉", "urgent")
            return

        async def go() -> None:
            SOURCE.set("auto")
            results = await asyncio.gather(*(self.set_power(p.id, False) for p in on), return_exceptions=True)
            failed = [self.name(p) for p, r in zip(on, results) if isinstance(r, Exception)]
            done = [self.name(p) for p, r in zip(on, results) if not isinstance(r, Exception)]
            if done:
                self.notifier.send("沒人在家，已關掉高風險電器", "、".join(done), "high")
            if failed:
                self.notifier.send("⚠️ 高風險電器關不掉！", f"{'、'.join(failed)} 沒有回應，請盡快處理", "urgent")
            await self.changed()

        self._spawn(go())

    def _router_new_devices(self, now: float) -> bool:
        r = self.router
        known = self.store.data["net_devices"]
        if not r.names:  # 還沒讀到名稱清單
            return False
        online = [m for m in r.clients if r.online(m)]
        if not self.store.data.get("net_seeded"):
            # 第一次：已經在的、路由器以前看過的，都當作認得的
            for m in set(online) | set(r.names):
                known.setdefault(m, {"first": now, "seed": True})
            self.store.data["net_seeded"] = True
            self._dirty = True
            return True
        new = [m for m in online if m not in known]
        for m in new:
            known[m] = {"first": now}
            same = self._rotated_from(m, known)
            if same:
                known[m]["same_as"] = same
                _LOGGER.info("%s 是 %s 換了 MAC（同廠牌、同名稱），不通知", m, same)
                continue
            if self.store.data["settings"].get("new_device_alert", True) and m not in self.devices:
                c = r.clients[m]
                vendor = r.names.get(m, {}).get("vendor")
                where = f"「{c['ssid']}」" if c.get("ssid") else ("有線網路" if c.get("wired") else "Wi-Fi")
                self.notifier.send("有新裝置連上網路", f"{r.name_of(m)}{f'（{vendor}）' if vendor else ''}連上了{where}。不認得的話，可以到路由器的管理頁封鎖它。")
        if new:
            if len(known) > 800:  # 太多就丟掉最舊、不在地圖上也不是誰的手機的
                mine = {m for p in self.store.data["people"] for m in p["macs"]}
                old = sorted((v.get("first", 0), m) for m, v in known.items() if not v.get("map") and not v.get("label") and m not in mine)
                for _, m in old[: len(known) - 800]:
                    del known[m]
            self._dirty = True
        return bool(new)

    def _rotated_from(self, mac: str, known: dict[str, Any]) -> str | None:
        """有些裝置（例如 Kobo 閱讀器）保留廠牌前綴、後半段每次換：同前綴＋同名稱的舊裝置就當作同一台。
        手機的「私人 MAC」（第一組的 0x02 位元）每台不同，不算。"""
        name = (self.router.names.get(mac) or {}).get("name")
        if not name or int(mac[:2], 16) & 2:
            return None
        for m, n in self.router.names.items():
            if m != mac and m[:8] == mac[:8] and n.get("name") == name and m in known:
                return m
        return None

    def _router_presence(self, now: float) -> bool:
        """誰在家：家人的手機有沒有連著 Wi-Fi。離線超過幾分鐘才算出門（手機睡著時偶爾會斷一下）。"""
        people = self.store.data["people"]
        if not people:
            return False
        cfg = self.store.data["settings"].get("presence") or {}
        grace = max(1, float(cfg.get("grace_min") or 10)) * 60
        settled = now - self._router_since >= grace  # 剛連上路由器：只判斷回家，不判斷出門
        before = any(self._presence.get(p["id"], {}).get("home") for p in people)
        changed = False
        arrived = []
        for p in people:
            last = max((self.router.clients.get(m, {}).get("seen", 0) for m in p["macs"]), default=0)
            home = bool(last and now - last < grace)
            st = self._presence.get(p["id"])
            if st is None:
                self._presence[p["id"]] = {"home": home, "since": now}
                changed = True
            elif st["home"] != home and (home or settled):
                st.update(home=home, since=now if home else last)
                changed = True
                self._presence_log({"name": p["name"], "home": home, "why": self._presence_why(p, home, last, grace)})
                if home:
                    arrived.append(p["name"])
        for pid in [k for k in self._presence if k not in {p["id"] for p in people}]:
            del self._presence[pid]
        if not changed:
            return False
        self._dirty = True
        after = any(self._presence[p["id"]]["home"] for p in people)
        if before and not after:
            self._presence_scene(cfg.get("away_scene"), "大家都出門了")
        elif after and not before and arrived:
            if not cfg.get("home_dark_only") or self.is_dark():
                self._presence_scene(cfg.get("home_scene"), f"{'、'.join(arrived)}回家了")
        return True

    def _presence_why(self, p: dict[str, Any], home: bool, last: float, grace: float) -> str:
        """誰在家改變的原因（給「最近變化」看）。"""
        if not home:
            at = datetime.fromtimestamp(last).strftime("%H:%M") if last else "—"
            return f"手機超過 {round(grace / 60)} 分鐘沒連線（最後看到 {at}）"
        mac = max(p["macs"], key=lambda m: self.router.clients.get(m, {}).get("seen", 0))
        c = self.router.clients.get(mac, {})
        if c.get("probe") and c["probe"] >= c.get("seen", 0) - 1:
            return "樹莓派直接問到手機"
        node = next((n["model"] for n in self.router.nodes if n["mac"] == c.get("node")), None)
        where = "有線" if c.get("wired") else (c.get("band") or "Wi-Fi")
        return f"手機連上 {node + ' ' if node else ''}{where}"

    def _presence_log(self, item: dict[str, Any]) -> None:
        log = self.store.data.setdefault("presence_log", [])
        log.append({"t": round(time.time()), **item})
        del log[:-PRESENCE_LOG_MAX]
        self._dirty = True

    def _presence_scene(self, scene_id: str | None, why: str) -> None:
        scene = self.store.scene(scene_id) if scene_id else None
        if scene is None:
            return

        async def go() -> None:
            SOURCE.set("auto")
            done = await self.run_scene(scene["id"])
            self._presence_log({"scene": scene["name"], "why": why, "n": len(done)})
            self.notifier.send(why, f"已經執行「{scene['name']}」" + (f"，動了 {len(done)} 個插座" if done else "（插座本來就是這樣）"))
            await self.changed()

        self._spawn(go())

    def is_dark(self) -> bool:
        """現在是不是天黑了（日落前 30 分鐘到日出之間）；不知道日出日落就用 17:30～06:30。"""
        now = datetime.now()
        m = now.hour * 60 + now.minute
        rise = self._sun_min(1, now.date())
        sset = self._sun_min(2, now.date())
        rise = 390 if rise is None else rise
        sset = 1050 if sset is None else sset
        return m >= sset - 30 or m < rise

    def _ip_of(self, mac: str) -> str | None:
        """路由器給的 IP；有線的路由器有時沒給，就看樹莓派自己的 ARP 表。"""
        ip = self.router.clients.get(mac, {}).get("ip")
        if ip:
            return ip
        try:
            with open("/proc/net/arp") as f:
                for line in f.read().splitlines()[1:]:
                    x = line.split()
                    if len(x) >= 4 and x[3].lower() == mac.lower() and x[2] != "0x0":
                        return x[0]
        except OSError:
            pass
        return None

    async def _probe_tick(self) -> None:
        """路由器也說不出名字的裝置：直接在家裡網路問它一下是什麼（只讀，不登入）。問過的記在樹莓派上，一週後才再問。"""
        r = self.router
        if not r.ok:
            return
        probes: dict[str, dict[str, Any]] = self.store.data.setdefault("net_probe", {})
        known = self.store.data["net_devices"]
        now = time.time()
        todo = []
        for mac in list(r.clients):
            if not r.online(mac) or mac in self.devices or known.get(mac, {}).get("label"):
                continue
            n = r.names.get(mac, {})
            if n.get("custom") or not netprobe.raw_name(n.get("name")):
                continue
            p = probes.get(mac)
            if p and now - p.get("at", 0) < (30 if p.get("guess") else 7) * 86400:
                continue
            ip = self._ip_of(mac)
            if ip:
                todo.append((mac, ip))
        for mac, ip in todo[:4]:  # 一次最多問 4 台，慢慢來
            res = await netprobe.probe(ip)
            probes[mac] = {"at": now, **(res or {})}
            if res and res.get("guess"):
                _LOGGER.info("認出網路裝置：%s", res["guess"])
            self._dirty = True
        if len(probes) > 300:
            for m, _ in sorted(probes.items(), key=lambda kv: kv[1].get("at", 0))[: len(probes) - 300]:
                del probes[m]

    def net_report(self) -> dict[str, Any]:
        r = self.router
        known = self.store.data["net_devices"]
        owner = {m: p["name"] for p in self.store.data["people"] for m in p["macs"]}
        plug_names = {k: "、".join(self.name(self.plugs[p]) for p in e.plugs) for k, e in self.devices.items()}
        models = {n["mac"]: n for n in r.nodes}
        now = time.time()
        usage_today = self.store.data.get("net_usage", {}).get(date.today().isoformat(), {})
        probes = self.store.data.get("net_probe", {})
        clients = []
        for mac in set(r.clients) | {m for m, v in known.items() if v.get("map") or v.get("label")} | set(owner):
            c = r.clients.get(mac, {})
            k = known.get(mac, {})
            names = r.names.get(mac, {})
            node = models.get(c.get("node") or "")
            clients.append({
                "mac": mac,
                "name": k.get("label") or plug_names.get(mac) or (probes.get(mac, {}).get("guess") if netprobe.raw_name(names.get("custom") or names.get("name")) else None) or r.name_of(mac),
                "router_name": names.get("custom") or names.get("name"),
                "label": k.get("label"),
                "vendor": names.get("vendor"),
                "guess": probes.get(mac, {}).get("guess"),
                "guess_kind": probes.get(mac, {}).get("kind"),
                "ip": self._ip_of(mac) if r.online(mac) else c.get("ip"),
                "node": c.get("node"),
                "node_model": node["model"] if node else None,
                "node_main": node["main"] if node else None,
                "band": c.get("band"),
                "ssid": c.get("ssid"),
                "rssi": c.get("rssi"),
                "wired": c.get("wired", False),
                "online": r.online(mac),
                "seen": c.get("seen"),
                "first": None if k.get("seed") else k.get("first"),
                "map": bool(k.get("map")),
                "trusted": bool(k.get("trusted")),
                "person": owner.get(mac),
                "plug": plug_names.get(mac),
                "today_bytes": usage_today.get(mac),
            })
        clients.sort(key=lambda c: (not c["online"], c["plug"] is not None, c["name"].lower()))
        return {
            "configured": r.configured, "ok": r.ok, "error": r.error,
            "updated": r.updated, "now": now,
            "nodes": r.nodes, "clients": clients,
        }

    def people_report(self) -> list[dict[str, Any]]:
        out = []
        for p in self.store.data["people"]:
            st = self._presence.get(p["id"], {"home": None, "since": None})
            out.append({**p, **st, "where": self.person_where(p) if st.get("home") else None})
        return out

    def _target(self, plug_id: str) -> tuple[Any, dict[str, Any]]:
        plug = self.plugs[plug_id]
        dev = self._entry(plug).device
        return dev, native.context(dev, plug.child_index)

    async def set_led(self, plug_id: str, on: bool) -> None:
        dev, _ = self._target(plug_id)
        await asyncio.wait_for(dev.modules["Led"].set_led(on), DEVICE_TIMEOUT)
        for pid in self._entry(self.plugs[plug_id]).plugs:  # 整台插座共用一個燈
            self.plugs[pid].led = on
        await self.changed()

    async def reboot(self, plug_id: str) -> None:
        dev, _ = self._target(plug_id)
        await asyncio.wait_for(dev.reboot(), DEVICE_TIMEOUT)
        self.mark_native()

    async def usage(self, plug_id: str) -> dict[str, Any]:
        dev, ctx = self._target(plug_id)
        return await native.usage(dev, ctx)

    async def adopt_kasa_rule(self, plug_id: str, key: native.Key, enabled: bool = True) -> dict[str, Any]:
        """把 Kasa App 設的一條排程轉成家庭中控的排程，再從插座刪掉原本那條。"""
        act, opt, val, wday = key
        dev, ctx = self._target(plug_id)
        days = sorted((i - 1) % 7 for i, v in enumerate(wday) if v)  # 插座從星期日開始；我們 0 = 星期一
        if not days:
            raise ValueError("這條是單次排程，請在家庭中控重新建立")
        await native.delete_foreign(dev, ctx, key)
        body: dict[str, Any] = {"days": days, "action": "on" if act == 1 else "off", "plugs": [plug_id]}
        if opt:
            body.update(time_mode="sunrise" if opt == 1 else "sunset", offset_min=val)
        else:
            body["time"] = f"{val // 60:02d}:{val % 60:02d}:00"
        sched = self.store.save_schedule(None, body)
        if not enabled:  # 原本停用的，接管後也先停用
            sched = self.store.save_schedule(sched["id"], {"enabled": False})
        self._drop_foreign(plug_id, key)
        self.mark_native()
        await self.changed()
        return sched

    def _drop_foreign(self, plug_id: str, key: native.Key) -> None:
        info = self.native.get(plug_id) or {}
        info["kasa"] = [r for r in info.get("kasa", []) if (r["sact"], r["opt"], r["val"], tuple(r["wday"])) != key]

    async def edit_kasa_rule(self, plug_id: str, key: native.Key, new_key: native.Key, enable: bool) -> None:
        dev, ctx = self._target(plug_id)
        await native.edit_foreign(dev, ctx, key, new_key, enable)
        info = self.native.get(plug_id) or {}
        for r in info.get("kasa", []):  # 畫面馬上更新，不等下一次同步
            if (r["sact"], r["opt"], r["val"], tuple(r["wday"])) == key:
                act, opt, val, wday = new_key
                r.update(sact=act, opt=opt, val=val, wday=list(wday), enable=1 if enable else 0,
                         smin=val if opt == 0 else self._sun_min(opt, date.today()) + val)
                break
        self.mark_native()
        await self.changed()

    async def delete_kasa_rule(self, plug_id: str, key: native.Key) -> None:
        dev, ctx = self._target(plug_id)
        await native.delete_foreign(dev, ctx, key)
        self._drop_foreign(plug_id, key)
        self.mark_native()
        await self.changed()

    # ---- 日出日落 ----

    def location(self) -> tuple[float, float] | None:
        """家裡的經緯度：用插座裡存的（Kasa App 設定時寫進去的）。只在樹莓派上用，不會傳出去。

        每個插座存的位置可能不一樣（例如在別的地方設定過），所以用最多插座一樣的那個；
        一樣多就沿用上次的。選到的會存下來，重開、插座斷線都不會跳到別的地方。
        """
        found: list[tuple[float, float]] = []
        for entry in self.devices.values():
            info = getattr(entry.device, "sys_info", None) or {}
            lat, lon = info.get("latitude_i"), info.get("longitude_i")
            if lat is not None and lon is not None and (lat or lon):
                found.append((lat / 10000, lon / 10000))
                continue
            lat, lon = info.get("latitude"), info.get("longitude")
            if lat is not None and lon is not None and (lat or lon):
                found.append((float(lat), float(lon)))
        if not found:
            return self._home_loc
        groups: dict[tuple[float, float], list[tuple[float, float]]] = {}
        for loc in found:
            groups.setdefault((round(loc[0], 2), round(loc[1], 2)), []).append(loc)  # 大約 1 公里內算同一個地方
        prev = self._home_loc
        prev_key = (round(prev[0], 2), round(prev[1], 2)) if prev else None
        key = max(groups, key=lambda k: (len(groups[k]), k == prev_key))
        if key != prev_key or prev is None:
            self._home_loc = groups[key][0]
        return self._home_loc

    def _sun_min(self, opt: int, day: date) -> int | None:
        loc = self.location()
        if loc is None:
            return None
        return sun.minutes(day, loc[0], loc[1], "sunrise" if opt == 1 else "sunset")

    def sched_time(self, sched: dict[str, Any], day: date) -> str | None:
        """排程在這一天實際是幾點（"HH:MM:SS"）；日出日落算不出來（沒有位置）時回傳 None。"""
        mode = sched.get("time_mode", "clock")
        if mode not in ("sunrise", "sunset"):
            return sched["time"]
        base = self._sun_min(1 if mode == "sunrise" else 2, day)
        if base is None:
            return None
        minute = min(1439, max(0, base + int(sched.get("offset_min") or 0)))
        return f"{minute // 60:02d}:{minute % 60:02d}:00"

    async def cloud_unbind_all(self) -> dict[str, int]:
        ok = failed = 0
        for key, entry in self.devices.items():
            if not native.supported(entry.device):
                continue
            try:
                await native.cloud_unbind(entry.device)
                ok += 1
            except Exception as err:  # noqa: BLE001
                if "not bind" not in str(err):  # 本來就沒綁 = 已經斷開了
                    _LOGGER.warning("斷開雲端失敗：%s", err)
                    failed += 1
                    continue
                ok += 1
            self.dev_info.setdefault(key, {})["cloud_bound"] = False
        return {"ok": ok, "failed": failed}

    async def _run_timers_once(self) -> None:
        self._timers_busy = True
        try:
            await self._run_timers()
            if self._dirty:
                self.store.save()
                self._dirty = False
                await self.changed()
        finally:
            self._timers_busy = False

    async def _run_timers(self) -> None:
        now = time.time()
        for pid, at in list(self.store.data["timers"].items()):
            if at > now or pid not in self.plugs:
                continue
            plug = self.plugs[pid]
            guarded = bool(self.store.meta(pid).max_on_s)
            try:
                await self.set_power(pid, False, force=True)
            except Exception:  # noqa: BLE001
                if pid not in self._timer_failed:
                    self._timer_failed.add(pid)
                    if guarded:
                        self.notifier.send("⚠️ 關不掉！", f"{self.name(plug)} 已經超過最長開啟時間，但插座沒有回應，請立刻手動關閉", "urgent")
                # 有最長開啟時間的會一直重試；一般定時 5 分鐘後放棄
                if guarded or now - at < 300:
                    continue
                self.notifier.send("定時關閉失敗", f"{self.name(plug)} 沒有回應，請手動關閉", "high")
                self._timer_failed.discard(pid)
                self.store.data["timers"].pop(pid, None)
                self._dirty = True
                continue
            late = pid in self._timer_failed
            self._timer_failed.discard(pid)
            self.store.data["timers"].pop(pid, None)
            self._dirty = True
            if late:
                self.notifier.send("已經關閉", f"{self.name(plug)} 恢復回應，已經關閉", "high")
            elif guarded:
                self.notifier.send("自動關閉", f"{self.name(plug)} 開了 {fmt_secs(self.store.meta(pid).max_on_s)}，已經關閉")
            else:
                self.notifier.send("定時關閉", f"{self.name(plug)} 時間到，已經關閉")

    # ---- 情境 ----

    def _default_scenes(self) -> None:
        """第一次執行時建立「出門」「睡覺」「看電影」，之後可以在畫面上改。"""
        if self.store.data.get("scenes") is not None or not self.plugs:
            return
        metas = {pid: self.store.meta(pid) for pid in self.plugs}
        leave = {pid: ("keep" if m.keep_on else "off") for pid, m in metas.items()}
        sleep: dict[str, str] = {}
        movie: dict[str, str] = {}
        for pid, plug in self.plugs.items():
            name = self.name(plug).lower()
            is_tv = "電視" in name or "tv" in name
            is_light = "燈" in name or "lamp" in name
            if metas[pid].keep_on:
                continue
            if is_tv or is_light or metas[pid].night:
                sleep[pid] = "off"  # 睡覺：燈和電視都關
            if is_tv:
                movie[pid] = "on"  # 看電影：開電視、關燈
            elif is_light:
                movie[pid] = "off"
        self.store.data["scenes"] = []
        self.store.save_scene(None, "出門", "mdi:logout", leave, "off")
        self.store.save_scene(None, "睡覺", "mdi:weather-night", sleep, "keep")
        self.store.save_scene(None, "看電影", "mdi:television", movie, "keep")

    async def run_scene(self, scene_id: str, remember: str | None = None) -> list[str]:
        """執行情境；常開的插座不會被關。remember 有給就記住原本的狀態，可以復原。"""
        scene = self.store.scene(scene_id)
        if scene is None:
            raise KeyError(scene_id)
        targets: dict[str, bool] = {}
        for pid, plug in self.plugs.items():
            act = scene["actions"].get(pid, scene.get("others", "keep"))
            if act == "keep" or not plug.online:
                continue
            on = act == "on"
            if not on and self.store.meta(pid).keep_on:
                continue
            if plug.is_on is not on:
                targets[pid] = on
        before = {pid: not on for pid, on in targets.items()}
        results = await asyncio.gather(*(self.set_power(pid, on) for pid, on in targets.items()), return_exceptions=True)
        done = [pid for pid, r in zip(targets, results) if not isinstance(r, Exception)]
        if remember:
            self.store.data["remembered"][remember] = {pid: before[pid] for pid in done}
            self.store.save()
        return done

    # ---- 排程 ----

    async def _schedule_loop(self) -> None:
        """每秒檢查一次排程（對齊到整秒）。"""
        while True:
            await asyncio.sleep(1.02 - time.time() % 1)
            self.watchdog.tick()
            if not self.backup.busy and self.backup.due(datetime.now()):
                self.backup.busy = True
                self._spawn(asyncio.to_thread(self.backup.run))
            try:
                await self.run_schedule()
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001
                _LOGGER.exception("排程失敗")
            # 定時關閉也每秒檢查（澆水可以設到秒）；上一輪還在關就不重複
            if not self._timers_busy:
                self._spawn(self._run_timers_once())
            if self.router.ok and not self._probe_busy and time.time() - self._probe_at >= PROBE_EVERY:
                self._probe_busy = True
                self._spawn(self._probe_people())
            self._sync_failsafes()

    async def _probe_people(self) -> None:
        """路由器一陣子沒看到家人的手機時，樹莓派直接問那台手機在不在（iPhone 睡著時常這樣）。"""
        try:
            now = time.time()
            for p in self.store.data["people"]:
                for mac in p["macs"]:
                    c = self.router.clients.get(mac)
                    if not c or now - c.get("seen", 0) < PROBE_EVERY or now - c.get("seen", 0) > PROBE_MAX_AGE:
                        continue
                    ip = c.get("ip") or self._ip_of(mac)
                    if ip and await asyncio.to_thread(arpprobe.probe, ip, mac):
                        c["seen"] = c["probe"] = time.time()
        except Exception:  # noqa: BLE001
            _LOGGER.exception("詢問家人手機失敗")
        finally:
            self._probe_at = time.time()
            self._probe_busy = False

    def _due(self, key: str, hms: str, now: datetime) -> bool:
        """排程時間已到（容許晚 SCHEDULE_GRACE 秒，避免卡住時錯過），而且今天這個時間還沒執行過。"""
        h, m, sec = (int(x) for x in hms.split(":"))
        late = now.hour * 3600 + now.minute * 60 + now.second - (h * 3600 + m * 60 + sec)
        mark = f"{now.date().isoformat()} {hms}"
        if 0 <= late <= SCHEDULE_GRACE and self._schedule_done.get(key) != mark:
            self._schedule_done[key] = mark
            return True
        return False

    async def run_schedule(self) -> None:
        now = datetime.now()
        for sched in self.store.schedules:
            key = sched["id"]
            at = self.sched_time(sched, now.date())
            if sched["enabled"] and at and now.weekday() in sched["days"] and self._due(key, at, now):
                why = self.skip_reason(sched, now.date())
                if why:
                    self.sched_skipped[key] = why
                    _LOGGER.info("排程 %s 今天不執行：%s", key, why)
                else:
                    self._spawn(self._run_one(sched))
            # 關閉之後指定時間再打開：只開被這個排程關掉、現在還關著的
            if sched.get("restore_at") and self._due(f"{key}:restore", sched["restore_at"], now):
                if f"sched:{key}" in self.store.data["remembered"]:
                    self._spawn(self._restore_sched(key))

    def skip_reason(self, sched: dict[str, Any], day: date) -> str | None:
        """這個排程在這一天要不要跳過：國定假日／手動放假、下雨。回傳原因。"""
        if sched.get("skip_holiday"):
            if self.store.data.get("day_off") == day.isoformat():
                return "今天放假"
            h = self.daysoff.holiday(day)
            if h:
                return h
            off = self.alerts.dayoff(self.weather.county, self.weather.town, day)
            if off and off["full"]:
                return f"停止上班（{off['text'][:30]}）"
        if sched.get("skip_rain"):
            r = self.daysoff.rainy(day)
            if r:
                return r
        return None

    def skip_days(self, sched: dict[str, Any]) -> set[int]:
        """接下來 7 天裡要跳過的星期（寫進插座的備援規則也拿掉那幾天）。"""
        today = date.today()
        return {(today + timedelta(days=i)).weekday() for i in range(7) if self.skip_reason(sched, today + timedelta(days=i))}

    def recheck_calendar(self) -> None:
        """排程改了：下一輪馬上查假日、天氣（還沒查過天氣的話）。"""
        self._calendar_at = 0.0
        if not self.weather.periods:
            self.weather.reset()

    async def _calendar_tick(self) -> None:
        try:
            self._check_reminders(time.time())
        except Exception as err:  # noqa: BLE001
            _LOGGER.warning("主動提醒失敗：%s", err)
        if not self._alerts_busy:
            self._alerts_busy = True
            try:
                sig = self._dayoff_sig()
                if await asyncio.to_thread(self.alerts.refresh, self.weather.county, self.location()):
                    if self._dayoff_sig() != sig:
                        self.mark_native()  # 停班停課變了：插座裡的備援規則跟著改
                    await self.changed()
            except Exception as err:  # noqa: BLE001
                _LOGGER.warning("讀取停班停課、特報、地震、供電失敗：%s", err)
            finally:
                self._alerts_busy = False
        today = date.today()
        if today != self._today:  # 過了午夜：跳過的日子變了，重寫插座裡的規則
            self._today = today
            self.sched_skipped.clear()
            self.mark_native()
            self._check_weekly()
        if time.time() - self._calendar_at < 600:
            return
        self._calendar_at = time.time()
        need_weather = any(x.get("skip_rain") and x.get("enabled") for x in self.store.schedules)
        show = self.store.data["settings"].get("weather", True)
        before = self.weather.updated
        if await self.daysoff.refresh(self.location(), need_weather, show):
            self.mark_native()
            await self.changed()
        elif self.weather.updated != before:  # 只有天氣更新：畫面更新就好
            await self.changed()
        self._check_weekly()

    def _dayoff_sig(self) -> tuple:
        today = date.today()
        return tuple(bool((self.alerts.dayoff(self.weather.county, self.weather.town, today + timedelta(days=i)) or {}).get("full")) for i in range(2))

    def _check_reminders(self, now: float) -> None:
        """主動提醒（固定規則，不用 AI）：開太久、早上會下雨、明天停水停電。每件事只講一次，講過的存在樹莓派上。"""
        settings = self.store.data["settings"]
        cfg = settings.get("remind") or {}
        sent: dict[str, float] = self.store.data.setdefault("remind_sent", {})
        dt = datetime.now()
        before = len(sent)

        # 用電異常（冰箱耗電上升、待機變高、開得比平常久）
        self._check_anomalies(now, sent)

        # 開太久：開超過「開太久提醒」的時數，這次開著只講一次；同時好幾個就併成一則
        # 常開、有最長開啟時間、「出門」情境裡設成不動的（本來就要一直開）不算
        if cfg.get("long_on", True):
            limit = float(settings.get("long_on_hours") or 6) * 3600
            away = self.store.scene((settings.get("presence") or {}).get("away_scene") or "") or {}
            keep = {pid for pid, act in (away.get("actions") or {}).items() if act == "keep"}
            long = []
            for plug in self.ordered():
                meta = self.store.meta(plug.id)
                since = self.store.data["on_since"].get(plug.id)
                if not (plug.online and plug.is_on and since) or meta.keep_on or meta.max_on_s or plug.id in keep or now - since < limit:
                    continue
                key = f"long:{plug.id}:{int(since)}"
                if key not in sent:
                    sent[key] = now
                    long.append(f"{self.name(plug)}（{(now - since) / 3600:.0f} 小時）")
            if long:
                self.notifier.send("電器開很久了", "、".join(long[:6]) + (f" 等 {len(long)} 個" if len(long) > 6 else "") + "。要關的話打開家庭中控")

        # 早上 7～10 點：今天白天降雨機率高，提醒帶傘（一天一次）
        key = f"rain:{dt.date().isoformat()}"
        if cfg.get("rain", True) and settings.get("weather", True) and 7 <= dt.hour < 10 and key not in sent:
            pop = self.weather.day_pop(dt.date())
            if pop is not None and pop >= 60:
                sent[key] = now
                self.notifier.send("今天可能會下雨", f"白天降雨機率 {pop:.0f}%，出門記得帶傘")

        # 晚上 8～11 點：明天家裡這條路要停水停電，前一晚再提醒一次
        if cfg.get("outage_eve", True) and 20 <= dt.hour < 23:
            tomorrow = (dt.date() + timedelta(days=1)).isoformat()
            for x in self.local.outages:
                key = f"eve:{x['id']}"
                if x.get("hit") == "road" and x["start"][:10] == tomorrow and key not in sent:
                    sent[key] = now
                    what = "停電" if x["kind"] == "power" else "停水"
                    self.notifier.send(f"明天要{what}", f"明天 {x['start'][11:16]}～{x['end'][11:16]} 你家附近{what}，記得先準備"
                                       + ("（儲水）" if x["kind"] == "water" else "（手機充電、冰箱少開）"))

        self._check_alerts_notify(now, dt, cfg, sent)

        for k in [k for k, v in sent.items() if now - v > 7 * 86400]:
            del sent[k]
        if len(sent) != before:
            self._dirty = True

    def _check_alerts_notify(self, now: float, dt: datetime, cfg: dict[str, Any], sent: dict[str, float]) -> None:
        """停班停課、天氣特報、地震、供電吃緊、明天空品不好：各講一次。"""
        A = self.alerts
        county, town = self.weather.county, self.weather.town
        # 停班停課：今天、明天有發布就通知（同一段文字只講一次）
        if cfg.get("dayoff", True):
            for i, word in ((0, "今天"), (1, "明天")):
                day = dt.date() + timedelta(days=i)
                off = A.dayoff(county, town, day)
                if off:
                    key = f"dayoff:{day.isoformat()}:{off['text'][:40]}"
                    if key not in sent:
                        sent[key] = now
                        note = "「國定假日不執行」的排程會跳過" if off["full"] else ""
                        self.notifier.send(f"{word}{county or ''}停班停課", off["text"] + (f"。{note}" if note else ""), "high")
        # 天氣特報：新發布的才講
        if cfg.get("warn", True):
            for w in A.warnings:
                key = f"warn:{w.get('name')}:{w.get('start')}"
                if key not in sent:
                    sent[key] = now
                    end = (w.get("end") or "")[5:16].replace("-", "/")
                    self.notifier.send(f"{county or ''}{w.get('name')}", f"氣象署發布{w.get('name')}" + (f"，到 {end}" if end else ""), "high")
        # 地震：你家附近 3 級以上、1 小時內的
        q = A.quake
        age = quake_age_h(q)
        if cfg.get("quake", True) and q and q.get("rank", 0) >= 3 and age is not None and age < 1:
            key = f"quake:{q.get('no')}"
            if key not in sent:
                sent[key] = now
                on = [self.name(p) for p in self.ordered() if p.online and p.is_on and not self.store.meta(p.id).keep_on]
                msg = f"你家附近震度 {q.get('here')}（規模 {q.get('mag')}，{q.get('where')}）。"
                msg += f"現在開著：{'、'.join(on[:8])}{'…' if len(on) > 8 else ''}" if on else "家裡的電器都關著"
                self.notifier.send("剛剛有地震", msg, "high")
        # 供電吃緊：今天預估尖峰備轉到橘燈以下
        pw = A.power
        if cfg.get("power", True) and pw and pw.get("light") in ("O", "R", "B"):
            key = f"power:{dt.date().isoformat()}:{pw['light']}"
            if key not in sent:
                sent[key] = now
                self.notifier.send(f"今天供電吃緊（{pw.get('light_name')}）",
                                   f"台電預估尖峰備轉容量率 {pw.get('rate')}%（{pw.get('peak') or ''}）。用不到的電器可以先關")
        # 明天空品不好：晚上 8～11 點講一次
        if cfg.get("air", True) and 20 <= dt.hour < 23:
            tm = A.air_on(dt.date() + timedelta(days=1))
            if tm and tm["aqi"] > 100:
                key = f"air:{tm['date']}"
                if key not in sent:
                    sent[key] = now
                    self.notifier.send("明天空氣品質不好", f"{tm['zone']}空品區預報 AQI {tm['aqi']:.0f}（{tm['status']}）"
                                       + (f"，主要是{tm['pollutant']}" if tm.get("pollutant") else "") + "。記得關窗、可以開清淨機")

    def _check_weekly(self) -> None:
        """每週日晚上 8 點後推播這一週的摘要（一週一次）。"""
        now = datetime.now()
        week = now.strftime("%G-W%V")
        if now.weekday() != 6 or now.hour < 20 or self.store.data.get("weekly_sent") == week:
            return
        if not self.store.data["settings"].get("weekly", True):
            return
        self.store.data["weekly_sent"] = week
        self._dirty = True
        try:
            self.notifier.send("這週的家", self.weekly_text())
        except Exception as err:  # noqa: BLE001
            _LOGGER.warning("每週摘要失敗：%s", err)

    def weekly_text(self) -> str:
        rep = self.energy_report()
        days = rep["days"]
        this = sum(d["kwh"] for d in days[-8:-1])
        prev = sum(d["kwh"] for d in days[-15:-8])
        price = rep["price"]
        lines = [f"用電約 {this:.1f} 度（{this * price:.0f} 元）" + (f"，比上週{'多' if this > prev else '少'} {abs(this - prev) / prev * 100:.0f}%" if prev > 0 else "")]
        top = sorted(((sum((p.get("days") or [])[-8:-1]) / 60, p["name"]) for p in rep["plugs"]), reverse=True)[:3]
        if top and top[0][0] > 0:
            lines.append("開最久：" + "、".join(f"{n} {h:.0f} 小時" for h, n in top if h > 0))
        week_ago = time.time() - 7 * 86400
        new = [m for m, v in self.store.data["net_devices"].items() if not v.get("seed") and v.get("first", 0) >= week_ago]
        if new:
            lines.append(f"新連上網路的裝置 {len(new)} 台：" + "、".join(self.router.name_of(m) for m in new[:5]))
        outages = [e for e in self.store.data["net_events"] if (e.get("start") or 0) >= week_ago]
        if outages:
            lines.append(f"Wi-Fi 斷線 {len(outages)} 次")
        usage = self.store.data.get("net_usage", {})
        tot: dict[str, int] = {}
        for d, per in usage.items():
            if d >= (date.today() - timedelta(days=7)).isoformat():
                for m, b in per.items():
                    tot[m] = tot.get(m, 0) + b
        if tot:
            m, b = max(tot.items(), key=lambda x: x[1])
            size = f"{b / 1e9:.1f} GB" if b >= 1e9 else f"{b / 1e6:.0f} MB"
            lines.append(f"用最多網路：{self.store.data['net_devices'].get(m, {}).get('label') or self.router.name_of(m)} {size}")
        return "\n".join(lines)

    def _spawn(self, coro: Any) -> None:
        """排程在背景執行，同一秒的多個排程不會互相等；保留參照、記錄錯誤。"""
        task = asyncio.create_task(coro)
        self._bg.add(task)

        def done(t: asyncio.Task) -> None:
            self._bg.discard(t)
            if not t.cancelled() and t.exception():
                _LOGGER.error("排程執行失敗", exc_info=t.exception())

        task.add_done_callback(done)

    async def _restore_sched(self, key: str) -> None:
        done = await self.restore(f"sched:{key}")
        _LOGGER.info("排程 %s 打開 %d 個插座", key, len(done))

    async def _run_one(self, sched: dict[str, Any]) -> None:
        if sched["action"] == "scene":
            if self.store.scene(sched.get("scene") or ""):
                done = await self.run_scene(sched["scene"])
                _LOGGER.info("排程執行情境 %s：%d 個插座", sched["scene"], len(done))
            return
        on = sched["action"] == "on"
        targets = [
            pid for pid in sched["plugs"]
            if pid in self.plugs and self.plugs[pid].online and self.plugs[pid].is_on is not on
            and (on or not self.store.meta(pid).keep_on)
        ]
        results = await asyncio.gather(*(self.set_power(pid, on) for pid in targets), return_exceptions=True)
        done = [pid for pid, r in zip(targets, results) if not isinstance(r, Exception)]
        if not on and sched.get("restore_at"):
            self.store.data["remembered"][f"sched:{sched['id']}"] = done
            self.store.save()
        if on and sched.get("duration_s"):
            # 打開之後多久自動關閉（本來就開著的也算，從現在開始計時）
            until = time.time() + sched["duration_s"]
            for pid in sched["plugs"]:
                if pid in self.plugs and self.plugs[pid].is_on:
                    self.store.data["timers"][pid] = until
                    self._cap_on_time(pid)
            self.store.save()
            await self.changed()
        _LOGGER.info("排程%s %d 個插座", "打開" if on else "關閉", len(done))

    # ---- 給前端的資料 ----

    def name(self, plug: Plug) -> str:
        return self.store.meta(plug.id).name or plug.kasa_name

    def ordered(self) -> list[Plug]:
        rank = {pid: i for i, pid in enumerate(self.store.data["plug_order"])}
        return sorted(self.plugs.values(), key=lambda p: (rank.get(p.id, len(rank)), self.name(p)))

    def snapshot(self) -> dict[str, Any]:
        settings = self.store.data["settings"]
        today = date.today()
        month_start = today.replace(day=1).isoformat()
        price = tariff.price(settings["household_monthly_kwh"], today)
        energy_today = self.store.energy.total(today.isoformat())
        energy_month = self.store.energy.total(month_start)
        since = (today - timedelta(days=13)).isoformat()
        per_day = self.store.energy.per_day(since)
        history = [
            {"day": (today - timedelta(days=i)).isoformat(),
             "kwh": round(per_day.get((today - timedelta(days=i)).isoformat(), 0.0), 3)}
            for i in range(13, -1, -1)
        ]
        plugs = []
        total_power = 0.0
        measured = False
        for plug in self.ordered():
            meta = self.store.meta(plug.id)
            watts = self.watts(plug) if plug.online else None
            if watts is not None:
                total_power += watts
            if self.mode(plug) != "switch":
                measured = True
            plugs.append({
                "id": plug.id,
                "name": self.name(plug),
                "kasa_name": plug.kasa_name,
                "model": plug.model,
                "host": plug.host,
                "device": plug.device_key,
                "room": meta.room if self.store.room(meta.room) else None,
                "is_on": plug.is_on,
                "online": plug.online,
                "power": plug.power,
                "watts": meta.watts,
                "mode": self.mode(plug),
                "keep_on": meta.keep_on,
                "protect": meta.protect,
                "matter": meta.matter,
                "risky": meta.risky,
                "max_on_s": meta.max_on_s,
                "night": meta.night,
                "standby": self.is_standby(plug),
                "on_since": self.store.data["on_since"].get(plug.id) if plug.is_on else None,
                "timer": self.store.data["timers"].get(plug.id),
                "led": plug.led,
                "rssi": plug.rssi,
                "cloud": plug.cloud,
                "native": self.native.get(plug.id),
                "net": self._plug_net(plug.device_key),
            })
        return {
            "version": self.version,
            "plugs": plugs,
            "rooms": self.store.rooms,
            "summary": {
                "power": round(total_power, 1) if measured else None,
                "energy_today": round(energy_today, 3),
                "energy_month": round(energy_month, 3),
                "cost_today": round(energy_today * price, 1),
                "cost_month": round(energy_month * price, 0),
                "price": price,
                "season": "夏月" if tariff.is_summer(today) else "非夏月",
                "history": history,
            },
            "now": time.time(),
            "scenes": self.store.scenes,
            "schedules": [{**x, "today": self.sched_time(x, date.today()), "backup_status": self._backup_status(x),
                           "skip_today": self.skip_reason(x, date.today()), "skipped": self.sched_skipped.get(x["id"])}
                          for x in self.store.schedules],
            "calendar": {
                "holiday": self.daysoff.holiday(date.today()),
                "day_off": self.store.data.get("day_off") == date.today().isoformat(),
                "rain": self.daysoff.rainy(date.today()),
                "holidays_ready": date.today().year in self.daysoff.years,
                "weather": self.weather.report(),  # 沒有氣象署授權碼是 None
                "weather_show": self.store.data["settings"].get("weather", True),
                "local": self.local.report(),
                "alerts": self.alerts.report(self.weather.county, self.weather.town),
            },
            "sun": {"sunrise": self._sun_min(1, date.today()), "sunset": self._sun_min(2, date.today()), "located": self.location() is not None},
            "settings": settings,
            "can_restore": bool(self.store.data["remembered"].get("undo")),
            "habits": {"suggestions": self.habits, "days": getattr(self, "habit_days", 0)},
            "net_events": self.store.data["net_events"][-10:] + list(self._outage.values()),
            "matter": self.matter_status(),
            "notify": self.notifier.status(),
            "router": {"configured": self.router.configured, "ok": self.router.ok, "error": self.router.error,
                       "nodes": self.router.nodes,
                       "ssids": sorted({i["ssid"] for i in self.router.ifaces.values() if i.get("ssid")})},
            "people": self.people_report(),
            "presence_log": self.store.data.get("presence_log", [])[-20:],
            "assistant": self.assistant.status() if getattr(self, "assistant", None) else None,
            "backup": self.backup.report(),
            "app_version": APP_VERSION,
        }

    def _plug_net(self, key: str) -> dict[str, Any]:
        """插座的 Wi-Fi 資訊；路由器看得到它的話，Wi-Fi 名稱用路由器即時的（插座自己的每 30 分鐘才讀一次）。"""
        net = {k: v for k, v in self.dev_info.get(key, {}).items() if k != "fw_checked"}
        c = self.router.clients.get(key)
        if c and self.router.online(key) and c.get("ssid") and not c.get("wired"):
            net["ssid"] = c["ssid"]
        return net

    def matter_status(self) -> dict[str, Any] | None:
        """Google Home 串接的狀態；外掛每 30 秒回報一次，超過 90 秒沒回報就當作沒在執行。"""
        if self.matter is None:
            return None
        return {**self.matter, "running": time.monotonic() - self.matter_seen < 90}


def _is_plug(device: Device) -> bool:
    """只要插座和排插（有開關、不是燈泡或攝影機）。"""
    family = str(getattr(device.config.connection_type, "device_family", ""))
    return "PLUG" in family.upper() or bool(device.children) or device.device_type.name in ("Plug", "Strip", "WallSwitch")


def _plug_id(raw: str) -> str:
    return raw.replace(":", "").replace("_", "-").lower()


def _float(value: Any) -> float | None:
    try:
        return None if value is None else float(value)
    except (TypeError, ValueError):
        return None


async def _quiet_disconnect(device: Device) -> None:
    try:
        await device.disconnect()
    except Exception:  # noqa: BLE001
        pass

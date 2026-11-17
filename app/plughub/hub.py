"""插座的偵測、狀態、控制、用電累計、夜間排程和通知。

- 每 60 秒用廣播在區網找一次插座，新插座自動加入，換了 IP 也會跟著更新
- 每 POLL_SECONDS 秒更新所有插座的狀態（同時進行，每台有逾時）
- 多孔排插（HS107、KP303）的每一孔各算一個插座
- 有計量的插座用它自己的累計用電；沒有計量但填了瓦數的，用「開著的時間 × 瓦數」估算
"""

from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from typing import Any, Callable

from kasa import Device, Discover, Module

from . import tariff
from .notify import Notifier
from .store import Store

_LOGGER = logging.getLogger(__name__)

POLL_SECONDS = 5
DISCOVER_SECONDS = 60
DEVICE_TIMEOUT = 4
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


@dataclass
class DeviceEntry:
    device: Device
    plugs: list[str] = field(default_factory=list)
    failures: int = 0


class Hub:
    def __init__(self, store: Store, notifier: Notifier) -> None:
        self.store = store
        self.notifier = notifier
        self.devices: dict[str, DeviceEntry] = {}  # MAC → 裝置
        self.plugs: dict[str, Plug] = {}
        self.version = 0
        self._changed = asyncio.Condition()
        self._tasks: list[asyncio.Task] = []
        self._schedule_done: dict[str, str] = {}  # "night_off"/"morning_on" → 今天已執行的日期
        self._offline_notified: set[str] = set()
        self._overload_notified: set[str] = set()
        self._last_flush = time.monotonic()
        self._discovering = False

    # ---- 生命週期 ----

    async def start(self) -> None:
        await self.discover()
        self._tasks = [
            asyncio.create_task(self._loop(self.discover, DISCOVER_SECONDS)),
            asyncio.create_task(self._loop(self.poll, POLL_SECONDS)),
            asyncio.create_task(self._loop(self.run_schedule, 20)),
        ]

    async def stop(self) -> None:
        for task in self._tasks:
            task.cancel()
        self.store.energy.flush()
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
            _LOGGER.info("找到插座 %s（%s，%s）", device.alias, device.model, host)
        if added:
            await self.changed()

    # ---- 更新狀態 ----

    async def poll(self) -> None:
        await asyncio.gather(*(self._poll_one(e) for e in list(self.devices.values())))
        self._accrue()
        self._check_alerts()
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
            plug.is_on = bool(source.is_on)
            plug.kasa_name = source.alias or plug.kasa_name
            plug.online = True
            plug.offline_since = None
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

    # ---- 通知 ----

    def _check_alerts(self) -> None:
        now = time.time()
        settings = self.store.data["settings"]
        for plug in self.plugs.values():
            name = self.name(plug)
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

    async def set_power(self, plug_id: str, on: bool) -> None:
        plug = self.plugs[plug_id]
        entry = self.devices[plug.device_key]
        target = entry.device.children[plug.child_index] if plug.child_index is not None else entry.device
        await asyncio.wait_for(target.turn_on() if on else target.turn_off(), DEVICE_TIMEOUT)
        plug.is_on = on
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

    async def restore(self, remember: str) -> list[str]:
        """打開 remember 記住的、而且現在還關著的插座。"""
        ids = self.store.data["remembered"].pop(remember, [])
        self.store.save()
        targets = [pid for pid in ids if pid in self.plugs and self.plugs[pid].is_on is False]
        await asyncio.gather(*(self.set_power(pid, True) for pid in targets), return_exceptions=True)
        return targets

    # ---- 夜間排程 ----

    async def run_schedule(self) -> None:
        sched = self.store.data["schedule"]
        now = datetime.now()
        hhmm = now.strftime("%H:%M")
        today = now.date().isoformat()
        if sched["enabled"] and hhmm == sched["night_off"] and self._schedule_done.get("night_off") != today:
            self._schedule_done["night_off"] = today
            done = await self.turn_off(night_only=True, remember="night")
            _LOGGER.info("夜間排程關閉 %d 個插座", len(done))
        # 早上只打開晚上被排程關掉的
        if hhmm == sched["morning_on"] and self._schedule_done.get("morning_on") != today:
            self._schedule_done["morning_on"] = today
            if "night" in self.store.data["remembered"]:
                done = await self.restore("night")
                _LOGGER.info("早上打開 %d 個插座", len(done))

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
                "night": meta.night,
                "standby": self.is_standby(plug),
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
            "schedule": self.store.data["schedule"],
            "settings": settings,
            "can_restore": bool(self.store.data["remembered"].get("undo")),
        }


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

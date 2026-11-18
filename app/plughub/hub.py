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

from . import native, tariff
from .notify import Notifier
from .store import Store

_LOGGER = logging.getLogger(__name__)

POLL_SECONDS = 5
# 名稱有這些字的插座，第一次看到時自動設「最長開啟 10 分鐘」（之後可以在 App 改）
WATER_WORDS = ("澆水", "灑水", "water", "sprinkler", "抽水", "水泵")
DEFAULT_MAX_ON = 600  # 秒


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
        self._lease_busy = False
        self._timer_failed: set[str] = set()  # 定時關閉失敗、已經通知過的插座
        self._offline_notified: set[str] = set()
        self._overload_notified: set[str] = set()
        self._last_flush = time.monotonic()
        self._discovering = False
        self._dirty = False  # store 有沒寫回的變動

    # ---- 生命週期 ----

    async def start(self) -> None:
        await self.discover()
        self._default_scenes()
        self._tasks = [
            asyncio.create_task(self._loop(self.discover, DISCOVER_SECONDS)),
            asyncio.create_task(self._loop(self.poll, POLL_SECONDS)),
            asyncio.create_task(self._schedule_loop()),
            asyncio.create_task(self._loop(self._native_tick, 5)),
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
            self._set_is_on(plug, bool(source.is_on))
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

    async def set_power(self, plug_id: str, on: bool, force: bool = False) -> None:
        """開關插座。鎖定的插座要 force 才能動（只有使用者在裝置詳細裡明確操作、或定時到了）。"""
        if not force and self.store.meta(plug_id).protect == "lock":
            raise Locked(self.name(self.plugs[plug_id]))
        plug = self.plugs[plug_id]
        entry = self.devices[plug.device_key]
        target = entry.device.children[plug.child_index] if plug.child_index is not None else entry.device
        await asyncio.wait_for(target.turn_on() if on else target.turn_off(), DEVICE_TIMEOUT)
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
                    want = native.lease_enabled(rule, now)
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

    def _target(self, plug_id: str) -> tuple[Any, dict[str, Any]]:
        plug = self.plugs[plug_id]
        dev = self.devices[plug.device_key].device
        return dev, native.context(dev, plug.child_index)

    async def set_led(self, plug_id: str, on: bool) -> None:
        dev, _ = self._target(plug_id)
        await asyncio.wait_for(dev.modules["Led"].set_led(on), DEVICE_TIMEOUT)
        for pid in self.devices[self.plugs[plug_id].device_key].plugs:  # 整台插座共用一個燈
            self.plugs[pid].led = on
        await self.changed()

    async def reboot(self, plug_id: str) -> None:
        dev, _ = self._target(plug_id)
        await asyncio.wait_for(dev.reboot(), DEVICE_TIMEOUT)
        self.mark_native()

    async def usage(self, plug_id: str) -> dict[str, Any]:
        dev, ctx = self._target(plug_id)
        return await native.usage(dev, ctx)

    async def adopt_kasa_rule(self, plug_id: str, sact: int, smin: int, wday: list[int], enabled: bool = True) -> dict[str, Any]:
        """把 Kasa App 設的一條排程轉成家庭中控的排程，再從插座刪掉原本那條。"""
        dev, ctx = self._target(plug_id)
        days = sorted((i - 1) % 7 for i, v in enumerate(wday) if v)  # 插座從星期日開始；我們 0 = 星期一
        if not days:
            raise ValueError("這條是單次排程，請在家庭中控重新建立")
        await native.delete_foreign(dev, ctx, sact, smin, wday)
        sched = self.store.save_schedule(None, {
            "time": f"{smin // 60:02d}:{smin % 60:02d}:00", "days": days,
            "action": "on" if sact == 1 else "off", "plugs": [plug_id],
        })
        if not enabled:  # 原本停用的，接管後也先停用
            sched = self.store.save_schedule(sched["id"], {"enabled": False})
        info = self.native.get(plug_id)
        if info and info.get("kasa"):
            info["kasa"] = [r for r in info["kasa"] if not (r["sact"] == sact and r["smin"] == smin and r["wday"] == list(wday))]
        self.mark_native()
        await self.changed()
        return sched

    def _foreign_fp(self, r: dict[str, Any]) -> list:
        return [r.get("sact"), r.get("smin"), list(r.get("wday", []))]

    async def edit_kasa_rule(self, plug_id: str, match: list, changes: dict[str, Any]) -> None:
        dev, ctx = self._target(plug_id)
        rule = await native.edit_foreign(dev, ctx, match, changes)
        info = self.native.get(plug_id) or {}
        for r in info.get("kasa", []):  # 畫面馬上更新，不等下一次同步
            if self._foreign_fp(r) == match:
                r.update({k: rule.get(k) for k in ("sact", "smin", "wday", "enable")})
                r["wday"] = list(r["wday"])
                break
        self.mark_native()
        await self.changed()

    async def delete_kasa_rule(self, plug_id: str, match: list) -> None:
        dev, ctx = self._target(plug_id)
        await native.delete_foreign(dev, ctx, *match)
        info = self.native.get(plug_id) or {}
        info["kasa"] = [r for r in info.get("kasa", []) if self._foreign_fp(r) != match]
        self.mark_native()
        await self.changed()

    async def cloud_unbind_all(self) -> dict[str, int]:
        ok = failed = 0
        for entry in self.devices.values():
            if not native.supported(entry.device):
                continue
            try:
                await native.cloud_unbind(entry.device)
                ok += 1
            except Exception as err:  # noqa: BLE001
                _LOGGER.warning("斷開雲端失敗：%s", err)
                failed += 1
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
            try:
                await self.run_schedule()
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001
                _LOGGER.exception("排程失敗")
            # 定時關閉也每秒檢查（澆水可以設到秒）；上一輪還在關就不重複
            if not self._timers_busy:
                self._spawn(self._run_timers_once())
            self._sync_failsafes()

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
            if sched["enabled"] and now.weekday() in sched["days"] and self._due(key, sched["time"], now):
                self._spawn(self._run_one(sched))
            # 關閉之後指定時間再打開：只開被這個排程關掉、現在還關著的
            if sched.get("restore_at") and self._due(f"{key}:restore", sched["restore_at"], now):
                if f"sched:{key}" in self.store.data["remembered"]:
                    self._spawn(self._restore_sched(key))

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
                "max_on_s": meta.max_on_s,
                "night": meta.night,
                "standby": self.is_standby(plug),
                "on_since": self.store.data["on_since"].get(plug.id) if plug.is_on else None,
                "timer": self.store.data["timers"].get(plug.id),
                "led": plug.led,
                "rssi": plug.rssi,
                "cloud": plug.cloud,
                "native": self.native.get(plug.id),
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
            "schedules": self.store.schedules,
            "settings": settings,
            "can_restore": bool(self.store.data["remembered"].get("undo")),
            "matter": self.matter_status(),
        }

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

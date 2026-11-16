"""Power Hub：自動偵測區網裡的智慧插座，統計用電並提供關閉／還原服務。

插座不用手動列出：任何「屬於某個裝置、而且是主要開關」的 switch 都會被納入，
同一個裝置底下有功率感測器的就算有計量。設定都靠 Home Assistant 內建的
區域和標籤，在手機 App 上就能改：

- 常開：所有關閉動作都會跳過
- 夜間關閉：夜間排程要關的插座
- 不管理：完全不納入
- 「9W」這種瓦數標籤：沒有計量的插座用這個瓦數估算用電
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta
import logging
import re
from typing import Any

import voluptuous as vol

from homeassistant.config_entries import DISCOVERY_SOURCES
from homeassistant.const import (
    ATTR_ENTITY_ID,
    EVENT_HOMEASSISTANT_STARTED,
    EVENT_HOMEASSISTANT_STOP,
    STATE_ON,
    STATE_UNAVAILABLE,
    Platform,
)
from homeassistant.core import (
    CALLBACK_TYPE,
    CoreState,
    Event,
    HomeAssistant,
    ServiceCall,
    callback,
)
from homeassistant.helpers import (
    area_registry as ar,
    config_validation as cv,
    device_registry as dr,
    entity_registry as er,
    label_registry as lr,
)
from homeassistant.helpers.debounce import Debouncer
from homeassistant.helpers.discovery import async_load_platform
from homeassistant.helpers.dispatcher import async_dispatcher_send
from homeassistant.helpers.event import (
    async_track_state_change_event,
    async_track_time_interval,
)
from homeassistant.helpers.storage import Store
from homeassistant.helpers.typing import ConfigType
from homeassistant.util import dt as dt_util

_LOGGER = logging.getLogger(__name__)

DOMAIN = "power_hub"
SIGNAL_UPDATE = f"{DOMAIN}_update"
EVENT_PLUG_ADDED = f"{DOMAIN}_plug_added"

LABEL_KEEP_ON = "常開"
LABEL_NIGHT = "夜間關閉"
LABEL_IGNORE = "不管理"
WATTS_LABEL = re.compile(r"^\s*(\d+(?:\.\d+)?)\s*[wW]\s*$")

# 這些整合的開關是網路、伺服器設備的功能（例如關掉某個網路埠），不能被「全部關閉」關掉
EXCLUDED_DOMAINS = {
    "adguard",
    "asuswrt",
    "fritz",
    "hassio",
    "keenetic_ndms2",
    "mikrotik",
    "mobile_app",
    "netgear",
    "nut",
    "pi_hole",
    "proxmoxve",
    "synology_dsm",
    "tplink_omada",
    "unifi",
    "unifiprotect",
    "upnp",
}

# 累計用電感測器裡，這些是每日／每月會歸零的，不是終身累計
RESETTING_ENERGY = re.compile(r"today|daily|week|month|year", re.IGNORECASE)

OFFLINE_AFTER = timedelta(minutes=10)
STANDBY_MIN_W = 0.2
DEFAULT_STANDBY_W = 5.0
DEFAULT_OVERLOAD_W = 1500.0
STANDBY_ENTITY = "input_number.standby_threshold"
OVERLOAD_ENTITY = "input_number.overload_threshold"

CONFIG_SCHEMA = vol.Schema(
    {DOMAIN: vol.Any(None, vol.Schema({}))}, extra=vol.ALLOW_EXTRA
)

TURN_OFF_SCHEMA = vol.Schema(
    {
        vol.Optional("area"): cv.string,
        vol.Optional("label"): cv.string,
        vol.Optional("standby_only", default=False): cv.boolean,
        vol.Optional("remember"): cv.string,
    }
)
RESTORE_SCHEMA = vol.Schema({vol.Required("remember"): cv.string})


@dataclass
class Plug:
    """一個被管理的插座（一個開關）。"""

    entity_id: str
    device_id: str
    name: str
    area_id: str | None
    labels: set[str]
    # 只有一個開關的裝置，功率才算在這個插座上；多孔排插的功率屬於整個裝置
    power_entity: str | None = None
    energy_entity: str | None = None
    watts: float | None = None

    @property
    def mode(self) -> str:
        if self.power_entity:
            return "metered"
        if self.watts is not None:
            return "estimated"
        return "switch"

    @property
    def keep_on(self) -> bool:
        return LABEL_KEEP_ON in self.labels


@dataclass
class Meter:
    """一個有計量的裝置（可能有好幾個開關，例如排插）。"""

    device_id: str
    power_entity: str | None
    energy_entity: str | None


@dataclass
class Status:
    """每次更新算出來、給感測器顯示的結果。"""

    power: float = 0.0
    offline: list[Plug] = field(default_factory=list)
    standby: list[tuple[Plug, float]] = field(default_factory=list)
    overload: list[tuple[str, float]] = field(default_factory=list)
    discovered: list[str] = field(default_factory=list)


class PowerHub:
    """偵測插座、累計用電、提供服務。"""

    def __init__(self, hass: HomeAssistant) -> None:
        self.hass = hass
        self.plugs: dict[str, Plug] = {}
        self.meters: dict[str, Meter] = {}
        self.status = Status()
        self.energy_total = 0.0
        self._store: Store[dict[str, Any]] = Store(hass, 1, DOMAIN)
        # 每個累計用電感測器上次的數值，用來算增加量
        self._energy_last: dict[str, float] = {}
        # 估算插座上次累計的時間和開關狀態
        self._estimate_last: dict[str, tuple[datetime, bool]] = {}
        self._known: set[str] | None = None
        self._remembered: dict[str, list[str]] = {}
        self._unsub_state: CALLBACK_TYPE | None = None
        self._rescan_debouncer = Debouncer(
            hass, _LOGGER, cooldown=2, immediate=False, function=self._async_rescan
        )

    # ---- 載入／儲存 ----

    async def async_load(self) -> None:
        data = await self._store.async_load() or {}
        self.energy_total = float(data.get("energy_total", 0.0))
        self._energy_last = {k: float(v) for k, v in data.get("energy_last", {}).items()}
        known = data.get("known")
        self._known = set(known) if known is not None else None
        self._remembered = data.get("remembered", {})

    def _data_to_save(self) -> dict[str, Any]:
        return {
            "energy_total": round(self.energy_total, 6),
            "energy_last": self._energy_last,
            "known": sorted(self._known or []),
            "remembered": self._remembered,
        }

    @callback
    def _schedule_save(self) -> None:
        self._store.async_delay_save(self._data_to_save, 30)

    async def async_save(self) -> None:
        await self._store.async_save(self._data_to_save())

    # ---- 偵測 ----

    async def _async_rescan(self) -> None:
        self.rescan()

    @callback
    def request_rescan(self, _event: Event | None = None) -> None:
        self._rescan_debouncer.async_schedule_call()

    @callback
    def rescan(self) -> None:
        """從裝置和實體登錄找出所有插座。"""
        ent_reg = er.async_get(self.hass)
        dev_reg = dr.async_get(self.hass)
        label_reg = lr.async_get(self.hass)

        def label_names(ids: set[str]) -> set[str]:
            names = set()
            for label_id in ids:
                if label := label_reg.async_get_label(label_id):
                    names.add(label.name)
            return names

        def device_domains(device: dr.DeviceEntry) -> set[str]:
            domains = set()
            for entry_id in device.config_entries:
                if entry := self.hass.config_entries.async_get_entry(entry_id):
                    domains.add(entry.domain)
            return domains

        candidates: dict[str, list[er.RegistryEntry]] = {}
        for entry in ent_reg.entities.values():
            if (
                entry.domain != Platform.SWITCH
                or entry.device_id is None
                or entry.disabled_by is not None
                or entry.hidden_by is not None
                or entry.entity_category is not None
                or entry.platform == DOMAIN
            ):
                continue
            device = dev_reg.async_get(entry.device_id)
            if (
                device is None
                or device.disabled_by is not None
                or device.entry_type is dr.DeviceEntryType.SERVICE
                or device_domains(device) & EXCLUDED_DOMAINS
            ):
                continue
            candidates.setdefault(entry.device_id, []).append(entry)

        plugs: dict[str, Plug] = {}
        meters: dict[str, Meter] = {}
        for device_id, switches in candidates.items():
            device = dev_reg.async_get(device_id)
            assert device is not None
            # 多孔排插：沒有名稱的那個開關是「整排」，關掉它會連常開的孔一起關，所以不納入
            if len(switches) > 1:
                named = [s for s in switches if s.original_name or s.name]
                switches = named or switches[:1]
            device_labels = label_names(device.labels)
            power, energy = self._find_meter(ent_reg, dev_reg, device)
            if power or energy:
                meters[device_id] = Meter(device_id, power, energy)
            for entry in switches:
                labels = label_names(entry.labels) | device_labels
                if LABEL_IGNORE in labels:
                    continue
                name = self._plug_name(entry, device)
                plug = Plug(
                    entity_id=entry.entity_id,
                    device_id=device_id,
                    name=name,
                    area_id=entry.area_id or device.area_id,
                    labels=labels,
                )
                if len(switches) == 1:
                    plug.power_entity = power
                    plug.energy_entity = energy
                if plug.power_entity is None:
                    for label in labels:
                        if match := WATTS_LABEL.match(label):
                            plug.watts = float(match.group(1))
                            break
                plugs[entry.entity_id] = plug

        self.plugs = plugs
        self.meters = meters
        self._announce_new_plugs()
        self._track_states()
        self.update()

    @staticmethod
    def _plug_name(entry: er.RegistryEntry, device: dr.DeviceEntry) -> str:
        """跟 Home Assistant 顯示的名稱一樣：自訂名稱優先，否則「裝置名稱 實體名稱」。"""
        if entry.name:
            return entry.name
        device_name = device.name_by_user or device.name or ""
        if entry.has_entity_name and entry.original_name:
            return f"{device_name} {entry.original_name}".strip()
        return entry.original_name or device_name or entry.entity_id

    def _find_meter(
        self,
        ent_reg: er.EntityRegistry,
        dev_reg: dr.DeviceRegistry,
        device: dr.DeviceEntry,
    ) -> tuple[str | None, str | None]:
        """找裝置（和它底下的子裝置）的功率與終身累計用電感測器。"""
        device_ids = [device.id] + [
            d.id for d in dev_reg.devices.values() if d.via_device_id == device.id
        ]
        power: list[er.RegistryEntry] = []
        energy: list[er.RegistryEntry] = []
        for device_id in device_ids:
            for entry in er.async_entries_for_device(ent_reg, device_id):
                if entry.domain != Platform.SENSOR or entry.disabled_by is not None:
                    continue
                device_class = entry.device_class or entry.original_device_class
                if device_class == "power":
                    power.append(entry)
                elif device_class == "energy":
                    text = f"{entry.entity_id} {entry.unique_id} {entry.translation_key or ''}"
                    if not RESETTING_ENERGY.search(text):
                        energy.append(entry)
        # 有好幾個的話，名稱裡有 total／current 的優先
        power.sort(key=lambda e: "current" not in f"{e.entity_id} {e.translation_key or ''}")
        energy.sort(key=lambda e: "total" not in f"{e.entity_id} {e.translation_key or ''}")
        # 子裝置各有自己的感測器時（每孔都有計量的排插），只取第一個會少算，
        # 所以只有在整個裝置剛好一個功率感測器時才當作有計量
        return (
            power[0].entity_id if len(power) == 1 else None,
            energy[0].entity_id if len(energy) == 1 else None,
        )

    @callback
    def _announce_new_plugs(self) -> None:
        # 啟動過程中各整合陸續建立實體，等完全啟動後再比對，免得把舊插座當成新的
        if self.hass.state is not CoreState.running:
            return
        current = set(self.plugs)
        if self._known is None:
            # 第一次啟動：現有的插座都當作已知，不通知
            self._known = current
            self._schedule_save()
            return
        new = current - self._known
        for entity_id in sorted(new):
            plug = self.plugs[entity_id]
            self.hass.bus.async_fire(
                EVENT_PLUG_ADDED,
                {
                    ATTR_ENTITY_ID: entity_id,
                    "name": plug.name,
                    "device_id": plug.device_id,
                    "mode": plug.mode,
                },
            )
        if new:
            self._known |= new
            self._schedule_save()

    @callback
    def _track_states(self) -> None:
        if self._unsub_state:
            self._unsub_state()
        entity_ids = set(self.plugs) | {STANDBY_ENTITY, OVERLOAD_ENTITY}
        for meter in self.meters.values():
            entity_ids |= {e for e in (meter.power_entity, meter.energy_entity) if e}
        self._unsub_state = async_track_state_change_event(
            self.hass, list(entity_ids), self._state_changed
        )

    @callback
    def _state_changed(self, _event: Event) -> None:
        self.update()

    # ---- 計算 ----

    def _number(self, entity_id: str | None) -> float | None:
        if entity_id is None or (state := self.hass.states.get(entity_id)) is None:
            return None
        try:
            return float(state.state)
        except ValueError:
            return None

    def _energy_kwh(self, entity_id: str) -> float | None:
        value = self._number(entity_id)
        if value is None:
            return None
        state = self.hass.states.get(entity_id)
        unit = state.attributes.get("unit_of_measurement") if state else None
        if unit == "Wh":
            return value / 1000
        if unit == "MWh":
            return value * 1000
        return value

    def _power_w(self, entity_id: str | None) -> float | None:
        value = self._number(entity_id)
        if value is None:
            return None
        state = self.hass.states.get(entity_id) if entity_id else None
        if state and state.attributes.get("unit_of_measurement") == "kW":
            return value * 1000
        return value

    @callback
    def _accrue_estimates(self) -> None:
        now = dt_util.utcnow()
        added = 0.0
        for plug in self.plugs.values():
            if plug.mode != "estimated":
                continue
            last = self._estimate_last.get(plug.entity_id)
            if last is not None:
                since, was_on = last
                if was_on:
                    hours = (now - since).total_seconds() / 3600
                    added += (plug.watts or 0) * hours / 1000
            self._estimate_last[plug.entity_id] = (now, self.hass.states.is_state(plug.entity_id, STATE_ON))
        if added:
            self.energy_total += added
            self._schedule_save()

    @callback
    def _accrue_meters(self) -> None:
        """把每個累計用電感測器的增加量加進總用電。

        只加增加量，所以斷線、新插座加入、感測器歸零都不會讓總用電亂跳；
        斷線期間用的電，恢復連線後也會補算進來。
        """
        changed = False
        for meter in self.meters.values():
            if meter.energy_entity is None:
                continue
            value = self._energy_kwh(meter.energy_entity)
            if value is None:
                continue
            last = self._energy_last.get(meter.energy_entity)
            if last is not None and value > last:
                self.energy_total += value - last
            if last != value:
                self._energy_last[meter.energy_entity] = value
                changed = True
        if changed:
            self._schedule_save()

    @callback
    def update(self, _now: datetime | None = None) -> None:
        self._accrue_meters()
        self._accrue_estimates()
        now = dt_util.utcnow()
        standby_w = self._number(STANDBY_ENTITY) or DEFAULT_STANDBY_W
        overload_w = self._number(OVERLOAD_ENTITY) or DEFAULT_OVERLOAD_W

        status = Status()
        for meter in self.meters.values():
            watts = self._power_w(meter.power_entity)
            if watts is None:
                continue
            status.power += watts
            if watts > overload_w:
                status.overload.append((self._device_name(meter.device_id), watts))
        for plug in self.plugs.values():
            state = self.hass.states.get(plug.entity_id)
            if state is None:
                continue
            if state.state == STATE_UNAVAILABLE and now - state.last_changed >= OFFLINE_AFTER:
                status.offline.append(plug)
            if state.state != STATE_ON:
                continue
            if plug.mode == "estimated":
                status.power += plug.watts or 0
            elif plug.mode == "metered" and not plug.keep_on:
                watts = self._power_w(plug.power_entity)
                if watts is not None and STANDBY_MIN_W < watts < standby_w:
                    status.standby.append((plug, watts))
        status.power = round(status.power, 1)
        status.discovered = self._discovered()
        self.status = status
        async_dispatcher_send(self.hass, SIGNAL_UPDATE)

    def _device_name(self, device_id: str) -> str:
        device = dr.async_get(self.hass).async_get(device_id)
        if device is None:
            return device_id
        return device.name_by_user or device.name or device_id

    def _discovered(self) -> list[str]:
        """區網上發現、但還沒加入的裝置。"""
        names = []
        for flow in self.hass.config_entries.flow.async_progress():
            context = flow.get("context") or {}
            if context.get("source") not in DISCOVERY_SOURCES:
                continue
            placeholders = context.get("title_placeholders") or {}
            name = placeholders.get("name") or flow["handler"]
            names.append(str(name))
        return sorted(names)

    # ---- 服務 ----

    def _select(self, call: ServiceCall) -> list[Plug]:
        plugs = [p for p in self.plugs.values() if not p.keep_on]
        if area := call.data.get("area"):
            area_reg = ar.async_get(self.hass)
            area_entry = area_reg.async_get_area(area) or area_reg.async_get_area_by_name(area)
            area_id = area_entry.id if area_entry else area
            plugs = [p for p in plugs if p.area_id == area_id]
        if label := call.data.get("label"):
            plugs = [p for p in plugs if label in p.labels]
        if call.data.get("standby_only"):
            standby = {p.entity_id for p, _ in self.status.standby}
            plugs = [p for p in plugs if p.entity_id in standby]
        return [p for p in plugs if self.hass.states.is_state(p.entity_id, STATE_ON)]

    async def async_turn_off(self, call: ServiceCall) -> None:
        targets = [p.entity_id for p in self._select(call)]
        if remember := call.data.get("remember"):
            self._remembered[remember] = targets
            await self.async_save()
        if targets:
            await self.hass.services.async_call(
                "switch", "turn_off", {ATTR_ENTITY_ID: targets}, blocking=True, context=call.context
            )

    async def async_restore(self, call: ServiceCall) -> None:
        remembered = self._remembered.pop(call.data["remember"], [])
        await self.async_save()
        targets = [e for e in remembered if self.hass.states.is_state(e, "off")]
        if targets:
            await self.hass.services.async_call(
                "switch", "turn_on", {ATTR_ENTITY_ID: targets}, blocking=True, context=call.context
            )

    def plug_info(self) -> list[dict[str, Any]]:
        area_reg = ar.async_get(self.hass)
        result = []
        for plug in sorted(self.plugs.values(), key=lambda p: p.name):
            area = area_reg.async_get_area(plug.area_id) if plug.area_id else None
            result.append(
                {
                    "entity_id": plug.entity_id,
                    "device_id": plug.device_id,
                    "name": plug.name,
                    "area_id": plug.area_id,
                    "area": area.name if area else None,
                    "mode": plug.mode,
                    "power_entity": plug.power_entity,
                    "energy_entity": plug.energy_entity,
                    "watts": plug.watts,
                    "keep_on": plug.keep_on,
                    "night": LABEL_NIGHT in plug.labels,
                }
            )
        return result


async def async_setup(hass: HomeAssistant, config: ConfigType) -> bool:
    """在 configuration.yaml 寫一行 power_hub: 就會啟用。"""
    hub = PowerHub(hass)
    await hub.async_load()
    hass.data[DOMAIN] = hub
    hub.rescan()

    for event_type in (
        er.EVENT_ENTITY_REGISTRY_UPDATED,
        dr.EVENT_DEVICE_REGISTRY_UPDATED,
        lr.EVENT_LABEL_REGISTRY_UPDATED,
        ar.EVENT_AREA_REGISTRY_UPDATED,
        EVENT_HOMEASSISTANT_STARTED,
    ):
        hass.bus.async_listen(event_type, hub.request_rescan)
    # 斷線時間、新發現的裝置、估算用電都需要定期更新
    async_track_time_interval(hass, hub.update, timedelta(minutes=1))

    async def _on_stop(_event: Event) -> None:
        hub._accrue_estimates()  # noqa: SLF001
        await hub.async_save()

    hass.bus.async_listen_once(EVENT_HOMEASSISTANT_STOP, _on_stop)

    hass.services.async_register(DOMAIN, "turn_off", hub.async_turn_off, schema=TURN_OFF_SCHEMA)
    hass.services.async_register(DOMAIN, "restore", hub.async_restore, schema=RESTORE_SCHEMA)

    async def _rescan(_call: ServiceCall) -> None:
        hub.rescan()

    hass.services.async_register(DOMAIN, "rescan", _rescan)

    hass.async_create_task(async_load_platform(hass, Platform.SENSOR, DOMAIN, {}, config))
    return True

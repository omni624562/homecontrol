"""Power Hub 的感測器：總功率、累計用電、斷線、待機、功率過高、新發現的裝置、插座清單。"""

from __future__ import annotations

from typing import Any

from homeassistant.components.sensor import (
    SensorDeviceClass,
    SensorEntity,
    SensorStateClass,
)
from homeassistant.const import UnitOfEnergy, UnitOfPower
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.dispatcher import async_dispatcher_connect
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.typing import ConfigType, DiscoveryInfoType

from . import DOMAIN, SIGNAL_UPDATE, PowerHub


async def async_setup_platform(
    hass: HomeAssistant,
    config: ConfigType,
    async_add_entities: AddEntitiesCallback,
    discovery_info: DiscoveryInfoType | None = None,
) -> None:
    hub: PowerHub = hass.data[DOMAIN]
    async_add_entities(
        [
            PowerSensor(hub),
            EnergySensor(hub),
            OfflineSensor(hub),
            StandbySensor(hub),
            OverloadSensor(hub),
            DiscoveredSensor(hub),
            PlugsSensor(hub),
        ]
    )


class HubSensor(SensorEntity):
    """跟著 PowerHub 更新的感測器。實體 ID 固定，名稱用中文。"""

    _attr_should_poll = False
    key: str

    def __init__(self, hub: PowerHub) -> None:
        self.hub = hub
        self._attr_unique_id = f"{DOMAIN}_{self.key}"
        self.entity_id = f"sensor.plugs_{self.key}"

    async def async_added_to_hass(self) -> None:
        await super().async_added_to_hass()
        self.async_on_remove(
            async_dispatcher_connect(self.hass, SIGNAL_UPDATE, self._handle_update)
        )
        self._handle_update()

    @callback
    def _handle_update(self) -> None:
        self.async_write_ha_state()


class PowerSensor(HubSensor):
    key = "power"
    _attr_name = "插座總功率"
    _attr_icon = "mdi:flash"
    _attr_device_class = SensorDeviceClass.POWER
    _attr_state_class = SensorStateClass.MEASUREMENT
    _attr_native_unit_of_measurement = UnitOfPower.WATT

    @property
    def native_value(self) -> float:
        return self.hub.status.power


class EnergySensor(HubSensor):
    """所有插座的累計用電（有計量的實際值 + 估算值），只會增加不會減少。"""

    key = "energy_total"
    _attr_name = "插座累計用電"
    _attr_icon = "mdi:lightning-bolt"
    _attr_device_class = SensorDeviceClass.ENERGY
    _attr_state_class = SensorStateClass.TOTAL_INCREASING
    _attr_native_unit_of_measurement = UnitOfEnergy.KILO_WATT_HOUR
    _attr_suggested_display_precision = 2

    @property
    def native_value(self) -> float:
        return round(self.hub.energy_total, 4)


class ListSensor(HubSensor):
    """數量當狀態，名稱放在 names 屬性。"""

    _attr_state_class = SensorStateClass.MEASUREMENT

    def items(self) -> list[str]:
        raise NotImplementedError

    @property
    def native_value(self) -> int:
        return len(self.items())

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        return {"names": self.items()}


class OfflineSensor(ListSensor):
    key = "offline"
    _attr_name = "斷線插座"
    _attr_icon = "mdi:power-plug-off-outline"

    def items(self) -> list[str]:
        return [p.name for p in self.hub.status.offline]


class StandbySensor(ListSensor):
    key = "standby"
    _attr_name = "待機中的插座"
    _attr_icon = "mdi:power-sleep"

    def items(self) -> list[str]:
        return [f"{p.name} {w:g} W" for p, w in self.hub.status.standby]


class OverloadSensor(ListSensor):
    key = "overload"
    _attr_name = "功率過高的插座"
    _attr_icon = "mdi:flash-alert"

    def items(self) -> list[str]:
        return [f"{name} {round(w)} W" for name, w in self.hub.status.overload]


class DiscoveredSensor(ListSensor):
    key = "discovered"
    _attr_name = "區網發現的新裝置"
    _attr_icon = "mdi:access-point-network"

    def items(self) -> list[str]:
        return self.hub.status.discovered


class PlugsSensor(HubSensor):
    """自動偵測到的插座數量；plugs 屬性是完整清單，儀表板靠它排版。"""

    key = "managed"
    _attr_name = "偵測到的插座"
    _attr_icon = "mdi:power-socket"
    _unrecorded_attributes = frozenset({"plugs"})

    @property
    def native_value(self) -> int:
        return len(self.hub.plugs)

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        return {"plugs": self.hub.plug_info()}

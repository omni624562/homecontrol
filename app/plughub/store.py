"""設定和用電紀錄的儲存。

- store.json：房間、插座設定（名稱、房間、常開、夜間關閉、估算瓦數）、順序、排程、門檻
- energy.db：每個插座每天的用電（度），用 SQLite 存

設定都很小，整份讀進記憶體，改了就整份寫回去（先寫暫存檔再改名，斷電也不會寫壞）。
"""

from __future__ import annotations

import json
import os
import sqlite3
import uuid
from copy import deepcopy
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Any

DEFAULTS: dict[str, Any] = {
    "rooms": [],  # [{"id", "name", "icon"}]，清單順序就是顯示順序
    "plugs": {},  # 插座 ID → PlugMeta
    "plug_order": [],
    "schedule": {"enabled": False, "night_off": "23:00", "morning_on": "07:00"},
    "settings": {
        "household_monthly_kwh": 300.0,  # 電費單上的每月度數，用來決定電價級距
        "standby_watts": 5.0,  # 開著但低於這個瓦數 = 待機
        "overload_watts": 1500.0,  # 超過這個瓦數持續 1 分鐘就通知
        "ntfy_topic": "",  # 有填就用 ntfy 推播通知
        "long_on_hours": 6.0,  # 開超過這麼久就在畫面上提醒（常開的不算）
    },
    # 關閉時記住關了哪些，之後可以還原：
    #   {"night": [插座 ID...]}（被關掉的）或 {"undo": {插座 ID: 原本開著嗎}}
    "remembered": {},
    "on_since": {},  # 插座 ID → 從什麼時候開著（epoch 秒）
    "timers": {},  # 插座 ID → 什麼時候自動關閉（epoch 秒）
    # 情境：[{"id", "name", "icon", "actions": {插座 ID: "on"/"off"/"keep"}, "others": "keep"/"off"}]
    # others：actions 裡沒有的插座（之後新找到的）要怎麼做。None = 還沒建立預設情境
    "scenes": None,
    # 排程：[{"id", "enabled", "time": "HH:MM:SS", "days": [0-6，0 = 星期一],
    #         "action": "scene"/"on"/"off", "scene": 情境 ID, "plugs": [插座 ID...],
    #         "restore_at": "HH:MM:SS" 或 None（關閉之後幾點再打開被它關掉的）}]
    # None = 還沒從舊版的夜間排程轉過來
    "schedules": None,
}


@dataclass
class PlugMeta:
    name: str | None = None  # 自訂名稱；None 用插座本身的名稱
    room: str | None = None
    keep_on: bool = False
    night: bool = False
    watts: float | None = None  # 沒有計量的插座，用這個瓦數估算用電
    # 最長開啟時間（分鐘）：澆水、電暖器這類開太久會出事的。不管從哪裡打開
    # （App、Google Home、排程、情境、插座上的按鈕），時間到一定關掉，不能取消。
    max_on: float | None = None

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "PlugMeta":
        known = {k: data[k] for k in cls.__dataclass_fields__ if k in data}
        return cls(**known)


class Store:
    def __init__(self, data_dir: Path) -> None:
        self.dir = data_dir
        self.dir.mkdir(parents=True, exist_ok=True)
        self.path = self.dir / "store.json"
        self.data = deepcopy(DEFAULTS)
        if self.path.exists():
            loaded = json.loads(self.path.read_text("utf-8"))
            for key, value in loaded.items():
                if isinstance(value, dict) and isinstance(self.data.get(key), dict) and key != "plugs":
                    self.data[key].update(value)
                else:
                    self.data[key] = value
        self.plugs: dict[str, PlugMeta] = {
            pid: PlugMeta.from_dict(meta) for pid, meta in self.data["plugs"].items()
        }
        self.energy = EnergyLog(self.dir / "energy.db")
        if self.data["schedules"] is None:
            self._migrate_schedule()
        # 舊資料只到分鐘（"HH:MM"），補上秒
        for sched in self.schedules:
            sched["time"] = _hms(sched.get("time")) or "23:00:00"
            sched["restore_at"] = _hms(sched.get("restore_at")) if sched.get("restore_at") else None

    def _migrate_schedule(self) -> None:
        """舊版只有一組夜間排程（勾選的插座晚上關、早上開），轉成新的排程清單。"""
        old = self.data.get("schedule") or {}
        night = [pid for pid, meta in self.plugs.items() if meta.night]
        self.data["schedules"] = []
        if night or old.get("enabled"):
            self.data["schedules"].append({
                "id": uuid.uuid4().hex[:8],
                "enabled": bool(old.get("enabled")),
                "time": old.get("night_off", "23:00"),
                "days": list(range(7)),
                "action": "off",
                "scene": None,
                "plugs": night,
                "restore_at": old.get("morning_on", "07:00"),
            })
        self.save()

    def save(self) -> None:
        self.data["plugs"] = {pid: asdict(meta) for pid, meta in self.plugs.items()}
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self.data, ensure_ascii=False, indent=2), "utf-8")
        os.replace(tmp, self.path)

    # ---- 房間 ----

    @property
    def rooms(self) -> list[dict[str, Any]]:
        return self.data["rooms"]

    def room(self, room_id: str | None) -> dict[str, Any] | None:
        return next((r for r in self.rooms if r["id"] == room_id), None)

    def add_room(self, name: str, icon: str | None = None) -> dict[str, Any]:
        room = {"id": uuid.uuid4().hex[:8], "name": name.strip(), "icon": icon or guess_icon(name)}
        self.rooms.append(room)
        self.save()
        return room

    def delete_room(self, room_id: str) -> None:
        self.data["rooms"] = [r for r in self.rooms if r["id"] != room_id]
        for meta in self.plugs.values():
            if meta.room == room_id:
                meta.room = None
        self.save()

    # ---- 情境 ----

    @property
    def scenes(self) -> list[dict[str, Any]]:
        return self.data["scenes"] or []

    def scene(self, scene_id: str) -> dict[str, Any] | None:
        return next((s for s in self.scenes if s["id"] == scene_id), None)

    def save_scene(self, scene_id: str | None, name: str, icon: str, actions: dict[str, str], others: str) -> dict[str, Any]:
        clean = {pid: a for pid, a in actions.items() if a in ("on", "off", "keep")}
        others = others if others in ("keep", "off") else "keep"
        scene = self.scene(scene_id) if scene_id else None
        if scene is None:
            scene = {"id": uuid.uuid4().hex[:8]}
            self.data["scenes"] = [*self.scenes, scene]
        scene.update(name=name.strip()[:20], icon=icon or "mdi:star-outline", actions=clean, others=others)
        self.save()
        return scene

    def delete_scene(self, scene_id: str) -> None:
        self.data["scenes"] = [s for s in self.scenes if s["id"] != scene_id]
        self.save()

    # ---- 排程 ----

    @property
    def schedules(self) -> list[dict[str, Any]]:
        return self.data["schedules"] or []

    def save_schedule(self, sched_id: str | None, body: dict[str, Any]) -> dict[str, Any]:
        sched = next((x for x in self.schedules if x["id"] == sched_id), None) if sched_id else None
        if sched is None:
            if sched_id:
                raise KeyError(sched_id)
            sched = {"id": uuid.uuid4().hex[:8], "enabled": True, "time": "23:00:00", "days": list(range(7)),
                     "action": "off", "scene": None, "plugs": [], "restore_at": None}
            self.data["schedules"] = [*self.schedules, sched]
        if "enabled" in body:
            sched["enabled"] = bool(body["enabled"])
        if "time" in body and _hms(body["time"]):
            sched["time"] = _hms(body["time"])
        if "days" in body:
            sched["days"] = sorted({int(d) for d in body["days"] if 0 <= int(d) <= 6})
        if body.get("action") in ("scene", "on", "off"):
            sched["action"] = body["action"]
        if "scene" in body:
            sched["scene"] = body["scene"] if self.scene(body["scene"]) else None
        if "plugs" in body:
            sched["plugs"] = list(dict.fromkeys(str(p) for p in body["plugs"]))
        if "restore_at" in body:
            sched["restore_at"] = _hms(body["restore_at"]) if body["restore_at"] else None
        self.save()
        return sched

    def delete_schedule(self, sched_id: str) -> None:
        self.data["schedules"] = [x for x in self.schedules if x["id"] != sched_id]
        self.save()

    def meta(self, plug_id: str) -> PlugMeta:
        if plug_id not in self.plugs:
            self.plugs[plug_id] = PlugMeta()
        return self.plugs[plug_id]


# 房間名稱 → 圖示，猜不到就用房子
ROOM_ICONS = [
    (("客廳", "起居"), "mdi:sofa"),
    (("廚房",), "mdi:stove"),
    (("餐",), "mdi:silverware-fork-knife"),
    (("主臥", "臥室", "房間", "寢"), "mdi:bed"),
    (("小孩", "兒童", "孩"), "mdi:teddy-bear"),
    (("書房", "辦公", "工作"), "mdi:desk"),
    (("浴", "廁", "洗手"), "mdi:shower"),
    (("陽台", "露台", "院"), "mdi:flower"),
    (("車庫",), "mdi:garage"),
    (("玄關", "門口"), "mdi:door"),
    (("洗衣",), "mdi:washing-machine"),
]


def _hms(value: Any) -> str | None:
    """"7:5"、"07:05"、"07:05:30" → "07:05:00"、"07:05:30"；不合法就 None。"""
    try:
        parts = [int(x) for x in str(value).split(":")]
    except (ValueError, TypeError):
        return None
    if len(parts) == 2:
        parts.append(0)
    if len(parts) != 3:
        return None
    h, m, sec = parts
    return f"{h:02d}:{m:02d}:{sec:02d}" if 0 <= h < 24 and 0 <= m < 60 and 0 <= sec < 60 else None


def guess_icon(name: str) -> str:
    for words, icon in ROOM_ICONS:
        if any(w in name for w in words):
            return icon
    return "mdi:home-outline"


class EnergyLog:
    """每個插座每天用了幾度電。"""

    def __init__(self, path: Path) -> None:
        self.db = sqlite3.connect(path, check_same_thread=False)
        self.db.execute(
            "CREATE TABLE IF NOT EXISTS daily (day TEXT, plug TEXT, kwh REAL, PRIMARY KEY (day, plug))"
        )
        self.db.commit()
        self._pending: dict[tuple[str, str], float] = {}

    def add(self, day: str, plug: str, kwh: float) -> None:
        if kwh > 0:
            key = (day, plug)
            self._pending[key] = self._pending.get(key, 0.0) + kwh

    def flush(self) -> None:
        if not self._pending:
            return
        self.db.executemany(
            "INSERT INTO daily (day, plug, kwh) VALUES (?, ?, ?) "
            "ON CONFLICT (day, plug) DO UPDATE SET kwh = kwh + excluded.kwh",
            [(d, p, k) for (d, p), k in self._pending.items()],
        )
        self.db.commit()
        self._pending.clear()

    def total(self, since: str, until: str | None = None) -> float:
        """since～until（含）之間所有插座的用電，含還沒寫入的部分。"""
        until = until or "9999-12-31"
        row = self.db.execute(
            "SELECT COALESCE(SUM(kwh), 0) FROM daily WHERE day >= ? AND day <= ?", (since, until)
        ).fetchone()
        pending = sum(k for (d, _), k in self._pending.items() if since <= d <= until)
        return float(row[0]) + pending

    def per_day(self, since: str) -> dict[str, float]:
        rows = self.db.execute(
            "SELECT day, SUM(kwh) FROM daily WHERE day >= ? GROUP BY day", (since,)
        ).fetchall()
        result = {d: float(k) for d, k in rows}
        for (d, _), k in self._pending.items():
            if d >= since:
                result[d] = result.get(d, 0.0) + k
        return result

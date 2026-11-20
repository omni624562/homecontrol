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
        # 離家模式：這段時間裡，選的插座由插座自己隨機開關（假裝有人在家）
        "away": {"enabled": False, "start": "18:00", "end": "23:00", "plugs": []},
        "sensing": True,  # Wi-Fi 感測（實驗）：每 2 秒讀插座的訊號強度
        "habit_dismissed": [],  # 按了「不用」的排程建議
        # 讀路由器的連線裝置清單（SSH 金鑰登入，只讀）；host 空白 = 不用
        "router": {"host": "", "port": 22, "user": ""},
        "new_device_alert": True,  # 沒看過的裝置連上 Wi-Fi 就通知
        # 誰在家：最後一個人離開 / 第一個人回來時執行的情境（None = 不做事）；手機離線多久才算出門
        "presence": {"away_scene": None, "home_scene": None, "grace_min": 10},
    },
    # 路由器看過的裝置：MAC → {"first": 第一次看到, "label": 自己取的名字, "map": 放到訊號地圖}
    "net_devices": {},
    "net_seeded": False,  # 第一次讀到路由器清單時，把已經在的裝置都當作認得的（不通知）
    # 在家的人：[{"id","name","macs":[手機的 MAC...]}]
    "people": [],
    # 整個 Wi-Fi 網路的插座同時斷線（多半是路由器的問題）：[{"ssid","start","end","devices"}]，最近 30 筆
    "net_events": [],
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
    #         "duration_s": 打開後幾秒自動關閉 或 None,
    #         "restore_at": "HH:MM:SS" 或 None（關閉之後幾點再打開被它關掉的）}]
    # None = 還沒從舊版的夜間排程轉過來
    "schedules": None,
    # 訊號地圖：rooms = [{"id","name","x","y","w","h"}]（座標 0～w／0～h）、
    # items = {裝置 MAC 或 "ap:編號": {"x","y"}}、aps = [{"id","name"}]（Wi-Fi 基地台）、
    # image = 平面圖底圖的版本（None = 沒有）
    "floorplan": {"w": 1000, "h": 700, "meters": 12, "rooms": None, "items": {}, "aps": [], "image": None},
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
    max_on_s: float | None = None  # 秒
    # 防呆："" = 不需要、"confirm_off" = 關閉前確認、"confirm" = 開關都確認、"lock" = 鎖定
    # 鎖定：App、Google Home、情境、排程、全部關閉都不能開關，要先在裝置詳細解鎖
    protect: str = ""
    matter: bool = True  # 讓 Google Home（Matter）控制
    # 高風險電器（電暖器、熨斗…）：最後一個人出門就馬上關掉並緊急通知，不等 10 分鐘
    risky: bool = False

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "PlugMeta":
        if data.get("max_on") and "max_on_s" not in data:  # 舊版用分鐘
            data = {**data, "max_on_s": float(data["max_on"]) * 60}
        known = {k: data[k] for k in cls.__dataclass_fields__ if k in data}
        return cls(**known)


class Store:
    def __init__(self, data_dir: Path) -> None:
        self.dir = data_dir
        self.dir.mkdir(parents=True, exist_ok=True)
        self.path = self.dir / "store.json"
        self.sched_skip = None  # hub 設定：排程 → 接下來 7 天要跳過的星期
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
            sched.setdefault("duration_s", None)
            sched.setdefault("backup", True)
            sched.setdefault("time_mode", "clock")
            sched.setdefault("offset_min", 0)

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
                     "action": "off", "scene": None, "plugs": [], "restore_at": None, "duration_s": None, "backup": True,
                     "time_mode": "clock", "offset_min": 0}
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
        if body.get("time_mode") in ("clock", "sunrise", "sunset"):  # 固定時間／日出／日落
            sched["time_mode"] = body["time_mode"]
        if "offset_min" in body:  # 日出日落提早（負）或延後（正）幾分鐘
            try:
                sched["offset_min"] = max(-180, min(180, int(body["offset_min"] or 0)))
            except (TypeError, ValueError):
                pass
        for key in ("skip_holiday", "skip_rain"):  # 國定假日不執行、下雨不執行
            if key in body:
                sched[key] = bool(body[key])
        if "backup" in body:  # 樹莓派離線時由插座接手（寫一份到插座）
            sched["backup"] = bool(body["backup"])
        if "duration_s" in body:  # 打開之後多久自動關閉（秒）
            try:
                dur = int(body["duration_s"] or 0)
            except (TypeError, ValueError):
                dur = 0
            sched["duration_s"] = dur if 0 < dur <= 24 * 3600 else None
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
        # 開關紀錄（找習慣用）：source = app／matter（Google Home）／button（插座上的按鈕或 Kasa App）／auto（排程、情境、定時）
        self.db.execute("CREATE TABLE IF NOT EXISTS switch (ts REAL, plug TEXT, is_on INTEGER, source TEXT)")
        self.db.execute("CREATE INDEX IF NOT EXISTS switch_ts ON switch (ts)")
        # Wi-Fi 感測的每分鐘摘要（平均訊號、最大擾動），留 30 天
        self.db.execute("CREATE TABLE IF NOT EXISTS sense_min (ts INTEGER, key TEXT, rssi REAL, motion REAL)")
        self.db.execute("CREATE INDEX IF NOT EXISTS sense_min_ts ON sense_min (ts)")
        # 用電異常（anomaly.py）：計量插座每天開著時量到的最低功率（待機有沒有變高）
        self.db.execute("CREATE TABLE IF NOT EXISTS power_floor (day TEXT, plug TEXT, w REAL, PRIMARY KEY (day, plug))")
        self.db.commit()
        self._sense_pruned = 0.0
        self._floor: dict[tuple[str, str], float] = {}

    SENSE_KEEP_DAYS = 30

    def add_sense(self, rows: list[tuple[int, str, float, float | None]]) -> None:
        if not rows:
            return
        self.db.executemany("INSERT INTO sense_min VALUES (?, ?, ?, ?)", rows)
        if rows[0][0] - self._sense_pruned > 3600:
            self._sense_pruned = rows[0][0]
            self.db.execute("DELETE FROM sense_min WHERE ts < ?", (rows[0][0] - self.SENSE_KEEP_DAYS * 86400,))
        self.db.commit()

    def sense_buckets(self, since: int, bucket: int) -> dict[str, dict[int, tuple[float, float | None]]]:
        """since 之後，每 bucket 秒一格：裝置 → {格子: (平均訊號, 最大擾動)}。"""
        rows = self.db.execute(
            "SELECT key, (ts - ?) / ? AS b, AVG(rssi), MAX(motion) FROM sense_min WHERE ts >= ? GROUP BY key, b",
            (since, bucket, since),
        ).fetchall()
        out: dict[str, dict[int, tuple[float, float | None]]] = {}
        for key, b, rssi, motion in rows:
            out.setdefault(key, {})[int(b)] = (rssi, motion)
        return out

    def sense_first(self) -> int | None:
        row = self.db.execute("SELECT MIN(ts) FROM sense_min").fetchone()
        return int(row[0]) if row and row[0] is not None else None

    def log_switch(self, ts: float, plug: str, on: bool, source: str) -> None:
        self.db.execute("INSERT INTO switch VALUES (?, ?, ?, ?)", (ts, plug, int(on), source))
        self.db.execute("DELETE FROM switch WHERE ts < ?", (ts - 60 * 86400,))  # 只留 60 天
        self.db.commit()

    def switches(self, since: float) -> list[tuple[float, str, bool, str]]:
        rows = self.db.execute("SELECT ts, plug, is_on, source FROM switch WHERE ts >= ? ORDER BY ts", (since,)).fetchall()
        return [(float(t), p, bool(o), s) for t, p, o, s in rows]

    def first_switch(self) -> float | None:
        row = self.db.execute("SELECT MIN(ts) FROM switch").fetchone()
        return float(row[0]) if row and row[0] is not None else None

    def add(self, day: str, plug: str, kwh: float) -> None:
        if kwh > 0:
            key = (day, plug)
            self._pending[key] = self._pending.get(key, 0.0) + kwh

    def add_floor(self, day: str, plug: str, watts: float) -> None:
        key = (day, plug)
        if watts < self._floor.get(key, float("inf")):
            self._floor[key] = watts

    def floors(self, since: str) -> dict[str, dict[str, float]]:
        rows = self.db.execute("SELECT day, plug, w FROM power_floor WHERE day >= ?", (since,)).fetchall()
        out: dict[str, dict[str, float]] = {}
        for d, p, w in rows:
            out.setdefault(p, {})[d] = float(w)
        for (d, p), w in self._floor.items():
            if d >= since:
                out.setdefault(p, {})[d] = min(w, out.get(p, {}).get(d, w))
        return out

    def per_plug(self, since: str) -> tuple[dict[str, dict[str, float]], dict[str, str]]:
        """since 之後每個插座每天的度數；以及每個插座第一次有紀錄的日期。"""
        out: dict[str, dict[str, float]] = {}
        for d, p, k in self.db.execute("SELECT day, plug, kwh FROM daily WHERE day >= ?", (since,)).fetchall():
            out.setdefault(p, {})[d] = float(k)
        for (d, p), k in self._pending.items():
            if d >= since:
                out.setdefault(p, {})[d] = out.get(p, {}).get(d, 0.0) + k
        first = {p: d for p, d in self.db.execute("SELECT plug, MIN(day) FROM daily GROUP BY plug").fetchall()}
        return out, first

    def flush(self) -> None:
        if self._floor:
            self.db.executemany(
                "INSERT INTO power_floor (day, plug, w) VALUES (?, ?, ?) "
                "ON CONFLICT (day, plug) DO UPDATE SET w = MIN(w, excluded.w)",
                [(d, p, w) for (d, p), w in self._floor.items()],
            )
            self.db.commit()
            self._floor.clear()
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

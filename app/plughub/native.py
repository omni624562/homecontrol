"""插座本身（韌體）的功能：內建排程、離家模式、使用時間、指示燈、重新啟動、雲端。

樹莓派是主要的大腦；重要的事也寫進插座，樹莓派離線時插座照樣會做：
- 排程：每個排程換算成插座的規則。插座的規則只到「分鐘」，一律往後取整（07:00:50 → 07:01），
  所以插座永遠比樹莓派晚、不會搶先。
  「租約」：樹莓派在線時，每條「打開」規則在執行前 2 分鐘先停用、過了 1 分鐘再啟用 ——
  樹莓派自己執行，插座的規則只在樹莓派離線（沒人去停用）時才會動作。
  「關閉」規則一直保持啟用：樹莓派在澆水途中當掉，插座照樣會關，比較安全。
  「打開」如果有「多久後關閉」或插座有「最長開啟時間」，會多寫一條關閉規則，離線時也一定會關。
  「之後再打開」要知道是誰關掉的，插座做不到，所以不寫進插座。
- 離家模式：插座內建的隨機開關（anti_theft），樹莓派離線也照跑。

只管理自己寫的規則，不動使用者在 Kasa App 自己設的。有些韌體（例如 KP303）不保存規則名稱，
所以「自己寫的」是用內容（動作、時間、星期）辨認：寫入時記在樹莓派上，之後比對。
"""

from __future__ import annotations

import asyncio
import logging
import time
from datetime import date, datetime, timedelta
from typing import Any

_LOGGER = logging.getLogger(__name__)

TAG = "homehub"
MAX_RULES = 30  # 插座最多大約 32 條規則，留一點給 Kasa App
LEASE_BEFORE = 120  # 執行前幾秒停用插座的「打開」規則
LEASE_AFTER = 60  # 執行後幾秒再啟用
CLOCK_TOLERANCE = 90  # 插座時鐘和樹莓派差超過這麼多秒，就不寫排程（以免在錯的時間動作）
TIMEOUT = 5

_SCHED_RULE = {"stime_opt": 0, "etime_opt": -1, "emin": 0, "eact": -1, "repeat": 1, "enable": 1,
               "year": 0, "month": 0, "day": 0, "longitude": 0, "latitude": 0, "force": 0}
_AWAY_RULE = {"stime_opt": 0, "etime_opt": 0, "repeat": 1, "enable": 1, "frequency": 5,
              "year": 0, "month": 0, "day": 0, "longitude": 0, "latitude": 0}


def context(device: Any, child_index: int | None) -> dict[str, Any]:
    """排插的孔要用插座回報的原始 ID（python-kasa 的 device_id 格式插座不接受）。"""
    if child_index is None:
        return {}
    return {"context": {"child_ids": [device.sys_info["children"][child_index]["id"]]}}


def supported(device: Any) -> bool:
    return hasattr(device, "sys_info") and hasattr(device, "protocol")  # Kasa（IOT）插座


async def query(device: Any, ctx: dict[str, Any], module: str, method: str, params: dict | None = None) -> dict:
    res = await asyncio.wait_for(device.protocol.query({**ctx, module: {method: params or {}}}), TIMEOUT)
    body = res.get(module, {}).get(method, {})
    if body.get("err_code", 0) != 0:
        raise RuntimeError(f"{module}.{method}：{body.get('err_msg') or body.get('err_code')}")
    return body


# ---------- 排程 → 插座規則 ----------

def _kasa_wday(days: list[int]) -> list[int]:
    """我們的 0 = 星期一；插座的 wday 從星期日開始。"""
    out = [0] * 7
    for d in days:
        out[(d + 1) % 7] = 1
    return out


def _round_up(total_seconds: int, days: list[int]) -> tuple[int, list[int]]:
    """往後取整到分鐘；跨過午夜的話星期幾也跟著往後一天。"""
    minutes = -(-total_seconds // 60)
    shift, minutes = divmod(minutes, 1440)
    return minutes, [(d + shift) % 7 for d in days]


def _seconds(hms: str) -> int:
    h, m, s = (int(x) for x in hms.split(":"))
    return h * 3600 + m * 60 + s


# 規則的「鍵」：(動作 1 開／0 關, 時間方式 0 固定／1 日出／2 日落, 值, 星期)
#   固定時間：值 = 第幾分鐘；日出日落：值 = 提早（負）／延後（正）幾分鐘
Key = tuple


def dev_key(r: dict[str, Any]) -> Key:
    """插座回報的規則 → 鍵。"""
    opt = int(r.get("stime_opt") or 0)
    val = r.get("smin") if opt == 0 else (r.get("soffset") or 0)
    return (r.get("sact"), opt, val, tuple(r.get("wday", [])))


def known_key(k: list) -> Key:
    """存在 store 裡的記錄 → 鍵（舊格式只有 [動作, 分鐘, 星期]）。"""
    if len(k) == 3:
        return (k[0], 0, k[1], tuple(k[2]))
    return (k[0], k[1], k[2], tuple(k[3]))


def rule_dict(r: dict[str, Any]) -> dict[str, Any]:
    act, opt, val, wday = dev_key(r)
    return {"sact": act, "opt": opt, "val": val, "smin": r.get("smin"), "wday": list(wday), "enable": r.get("enable", 1)}


def schedule_rules(store: Any, plug_id: str, only: list | None = None) -> list[Key]:
    """這個插座應該有的排程規則（鍵）。only：只算這幾個排程。"""
    meta = store.meta(plug_id)
    rules: list[Key] = []
    if meta.protect == "lock":  # 鎖定的插座不寫排程（插座自己執行時不會檢查鎖定）
        return rules

    def add(rule: Key) -> None:
        if rule not in rules:
            rules.append(rule)

    for sched in (only if only is not None else store.schedules):
        if not sched.get("enabled") or not sched.get("days") or sched.get("backup") is False:
            continue
        if sched["action"] == "scene":
            scene = store.scene(sched.get("scene") or "")
            if not scene:
                continue
            act = scene["actions"].get(plug_id, scene.get("others", "keep"))
            duration = None
        elif plug_id in sched["plugs"]:
            act = sched["action"]
            duration = sched.get("duration_s") if act == "on" else None
        else:
            continue
        if act not in ("on", "off") or (act == "off" and meta.keep_on):
            continue
        limits = [x for x in (duration, meta.max_on_s) if x] if act == "on" else []
        mode = sched.get("time_mode", "clock")
        if mode in ("sunrise", "sunset"):
            # 日出日落：插座自己每天算時間（離線好幾天也會跟著季節變）
            opt = 1 if mode == "sunrise" else 2
            offset = int(sched.get("offset_min") or 0)
            wday = tuple(_kasa_wday(sched["days"]))
            add((1 if act == "on" else 0, opt, offset, wday))
            if limits:  # 離線時也要關：往後取整到分鐘
                add((0, opt, offset + -(-int(min(limits)) // 60), wday))
        else:
            total = _seconds(sched["time"])
            smin, ds = _round_up(total, sched["days"])
            add((1 if act == "on" else 0, 0, smin, tuple(_kasa_wday(ds))))
            if limits:
                smin, ds = _round_up(total + int(min(limits)), sched["days"])
                add((0, 0, smin, tuple(_kasa_wday(ds))))
    return rules


def schedule_plugs(store: Any, sched: dict[str, Any]) -> list[str]:
    """這個排程會動到哪些插座（情境要展開）。"""
    if sched["action"] != "scene":
        return list(sched.get("plugs", []))
    scene = store.scene(sched.get("scene") or "")
    if not scene:
        return []
    out = [pid for pid, act in scene["actions"].items() if act != "keep"]
    if scene.get("others", "keep") != "keep":
        out += [pid for pid in store.plugs if pid not in scene["actions"]]
    return out


def away_rule(store: Any, plug_id: str) -> tuple[int, int] | None:
    away = store.data["settings"].get("away") or {}
    meta = store.meta(plug_id)
    if not away.get("enabled") or plug_id not in away.get("plugs", []) or meta.keep_on or meta.max_on_s or meta.protect == "lock":
        return None
    start = _seconds(away.get("start", "18:00") + ":00") // 60
    end = _seconds(away.get("end", "23:00") + ":00") // 60
    return start, end


async def clock_skew(device: Any) -> float:
    t = await query(device, {}, "time", "get_time")
    dev = datetime(t["year"], t["month"], t["mday"], t["hour"], t["min"], t["sec"])
    return abs((dev - datetime.now()).total_seconds())


def away_fp(r: dict[str, Any]) -> list:
    return [r.get("smin"), r.get("emin")]


def _mine(rules: list[dict], known: list, fp: Any) -> list[dict]:
    """自己寫的規則：內容在記錄裡，或名稱是 homehub（有保存名稱的韌體）。"""
    out, pool = [], [list(k) for k in known]
    for r in rules:
        f = fp(r)
        if f in pool:
            pool.remove(f)
            out.append(r)
        elif str(r.get("name", "")).startswith(TAG):
            out.append(r)
    return out


def _mine_sched(rules: list[dict], known: list) -> list[dict]:
    """自己寫的排程規則：內容在記錄裡，或名稱是 homehub。"""
    out, pool = [], [known_key(k) for k in known]
    for r in rules:
        k = dev_key(r)
        if k in pool:
            pool.remove(k)
            out.append(r)
        elif str(r.get("name", "")).startswith(TAG):
            out.append(r)
    return out


async def sync_rules(device: Any, ctx: dict[str, Any], schedule: list, away: tuple[int, int] | None,
                     known: dict[str, list]) -> dict[str, Any]:
    """把插座上自己寫的規則改成想要的樣子；一樣的話不動。

    known：上次寫入的內容 {"schedule": [...], "away": [...]}，回傳新的（呼叫的人要存起來）。
    """
    # 排程（停用中的也算：那是租約暫時停用的）
    cur = (await query(device, ctx, "schedule", "get_rules")).get("rule_list", [])
    mine = _mine_sched(cur, known.get("schedule", []))
    have = sorted(dev_key(r) for r in mine)
    want = sorted(schedule)
    room = MAX_RULES - (len(cur) - len(mine))
    written = want[:room]
    if written != have:
        for r in mine:
            await query(device, ctx, "schedule", "delete_rule", {"id": r["id"]})
        for act, opt, val, wday in written:
            await query(device, ctx, "schedule", "add_rule", {
                **_SCHED_RULE, "name": TAG, "sact": act, "stime_opt": opt,
                "smin": val if opt == 0 else 0, "soffset": val if opt else 0, "wday": list(wday)})
        if written:
            await query(device, ctx, "schedule", "set_overall_enable", {"enable": 1})
    new_known = {"schedule": [[a, o, v, list(w)] for a, o, v, w in written]}
    cur = (await query(device, ctx, "schedule", "get_rules")).get("rule_list", [])
    mine = _mine_sched(cur, new_known["schedule"])
    others = [r for r in cur if r not in mine]
    # 離家模式
    cur_a = (await query(device, ctx, "anti_theft", "get_rules")).get("rule_list", [])
    mine_a = _mine(cur_a, known.get("away", []), away_fp)
    want_away = [list(away)] if away else []
    if [away_fp(r) for r in mine_a] != want_away:
        for r in mine_a:
            await query(device, ctx, "anti_theft", "delete_rule", {"id": r["id"]})
        if away:
            await query(device, ctx, "anti_theft", "add_rule",
                        {**_AWAY_RULE, "name": TAG, "smin": away[0], "emin": away[1], "wday": [1] * 7})
        rest = len(cur_a) - len(mine_a)
        await query(device, ctx, "anti_theft", "set_overall_enable", {"enable": 1 if (away or rest) else 0})
    new_known["away"] = want_away
    rules = [rule_dict(r) for r in mine]
    # 使用者自己在 Kasa App 設的排程（插座會自己執行，顯示在畫面上讓使用者知道）
    foreign = [{**rule_dict(r), "repeat": r.get("repeat", 1), "date": f"{r.get('year', 0):04d}-{r.get('month', 0):02d}-{r.get('day', 0):02d}" if not r.get("repeat", 1) else None}
               for r in others]
    return {"schedule": len(written), "away": 1 if away else 0, "rules": rules, "known": new_known, "kasa": foreign}


# ---------- 租約：樹莓派在線時，插座的「打開」規則在執行前後暫時停用 ----------

def lease_enabled(rule: dict[str, Any], now: datetime, sun_min: Any) -> bool:
    """這條規則現在應不應該啟用。關閉規則一直啟用；打開規則在執行前後的時段停用。

    sun_min(opt, day) → 那天日出（1）／日落（2）是第幾分鐘。日出日落的時段放寬（插座和樹莓派算的可能差 1～2 分鐘）。
    """
    if rule.get("sact") != 1:
        return True
    opt = rule.get("opt", 0)
    before, after = (LEASE_BEFORE, LEASE_AFTER) if opt == 0 else (300, 300)
    for offset in (-1, 0, 1):
        day = now.date() + timedelta(days=offset)
        if not rule["wday"][(day.weekday() + 1) % 7]:
            continue
        if opt == 0:
            minute = rule["val"]
        else:
            base = sun_min(opt, day)
            minute = (base + rule["val"]) if base is not None else rule.get("smin") or 0
        fire = datetime.combine(day, datetime.min.time()) + timedelta(minutes=minute)
        if -after <= (fire - now).total_seconds() <= before:
            return False
    return True


def _rule_body(key: Key, enable: Any, extra: dict | None = None) -> dict[str, Any]:
    act, opt, val, wday = key
    return {**_SCHED_RULE, **(extra or {}), "sact": act, "stime_opt": opt, "smin": val if opt == 0 else (extra or {}).get("smin", 0),
            "soffset": val if opt else 0, "wday": list(wday), "enable": 1 if enable else 0}


async def _find(device: Any, ctx: dict[str, Any], key: Key, foreign: bool) -> dict[str, Any]:
    cur = (await query(device, ctx, "schedule", "get_rules")).get("rule_list", [])
    for r in cur:
        if dev_key(r) == key and (not foreign or not str(r.get("name", "")).startswith(TAG)):
            return r
    raise RuntimeError("插座上找不到這條排程，可能已經被改過")


async def set_rule_enabled(device: Any, ctx: dict[str, Any], rule: dict[str, Any], enable: bool) -> None:
    """先重新讀插座的規則，用內容找到自己那條再改（有些韌體的 ID 會變，不能直接用舊 ID）。"""
    key = (rule["sact"], rule["opt"], rule["val"], tuple(rule["wday"]))
    target = await _find(device, ctx, key, foreign=False)
    await query(device, ctx, "schedule", "edit_rule", {**_rule_body(key, enable, {"name": TAG}), "id": target["id"]})
    rule["enable"] = 1 if enable else 0


async def delete_foreign(device: Any, ctx: dict[str, Any], key: Key) -> None:
    """刪除使用者在 Kasa App 設的一條排程。用內容找，找不到就報錯。"""
    target = await _find(device, ctx, key, foreign=True)
    await query(device, ctx, "schedule", "delete_rule", {"id": target["id"]})


async def edit_foreign(device: Any, ctx: dict[str, Any], key: Key, new_key: Key, enable: bool) -> dict[str, Any]:
    """直接修改插座裡一條 Kasa App 設的排程，保留名稱等其他欄位。"""
    target = await _find(device, ctx, key, foreign=True)
    keep = {k: v for k, v in target.items() if k not in ("id", "sact", "stime_opt", "smin", "soffset", "wday", "enable")}
    body = _rule_body(new_key, enable, keep)
    await query(device, ctx, "schedule", "edit_rule", {**body, "id": target["id"]})
    if enable:
        await query(device, ctx, "schedule", "set_overall_enable", {"enable": 1})
    return body


# ---------- 使用時間（插座自己記錄的每天開了幾分鐘）----------

async def usage(device: Any, ctx: dict[str, Any], days: int = 14) -> dict[str, Any]:
    today = date.today()
    months = {(today.year, today.month)}
    first = today - timedelta(days=days - 1)
    months.add((first.year, first.month))
    per_day: dict[str, int] = {}
    for year, month in sorted(months):
        body = await query(device, ctx, "schedule", "get_daystat", {"year": year, "month": month})
        for d in body.get("day_list", []):
            per_day[f"{d['year']:04d}-{d['month']:02d}-{d['day']:02d}"] = int(d.get("time", 0))
    series = [{"day": (first + timedelta(days=i)).isoformat(), "minutes": per_day.get((first + timedelta(days=i)).isoformat(), 0)}
              for i in range(days)]
    month_total = sum(v for k, v in per_day.items() if k.startswith(f"{today.year:04d}-{today.month:02d}"))
    return {"today": per_day.get(today.isoformat(), 0), "month": month_total, "days": series}


# ---------- 雲端 ----------

async def cloud_unbind(device: Any) -> None:
    await query(device, {}, "cnCloud", "unbind")


def now() -> float:
    return time.time()

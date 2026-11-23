"""每天、每月的例行判斷：電費級距提醒、每月報告、晚安檢查、離家模式自動開關、插座連線健檢。

這裡只放判斷用的小函式（好測試）；狀態、通知在 hub.py。
"""
from __future__ import annotations

from datetime import date, datetime, timedelta
from typing import Any, Iterable

from . import tariff

TIER_MIN_DAY = 7  # 這個月過了幾天才預估（太早的預估不準）
DROPS_KEEP_DAYS = 30
DROPS_KEEP = 300
MASS_DROP_RATIO = 0.5  # 同一時間這麼多插座一起斷，算 Wi-Fi 或停電，不算插座自己的問題
MASS_DROP_WINDOW = 180  # 秒
WEAK_RSSI = -70  # dBm 以下算訊號弱
NIGHT_WINDOW_H = 3  # 晚安檢查時間過後幾小時內還會補做（例如樹莓派剛好在重開）
AWAY_AUTO_H = 4  # 大家出門超過幾小時，自動打開離家模式（預設）


def tier_index(kwh: float) -> int:
    for i, (lim, _, _) in enumerate(tariff.TIERS):
        if lim is None or kwh <= lim:
            return i
    return len(tariff.TIERS) - 1


def tier_alert(household: float, plug_proj: float, plug_last: float, day: int, today: date) -> dict[str, Any] | None:
    """這個月插座用電比上個月多，多出來的加到電費單的度數上，會不會跨到下一級電價。

    household：電費單上的每月度數（設定）；plug_proj：插座這個月預估度數；plug_last：上個月插座度數。
    """
    if day < TIER_MIN_DAY or plug_last <= 0 or household <= 0:
        return None
    extra = plug_proj - plug_last
    est = household + extra
    a, b = tier_index(household), tier_index(est)
    if b <= a:
        return None
    col = 1 if tariff.is_summer(today) else 2
    return {
        "est": round(est),
        "limit": tariff.TIERS[a][0],
        "extra": round(extra, 1),
        "from": tariff.TIERS[a][col],
        "to": tariff.TIERS[b][col],
    }


def prev_month(d: date) -> str:
    first = d.replace(day=1) - timedelta(days=1)
    return f"{first.year:04d}-{first.month:02d}"


def month_range(ym: str) -> tuple[float, float]:
    y, m = int(ym[:4]), int(ym[5:])
    start = datetime(y, m, 1)
    end = datetime(y + (m == 12), 1 if m == 12 else m + 1, 1)
    return start.timestamp(), end.timestamp()


def net_summary(events: Iterable[dict[str, Any]], start: float, end: float) -> dict[str, dict[str, float]]:
    """這段時間的斷線：每種幾次、總共多久（秒）。"""
    out: dict[str, dict[str, float]] = {}
    for e in events:
        s = e.get("start") or 0
        if not (start <= s < end):
            continue
        k = e.get("kind") or "wifi"
        o = out.setdefault(k, {"count": 0, "sec": 0.0})
        o["count"] += 1
        o["sec"] += max(0.0, (e.get("end") or s) - s)
    return out


def add_drop(drops: dict[str, list[list[float]]], pid: str, start: float, end: float) -> None:
    """記一次插座斷線（開始、結束），只留最近 30 天、最多 300 筆。"""
    lst = drops.setdefault(pid, [])
    lst.append([round(start), round(end)])
    cut = end - DROPS_KEEP_DAYS * 86400
    lst[:] = [x for x in lst if x[0] >= cut][-DROPS_KEEP:]


def plug_health(drops: dict[str, list[list[float]]], plugs: list[dict[str, Any]], now: float, days: int = 30) -> list[dict[str, Any]]:
    """插座連線健檢：每個插座最近斷了幾次、斷多久、訊號多強，給建議。

    plugs：[{"id", "name", "rssi", "online", "ssid"}]。很多插座同一時間一起斷的（Wi-Fi 或停電）不算在插座頭上。
    """
    since = now - days * 86400
    starts = sorted((x[0], pid) for pid, lst in drops.items() for x in lst if x[0] >= since)
    total = max(1, len(plugs))
    mass: set[tuple[float, str]] = set()
    for i, (t, _) in enumerate(starts):
        near = {p for tt, p in starts if abs(tt - t) <= MASS_DROP_WINDOW}
        if len(near) >= max(2, total * MASS_DROP_RATIO):
            mass.add(starts[i])
    out = []
    for p in plugs:
        own = [x for x in drops.get(p["id"], []) if x[0] >= since and (x[0], p["id"]) not in mass]
        sec = sum(max(0, x[1] - x[0]) for x in own)
        rssi = p.get("rssi")
        weak = rssi is not None and rssi <= WEAK_RSSI
        if len(own) >= 3 and weak:
            level, tip = "bad", "常斷線而且訊號弱：換一個離基地台近一點的插孔，或在附近加基地台"
        elif len(own) >= 3:
            level, tip = "bad", "訊號不差卻常斷：可能是插座本身或電源不穩，試試拔掉重插、換插孔，還是一樣就考慮換插座"
        elif weak:
            level, tip = "warn", "訊號偏弱，目前還算穩；如果開始斷線，換近一點的插孔"
        elif own:
            level, tip = "ok", "偶爾斷一下，不用處理"
        else:
            level, tip = "ok", ""
        out.append({"id": p["id"], "name": p["name"], "rssi": rssi, "online": p.get("online"), "ssid": p.get("ssid"),
                    "drops": len(own), "offline_sec": round(sec), "last": max((x[0] for x in own), default=None),
                    "level": level, "tip": tip})
    order = {"bad": 0, "warn": 1, "ok": 2}
    out.sort(key=lambda x: (order[x["level"]], -x["drops"], x["rssi"] if x["rssi"] is not None else 0))
    return out


def hm(s: str | None) -> int | None:
    try:
        h, m = (s or "").split(":")[:2]
        v = int(h) * 60 + int(m)
        return v if 0 <= v < 1440 else None
    except ValueError:
        return None


def night_due(at: str | None, dt: datetime, last: str | None) -> str | None:
    """晚安檢查的時間到了沒：回傳這個晚上的代號（日期），沒到或已經做過就回 None。

    at 是「23:30」這種時間；過了午夜的時間（例如 00:30）算前一天晚上。時間過後 3 小時內還會補做。
    """
    t = hm(at)
    if t is None:
        return None
    for back in (0, 1):  # 今天這個時間，或昨天這個時間（例如 23:30 的檢查在凌晨 1 點補做）
        target = datetime.combine(dt.date() - timedelta(days=back), datetime.min.time()) + timedelta(minutes=t)
        if target <= dt < target + timedelta(hours=NIGHT_WINDOW_H):
            # 這個晚上的代號：檢查時間在中午以前（凌晨）的，屬於前一天晚上
            night = target.date() if t >= 720 else target.date() - timedelta(days=1)
            key = night.isoformat()
            return None if last == key else key
    return None


def away_auto(cfg: dict[str, Any], anyone_home: bool | None, away_since: float | None, now: float) -> str | None:
    """離家模式自動開關：回傳 "on"（大家出門夠久了，自動打開）或 None。

    關閉在「有人回家」那一刻處理（hub._router_presence）。
    """
    if not cfg.get("auto_on") or cfg.get("enabled") or not cfg.get("plugs"):
        return None
    if anyone_home is not False or not away_since:
        return None
    hours = float(cfg.get("auto_h") or AWAY_AUTO_H)
    return "on" if now - away_since >= hours * 3600 else None

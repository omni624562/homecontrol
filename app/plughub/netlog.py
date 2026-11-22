"""網路狀況：基地台卡住、外網斷線、停電後恢復插座、一週動靜統計。

這裡只放判斷用的小函式（好測試）；狀態、通知、紀錄在 hub.py。
"""
from __future__ import annotations

import asyncio
from datetime import datetime
from typing import Any, Iterable

# 外網檢查：連這幾個位址的 TCP 埠（不送任何資料），一個通就算有網路
WAN_TARGETS = (("1.1.1.1", 443), ("8.8.8.8", 443), ("168.95.1.1", 53))
WAN_EVERY = 30  # 秒
WAN_FAILS = 2  # 連續幾次都不通才算斷
AP_IDLE_MIN = 10  # 基地台幾分鐘都沒有裝置連，才算卡住
AP_MIN_CLIENTS = 5  # 全家至少要有幾台 Wi-Fi 裝置連著才判斷（半夜大家都睡、裝置很少時不算）
AP_SEEN_HOURS = 24  # 這台基地台最近這麼久有過裝置連，才會判斷它卡住（本來就沒人連的不算）
RESTORE_MAX_H = 6  # 斷電超過這麼久就不恢復（情況可能已經不一樣）
EVENTS_KEEP = 200


async def _tcp_ok(host: str, port: int, timeout: float = 3) -> bool:
    try:
        _, w = await asyncio.wait_for(asyncio.open_connection(host, port), timeout)
    except Exception:  # noqa: BLE001
        return False
    w.close()
    try:
        await w.wait_closed()
    except Exception:  # noqa: BLE001
        pass
    return True


async def wan_ok() -> bool:
    res = await asyncio.gather(*(_tcp_ok(h, p) for h, p in WAN_TARGETS))
    return any(res)


def wifi_by_node(clients: dict[str, dict[str, Any]], online: Iterable[str]) -> dict[str, int]:
    """每台基地台現在有幾台 Wi-Fi 裝置連著（有線的不算）。"""
    out: dict[str, int] = {}
    for mac in online:
        c = clients.get(mac) or {}
        if c.get("wired") or not c.get("node"):
            continue
        out[c["node"]] = out.get(c["node"], 0) + 1
    return out


def ap_check(nodes: list[dict[str, Any]], counts: dict[str, int], state: dict[str, dict[str, Any]], now: float) -> list[tuple[str, dict[str, Any]]]:
    """更新每台基地台的狀態，回傳要處理的事：("stuck", 節點) 剛判斷卡住、("back", 節點) 恢復了。

    state：MAC → {"last": 最後一次有裝置連的時間, "zero": 從什麼時候開始 0 台, "stuck": 卡住的開始時間或 None}
    """
    events: list[tuple[str, dict[str, Any]]] = []
    total = sum(counts.values())
    for n in nodes:
        mac = n["mac"]
        st = state.setdefault(mac, {"last": 0.0, "zero": None, "stuck": None})
        if counts.get(mac, 0) > 0:
            st["last"] = now
            st["zero"] = None
            if st.get("stuck"):
                events.append(("back", {**n, "start": st["stuck"]}))
                st["stuck"] = None
            continue
        if total < AP_MIN_CLIENTS:
            st["zero"] = None  # 裝置太少不判斷，重新計時
            continue
        st["zero"] = st.get("zero") or now
        if (not st.get("stuck") and now - st["zero"] >= AP_IDLE_MIN * 60
                and now - (st.get("last") or 0) < AP_SEEN_HOURS * 3600):
            st["stuck"] = st["zero"]
            events.append(("stuck", n))
    return events


def week_grid(start: int, bucket: int, rooms: dict[str, list[float | None]], active: float) -> dict[str, Any]:
    """每 bucket 秒的房間分數 → 每間房「星期幾 × 幾點」有動靜的比例（0～1）。

    回傳 {"rooms": {房間: [[24 格] × 7 天（週一開始）]}, "hours": {房間: 有資料的格數}}
    """
    out: dict[str, list[list[float | None]]] = {}
    for room, vals in rooms.items():
        hit = [[0] * 24 for _ in range(7)]
        tot = [[0] * 24 for _ in range(7)]
        for i, v in enumerate(vals):
            if v is None:
                continue
            t = datetime.fromtimestamp(start + i * bucket)
            d, h = t.weekday(), t.hour
            tot[d][h] += 1
            if v >= active:
                hit[d][h] += 1
        out[room] = [[round(hit[d][h] / tot[d][h], 3) if tot[d][h] else None for h in range(24)] for d in range(7)]
    return {"rooms": out}


def uptime() -> float:
    """樹莓派開機多久了（秒）；讀不到就當作很久。"""
    try:
        with open("/proc/uptime", encoding="ascii") as f:
            return float(f.read().split()[0])
    except Exception:  # noqa: BLE001
        return 1e9


def fmt_dur(sec: float) -> str:
    m = max(1, round(sec / 60))
    if m < 60:
        return f"{m} 分鐘"
    h, m = divmod(m, 60)
    return f"{h} 小時{f' {m} 分' if m else ''}"


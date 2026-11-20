"""網頁伺服器：手機上的網頁 App 和它用的 API。

GET  /api/state             目前全部的狀態
GET  /api/events            狀態一有變動就推送（Server-Sent Events）
POST /api/plugs/{id}/power  {"on": true/false}
PATCH /api/plugs/{id}       {"name", "room", "keep_on", "night", "watts", "max_on_s"}
POST /api/off               {"room", "standby_only"} 關閉並記住，可以 /api/restore 復原
POST /api/on                {"room"} 打開整個房間，可以 /api/restore 復原
POST /api/restore
POST /api/rooms             {"name"}；PATCH/DELETE /api/rooms/{id}
POST /api/order             {"plugs": [...], "rooms": [...], "scenes": [...]}
POST /api/plugs/{id}/timer  {"seconds": 90}（或 {"minutes": 10}）打開、多久後自動關閉；DELETE 取消
POST /api/scenes            {"name", "icon", "actions", "others"}；PUT/DELETE /api/scenes/{id}
POST /api/scenes/{id}/run   執行情境（可以 /api/restore 復原）
POST /api/schedules         新增排程；PUT/DELETE /api/schedules/{id}
PUT  /api/settings
PUT  /api/away              離家模式 {"enabled", "start", "end", "plugs"}
GET/PUT /api/floorplan      訊號地圖（房間、裝置位置、Wi-Fi 基地台）；POST/GET/DELETE /api/floorplan/image 底圖
GET/PUT /api/sensing        Wi-Fi 感測（實驗）：訊號擾動；{"enabled": false} 停止記錄
GET  /api/energy             用電（插座自己記錄的開機時間 × 瓦數）
GET  /api/plugs/{id}/usage  插座自己記錄的使用時間；POST /api/plugs/{id}/reboot 重新啟動
PUT/DELETE /api/kasa-rules  直接修改／刪除插座裡 Kasa App 設的排程
POST /api/kasa-rules/adopt  Kasa App 設的排程改由家庭中控管理
PUT/DELETE /api/kasa-away   Kasa App 設的離家模式：啟用／停用、刪除
POST /api/cloud/unbind      斷開所有插座的 TP-Link 雲端（要帶 {"confirm": "斷開"}）
POST /api/discover          立刻重新找插座
PUT  /api/matter            Google Home 串接外掛回報配對狀態（只接受樹莓派本機）
GET  /api/matter/qr.svg     配對用的 QR code
GET  /matterbridge          拿通行證，轉到 Matterbridge 管理頁（:8283）
"""

from __future__ import annotations

import asyncio
import io
import json
import logging
import os
import re
import secrets
import time
import uuid
from contextlib import asynccontextmanager
from datetime import date
from pathlib import Path
from typing import Any

import segno
from fastapi import Body, FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, RedirectResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles

from .assistant import MODELS as ASSISTANT_MODELS, Assistant
from .hub import SOURCE, Hub, Locked
from .notify import LineError, Notifier
from .store import Store, _hms

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

DATA_DIR = Path(os.environ.get("PLUGHUB_DATA", "/data"))
STATIC = Path(__file__).parent / "static"

store = Store(DATA_DIR)
hub = Hub(store, Notifier(lambda: store.data["settings"].get("ntfy_topic", ""), store.dir / "secrets.json"))
assistant = Assistant(hub)
hub.assistant = assistant
_LOGGER = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    await hub.start()
    yield
    await hub.stop()


app = FastAPI(title="插座", lifespan=lifespan, docs_url=None, redoc_url=None)


def _plug(plug_id: str):
    if plug_id not in hub.plugs:
        raise HTTPException(404, "找不到這個插座")
    return hub.plugs[plug_id]


async def _done() -> dict[str, Any]:
    await hub.changed()
    return {"ok": True}


# ---- 狀態 ----


@app.get("/api/state")
async def state() -> dict[str, Any]:
    return hub.snapshot()


@app.get("/api/events")
async def events(request: Request) -> StreamingResponse:
    async def stream():
        version = -1
        while not await request.is_disconnected():
            new = await hub.wait_change(version, timeout=15)
            if new != version:
                version = new
                yield f"data: {json.dumps(hub.snapshot(), ensure_ascii=False)}\n\n"
            else:
                yield ": ping\n\n"  # 讓手機和中間的網路設備知道連線還在

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ---- 插座 ----


@app.post("/api/plugs/{plug_id}/power")
async def set_power(plug_id: str, body: dict = Body(...)) -> dict[str, Any]:
    _plug(plug_id)
    SOURCE.set("matter" if body.get("source") == "matter" else "app")
    try:
        await hub.set_power(plug_id, bool(body.get("on")), force=bool(body.get("force")))
    except Locked as err:
        raise HTTPException(423, f"「{err}」已鎖定，要先在裝置詳細解鎖") from err
    except Exception as err:  # noqa: BLE001
        raise HTTPException(502, f"插座沒有回應：{err}") from err
    return {"ok": True}


@app.post("/api/plugs/{plug_id}/timer")
async def set_timer(plug_id: str, body: dict = Body(...)) -> dict[str, Any]:
    _plug(plug_id)
    try:
        seconds = float(body["seconds"]) if "seconds" in body else float(body.get("minutes")) * 60
    except (TypeError, ValueError, KeyError):
        raise HTTPException(400, "請輸入時間") from None
    if not 1 <= seconds <= 24 * 3600:
        raise HTTPException(400, "定時要在 1 秒到 24 小時之間")
    try:
        await hub.set_timer(plug_id, seconds)
    except Exception as err:  # noqa: BLE001
        raise HTTPException(502, f"插座沒有回應：{err}") from err
    return {"ok": True}


@app.delete("/api/plugs/{plug_id}/timer")
async def cancel_timer(plug_id: str) -> dict[str, Any]:
    _plug(plug_id)
    await hub.cancel_timer(plug_id)
    return {"ok": True}


@app.patch("/api/plugs/{plug_id}")
async def update_plug(plug_id: str, body: dict = Body(...)) -> dict[str, Any]:
    _plug(plug_id)
    meta = store.meta(plug_id)
    if "name" in body:
        name = (body["name"] or "").strip()
        meta.name = name or None
    if "room" in body:
        room = body["room"]
        if room is not None and not store.room(room):
            raise HTTPException(400, "沒有這個區域")
        meta.room = room
    for key in ("keep_on", "night", "matter"):
        if key in body:
            setattr(meta, key, bool(body[key]))
    if "protect" in body:
        if body["protect"] not in ("", "confirm_off", "confirm", "lock"):
            raise HTTPException(400, "防呆設定不對")
        meta.protect = body["protect"]
    if "max_on_s" in body:
        value = body["max_on_s"]
        if value in (None, "", 0):
            meta.max_on_s = None
        else:
            try:
                value = round(float(value))
            except (TypeError, ValueError):
                raise HTTPException(400, "最長開啟時間要是秒數") from None
            if not 1 <= value <= 24 * 3600:
                raise HTTPException(400, "最長開啟時間要在 1 秒到 24 小時之間")
            meta.max_on_s = value
            hub.store.data["timers"].pop(plug_id, None)  # 重新依新的上限算
    # 「常開」和「最長開啟時間」互相矛盾，後設定的為準
    if body.get("keep_on"):
        meta.max_on_s = None
    elif meta.max_on_s:
        meta.keep_on = False
    if meta.max_on_s and hub.plugs[plug_id].is_on:
        hub._cap_on_time(plug_id)
    if "watts" in body:
        watts = body["watts"]
        meta.watts = float(watts) if watts not in (None, "", 0) and float(watts) > 0 else None
    if "led" in body:
        try:
            await hub.set_led(plug_id, bool(body["led"]))
        except Exception as err:  # noqa: BLE001
            raise HTTPException(502, f"插座沒有回應：{err}") from err
    store.save()
    hub.mark_native()  # 常開／最長開啟時間會影響寫進插座的排程
    return await _done()


@app.post("/api/off")
async def turn_off(body: dict = Body(default={})) -> dict[str, Any]:
    done = await hub.turn_off(
        room=body.get("room"), standby_only=bool(body.get("standby_only")), remember="undo"
    )
    await hub.changed()
    return {"ok": True, "count": len(done)}


@app.post("/api/on")
async def turn_on(body: dict = Body(default={})) -> dict[str, Any]:
    room = body.get("room")
    if not room or not store.room(room):
        raise HTTPException(404, "找不到這個區域")
    done = await hub.turn_on(room, remember="undo")
    await hub.changed()
    return {"ok": True, "count": len(done)}


@app.post("/api/restore")
async def restore() -> dict[str, Any]:
    done = await hub.restore("undo")
    await hub.changed()
    return {"ok": True, "count": len(done)}


@app.post("/api/discover")
async def discover() -> dict[str, Any]:
    await hub.discover()
    return await _done()


# ---- 房間與順序 ----


@app.post("/api/rooms")
async def add_room(body: dict = Body(...)) -> dict[str, Any]:
    name = (body.get("name") or "").strip()
    if not name:
        raise HTTPException(400, "請輸入區域名稱")
    room = store.add_room(name, body.get("icon"))
    await hub.changed()
    return room


@app.patch("/api/rooms/{room_id}")
async def update_room(room_id: str, body: dict = Body(...)) -> dict[str, Any]:
    room = store.room(room_id)
    if not room:
        raise HTTPException(404, "沒有這個區域")
    if body.get("name", "").strip():
        room["name"] = body["name"].strip()
    if body.get("icon"):
        room["icon"] = body["icon"]
    store.save()
    return await _done()


@app.delete("/api/rooms/{room_id}")
async def delete_room(room_id: str) -> dict[str, Any]:
    store.delete_room(room_id)
    return await _done()


@app.post("/api/order")
async def set_order(body: dict = Body(...)) -> dict[str, Any]:
    if "plugs" in body:
        store.data["plug_order"] = list(dict.fromkeys(body["plugs"]))
    if "rooms" in body:
        by_id = {r["id"]: r for r in store.rooms}
        ordered = [by_id[i] for i in dict.fromkeys(body["rooms"]) if i in by_id]
        ordered += [r for r in store.rooms if r not in ordered]
        store.data["rooms"] = ordered
    if "scenes" in body:
        by_id = {x["id"]: x for x in store.scenes}
        ordered = [by_id[i] for i in dict.fromkeys(body["scenes"]) if i in by_id]
        store.data["scenes"] = ordered + [x for x in store.scenes if x not in ordered]
    store.save()
    return await _done()




# ---- 情境 ----


def _scene_body(body: dict) -> tuple[str, str, dict[str, str], str]:
    name = (body.get("name") or "").strip()
    if not name:
        raise HTTPException(400, "請輸入情境名稱")
    actions = body.get("actions") or {}
    if not isinstance(actions, dict):
        raise HTTPException(400, "actions 格式不對")
    return name, str(body.get("icon") or ""), {str(k): str(v) for k, v in actions.items()}, str(body.get("others") or "keep")


@app.post("/api/scenes")
async def add_scene(body: dict = Body(...)) -> dict[str, Any]:
    scene = store.save_scene(None, *_scene_body(body))
    hub.mark_native()
    await hub.changed()
    return scene


@app.put("/api/scenes/{scene_id}")
async def update_scene(scene_id: str, body: dict = Body(...)) -> dict[str, Any]:
    if not store.scene(scene_id):
        raise HTTPException(404, "沒有這個情境")
    scene = store.save_scene(scene_id, *_scene_body(body))
    hub.mark_native()
    await hub.changed()
    return scene


@app.delete("/api/scenes/{scene_id}")
async def delete_scene(scene_id: str) -> dict[str, Any]:
    store.delete_scene(scene_id)
    for sched in store.schedules:  # 用到這個情境的排程先停用
        if sched["action"] == "scene" and sched.get("scene") == scene_id:
            store.save_schedule(sched["id"], {"enabled": False, "scene": None})
    hub.mark_native()
    return await _done()


@app.post("/api/scenes/{scene_id}/run")
async def run_scene(scene_id: str) -> dict[str, Any]:
    if not store.scene(scene_id):
        raise HTTPException(404, "沒有這個情境")
    done = await hub.run_scene(scene_id, remember="undo")
    await hub.changed()
    return {"ok": True, "count": len(done)}


# ---- 排程 ----


@app.post("/api/schedules")
async def add_schedule(body: dict = Body(...)) -> dict[str, Any]:
    sched = store.save_schedule(None, body)
    hub.mark_native()
    hub.recheck_calendar()  # 剛打開「下雨不執行」：馬上查天氣
    hub.refresh_habits()  # 剛照建議建的排程，建議馬上消失
    await hub.changed()
    return sched


@app.put("/api/schedules/{sched_id}")
async def update_schedule(sched_id: str, body: dict = Body(...)) -> dict[str, Any]:
    try:
        sched = store.save_schedule(sched_id, body)
    except KeyError:
        raise HTTPException(404, "沒有這個排程") from None
    hub.mark_native()
    hub.recheck_calendar()
    await hub.changed()
    return sched


@app.delete("/api/schedules/{sched_id}")
async def delete_schedule(sched_id: str) -> dict[str, Any]:
    store.delete_schedule(sched_id)
    hub.mark_native()
    return await _done()


# ---- 插座本身的功能 ----


# ---- 訊號地圖 ----

FLOORPLAN_IMAGE = DATA_DIR / "floorplan.img"
IMAGE_MAGIC = ((b"\xff\xd8\xff", "image/jpeg"), (b"\x89PNG\r\n\x1a\n", "image/png"), (b"RIFF", "image/webp"))
IMAGE_HEADERS = {"Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; sandbox"}


def _num(v: Any, lo: float, hi: float) -> float:
    try:
        return max(lo, min(hi, float(v)))
    except (TypeError, ValueError):
        raise HTTPException(400, "座標不對") from None


@app.get("/api/floorplan")
async def get_floorplan() -> dict[str, Any]:
    return store.data["floorplan"]


@app.put("/api/floorplan")
async def put_floorplan(body: dict = Body(...)) -> dict[str, Any]:
    """{"w","h","meters","rooms":[{id,name,x,y,w,h}],"items":{key:{x,y,z}},"aps":[{id,name,ssid,z}]}

    meters = 地圖寬度是幾公尺（算距離用）；z = 離地高度（公尺），None = 用預設值。
    """
    fp = store.data["floorplan"]
    w = _num(body.get("w", fp["w"]), 200, 4000)
    h = _num(body.get("h", fp["h"]), 200, 4000)
    if "rooms" in body:
        fp["rooms"] = [
            {"id": str(r.get("id"))[:20], "name": str(r.get("name", ""))[:20],
             "x": _num(r.get("x"), 0, w), "y": _num(r.get("y"), 0, h), "w": _num(r.get("w"), 20, w), "h": _num(r.get("h"), 20, h)}
            for r in body["rooms"][:40]
        ] if body["rooms"] is not None else None
    z = lambda v: None if v is None else _num(v, 0, 5)  # noqa: E731
    if "items" in body:
        fp["items"] = {str(k)[:80]: {"x": _num(v.get("x"), 0, w), "y": _num(v.get("y"), 0, h), "z": z(v.get("z"))}
                       for k, v in list((body["items"] or {}).items())[:100]}
    if "aps" in body:
        fp["aps"] = [{"id": str(a.get("id"))[:20], "name": str(a.get("name", ""))[:30],
                      "ssid": str(a["ssid"])[:32] if a.get("ssid") else None,
                      "node": _mac(a.get("node")), "z": z(a.get("z"))}
                     for a in (body["aps"] or [])[:10]]
    if "meters" in body:
        fp["meters"] = _num(body["meters"], 2, 100)
    if "auto_nodes" in body:  # 已經自動放過的路由器（使用者刪掉的不會再出現）
        fp["auto_nodes"] = [m for m in (_mac(x) for x in (body["auto_nodes"] or [])[:10]) if m]
    fp["w"], fp["h"] = w, h
    store.save()
    return fp


@app.post("/api/floorplan/image")
async def put_floorplan_image(body: dict = Body(...)) -> dict[str, Any]:
    """平面圖底圖：{"data": "data:image/png;base64,..."}（最大 5 MB）。"""
    import base64
    import binascii
    data = str(body.get("data", ""))
    if ";base64," not in data:
        raise HTTPException(400, "請上傳圖片")
    try:
        raw = base64.b64decode(data.split(",", 1)[1], validate=True)
    except (binascii.Error, ValueError):
        raise HTTPException(400, "請上傳圖片") from None
    if len(raw) > 5 * 1024 * 1024:
        raise HTTPException(400, "圖片太大（最大 5 MB）")
    # 只收點陣圖，而且看檔案內容判斷，不相信上傳者說的格式（SVG 之類能夾帶程式碼的一律不收）
    mime = next((m for sig, m in IMAGE_MAGIC if raw.startswith(sig)), None)
    if mime == "image/webp" and raw[8:12] != b"WEBP":
        mime = None
    if not mime:
        raise HTTPException(400, "只能上傳 JPEG、PNG 或 WebP 圖片")
    FLOORPLAN_IMAGE.write_bytes(raw)
    store.data["floorplan"]["image"] = mime + "|" + str(int(time.time()))
    store.save()
    return store.data["floorplan"]


@app.delete("/api/floorplan/image")
async def delete_floorplan_image() -> dict[str, Any]:
    FLOORPLAN_IMAGE.unlink(missing_ok=True)
    store.data["floorplan"]["image"] = None
    store.save()
    return store.data["floorplan"]


@app.get("/api/floorplan/image")
async def floorplan_image() -> Response:
    img = store.data["floorplan"].get("image")
    if not img or not FLOORPLAN_IMAGE.exists():
        raise HTTPException(404, "沒有平面圖")
    mime = img.split("|")[0]
    if mime not in {m for _, m in IMAGE_MAGIC}:
        raise HTTPException(404, "沒有平面圖")
    return FileResponse(FLOORPLAN_IMAGE, media_type=mime, headers=IMAGE_HEADERS)


@app.post("/api/habits/dismiss")
async def dismiss_habit(body: dict = Body(...)) -> dict[str, Any]:
    """排程建議按「不用」：之後不再建議。"""
    key = str(body.get("key", ""))[:120]
    lst = store.data["settings"].setdefault("habit_dismissed", [])
    if key and key not in lst:
        lst.append(key)
        del lst[:-200]
        store.save()
    hub.habits = [s for s in hub.habits if s["key"] != key]
    await hub.changed()
    return {"ok": True}


@app.get("/manifest.webmanifest")
async def manifest() -> Response:
    """加入主畫面用；長按圖示會出現前 4 個情境的捷徑（Android、電腦版 Chrome）。"""
    data = json.loads((STATIC / "manifest.webmanifest").read_text("utf-8"))
    data["shortcuts"] = [
        {"name": sc["name"], "short_name": sc["name"], "url": f"/?run={sc['id']}",
         "icons": [{"src": "/static/icon-192.png", "sizes": "192x192", "type": "image/png"}]}
        for sc in store.scenes[:4]
    ]
    return Response(json.dumps(data, ensure_ascii=False), media_type="application/manifest+json", headers={"Cache-Control": "no-cache"})


@app.get("/api/sensing")
async def sensing(minutes: int = 60, range: str = "1h") -> dict[str, Any]:  # noqa: A002
    """Wi-Fi 感測（實驗）：每台插座每分鐘的訊號強度和擾動；range = 24h／7d／30d 看長期紀錄。"""
    if range in hub.SENSE_RANGES:
        return hub.sensing_history(range)
    return hub.sensing_report(max(5, min(60, minutes)))


@app.put("/api/sensing")
async def set_sensing(body: dict = Body(...)) -> dict[str, Any]:
    store.data["settings"]["sensing"] = bool(body.get("enabled"))
    store.save()
    return await _done()


@app.get("/api/energy")
async def energy() -> dict[str, Any]:
    """用電頁的資料：插座自己記錄的開機時間 × 瓦數，近 30 天、近 12 個月、各裝置。"""
    if time.time() - hub._usage_at > 600:
        await hub.refresh_usage()
    return hub.energy_report()


@app.get("/api/plugs/{plug_id}/usage")
async def plug_usage(plug_id: str) -> dict[str, Any]:
    """插座自己記錄的使用時間（每天開了幾分鐘）。"""
    _plug(plug_id)
    try:
        return await hub.usage(plug_id)
    except Exception as err:  # noqa: BLE001
        raise HTTPException(502, f"插座沒有回應：{err}") from err


@app.post("/api/plugs/{plug_id}/reboot")
async def plug_reboot(plug_id: str) -> dict[str, Any]:
    _plug(plug_id)
    try:
        await hub.reboot(plug_id)
    except Exception as err:  # noqa: BLE001
        raise HTTPException(502, f"插座沒有回應：{err}") from err
    return {"ok": True}


@app.delete("/api/plugs/{plug_id}")
async def plug_forget(plug_id: str) -> dict[str, Any]:
    """從清單移除連不上的插座（已經不用的）。之後它又連上網路的話會自動再出現。"""
    plug = _plug(plug_id)
    if plug.online:
        raise HTTPException(400, "插座還連得上，不能移除；先把它拔掉")
    await hub.forget(plug_id)
    return {"ok": True}


@app.put("/api/away")
async def set_away(body: dict = Body(...)) -> dict[str, Any]:
    """離家模式：{"enabled", "start": "HH:MM", "end": "HH:MM", "plugs": [...]}"""
    away = dict(store.data["settings"].get("away") or {})
    if "enabled" in body:
        away["enabled"] = bool(body["enabled"])
    for key in ("start", "end"):
        if key in body:
            hms = _hms(body[key])
            if not hms:
                raise HTTPException(400, "時間格式不對")
            away[key] = hms[:5]
    if "plugs" in body:
        away["plugs"] = [str(x) for x in body["plugs"] if str(x) in hub.plugs]
    if away.get("start") == away.get("end"):
        raise HTTPException(400, "開始和結束時間不能一樣")
    store.data["settings"]["away"] = away
    store.save()
    hub.mark_native()
    return await _done()


def _key(m: dict) -> tuple:
    """{"sact", "opt", "val", "wday"} → 規則的鍵。opt：0 固定時間（val = 第幾分鐘）、1 日出、2 日落（val = 提早／延後分鐘）。"""
    try:
        opt = int(m.get("opt", 0))
        val = int(m["val"])
        wday = tuple(1 if int(x) else 0 for x in m["wday"])
    except (KeyError, TypeError, ValueError):
        raise HTTPException(400, "排程內容不對") from None
    if opt not in (0, 1, 2) or len(wday) != 7 or (opt == 0 and not 0 <= val < 1440) or (opt and not -180 <= val <= 180):
        raise HTTPException(400, "排程內容不對")
    return (1 if int(m.get("sact", 0)) else 0, opt, val, wday)


def _kasa_plug(body: dict) -> str:
    pid = str(body.get("plug", ""))
    _plug(pid)
    return pid


@app.put("/api/kasa-rules")
async def edit_kasa_rule(body: dict = Body(...)) -> dict[str, Any]:
    """直接修改插座裡 Kasa App 設的排程：{"plug", "match": {sact, opt, val, wday}, "set": {sact, opt, val, wday, enable}}"""
    pid = _kasa_plug(body)
    key = _key(body.get("match") or {})
    new = {**dict(zip(("sact", "opt", "val", "wday"), key)), **(body.get("set") or {})}
    new_key = _key(new)
    if not any(new_key[3]):
        raise HTTPException(400, "請至少選一天")
    try:
        await hub.edit_kasa_rule(pid, key, new_key, bool(new.get("enable", True)))
    except Exception as err:  # noqa: BLE001
        raise HTTPException(502, f"沒有成功：{err}") from err
    return {"ok": True}


@app.delete("/api/kasa-rules")
async def delete_kasa_rule(body: dict = Body(...)) -> dict[str, Any]:
    pid = _kasa_plug(body)
    try:
        await hub.delete_kasa_rule(pid, _key(body.get("match") or {}))
    except Exception as err:  # noqa: BLE001
        raise HTTPException(502, f"沒有成功：{err}") from err
    return {"ok": True}


@app.post("/api/kasa-rules/adopt")
async def adopt_kasa_rule(body: dict = Body(...)) -> dict[str, Any]:
    """Kasa App 設的排程改由家庭中控管理：{"plug", "match": {sact, opt, val, wday}, "enabled"}"""
    pid = _kasa_plug(body)
    try:
        return await hub.adopt_kasa_rule(pid, _key(body.get("match") or {}), bool(body.get("enabled", True)))
    except ValueError as err:
        raise HTTPException(400, str(err)) from err
    except Exception as err:  # noqa: BLE001
        raise HTTPException(502, f"插座沒有回應：{err}") from err


def _away_match(body: dict) -> tuple[str, int, int, list[int]]:
    pid = _kasa_plug(body)
    m = body.get("match") or {}
    try:
        return pid, int(m["smin"]), int(m["emin"]), [1 if int(x) else 0 for x in m["wday"]]
    except (KeyError, TypeError, ValueError):
        raise HTTPException(400, "缺少要改哪一條") from None


@app.put("/api/kasa-away")
async def edit_kasa_away(body: dict = Body(...)) -> dict[str, Any]:
    """啟用／停用 Kasa App 設的離家模式：{"plug", "match": {smin, emin, wday}, "enable"}"""
    pid, smin, emin, wday = _away_match(body)
    try:
        await hub.set_kasa_away(pid, smin, emin, wday, bool(body.get("enable")))
    except Exception as err:  # noqa: BLE001
        raise HTTPException(502, f"沒有成功：{err}") from err
    return {"ok": True}


@app.delete("/api/kasa-away")
async def delete_kasa_away(body: dict = Body(...)) -> dict[str, Any]:
    pid, smin, emin, wday = _away_match(body)
    try:
        await hub.set_kasa_away(pid, smin, emin, wday, None)
    except Exception as err:  # noqa: BLE001
        raise HTTPException(502, f"沒有成功：{err}") from err
    return {"ok": True}


@app.post("/api/cloud/unbind")
async def cloud_unbind(body: dict = Body(...)) -> dict[str, Any]:
    """把所有插座和 TP-Link 雲端斷開。要帶 {"confirm": "斷開"} 才會做。"""
    if body.get("confirm") != "斷開":
        raise HTTPException(400, "需要確認")
    result = await hub.cloud_unbind_all()
    await hub.changed()
    return result


# ---- 設定 ----


@app.put("/api/settings")
async def set_settings(body: dict = Body(...)) -> dict[str, Any]:
    settings = store.data["settings"]
    limits = {
        "household_monthly_kwh": (0, 5000),
        "standby_watts": (0, 100),
        "overload_watts": (50, 5000),
        "long_on_hours": (1, 48),
    }
    for key, (lo, hi) in limits.items():
        if key in body:
            settings[key] = min(hi, max(lo, float(body[key])))
    if "ntfy_topic" in body:
        settings["ntfy_topic"] = str(body["ntfy_topic"]).strip()
    if "new_device_alert" in body:
        settings["new_device_alert"] = bool(body["new_device_alert"])
    if isinstance(body.get("remind"), dict):  # 主動提醒：開太久、早上會下雨、明天停水停電
        rem = settings.setdefault("remind", {})
        for key in ("long_on", "rain", "outage_eve"):
            if key in body["remind"]:
                rem[key] = bool(body["remind"][key])
    if isinstance(body.get("presence"), dict):
        pres = settings.setdefault("presence", {})
        for key in ("away_scene", "home_scene"):
            if key in body["presence"]:
                v = body["presence"][key]
                pres[key] = v if v and store.scene(v) else None
        if "grace_min" in body["presence"]:
            pres["grace_min"] = min(60, max(2, int(body["presence"]["grace_min"])))
        if body["presence"].get("left_on") in ("notify", "off", "none"):  # 沒人在家還有電器開著：通知／自動關／不管
            pres["left_on"] = body["presence"]["left_on"]
        if "home_dark_only" in body["presence"]:  # 回家的情境只在天黑後執行
            pres["home_dark_only"] = bool(body["presence"]["home_dark_only"])
    if "weather" in body:  # 首頁顯示天氣（每 10 分鐘向氣象署查一次）
        settings["weather"] = bool(body["weather"])
        if settings["weather"]:
            hub.recheck_calendar()
            hub.weather.reset()
    if "weekly" in body:  # 每週日晚上的摘要推播
        settings["weekly"] = bool(body["weekly"])
    if "matter_scenes" in body:  # 情境也放到 Google Home（打開 = 執行）
        settings["matter_scenes"] = bool(body["matter_scenes"])
    if isinstance(body.get("router"), dict):
        r = body["router"]
        host = str(r.get("host", "")).strip()
        user = str(r.get("user", "")).strip()
        if host and not re.fullmatch(r"(10|172|192)\.[0-9.]{3,11}", host):
            raise HTTPException(400, "路由器的位址要是家裡網路的 IP（例如 192.168.1.1）")
        if user and not re.fullmatch(r"[A-Za-z0-9._-]{1,32}", user):
            raise HTTPException(400, "帳號名稱只能有英文、數字和 . _ -")
        settings["router"] = {"host": host, "user": user, "port": min(65535, max(1, int(r.get("port") or 22)))}
    store.save()
    return await _done()


@app.post("/api/day-off")
async def day_off(body: dict = Body(...)) -> dict[str, Any]:
    """今天放假（颱風假、請假）：打開「國定假日不執行」的排程今天都跳過。"""
    if body.get("on"):
        store.data["day_off"] = date.today().isoformat()
    else:
        store.data.pop("day_off", None)
    store.save()
    hub.mark_native()
    return await _done()


# ---- 天氣（氣象署、環境部的授權碼）----


@app.put("/api/weather/keys")
async def weather_keys(body: dict = Body(...)) -> dict[str, Any]:
    """{"cwa": 氣象署授權碼, "moenv": 環境部 API 金鑰}（空字串 = 刪除）；不會回傳。"""
    cwa = body.get("cwa")
    moenv = body.get("moenv")
    if cwa and not re.fullmatch(r"CWA-[A-Fa-f0-9\-]{20,60}", str(cwa).strip()):
        raise HTTPException(400, "氣象署授權碼格式不對，應該是 CWA- 開頭")
    if moenv and not re.fullmatch(r"[A-Za-z0-9\-]{16,80}", str(moenv).strip()):
        raise HTTPException(400, "環境部 API 金鑰格式不對")
    hub.weather.set_keys(None if cwa is None else str(cwa), None if moenv is None else str(moenv))
    hub.recheck_calendar()
    await hub.changed()
    return {"cwa": bool(hub.weather.key()), "moenv": bool(hub.weather.air_key())}


@app.get("/api/local/map")
async def local_map() -> dict[str, Any]:
    """家附近的街道（座標是離家幾公尺，不是經緯度）。"""
    return hub.local.map()


@app.put("/api/local")
async def local_settings(body: dict = Body(...)) -> dict[str, Any]:
    """生活資訊：{"stop": {"lineid", "rank"}, "roads": [路名], "garbage_notify", "outage_notify", "truck_rush"（快到時畫面上衝出一台垃圾車）, "bus_routes": [路線名], "bus_pick": {"路線代碼:方向": 站牌代碼｜"off"}, "bike_station": 站號, "bike_show"}；只存在樹莓派上。"""
    cfg = store.data["settings"].setdefault("local", {})
    if isinstance(body.get("stop"), dict):
        cfg["stop"] = {"lineid": str(body["stop"].get("lineid", ""))[:20], "rank": str(body["stop"].get("rank", ""))[:6]}
    if isinstance(body.get("roads"), list):
        cfg["roads"] = [str(r).strip()[:20] for r in body["roads"] if str(r).strip()][:8]
        hub.local.recheck()
    for k in ("garbage_notify", "outage_notify", "truck_rush", "fun"):
        if k in body:
            cfg[k] = bool(body[k])
    if body.get("truck_rush_style") in ("side", "front", "drop", "reverse", "parade", "tilt", "chase", "random"):
        cfg["truck_rush_style"] = body["truck_rush_style"]
    bike = cfg.setdefault("bike", {})
    if "bike_station" in body:  # 首頁顯示哪一站
        bike["station"] = str(body["bike_station"])[:12]
    if "bike_show" in body:
        bike["show"] = bool(body["bike_show"])
        hub.local.bike._tried = 0
    bus = cfg.setdefault("bus", {})
    if isinstance(body.get("bus_routes"), list):
        bus["routes"] = list(dict.fromkeys(str(r).strip()[:12] for r in body["bus_routes"] if str(r).strip()))[:6]
        hub.local.bus._tried = 0
    if isinstance(body.get("bus_pick"), dict):  # {"路線代碼:方向": 站牌代碼 或 "off"}
        bus.setdefault("pick", {}).update({str(k)[:20]: str(v)[:12] for k, v in body["bus_pick"].items()})
    store.save()
    hub.local._at.pop("truck", None)
    await hub.changed()
    return hub.local.report()


# ---- 問家裡（Claude）----


@app.get("/api/assistant")
async def assistant_status() -> dict[str, Any]:
    return assistant.status()


@app.put("/api/assistant")
async def assistant_settings(body: dict = Body(...)) -> dict[str, Any]:
    """{"key": API 金鑰（空字串 = 刪除）, "model": 模型}；金鑰不會回傳。"""
    if "key" in body:
        key = str(body["key"] or "").strip()
        if key and not re.fullmatch(r"sk-ant-[A-Za-z0-9_\-]{20,300}", key):
            raise HTTPException(400, "金鑰格式不對，應該是 sk-ant- 開頭")
        assistant.set_key(key or None)
    if "cap" in body:
        store.data["settings"].setdefault("assistant", {})["cap"] = max(0.0, min(500.0, float(body["cap"] or 0)))
        store.save()
    if body.get("model") in ASSISTANT_MODELS:
        store.data["settings"].setdefault("assistant", {})["model"] = body["model"]
        store.save()
    await hub.changed()
    return assistant.status()


@app.post("/api/assistant/chat")
async def assistant_chat(body: dict = Body(...)) -> dict[str, Any]:
    """{"messages": [{"role": "user"|"assistant", "content": 文字}]} → {"reply", "actions", "usd"}"""
    import anthropic  # noqa: PLC0415

    try:
        result = await assistant.chat(list(body.get("messages") or []))
    except anthropic.AuthenticationError:
        raise HTTPException(401, "API 金鑰無效，請到設定重新貼上") from None
    except anthropic.PermissionDeniedError:
        raise HTTPException(403, "這把金鑰沒有權限，或帳戶沒有額度") from None
    except anthropic.RateLimitError:
        raise HTTPException(429, "用得太快了，等一下再試") from None
    except anthropic.APIConnectionError:
        raise HTTPException(503, "連不上 Anthropic，確認樹莓派有網路") from None
    except anthropic.APIStatusError as err:
        _LOGGER.warning("Claude API 錯誤：%s", err)
        raise HTTPException(502, f"Claude 那邊出錯了（{err.status_code}），等一下再試") from None
    except (RuntimeError, ValueError) as err:
        raise HTTPException(400, str(err)) from None
    await hub.changed()
    return result


@app.get("/api/weekly")
async def weekly() -> dict[str, Any]:
    """每週摘要的內容（預覽用）。"""
    return {"text": hub.weekly_text()}


# ---- 路由器：連線裝置、誰在家 ----


def _mac(v: Any) -> str | None:
    v = str(v or "").strip().upper()
    return v if re.fullmatch(r"([0-9A-F]{2}:){5}[0-9A-F]{2}", v) else None


@app.get("/api/net")
async def net() -> dict[str, Any]:
    return hub.net_report()


@app.patch("/api/net/devices/{mac}")
async def edit_net_device(mac: str, body: dict = Body(...)) -> dict[str, Any]:
    """{"label": 自己取的名字 或 null, "map": 放到訊號地圖}"""
    m = _mac(mac)
    if not m:
        raise HTTPException(400, "MAC 格式不對")
    d = store.data["net_devices"].setdefault(m, {"first": time.time()})
    if "label" in body:
        label = str(body["label"] or "").strip()[:30]
        d["label"] = label or None
    if "map" in body:
        d["map"] = bool(body["map"])
        if not d["map"]:
            hub.sensing.forget(m)
            store.data["floorplan"]["items"].pop(m, None)
    store.save()
    await hub.changed()
    return hub.net_report()


def _person(body: dict[str, Any]) -> dict[str, Any]:
    name = str(body.get("name", "")).strip()[:20]
    if not name:
        raise HTTPException(400, "請填名字")
    macs = [m for m in (_mac(x) for x in (body.get("macs") or [])[:6]) if m]
    return {"name": name, "macs": list(dict.fromkeys(macs))}


@app.post("/api/people")
async def add_person(body: dict = Body(...)) -> dict[str, Any]:
    if len(store.data["people"]) >= 12:
        raise HTTPException(400, "最多 12 個人")
    store.data["people"].append({"id": uuid.uuid4().hex[:8], **_person(body)})
    store.save()
    return await _done()


@app.put("/api/people/{pid}")
async def edit_person(pid: str, body: dict = Body(...)) -> dict[str, Any]:
    p = next((x for x in store.data["people"] if x["id"] == pid), None)
    if p is None:
        raise HTTPException(404, "找不到這個人")
    p.update(_person(body))
    store.save()
    return await _done()


@app.delete("/api/people/{pid}")
async def delete_person(pid: str) -> dict[str, Any]:
    store.data["people"] = [x for x in store.data["people"] if x["id"] != pid]
    hub._presence.pop(pid, None)
    store.save()
    return await _done()


@app.post("/api/test-notify")
async def test_notify() -> dict[str, Any]:
    n = hub.notifier
    if n.status()["line"]:
        try:
            await asyncio.to_thread(n.push_now, "測試通知", "收到這則訊息，就代表家庭中控的通知設定好了")
        except LineError as err:
            raise HTTPException(502, str(err)) from None
    elif store.data["settings"].get("ntfy_topic"):
        n.send("測試通知", "收到這則通知，就代表手機通知設定好了")
    else:
        raise HTTPException(400, "還沒有設定 LINE 通知")
    return {"ok": True}


@app.put("/api/notify")
async def notify_set(body: dict = Body(...)) -> dict[str, Any]:
    """{"line_token": LINE 的 Channel access token}（空字串 = 刪除）；只存在樹莓派上，不會回傳。"""
    token = str(body.get("line_token", "")).strip()
    if token and not re.fullmatch(r"[A-Za-z0-9+/=]{100,300}", token):
        raise HTTPException(400, "格式不對：要貼的是 Messaging API 分頁最下面的 Channel access token（很長的一串）")
    try:
        out = await asyncio.to_thread(hub.notifier.set_token, token)
    except LineError as err:
        raise HTTPException(400, str(err)) from None
    await hub.changed()
    return out


@app.get("/api/notify/usage")
async def notify_usage() -> dict[str, Any]:
    try:
        return await asyncio.to_thread(hub.notifier.usage)
    except LineError as err:
        return {"error": str(err)}


# ---- Google Home 串接（Matter） ----

LOCAL = {"127.0.0.1", "::1", "localhost"}


@app.put("/api/matter")
async def matter_report(request: Request, body: dict = Body(...)) -> dict[str, Any]:
    # 只有樹莓派上的 Matterbridge 外掛可以回報，區網裡的其他裝置不行
    if not request.client or request.client.host not in LOCAL:
        raise HTTPException(403, "只接受本機回報")
    status = {
        "online": bool(body.get("online")),
        "commissioned": bool(body.get("commissioned")),
        "manual_code": str(body.get("manual_code") or "")[:20],
        "qr_code": str(body.get("qr_code") or "")[:64],
        "fabrics": [
            {"vendor": str(f.get("vendor") or "")[:40], "label": str(f.get("label") or "")[:40]}
            for f in (body.get("fabrics") or [])[:8]
            if isinstance(f, dict)
        ],
        "plugs": int(body.get("plugs") or 0),
    }
    was_running = (hub.matter_status() or {}).get("running")
    changed = status != hub.matter
    hub.matter = status
    hub.matter_seen = time.monotonic()
    if changed or not was_running:
        await hub.changed()
    return {"ok": True}


@app.get("/api/matter/qr.svg")
async def matter_qr() -> Response:
    status = hub.matter_status()
    # 配對好之後就不再提供配對碼
    if not status or status["commissioned"] or not status["qr_code"]:
        raise HTTPException(404, "目前不需要配對")
    out = io.BytesIO()
    segno.make(status["qr_code"], error="m").save(out, kind="svg", scale=6, border=2, dark="#000", light="#fff")
    return Response(out.getvalue(), media_type="image/svg+xml", headers={"Cache-Control": "no-store"})


# Matterbridge 管理頁的通行證：從插座 App 點連結才發，12 小時有效。
# :8283 的 nginx 每個請求都會來問 /api/matterbridge/auth。
# cookie 不分連接埠，所以 :8100 發的 cookie 瀏覽器到 :8283 也會帶著。
MB_COOKIE = "plughub_mb"
MB_TTL = 12 * 3600
mb_passes: dict[str, float] = {}


@app.get("/matterbridge")
async def open_matterbridge(request: Request) -> RedirectResponse:
    now = time.time()
    for token, expires in list(mb_passes.items()):
        if expires < now:
            del mb_passes[token]
    token = secrets.token_urlsafe(32)
    mb_passes[token] = now + MB_TTL
    host = request.url.hostname or "localhost"
    if ":" in host:
        host = f"[{host}]"
    response = RedirectResponse(f"http://{host}:8283/", status_code=303)
    response.set_cookie(MB_COOKIE, token, max_age=MB_TTL, httponly=True, samesite="lax", path="/")
    return response


@app.get("/api/matterbridge/auth")
async def matterbridge_auth(request: Request) -> Response:
    if not request.client or request.client.host not in LOCAL:
        raise HTTPException(403, "只接受本機")
    expires = mb_passes.get(request.cookies.get(MB_COOKIE, ""))
    return Response(status_code=204 if expires and expires > time.time() else 401)


# ---- 網頁 ----


# 新版畫面（React，app/web 編譯出來的）是首頁；舊版暫時留在 /old/ 備用
WEB = Path(__file__).parent / "web"


@app.get("/")
async def index() -> FileResponse:
    page = WEB / "index.html"
    if not page.exists():  # 還沒編譯新版：先用舊版
        page = STATIC / "index.html"
    return FileResponse(page, headers={"Cache-Control": "no-cache"})


@app.get("/old")
async def old_redirect() -> RedirectResponse:
    return RedirectResponse("/old/")


@app.get("/old/")
async def old_index() -> FileResponse:
    return FileResponse(STATIC / "index.html", headers={"Cache-Control": "no-cache"})


@app.get("/new")
@app.get("/new/")
async def new_redirect() -> RedirectResponse:
    # 試用期間的網址：書籤改到首頁
    return RedirectResponse("/")


@app.get("/sw.js")
async def service_worker() -> FileResponse:
    # service worker 要放在網站根目錄，才能管整個網站
    return FileResponse(STATIC / "sw.js", media_type="text/javascript", headers={"Cache-Control": "no-cache"})


if (WEB / "assets").is_dir():
    # 檔名有內容雜湊，可以放心長期快取
    app.mount("/assets", StaticFiles(directory=WEB / "assets"), name="web")

app.mount("/static", StaticFiles(directory=STATIC), name="static")

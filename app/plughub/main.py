"""網頁伺服器：手機上的網頁 App 和它用的 API。

GET  /api/state             目前全部的狀態
GET  /api/events            狀態一有變動就推送（Server-Sent Events）
POST /api/plugs/{id}/power  {"on": true/false}
PATCH /api/plugs/{id}       {"name", "room", "keep_on", "night", "watts"}
POST /api/off               {"room", "standby_only"} 關閉並記住，可以 /api/restore 復原
POST /api/restore
POST /api/rooms             {"name"}；PATCH/DELETE /api/rooms/{id}
POST /api/order             {"plugs": [...], "rooms": [...], "scenes": [...]}
POST /api/plugs/{id}/timer  {"minutes": 10} 打開、幾分鐘後自動關閉；DELETE 取消
POST /api/scenes            {"name", "icon", "actions", "others"}；PUT/DELETE /api/scenes/{id}
POST /api/scenes/{id}/run   執行情境（可以 /api/restore 復原）
POST /api/schedules         新增排程；PUT/DELETE /api/schedules/{id}
PUT  /api/settings
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
import secrets
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

import segno
from fastapi import Body, FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, RedirectResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles

from .hub import Hub
from .notify import Notifier
from .store import Store

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

DATA_DIR = Path(os.environ.get("PLUGHUB_DATA", "/data"))
STATIC = Path(__file__).parent / "static"

store = Store(DATA_DIR)
hub = Hub(store, Notifier(lambda: store.data["settings"].get("ntfy_topic", "")))


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
    try:
        await hub.set_power(plug_id, bool(body.get("on")))
    except Exception as err:  # noqa: BLE001
        raise HTTPException(502, f"插座沒有回應：{err}") from err
    return {"ok": True}


@app.post("/api/plugs/{plug_id}/timer")
async def set_timer(plug_id: str, body: dict = Body(...)) -> dict[str, Any]:
    _plug(plug_id)
    try:
        minutes = float(body.get("minutes"))
    except (TypeError, ValueError):
        raise HTTPException(400, "請輸入分鐘數") from None
    if not 1 <= minutes <= 24 * 60:
        raise HTTPException(400, "定時要在 1 分鐘到 24 小時之間")
    try:
        await hub.set_timer(plug_id, minutes)
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
            raise HTTPException(400, "沒有這個房間")
        meta.room = room
    for key in ("keep_on", "night"):
        if key in body:
            setattr(meta, key, bool(body[key]))
    if "watts" in body:
        watts = body["watts"]
        meta.watts = float(watts) if watts not in (None, "", 0) and float(watts) > 0 else None
    store.save()
    return await _done()


@app.post("/api/off")
async def turn_off(body: dict = Body(default={})) -> dict[str, Any]:
    done = await hub.turn_off(
        room=body.get("room"), standby_only=bool(body.get("standby_only")), remember="undo"
    )
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
        raise HTTPException(400, "請輸入房間名稱")
    room = store.add_room(name, body.get("icon"))
    await hub.changed()
    return room


@app.patch("/api/rooms/{room_id}")
async def update_room(room_id: str, body: dict = Body(...)) -> dict[str, Any]:
    room = store.room(room_id)
    if not room:
        raise HTTPException(404, "沒有這個房間")
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
    await hub.changed()
    return scene


@app.put("/api/scenes/{scene_id}")
async def update_scene(scene_id: str, body: dict = Body(...)) -> dict[str, Any]:
    if not store.scene(scene_id):
        raise HTTPException(404, "沒有這個情境")
    scene = store.save_scene(scene_id, *_scene_body(body))
    await hub.changed()
    return scene


@app.delete("/api/scenes/{scene_id}")
async def delete_scene(scene_id: str) -> dict[str, Any]:
    store.delete_scene(scene_id)
    for sched in store.schedules:  # 用到這個情境的排程先停用
        if sched["action"] == "scene" and sched.get("scene") == scene_id:
            store.save_schedule(sched["id"], {"enabled": False, "scene": None})
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
    await hub.changed()
    return sched


@app.put("/api/schedules/{sched_id}")
async def update_schedule(sched_id: str, body: dict = Body(...)) -> dict[str, Any]:
    try:
        sched = store.save_schedule(sched_id, body)
    except KeyError:
        raise HTTPException(404, "沒有這個排程") from None
    await hub.changed()
    return sched


@app.delete("/api/schedules/{sched_id}")
async def delete_schedule(sched_id: str) -> dict[str, Any]:
    store.delete_schedule(sched_id)
    return await _done()


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
    store.save()
    return await _done()


@app.post("/api/test-notify")
async def test_notify() -> dict[str, Any]:
    if not store.data["settings"].get("ntfy_topic"):
        raise HTTPException(400, "還沒有填通知主題")
    hub.notifier.send("測試通知", "收到這則通知，就代表手機通知設定好了")
    return {"ok": True}


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


@app.get("/")
async def index() -> FileResponse:
    return FileResponse(STATIC / "index.html", headers={"Cache-Control": "no-cache"})


@app.get("/sw.js")
async def service_worker() -> FileResponse:
    # service worker 要放在網站根目錄，才能管整個網站
    return FileResponse(STATIC / "sw.js", media_type="text/javascript", headers={"Cache-Control": "no-cache"})


app.mount("/static", StaticFiles(directory=STATIC), name="static")

"""網頁伺服器：手機上的網頁 App 和它用的 API。

GET  /api/state             目前全部的狀態
GET  /api/events            狀態一有變動就推送（Server-Sent Events）
POST /api/plugs/{id}/power  {"on": true/false}
PATCH /api/plugs/{id}       {"name", "room", "keep_on", "night", "watts"}
POST /api/off               {"room", "standby_only"} 關閉並記住，可以 /api/restore 復原
POST /api/restore
POST /api/rooms             {"name"}；PATCH/DELETE /api/rooms/{id}
POST /api/order             {"plugs": [...], "rooms": [...]}
PUT  /api/schedule、/api/settings
POST /api/discover          立刻重新找插座
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import Body, FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, StreamingResponse
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
    store.save()
    return await _done()


# ---- 排程與設定 ----


@app.put("/api/schedule")
async def set_schedule(body: dict = Body(...)) -> dict[str, Any]:
    sched = store.data["schedule"]
    if "enabled" in body:
        sched["enabled"] = bool(body["enabled"])
    for key in ("night_off", "morning_on"):
        if body.get(key):
            sched[key] = str(body[key])[:5]
    store.save()
    return await _done()


@app.put("/api/settings")
async def set_settings(body: dict = Body(...)) -> dict[str, Any]:
    settings = store.data["settings"]
    limits = {
        "household_monthly_kwh": (0, 5000),
        "standby_watts": (0, 100),
        "overload_watts": (50, 5000),
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


# ---- 網頁 ----


@app.get("/")
async def index() -> FileResponse:
    return FileResponse(STATIC / "index.html", headers={"Cache-Control": "no-cache"})


@app.get("/sw.js")
async def service_worker() -> FileResponse:
    # service worker 要放在網站根目錄，才能管整個網站
    return FileResponse(STATIC / "sw.js", media_type="text/javascript", headers={"Cache-Control": "no-cache"})


app.mount("/static", StaticFiles(directory=STATIC), name="static")

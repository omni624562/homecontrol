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
GET  /api/energy             用電（插座自己記錄的開機時間 × 瓦數）
GET  /api/plugs/{id}/usage  插座自己記錄的使用時間；POST /api/plugs/{id}/reboot 重新啟動
PUT/DELETE /api/kasa-rules  直接修改／刪除插座裡 Kasa App 設的排程
POST /api/kasa-rules/adopt  Kasa App 設的排程改由家庭中控管理
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
import secrets
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

import segno
from fastapi import Body, FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, RedirectResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles

from .hub import Hub, Locked
from .notify import Notifier
from .store import Store, _hms

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
            raise HTTPException(400, "沒有這個房間")
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
        raise HTTPException(404, "找不到這個房間")
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
    await hub.changed()
    return sched


@app.put("/api/schedules/{sched_id}")
async def update_schedule(sched_id: str, body: dict = Body(...)) -> dict[str, Any]:
    try:
        sched = store.save_schedule(sched_id, body)
    except KeyError:
        raise HTTPException(404, "沒有這個排程") from None
    hub.mark_native()
    await hub.changed()
    return sched


@app.delete("/api/schedules/{sched_id}")
async def delete_schedule(sched_id: str) -> dict[str, Any]:
    store.delete_schedule(sched_id)
    hub.mark_native()
    return await _done()


# ---- 插座本身的功能 ----


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

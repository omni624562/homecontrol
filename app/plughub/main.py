"""網頁伺服器：手機上的網頁 App 和它用的 API。

GET  /api/state             目前全部的狀態
GET  /api/events            狀態一有變動就推送（Server-Sent Events）
POST /api/plugs/{id}/power  {"on": true/false}
PATCH /api/plugs/{id}       {"name", "room", "keep_on", "night", "watts", "usage", "max_on_s"}
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
PUT  /api/away              離家模式 {"enabled", "start", "end", "plugs", "auto_on", "auto_h", "auto_off"}
GET/PUT /api/floorplan      訊號地圖（房間、裝置位置、Wi-Fi 基地台）；POST/GET/DELETE /api/floorplan/image 底圖
GET/PUT /api/sensing        Wi-Fi 感測（實驗）：訊號擾動、各房間動靜；{"enabled": false} 停止記錄
GET /api/sensing/replay     動靜回放：最近 24 小時每 5 分鐘一格
GET /api/sensing/week       一週動靜：每間房「星期幾 × 幾點」有動靜的比例
GET /api/net/events         斷線紀錄：外網、基地台卡住、Wi-Fi、插座、停電恢復
GET /api/net/plug-health    插座連線健檢：斷幾次、訊號、建議
GET/POST /api/cameras       網路攝影機（認人）；PUT/DELETE /api/cameras/{id}（room、enabled、alert、帳密）；GET …/{id}/snapshot.jpg 現在的畫面；POST …/{id}/segment 點一下就框；GET …/{id}/clip.mp4?t= 錄影片段；GET/PUT /api/recorder 錄影機；GET/PUT /api/vision GPU 辨識
GET /api/faces              認臉：認得的人、動作、登記（POST/DELETE /api/faces/enroll）、紀錄；PUT /api/faces/actions、PUT/DELETE /api/faces/{id}
PUT /api/cameras/access     誰可以看攝影機；POST …/access/send-code 驗證碼送到手機、POST …/access/claim 開通這台
GET /api/report/monthly     每月報告預覽（上個月）
GET/PUT /api/motion-rules   動靜自動化：{"rules": [{"room","plug","start","end","off_min","need_home","enabled"}]}
GET /api/locate/{id}         人在哪個房間（實驗）：每個房間教了幾筆、現在的判斷；POST …/train {"room"} 教 2 分鐘、DELETE …/train 停止、DELETE /api/locate/{id}?room= 清掉
GET  /api/energy             用電（插座自己記錄的開機時間 × 瓦數）
GET  /api/plugs/{id}/usage  插座自己記錄的使用時間；POST /api/plugs/{id}/reboot 重新啟動
PUT/DELETE /api/kasa-rules  直接修改／刪除插座裡 Kasa App 設的排程
POST /api/kasa-rules/adopt  Kasa App 設的排程改由家庭中控管理
PUT/DELETE /api/kasa-away   Kasa App 設的離家模式：啟用／停用、刪除
POST /api/cloud/unbind      斷開所有插座的 TP-Link 雲端（要帶 {"confirm": "斷開"}）
POST /api/discover          立刻重新找插座
PUT  /api/matter            Google Home 串接外掛回報配對狀態（只接受樹莓派本機）
GET  /api/matter/qr.svg     配對用的 QR code
GET  /api/auth              這台裝置配對了沒；POST /api/auth/pair {"code","name"} 配對（拿到 cookie）
POST /api/auth/send-code    配對碼送到手機通知；POST /api/auth/code 已配對的裝置產生配對碼
GET/PATCH/DELETE /api/auth/devices[/{id}]  已配對的裝置
GET  /api/tls               HTTPS 狀態；GET /api/tls/ca.crt 下載根憑證（不用配對）
GET  /api/health            健康檢查（不用配對）：{"ok", "version"}；主程式卡住回 503
POST /api/backup            立刻備份 data/

除了 /api/auth*、/api/health、/api/tls/ca.crt，所有 /api/ 都要先配對（樹莓派本機除外）。
GET  /matterbridge          拿通行證，轉到 Matterbridge 管理頁（:8283）
"""

from __future__ import annotations

import asyncio
import contextlib
import io
import json
import logging
import os
import re
import secrets
import time
import uuid
from contextlib import asynccontextmanager
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any

import segno
import uvicorn
from fastapi import Body, FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.gzip import GZipMiddleware

from . import auth as authmod
from . import camera as camera_mod
from . import vision as vision_mod
from . import segment as segment_mod
from . import tls as tlsmod
from .locate import MIN_SAMPLES as LOCATE_MIN, TRAIN_S as LOCATE_TRAIN_S
from .assistant import MODELS as ASSISTANT_MODELS, Assistant
from .claude_vision import FEATURES as CV_FEATURES, ClaudeVision
from .hub import APP_VERSION, SOURCE, Hub, Locked, arrive_rule
from .summary import build_summary
from .notify import LineError, Notifier
from .store import ICONS, Store, _hms, usage_clean, usage_watts

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

DATA_DIR = Path(os.environ.get("PLUGHUB_DATA", "/data"))
STATIC = Path(__file__).parent / "static"

store = Store(DATA_DIR)
hub = Hub(store, Notifier(store.dir / "secrets.json"))
assistant = Assistant(hub)
hub.assistant = assistant
hub.claude = ClaudeVision(hub)  # Claude 看影像（預設關）
hub.assistant = assistant
auth = authmod.Auth(DATA_DIR)
_LOGGER = logging.getLogger(__name__)


HTTPS_PORT = int(os.environ.get("PLUGHUB_HTTPS_PORT", "8443"))  # 0 = 不開 HTTPS


class _QuietServer(uvicorn.Server):
    """同一個程式裡多開一個 HTTPS 埠：訊號（Ctrl+C、Docker 停止）交給主要的那個處理。"""

    def capture_signals(self):  # type: ignore[override]
        return contextlib.nullcontext()


async def _https(app_: FastAPI) -> tuple[uvicorn.Server, asyncio.Task] | None:
    """開 HTTPS（8443）：憑證不在、快到期、IP 變了就先重簽。失敗只記一行，不影響原本的 HTTP。"""
    try:
        p = await asyncio.to_thread(tlsmod.ensure, DATA_DIR)
        cfg = uvicorn.Config(app_, host="0.0.0.0", port=HTTPS_PORT, ssl_keyfile=str(p["key"]), ssl_certfile=str(p["crt"]),
                             lifespan="off", proxy_headers=True, log_level="warning", timeout_graceful_shutdown=3)
        srv = _QuietServer(cfg)
        task = asyncio.create_task(srv.serve())
        _LOGGER.info("HTTPS 開在 %s 埠", HTTPS_PORT)
        return srv, task
    except Exception as err:  # noqa: BLE001
        _LOGGER.warning("HTTPS 沒有開成：%s", err)
        return None


async def _tls_renew(srv: uvicorn.Server) -> None:
    """每天檢查一次：IP 變了、快到期就重簽，直接換上（新的連線就用新的憑證，不用重開）。"""
    while True:
        await asyncio.sleep(86400)
        try:
            p = await asyncio.to_thread(tlsmod.ensure, DATA_DIR)
            if srv.config.ssl is not None:
                srv.config.ssl.load_cert_chain(str(p["crt"]), str(p["key"]))
        except Exception as err:  # noqa: BLE001
            _LOGGER.warning("檢查 HTTPS 憑證失敗：%s", err)


@asynccontextmanager
async def lifespan(app_: FastAPI):
    await hub.start()
    https = await _https(app_) if HTTPS_PORT else None
    renew = asyncio.create_task(_tls_renew(https[0])) if https else None
    yield
    if renew:
        renew.cancel()
    if https:
        https[0].should_exit = True
        try:
            await asyncio.wait_for(https[1], 5)
        except Exception:  # noqa: BLE001
            pass
    await hub.stop()
    hub.usage.save()
    hub.activity.maybe_save(force=True)


app = FastAPI(title="插座", lifespan=lifespan, docs_url=None, redoc_url=None)


class _Gzip:
    """壓縮網頁和 API 回應（手機在 Wi-Fi 邊緣、用 4G 時快很多）。

    即時推送（/api/events）不能壓：壓縮會把小訊息卡在緩衝區裡送不出去；圖片本來就壓過了也不壓。
    """
    SKIP = ("/api/events", "/api/floorplan/image")

    def __init__(self, app: Any) -> None:
        self.app = app
        self.gz = GZipMiddleware(app, minimum_size=1000, compresslevel=6)

    async def __call__(self, scope: Any, receive: Any, send: Any) -> None:
        path = scope.get("path", "") if scope["type"] == "http" else ""
        if path and not path.startswith(self.SKIP) and not path.endswith((".png", ".jpg", ".webp", ".ico")):
            await self.gz(scope, receive, send)
        else:
            await self.app(scope, receive, send)


app.add_middleware(_Gzip)

LOCAL = {"127.0.0.1", "::1", "localhost"}
# 不用配對就能用的：配對本身、健康檢查
OPEN_PATHS = {"/api/auth", "/api/auth/pair", "/api/auth/send-code", "/api/health", "/api/tls/ca.crt"}  # 根憑證是公開的，還沒配對的裝置也要能先裝


def _is_local(request: Request) -> bool:
    return bool(request.client and request.client.host in LOCAL)


def _arp_mac(ip: str) -> str | None:
    """樹莓派的 ARP 表（容器用主機網路，看得到）：IP → MAC。"""
    try:
        with open("/proc/net/arp", encoding="ascii") as f:
            next(f, None)
            for line in f:
                cols = line.split()
                if len(cols) >= 4 and cols[0] == ip and cols[2] != "0x0":
                    return cols[3].upper()
    except OSError:
        pass
    return None


def _mac_of(ip: str) -> str | None:
    """這個 IP 現在是哪台裝置：先看樹莓派的 ARP 表（最直接），再問路由器的連線清單。"""
    mac = _arp_mac(ip)
    if mac:
        return mac
    for mac, c in hub.router.clients.items():
        if c.get("ip") == ip and hub.router.online(mac):
            return mac
    return None


def trusted_devices() -> dict[str, str]:
    """不用配對的裝置：「誰在家」登記的家人手機、網路裝置裡勾了「信任」的。MAC → 名稱。"""
    out: dict[str, str] = {}
    for mac, d in store.data["net_devices"].items():
        if d.get("trusted"):
            out[mac] = d.get("label") or hub.router.name_of(mac)
    for person in store.data["people"]:
        for mac in person["macs"]:
            out[mac] = f"{person['name']}的手機"
    return out


def _trusted(request: Request) -> dict[str, Any] | None:
    if not request.client:
        return None
    mac = _mac_of(request.client.host)
    name = trusted_devices().get(mac or "")
    return {"id": f"mac:{mac}", "name": name, "trusted": True} if name else None


def _token(request: Request) -> str | None:
    header = request.headers.get("authorization", "")
    if header.lower().startswith("bearer "):
        return header[7:].strip()
    return request.cookies.get(authmod.COOKIE)


@app.middleware("http")
async def require_pairing(request: Request, call_next):
    path = request.url.path
    guarded = path.startswith("/api/") or path == "/matterbridge"
    if guarded and request.method not in ("GET", "HEAD", "OPTIONS"):
        # 別的網站不能借瀏覽器的通行證來按開關
        origin = request.headers.get("origin")
        if origin and origin != "null":
            from urllib.parse import urlsplit

            if urlsplit(origin).netloc != request.headers.get("host", ""):
                return JSONResponse({"detail": "不接受其他網站的請求"}, status_code=403)
    if guarded and path not in OPEN_PATHS and not _is_local(request):
        device = auth.check(_token(request))
        if device and request.client:
            mac = _mac_of(request.client.host)
            mac = hub.router.canon(mac) if mac else None
            if mac and device.get("mac") != mac:
                device["mac"] = mac
                auth.save()
        device = device or _trusted(request)
        if not device:
            return JSONResponse({"detail": "這台裝置還沒配對", "unpaired": True}, status_code=401)
        request.state.device = device
    response = await call_next(request)
    # 使用統計：會改東西的操作，用處理它的函式名稱記一次（不記內容、不記是誰）
    if guarded and request.method in ("POST", "PUT", "PATCH", "DELETE") and response.status_code < 400:
        endpoint = request.scope.get("endpoint")
        name = getattr(endpoint, "__name__", "")
        if name and name not in USAGE_SKIP:
            hub.usage.hit(f"api:{name}")
    return response


def _plug(plug_id: str):
    if plug_id not in hub.plugs:
        raise HTTPException(404, "找不到這個插座")
    return hub.plugs[plug_id]


async def _done() -> dict[str, Any]:
    await hub.changed()
    return {"ok": True}


# ---- 配對 ----

_last_sent: float | None = None  # 上次送配對碼（monotonic；開機不到 1 分鐘時 0 會被誤判成剛送過）


@app.get("/api/auth")
async def auth_status(request: Request) -> dict[str, Any]:
    device = auth.check(_token(request)) or _trusted(request)
    return {
        "paired": bool(device) or _is_local(request),
        "device": {"id": device["id"], "name": device["name"]} if device else None,
        "can_send": bool(hub.notifier.status().get("line")),
        "locked_for": auth.locked_for(),
    }


@app.post("/api/auth/pair")
async def auth_pair(request: Request, body: dict = Body(...)) -> Response:
    if auth.locked_for():
        raise HTTPException(429, f"輸錯太多次，請 {max(1, round(auth.locked_for() / 60))} 分鐘後再試")
    got = auth.pair(str(body.get("code") or ""), str(body.get("name") or ""), request.headers.get("user-agent", ""))
    if not got:
        raise HTTPException(403, "配對碼不對或已經過期")
    token, device = got
    _LOGGER.info("新裝置配對：%s", device["name"])
    hub.notifier.send("有新裝置配對", f"「{device['name']}」可以控制家庭中控了；不是你的話到設定 → 已配對的裝置移除")
    response = JSONResponse({"ok": True, "device": {"id": device["id"], "name": device["name"]}})
    response.set_cookie(authmod.COOKIE, token, max_age=authmod.COOKIE_MAX_AGE, httponly=True, samesite="strict", path="/")
    return response


@app.post("/api/auth/send-code")
async def auth_send_code() -> dict[str, Any]:
    """配對畫面：把配對碼送到手機通知（LINE），也印在伺服器紀錄裡。"""
    global _last_sent
    if _last_sent is not None and time.monotonic() - _last_sent < 60:
        raise HTTPException(429, "剛剛送過了，1 分鐘後再試")
    _last_sent = time.monotonic()
    code = auth.new_code()
    _LOGGER.warning("配對碼：%s（10 分鐘內有效）", code)
    hub.notifier.send("配對碼", f"{code}\n10 分鐘內有效。不是你要求的話，可以不用理它")
    return {"ok": True}


@app.post("/api/auth/code")
async def auth_new_code() -> dict[str, Any]:
    """已經配對的裝置幫新裝置產生配對碼。"""
    return {"code": auth.new_code(), "expires_in": authmod.CODE_TTL}


@app.get("/api/auth/devices")
async def auth_devices(request: Request) -> dict[str, Any]:
    device = getattr(request.state, "device", None)
    online = {m for m in hub.router.clients if hub.router.online(m)}
    return {
        "devices": auth.public(device["id"] if device else None),
        # 自動認得的（不用配對）
        "trusted": [{"mac": m, "name": n, "online": m in online, "current": bool(device and device["id"] == f"mac:{m}")}
                    for m, n in trusted_devices().items()],
    }


@app.patch("/api/auth/devices/{device_id}")
async def auth_rename(device_id: str, body: dict = Body(...)) -> dict[str, Any]:
    if not auth.rename(device_id, str(body.get("name") or "")):
        raise HTTPException(404, "找不到這台裝置")
    return {"ok": True}


@app.delete("/api/auth/devices/{device_id}")
async def auth_remove(device_id: str) -> dict[str, Any]:
    if not auth.remove(device_id):
        raise HTTPException(404, "找不到這台裝置")
    return {"ok": True}


# ---- 健康檢查、版本、備份 ----


@app.get("/api/health")
async def health() -> Response:
    ok = hub.watchdog.healthy()
    return JSONResponse(
        {"ok": ok, "version": APP_VERSION, "stalled_s": round(hub.watchdog.stalled_for(), 1)},
        status_code=200 if ok else 503,
    )


@app.post("/api/backup")
async def backup_now() -> dict[str, Any]:
    if hub.backup.busy:
        raise HTTPException(409, "正在備份")
    hub.backup.busy = True
    result = await asyncio.to_thread(hub.backup.run)
    await hub.changed()
    if not result.get("ok"):
        raise HTTPException(500, result.get("error") or "備份失敗")
    return result


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
    if "short" in body:
        meta.short = (body["short"] or "").strip()[:8] or None
    if "icon" in body:
        icon = body["icon"] or None
        if icon is not None and icon not in ICONS:
            raise HTTPException(400, "沒有這個圖示")
        meta.icon = icon
    if "room" in body:
        room = body["room"]
        if room is not None and not store.room(room):
            raise HTTPException(400, "沒有這個區域")
        meta.room = room
    for key in ("keep_on", "night", "matter", "risky"):
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
    if body.get("usage"):
        try:
            meta.usage = usage_clean(body["usage"])
        except ValueError as err:
            raise HTTPException(400, str(err)) from err
        meta.watts = usage_watts(meta.usage)
    elif "watts" in body:
        watts = body["watts"]
        meta.watts = float(watts) if watts not in (None, "", 0) and float(watts) > 0 else None
        meta.usage = None
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


def _fp_room(r: dict, w: float, h: float) -> dict[str, Any]:
    """地圖上的區域；pts = 不是長方形時的轉角（4～24 個點），外框照轉角算。"""
    room: dict[str, Any] = {"id": str(r.get("id"))[:20], "name": str(r.get("name", ""))[:20],
                            "x": _num(r.get("x"), 0, w), "y": _num(r.get("y"), 0, h), "w": _num(r.get("w"), 20, w), "h": _num(r.get("h"), 20, h)}
    pts = r.get("pts")
    if isinstance(pts, list) and 4 < len(pts) <= 24 and all(isinstance(p, (list, tuple)) and len(p) == 2 for p in pts):
        room["pts"] = [[_num(p[0], 0, w), _num(p[1], 0, h)] for p in pts]
        xs, ys = [p[0] for p in room["pts"]], [p[1] for p in room["pts"]]
        room.update(x=min(xs), y=min(ys), w=max(20, max(xs) - min(xs)), h=max(20, max(ys) - min(ys)))
    lb = r.get("label")  # 自己拖過的名稱位置：離區域外框左上角多遠
    if isinstance(lb, (list, tuple)) and len(lb) == 2:
        room["label"] = [_num(lb[0], 0, room["w"]), _num(lb[1], 0, room["h"])]
    return room


@app.put("/api/floorplan")
async def put_floorplan(body: dict = Body(...)) -> dict[str, Any]:
    """{"w","h","meters","rooms":[{id,name,x,y,w,h,pts}],"walls":[{id,x1,y1,x2,y2}],"doors":[{id,wall,t,w,flip}],"items":{key:{x,y,z}},"aps":[{id,name,ssid,z}]}

    meters = 地圖寬度是幾公尺（算距離用）；z = 離地高度（公尺），None = 用預設值。
    """
    fp = store.data["floorplan"]
    w = _num(body.get("w", fp["w"]), 200, 4000)
    h = _num(body.get("h", fp["h"]), 200, 4000)
    if "rooms" in body:
        fp["rooms"] = [_fp_room(r, w, h) for r in body["rooms"][:40]] if body["rooms"] is not None else None
    if "walls" in body:  # 實牆：線段
        fp["walls"] = [{"id": str(x.get("id"))[:20], "x1": _num(x.get("x1"), 0, w), "y1": _num(x.get("y1"), 0, h),
                        "x2": _num(x.get("x2"), 0, w), "y2": _num(x.get("y2"), 0, h)}
                       for x in (body["walls"] or [])[:300] if isinstance(x, dict)]
    if "doors" in body:  # 門窗：開在哪道牆、在牆的哪裡（0～1）、多寬、往哪開；kind：win 一般窗、fwin 落地窗，沒有就是門
        walls = {x["id"] for x in fp.get("walls") or []}
        fp["doors"] = [{"id": str(x.get("id"))[:20], "wall": str(x.get("wall"))[:20], "t": _num(x.get("t"), 0, 1),
                        "w": _num(x.get("w"), 10, 600), "flip": int(_num(x.get("flip") or 0, 0, 3)),
                        **({"kind": x["kind"]} if x.get("kind") in ("win", "fwin") else {})}
                       for x in (body["doors"] or [])[:150] if isinstance(x, dict) and str(x.get("wall")) in walls]
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
async def sensing(minutes: int = 60, range: str = "1h", lite: bool = False) -> dict[str, Any]:  # noqa: A002
    """Wi-Fi 感測（實驗）：每台插座每分鐘的訊號強度和擾動；range = 24h／7d／30d 看長期紀錄。

    lite=1（地圖每 10 秒用）：只要現在的擾動、房間動靜、網路裝置的連線摘要，不要每分鐘的紀錄。
    """
    if range in hub.SENSE_RANGES:
        return hub.sensing_history(range)
    return hub.sensing_report(max(5, min(60, minutes)), lite=lite)


@app.get("/api/motion-rules")
async def motion_rules() -> dict[str, Any]:
    """動靜自動化：房間有人走動就開插座，沒動靜幾分鐘後關掉。"""
    return {"rules": store.data.get("motion_rules") or [], "state": hub.motion_rules_state()}


def _hm(v: Any) -> str:
    v = str(v or "")
    return v if re.fullmatch(r"([01]\d|2[0-3]):[0-5]\d", v) else ""


@app.put("/api/motion-rules")
async def set_motion_rules(body: dict = Body(...)) -> dict[str, Any]:
    rooms = {r["id"] for r in (store.data.get("floorplan") or {}).get("rooms") or []}
    rules = []
    for x in (body.get("rules") or [])[:20]:
        if not isinstance(x, dict) or x.get("room") not in rooms or x.get("plug") not in hub.plugs:
            continue
        start, end = _hm(x.get("start")), _hm(x.get("end"))
        if not start or not end:
            start = end = ""
        rules.append({"id": str(x.get("id") or uuid.uuid4().hex[:8])[:20], "room": x["room"], "plug": x["plug"], "start": start, "end": end,
                      "off_min": int(_num(x.get("off_min") or 5, 1, 120)), "need_home": bool(x.get("need_home", True)),
                      "enabled": bool(x.get("enabled", True))})
    store.data["motion_rules"] = rules
    store.save()
    return await motion_rules()


# ---- 回家自動開：誰（的手機連上 Wi-Fi）回家 → 打開插座或執行情境 ----

def _arrive_out() -> dict[str, Any]:
    return {"rules": store.data.get("arrive_rules") or [], "suggestions": hub.arrive_suggestions()}


def _arrive_clean(x: dict[str, Any], old: dict[str, Any] | None = None) -> dict[str, Any]:
    """檢查、整理一條規則；不對的地方回 400（說明哪裡不對）。"""
    r = arrive_rule(**(old or {}))
    people = {p["id"] for p in store.data["people"]}
    if "who" in x:
        if x["who"] != "any" and x["who"] not in people:
            raise HTTPException(400, "找不到這位家人")
        r["who"] = x["who"]
    for k in ("enabled", "only_empty"):
        if k in x:
            r[k] = bool(x[k])
    if "when" in x:
        if x["when"] not in ("all", "dark", "range"):
            raise HTTPException(400, "時段不對")
        r["when"] = x["when"]
    if "start" in x or "end" in x:
        r["start"], r["end"] = _hm(x.get("start", r["start"])), _hm(x.get("end", r["end"]))
    if r["when"] == "range" and (not r["start"] or not r["end"] or r["start"] == r["end"]):
        raise HTTPException(400, "自訂時段要填開始和結束時間")
    if "days" in x:
        if x["days"] not in ("all", "weekday", "weekend"):
            raise HTTPException(400, "哪幾天不對")
        r["days"] = x["days"]
    if "kind" in x:
        if x["kind"] not in ("plugs", "scene"):
            raise HTTPException(400, "要做的事不對")
        r["kind"] = x["kind"]
    if "plugs" in x:
        r["plugs"] = [p for p in dict.fromkeys(x["plugs"] or []) if p in hub.plugs][:20]
    if "scene" in x:
        r["scene"] = x["scene"] if x["scene"] and store.scene(x["scene"]) else None
    if "for_min" in x:
        r["for_min"] = int(_num(x["for_min"] or 0, 0, 720))
    if r["kind"] == "plugs" and not r["plugs"]:
        raise HTTPException(400, "至少選一個插座")
    if r["kind"] == "scene" and not r["scene"]:
        raise HTTPException(400, "請選一個情境")
    return r


@app.get("/api/arrive-rules")
async def arrive_rules() -> dict[str, Any]:
    return _arrive_out()


@app.post("/api/arrive-rules")
async def add_arrive_rule(body: dict = Body(...)) -> dict[str, Any]:
    rules = store.data.get("arrive_rules") or []
    if len(rules) >= 30:
        raise HTTPException(400, "規則最多 30 條")
    rules.append(_arrive_clean(body))
    store.data["arrive_rules"] = rules
    store.save()
    return _arrive_out()


@app.put("/api/arrive-rules/{rid}")
async def edit_arrive_rule(rid: str, body: dict = Body(...)) -> dict[str, Any]:
    rules = store.data.get("arrive_rules") or []
    for i, r in enumerate(rules):
        if r["id"] == rid:
            rules[i] = _arrive_clean(body, r)
            store.save()
            return _arrive_out()
    raise HTTPException(404, "找不到這條規則")


@app.delete("/api/arrive-rules/{rid}")
async def del_arrive_rule(rid: str) -> dict[str, Any]:
    rules = store.data.get("arrive_rules") or []
    store.data["arrive_rules"] = [r for r in rules if r["id"] != rid]
    if len(store.data["arrive_rules"]) == len(rules):
        raise HTTPException(404, "找不到這條規則")
    store.save()
    return _arrive_out()


@app.get("/api/sensing/replay")
async def sensing_replay(hours: int = 24) -> dict[str, Any]:
    """動靜回放：每 5 分鐘一格，每台裝置的擾動、每個房間的分數。"""
    return hub.sensing_replay(max(1, min(48, hours)))


@app.get("/api/sensing/week")
async def sensing_week(days: int = 28) -> dict[str, Any]:
    """一週動靜：最近 days 天（7～30），每間房每個「星期幾 × 幾點」有動靜的比例。"""
    return await hub.sensing_week(max(7, min(30, days)))


# ---- 網路攝影機（認人）----
# 看畫面、改攝影機設定：只有「可以看攝影機」名單裡的裝置（樹莓派本機除外）。
# 名單是空的時候沒有人能看；用送到手機通知的驗證碼開通第一台，之後由有權限的人勾選。


def _me(request: Request) -> str | None:
    """發出請求的是哪台裝置：配對的裝置 ID、家人手機的「mac:…」；樹莓派本機回 "local"。"""
    if _is_local(request):
        return "local"
    device = getattr(request.state, "device", None)
    return device["id"] if device else None


def _same(dev_id: str) -> set[str]:
    """同一台裝置的所有代號：配對的裝置 ID ↔ 它的 MAC（家人手機、信任的裝置用「mac:…」）。"""
    out = {dev_id}
    if dev_id.startswith("mac:"):
        out |= {d["id"] for d in auth.devices if d.get("mac") and f"mac:{d['mac']}" == dev_id}
    else:
        mac = next((d.get("mac") for d in auth.devices if d["id"] == dev_id), None)
        if mac:
            out.add(f"mac:{mac}")
    return out


def _can_view(request: Request) -> bool:
    me = _me(request)
    return me == "local" or (me is not None and bool(_same(me) & set(hub.cameras.viewers)))


def _need_view(request: Request) -> None:
    if not _can_view(request):
        raise HTTPException(403, "這台裝置沒有看攝影機的權限")


def _camera_candidates() -> list[dict[str, Any]]:
    """可以給權限的裝置：配對過的、家人的手機和信任的裝置。同一支手機（配對時記下的 MAC 一樣）合併成一個。"""
    trusted = trusted_devices()
    out: list[dict[str, Any]] = []
    used: set[str] = set()
    for d in auth.devices:
        mac = d.get("mac")
        if mac and mac in trusted:
            used.add(mac)
            out.append({"id": d["id"], "name": f"{d['name']}（{trusted[mac]}）", "kind": "paired", "ids": [d["id"], f"mac:{mac}"]})
        else:
            out.append({"id": d["id"], "name": d["name"], "kind": "paired", "ids": [d["id"]]})
    out += [{"id": f"mac:{m}", "name": n, "kind": "trusted", "ids": [f"mac:{m}"]} for m, n in trusted.items() if m not in used]
    return out


def _camera_access(request: Request) -> dict[str, Any]:
    can = _can_view(request)
    cands = _camera_candidates()
    me = _me(request)
    me = next((c["id"] for c in cands if me in c["ids"]), me)  # 合併後的代號（畫面標「這台」用）
    acc: dict[str, Any] = {"can_view": can, "me": me, "count": len(hub.cameras.viewers)}
    if can:
        viewers = set(hub.cameras.viewers)
        # 名單用合併後的代號表示：同一台裝置任一個代號有權限就算有
        acc["viewers"] = [{"id": c["id"], "name": c["name"]} for c in cands if viewers & set(c["ids"])]
        known = {i for c in cands for i in c["ids"]}
        acc["viewers"] += [{"id": v, "name": "已移除的裝置"} for v in hub.cameras.viewers if v not in known]
        acc["candidates"] = [{k: c[k] for k in ("id", "name", "kind")} for c in cands]
    return acc


_cam_code_sent: float | None = None


@app.get("/api/cameras")
def cameras_list(request: Request) -> dict[str, Any]:
    """攝影機清單和現在有沒有看到人（不含帳密）；access：這台裝置能不能看畫面、誰可以看。"""
    return {"cameras": hub.cameras.public(), "access": _camera_access(request)}


@app.put("/api/cameras/access")
async def cameras_access(request: Request, body: dict = Body(...)) -> dict[str, Any]:
    """改「可以看攝影機」的名單：{"viewers": [裝置 ID…]}（只有已經有權限的裝置能改）。"""
    _need_view(request)
    ids = {c["id"]: c["ids"] for c in _camera_candidates()}
    # 選了合併的那一個：同一台裝置的所有代號都算有權限
    hub.cameras.viewers = list(dict.fromkeys(i for v in body.get("viewers") or [] if str(v) in ids for i in ids[str(v)]))
    hub.cameras.save()
    return {"access": _camera_access(request)}


@app.post("/api/cameras/access/send-code")
async def cameras_access_code(request: Request) -> dict[str, Any]:
    """把開通看攝影機的驗證碼送到手機通知（LINE），也印在伺服器紀錄裡。"""
    global _cam_code_sent
    if _me(request) is None:
        raise HTTPException(401, "這台裝置還沒配對")
    if _cam_code_sent is not None and time.monotonic() - _cam_code_sent < 60:
        raise HTTPException(429, "剛剛送過了，1 分鐘後再試")
    _cam_code_sent = time.monotonic()
    code = hub.cameras.code.new()
    _LOGGER.warning("看攝影機的驗證碼：%s（10 分鐘內有效）", code)
    hub.notifier.send("看攝影機畫面的驗證碼", f"{code}\n10 分鐘內有效。不是你要求的話，不要告訴別人", "high")
    return {"ok": True}


@app.post("/api/cameras/access/claim")
async def cameras_access_claim(request: Request, body: dict = Body(...)) -> dict[str, Any]:
    """輸入驗證碼：對了就把這台裝置加進「可以看攝影機」的名單。"""
    me = _me(request)
    if me is None or me == "local":
        raise HTTPException(400, "這台裝置不能開通")
    if hub.cameras.code.locked_for():
        raise HTTPException(429, f"輸錯太多次，{hub.cameras.code.locked_for() // 60 + 1} 分鐘後再試")
    if not hub.cameras.code.claim(str(body.get("code") or "")):
        raise HTTPException(400, "驗證碼不對或已經過期")
    if me not in hub.cameras.viewers:
        hub.cameras.viewers.append(me)
        hub.cameras.save()
    name = next((c["name"] for c in _camera_candidates() if me in c["ids"]), me)
    hub.notifier.send("有裝置開通了攝影機畫面", f"{name} 現在可以看攝影機畫面了。不是你開通的話，到設定 → 攝影機把它拿掉")
    return {"access": _camera_access(request)}


@app.post("/api/cameras")
async def cameras_add(request: Request, body: dict = Body(...)) -> dict[str, Any]:
    """新增攝影機：{"host", "port", "user", "pwd", "name"}；先登入看看，帳密錯就不加。"""
    _need_view(request)
    host = str(body.get("host") or "").strip()
    if not host:
        raise HTTPException(400, "請填攝影機的 IP")
    cam = {"host": host, "port": int(body.get("port") or 88), "user": str(body.get("user") or ""), "pwd": str(body.get("pwd") or "")}
    try:
        info = await asyncio.to_thread(camera_mod.dev_info, cam)
    except Exception as err:  # noqa: BLE001
        raise HTTPException(400, f"連不上攝影機：{err}") from None
    cam.update(id=uuid.uuid4().hex[:8], name=str(body.get("name") or info["name"] or host), model=info["model"],
               room=None, enabled=True, alert=True)
    hub.cameras.list.append(cam)
    hub.cameras.save()
    await hub.changed()
    return {"camera": next(c for c in hub.cameras.public() if c["id"] == cam["id"])}


@app.get("/api/cameras/{cam_id}/snapshot.jpg")
async def cameras_snapshot(cam_id: str, request: Request) -> Response:
    """看攝影機現在的畫面（一張 JPEG，不存檔）。只有「可以看攝影機」名單裡的裝置拿得到。"""
    _need_view(request)
    cam = hub.cameras.get(cam_id)
    if not cam:
        raise HTTPException(404, "找不到這台攝影機")
    hub.usage.hit("view:camera", every=300)  # 即時畫面一直抓圖：5 分鐘內算一次
    try:
        data = await asyncio.to_thread(camera_mod.snapshot, cam)
    except Exception as err:  # noqa: BLE001
        raise HTTPException(502, f"讀不到畫面：{err}") from None
    return Response(data, media_type="image/jpeg", headers={"Cache-Control": "no-store"})


@app.put("/api/cameras/{cam_id}")
async def cameras_update(cam_id: str, request: Request, body: dict = Body(...)) -> dict[str, Any]:
    """改攝影機：{"name", "room"（地圖的區域 ID，null = 不指定）, "enabled", "alert", "user", "pwd"}"""
    _need_view(request)
    cam = hub.cameras.get(cam_id)
    if not cam:
        raise HTTPException(404, "找不到這台攝影機")
    if "name" in body:
        cam["name"] = str(body["name"]).strip() or cam["host"]
    if "room" in body:
        rooms = {r.get("id") for r in (store.data.get("floorplan") or {}).get("rooms") or []}
        cam["room"] = body["room"] if body["room"] in rooms else None
    for key in ("enabled", "alert", "faces", "pets", "fall", "pet_notify"):
        if key in body:
            cam[key] = bool(body[key])
    if body.get("role") in ("entry", "room"):
        cam["role"] = body["role"]
        if body.get("defaults"):  # 選了門口／房間：常用的功能先幫忙打開
            cam.update(camera_mod.ROLE_DEFAULTS[body["role"]])
    if isinstance(body.get("ignore"), list):  # 不要看的地方：每塊是多邊形頂點 [[x, y], …]（或舊的方框 [x, y, w, h]），0～1
        zones = []
        for z in body["ignore"][:6]:
            pts = _poly(z)
            if pts:
                zones.append(pts)
        cam["ignore"] = zones
    if "light" in body:
        cam["light"] = body["light"] if body["light"] in hub.plugs else None
    if isinstance(body.get("sound"), dict):  # 聽到這些就通知：{"on", "alarm"|"glass"|"scream"|"dog": "urgent"|"normal"|"off"}
        e = body["sound"]
        cam["sound"] = {"on": bool(e.get("on")), **{k: (e.get(k) if e.get(k) in ("urgent", "normal", "off") else d)
                                                    for k, d in (("alarm", "urgent"), ("glass", "urgent"), ("scream", "urgent"), ("dog", "normal"))}}
        hub.gpu._pushed = None
    if isinstance(body.get("still"), dict):  # 很久沒動靜提醒：{"on", "window": "07:00-22:00", "min": 0（自動）或分鐘}
        e = body["still"]
        win = str(e.get("window") or "")
        cam["still"] = {"on": bool(e.get("on")), "window": win if re.fullmatch(r"\d{2}:\d{2}-\d{2}:\d{2}", win) else "07:00-22:00",
                        "min": int(_num(e.get("min") or 0, 0, 480))}
    if isinstance(body.get("empty_off"), dict):  # 沒人一陣子就關掉：{"on", "plugs": [插座 ID], "min": 分鐘, "quiet": "23:00-07:00", "ask": 先問}
        e = body["empty_off"]
        quiet = str(e.get("quiet") or "")
        cam["empty_off"] = {"on": bool(e.get("on")), "plugs": [p for p in (e.get("plugs") or []) if p in hub.plugs][:8],
                            "min": int(_num(e.get("min") or 30, 5, 240)), "ask": bool(e.get("ask")),
                            "quiet": quiet if re.fullmatch(r"\d{2}:\d{2}-\d{2}:\d{2}", quiet) else ""}
    if "user" in body or "pwd" in body:
        test = {**cam, "user": str(body.get("user", cam.get("user", ""))), "pwd": str(body.get("pwd", cam.get("pwd", "")))}
        try:
            await asyncio.to_thread(camera_mod.dev_info, test)
        except Exception as err:  # noqa: BLE001
            raise HTTPException(400, f"登入失敗：{err}") from None
        cam.update(user=test["user"], pwd=test["pwd"])
        hub.cameras.state.pop(cam_id, None)
    if not cam.get("enabled"):
        hub.cameras.state.pop(cam_id, None)
    hub.cameras.save()
    await hub.changed()
    return {"cameras": hub.cameras.public()}


def _poly(z: Any) -> list[list[float]] | None:
    """畫面上的一塊區域 → 0～1 的多邊形頂點（3～12 個點；外框太小就不收）。舊的方框 [x, y, w, h] 也收。"""
    try:
        pts = camera_mod.zone_points(z)
        pts = [[round(min(1.0, max(0.0, float(x))), 4), round(min(1.0, max(0.0, float(y))), 4)] for x, y in pts][:12]
    except (TypeError, ValueError, IndexError):
        raise HTTPException(400, "框的位置不對") from None
    if len(pts) < 3:
        return None
    _, _, w, h = vision_mod.poly_bbox(pts)
    return pts if w >= 0.02 and h >= 0.02 else None


def _act(a: Any) -> dict[str, Any]:
    """觸發後要做什麼：{"notify": off/away/always, "scene": 情境 ID, "dark": 情境只在天黑後, "taken": 包裹、袋子被拿走也通知（預設要）}"""
    a = a if isinstance(a, dict) else {}
    return {"notify": a.get("notify") if a.get("notify") in ("off", "away", "always") else "off",
            "scene": a.get("scene") if a.get("scene") and store.scene(a.get("scene")) else None, "dark": bool(a.get("dark")),
            "taken": a.get("taken") is not False}


@app.put("/api/cameras/{cam_id}/zones")
async def cameras_zones(cam_id: str, request: Request, body: dict = Body(...)) -> dict[str, Any]:
    """區域：{"zones": [{"id","name","kind": area/object/door,"poly","linger": 秒,"act": {...}}]}（整份換掉；記住的樣子會保留）"""
    _need_view(request)
    cam = hub.cameras.get(cam_id)
    if not cam:
        raise HTTPException(404, "找不到這台攝影機")
    old = {z["id"]: z for z in cam.get("zones") or []}
    out = []
    for z in (body.get("zones") or [])[:8]:
        pts = _poly(z.get("poly"))
        kind = z.get("kind")
        if not pts or kind not in ("area", "object", "door"):
            continue
        zid = str(z.get("id") or uuid.uuid4().hex[:6])[:12]
        prev = old.get(zid) or {}
        same = prev.get("poly") == pts and prev.get("kind") == kind
        out.append({"id": zid, "name": str(z.get("name") or "區域").strip()[:12], "kind": kind, "poly": pts,
                    "linger": int(_num(z.get("linger") or 0, 0, 600)), "act": _act(z.get("act")),
                    "refs": prev.get("refs") or [] if same else [], "ref_when": prev.get("ref_when") or [] if same else []})  # 形狀或種類改了：記住的樣子作廢
        if not same:
            hub.cameras.state.get(cam_id, {}).get("zones", {}).pop(zid, None)
    cam["zones"] = out
    hub.cameras.save()
    return {"cameras": hub.cameras.public()}


@app.post("/api/cameras/{cam_id}/zones/{zid}/ref")
async def cameras_zone_ref(cam_id: str, zid: str, request: Request) -> dict[str, Any]:
    """現在的樣子是正常的（門：關著的樣子；東西多了／不見了：正常的樣子）。"""
    _need_view(request)
    cam = hub.cameras.get(cam_id)
    if not cam or not any(z["id"] == zid for z in cam.get("zones") or []):
        raise HTTPException(404, "找不到這個區域")
    try:
        jpeg = await asyncio.to_thread(camera_mod.snapshot, cam)
        n = hub.zone_reference(cam, zid, jpeg)
    except Exception as err:  # noqa: BLE001
        raise HTTPException(502, f"記不起來：{err}") from None
    hub.cameras.save()
    z = next(x for x in cam["zones"] if x["id"] == zid)
    return {"cameras": hub.cameras.public(), "refs": n, "is_night": bool(hub.cameras.state.get(cam_id, {}).get("night")), **camera_mod.ref_counts(z)}


segmenter = segment_mod.Segmenter()


@app.post("/api/cameras/{cam_id}/segment")
async def cameras_segment(cam_id: str, request: Request, body: dict = Body(...)) -> dict[str, Any]:
    """點一下就框：{"x", "y"}（0～1）→ {"shapes": [{"poly", "area", "score"}]}（由小到大）。第一次約 4 秒，60 秒內再點很快。"""
    _need_view(request)
    cam = hub.cameras.get(cam_id)
    if not cam:
        raise HTTPException(404, "找不到這台攝影機")
    if not segment_mod.available():
        raise HTTPException(503, "還沒有找邊的模型（要重新建置）")
    try:
        x, y = (min(1.0, max(0.0, float(body[k]))) for k in ("x", "y"))
    except (KeyError, TypeError, ValueError):
        raise HTTPException(400, "要給點的位置 x、y") from None
    t = time.monotonic()
    try:
        shapes = await _segment_gpu(cam, x, y, bool(body.get("fresh")))  # 先問 Jetson（GPU）
        if shapes is None:  # 沒設定、連不上：樹莓派自己算
            if body.get("fresh") or not segmenter.has_frame(cam_id):
                jpeg = await asyncio.to_thread(camera_mod.snapshot, cam)
                await asyncio.to_thread(segmenter.encode, cam_id, jpeg)
            shapes = await asyncio.to_thread(segmenter.segment, cam_id, x, y)
            asyncio.get_running_loop().call_later(segment_mod.IDLE_FREE + 5, segmenter.free_if_idle)
    except Exception as err:  # noqa: BLE001
        raise HTTPException(502, f"找不到邊：{err}") from None
    return {"shapes": shapes, "ms": round((time.monotonic() - t) * 1000)}


_seg_sent: dict[str, float] = {}  # 攝影機 → 上次把畫面送給 Jetson 編碼的時間


async def _segment_gpu(cam: dict[str, Any], x: float, y: float, fresh: bool) -> list[dict[str, Any]] | None:
    if not hub.gpu.url:
        return None
    cid = cam["id"]
    jpeg = None
    if fresh or time.time() - _seg_sent.get(cid, 0) > segment_mod.KEEP_EMB - 10:
        jpeg = await asyncio.to_thread(camera_mod.snapshot, cam)
    r = await asyncio.to_thread(hub.gpu.segment, cid, x, y, jpeg)
    if r == "need":  # Jetson 那邊的編碼過期了：送新畫面
        jpeg = await asyncio.to_thread(camera_mod.snapshot, cam)
        r = await asyncio.to_thread(hub.gpu.segment, cid, x, y, jpeg)
    if isinstance(r, list) and jpeg:
        _seg_sent[cid] = time.time()
    return r if isinstance(r, list) else None


CLIP_DIR = Path("/tmp/plughub-clips")


def _lan_url(raw: Any) -> str:
    """家裡網路的 http://IP:port（空字串 = 不用）；其他的擋掉。"""
    import ipaddress

    url = str(raw or "").strip().rstrip("/")
    if url:
        m = re.fullmatch(r"http://(\d{1,3}(?:\.\d{1,3}){3}):(\d{2,5})", url)
        try:
            ok = bool(m) and ipaddress.ip_address(m.group(1)).is_private
        except ValueError:
            ok = False
        if not ok:
            raise HTTPException(400, "要是家裡網路的位址，例如 http://10.0.2.99:8200")
    return url


@app.post("/api/cameras/{cam_id}/empty-off/cancel")
async def cameras_empty_cancel(cam_id: str, request: Request) -> dict[str, Any]:
    """「沒人一陣子就關掉」先問的時候按「不要關」：這次不關（有人再出現、再離開才會重新算）。"""
    _need_view(request)
    if not hub.cameras.get(cam_id):
        raise HTTPException(404, "找不到這台攝影機")
    hub.empty_cancel(cam_id)
    return {"cameras": hub.cameras.public()}


@app.get("/api/activity")
async def activity_get(request: Request, range: str = "today") -> dict[str, Any]:  # noqa: A002
    """活動熱圖：每台攝影機的每小時有人秒數、畫面格子；每個區域（有攝影機的）加總；compare＝這週跟上週。"""
    _need_view(request)
    rng = range if range in ("today", "week", "lastweek", "compare") else "today"
    cams, rooms = {}, {}
    for c in hub.cameras.list:
        a = hub.activity.summary(c["id"], "week" if rng == "compare" else rng)
        cams[c["id"]] = {**a, "name": c.get("name"), "room": c.get("room")}
        if c.get("room"):
            r = rooms.setdefault(c["room"], {"seconds": 0, "last": 0})
            r["seconds"] += a["seconds"]
            if rng == "compare":
                r["last"] += hub.activity.summary(c["id"], "lastweek_same")["seconds"]
    return {"range": rng, "cams": cams, "rooms": rooms}


@app.get("/api/visitors")
async def visitors_get(request: Request) -> dict[str, Any]:
    """常來的人：自動分好的群（7 天內來 3 次以上、還沒取名字）和取了名字的。"""
    _need_view(request)
    v = hub.visitors
    return {"groups": [{k: g[k] for k in ("id", "count", "first", "last", "weekdays", "hours", "thumbs")} for g in v.groups()],
            "named": [{"id": n["id"], "name": n["name"], "n": n["n"]} for n in v.named]}


@app.put("/api/visitors/{gid}")
async def visitors_name(gid: str, request: Request, body: dict = Body(...)) -> dict[str, Any]:
    """幫一群取名字：{"name": "清潔阿姨"} → 之後再來就是常來的人。"""
    _need_view(request)
    name = str(body.get("name") or "").strip()
    if not name:
        raise HTTPException(400, "要給名字")
    if hub.visitors.name_group(gid, name) is None:
        raise HTTPException(404, "找不到這一群（可能已經過 7 天）")
    return await visitors_get(request)


@app.delete("/api/visitors/named/{nid}")
async def visitors_forget(nid: str, request: Request) -> dict[str, Any]:
    _need_view(request)
    if not hub.visitors.forget(nid):
        raise HTTPException(404, "找不到")
    return await visitors_get(request)


@app.get("/api/visitors/thumb/{name}")
async def visitors_thumb(name: str, request: Request) -> Response:
    _need_view(request)
    if not re.fullmatch(r"visitor_[0-9a-f]{10}\.jpg", name):
        raise HTTPException(404, "沒有這張")
    p = hub.visitors.thumbs / name
    if not p.exists():
        raise HTTPException(404, "沒有這張（可能已經過 7 天）")
    return Response(p.read_bytes(), media_type="image/jpeg", headers={"Cache-Control": "private, max-age=3600"})


@app.get("/api/claude-vision")
async def claude_vision_get(request: Request) -> dict[str, Any]:
    """Claude 看影像的設定和這個月看了幾次。"""
    _need_view(request)
    return hub.claude.status()


@app.put("/api/claude-vision")
async def claude_vision_put(request: Request, body: dict = Body(...)) -> dict[str, Any]:
    """{"on": 總開關, "describe"|"ask"|"second"|"story"|"classify": 每一項, "cams": [可以送的攝影機 ID]}（只改有給的）"""
    _need_view(request)
    cfg = dict(store.data["settings"].get("claude_vision") or {})
    for k in ("on", *CV_FEATURES):
        if k in body:
            cfg[k] = bool(body[k])
    if isinstance(body.get("cams"), list):
        ids = {c["id"] for c in hub.cameras.list}
        cfg["cams"] = [c for c in body["cams"] if c in ids]
    if cfg.get("on") and not cfg.get("cams"):  # 剛打開、還沒選：先開門口的攝影機
        cfg["cams"] = [c["id"] for c in hub.cameras.list if c.get("role") == "entry"]
    store.data["settings"]["claude_vision"] = cfg
    store.save()
    return hub.claude.status()


@app.get("/api/recorder")
async def recorder_get(request: Request) -> dict[str, Any]:
    """錄影機（另一台主機全天錄影）的狀態。"""
    _need_view(request)
    return hub.recorder.public()


@app.put("/api/recorder")
async def recorder_put(request: Request, body: dict = Body(...)) -> dict[str, Any]:
    """{"url": "http://10.0.2.99:8200"}（空字串＝不用錄影機；只能是家裡網路的位址）、{"keep_all": 天, "keep_event": 天}。"""
    _need_view(request)
    if "keep_all" in body or "keep_event" in body:
        st = store.data["settings"]
        if "keep_all" in body:
            st["rec_keep_all"] = int(_num(body["keep_all"], 1, 14))
        if "keep_event" in body:
            st["rec_keep_event"] = int(_num(body["keep_event"], 1, 90))
        st["rec_keep_event"] = max(int(st.get("rec_keep_event") or 30), int(st.get("rec_keep_all") or 3))
        store.save()
        if "url" not in body:
            await asyncio.to_thread(hub.recorder.refresh, hub.cameras.list)
            return hub.recorder.public()
    url = _lan_url(body.get("url"))
    store.data["settings"]["recorder_url"] = url
    store.save()
    await asyncio.to_thread(hub.recorder.refresh, hub.cameras.list)
    return hub.recorder.public()


@app.get("/api/vision")
async def vision_get(request: Request) -> dict[str, Any]:
    """GPU 辨識（另一台主機）的狀態；每台攝影機現在用哪個在認（gpu / cpu）。"""
    _need_view(request)
    engines = {cid: st.get("engine") for cid, st in hub.cameras.state.items()}
    return {**hub.gpu.public(), "engines": engines}


@app.put("/api/vision")
async def vision_put(request: Request, body: dict = Body(...)) -> dict[str, Any]:
    """{"url": "http://10.0.2.99:8210"}（空字串＝只用樹莓派自己的模型）。只能是家裡網路的位址。"""
    _need_view(request)
    url = _lan_url(body.get("url"))
    store.data["settings"]["vision_url"] = url
    store.save()
    hub.gpu.error, hub.gpu._fail_at = None, 0.0
    return {**hub.gpu.public(), "engines": {}}


@app.get("/api/cameras/{cam_id}/frame.jpg")
async def cameras_frame(cam_id: str, request: Request, t: float, w: int = 640) -> Response:
    """錄影裡 t（秒，epoch）那一刻的一張畫面（搜尋結果、摘要的縮圖）。只有「可以看攝影機」的裝置拿得到。"""
    _need_view(request)
    if not hub.cameras.get(cam_id) or not hub.recorder.url:
        raise HTTPException(404, "沒有錄影")
    w = 320 if w <= 320 else 640 if w <= 640 else 1280
    CLIP_DIR.mkdir(mode=0o700, exist_ok=True)
    safe = re.sub(r"[^\w-]", "", cam_id)
    path = CLIP_DIR / f"{safe}-{int(t)}-{w}.jpg"
    if not path.exists():
        try:
            data = await asyncio.to_thread(hub.recorder.frame, cam_id, t, w)
        except Exception as err:  # noqa: BLE001
            code = getattr(err, "code", None)
            raise HTTPException(404 if code == 404 else 502, "那個時間沒有錄到" if code == 404 else "錄影機連不上") from None
        path.write_bytes(data)
    return FileResponse(path, media_type="image/jpeg", headers={"Cache-Control": "private, max-age=3600"})


@app.get("/api/recordings/search")
async def recordings_search(request: Request, q: str, days: int = 7, cam: str | None = None) -> dict[str, Any]:
    """打字找錄影：{"hits": [{"cam", "name", "t", "cls", "box", "score"}]}。"""
    _need_view(request)
    q = q.strip()[:80]
    if not q:
        return {"hits": []}
    res = await asyncio.to_thread(hub.gpu.search, q, max(1, min(31, days)), cam)
    if res is None:
        raise HTTPException(503, "錄影分析連不上（Jetson）")
    names = {c["id"]: c.get("name") or c["id"] for c in hub.cameras.list}
    hub.usage.hit("view:search", every=0)
    return {"hits": [{**h, "name": names.get(h["cam"], h["cam"])} for h in res.get("hits") or [] if h["cam"] in names], "classes": res.get("classes") or []}


@app.get("/api/summary")
async def summary_get(request: Request, day: str | None = None) -> dict[str, Any]:
    """某一天（預設昨天）每台攝影機的摘要：紀錄裡的事件＋Jetson 半夜重看錄影的結果。"""
    _need_view(request)
    try:
        d = date.fromisoformat(day) if day else date.today() - timedelta(days=1)
    except ValueError:
        raise HTTPException(400, "日期格式是 YYYY-MM-DD") from None
    vis = await asyncio.to_thread(hub.gpu.summary, d.isoformat())
    out = build_summary(d, hub.cameras.list, hub.face_log.items, vis)
    stories = store.data.setdefault("summary_story", {})
    out["story"] = stories.get(d.isoformat())
    out["story_pending"] = False
    if out["story"] is None and d < date.today() and hub.claude.allowed("story"):
        out["story_pending"] = True
        if d.isoformat() not in _story_busy:
            _story_busy.add(d.isoformat())
            asyncio.get_running_loop().create_task(_write_story(d, out))
    return out


_story_busy: set[str] = set()


async def _write_story(d: date, summary: dict[str, Any]) -> None:
    """Claude 把那天的摘要寫成一段話（只用「可以送」的攝影機；值得看的事件各附一張錄影畫面）。存起來，一天只寫一次。"""
    try:
        cv = hub.claude
        cams = [c for c in summary["cams"] if c["id"] in (cv.cfg.get("cams") or [])]
        if not cams:
            return
        lines, frames = [], []
        for c in cams:
            hl = "、".join(f"{datetime.fromtimestamp(h['t']).strftime('%H:%M')} {h['text']}" for h in c["highlights"]) or "沒有特別的事"
            lines.append(f"{c['name']}：次數 {json.dumps(c['counts'], ensure_ascii=False)}；值得看的：{hl}")
            for h in c["highlights"][:2]:
                if len(frames) < 4 and hub.recorder.url:
                    with contextlib.suppress(Exception):
                        frames.append(await asyncio.to_thread(hub.recorder.frame, c["id"], h["t"], 640))
        prompt = (f"這是 {d.month}/{d.day} 家裡攝影機的紀錄（附的照片依序是值得看的事件那一刻）：\n" + "\n".join(lines) +
                  "\n用 2～3 句話寫成給家人看的當天摘要（像家人在講，先講重要的；平常的進出用一句帶過）。")
        text = await cv.look("story", None, frames, prompt, 400)  # 沒有錄影畫面就只用文字
        if text:
            stories = store.data.setdefault("summary_story", {})
            stories[d.isoformat()] = text[:500]
            for k in sorted(stories)[:-14]:
                del stories[k]
            store.save()
    finally:
        _story_busy.discard(d.isoformat())


@app.get("/api/cameras/{cam_id}/sound.wav")
async def cameras_sound(cam_id: str, request: Request, t: int) -> Response:
    """聽到警報、玻璃破掉…那一刻前後各 10 秒的聲音。只有「可以看攝影機」的裝置拿得到。"""
    _need_view(request)
    if not hub.cameras.get(cam_id):
        raise HTTPException(404, "找不到這台攝影機")
    data = await asyncio.to_thread(hub.gpu.sound_clip, cam_id, t)
    if not data:
        raise HTTPException(404, "沒有這段聲音（只留 7 天）")
    return Response(data, media_type="audio/wav", headers={"Cache-Control": "private, max-age=3600"})


@app.get("/api/cameras/{cam_id}/clip.mp4")
async def cameras_clip(cam_id: str, request: Request, t: float, before: float = 10, after: float = 20) -> Response:
    """錄影機剪出 t（秒，epoch）前 before 秒到後 after 秒的影片。只有「可以看攝影機」的裝置拿得到。"""
    _need_view(request)
    if not hub.cameras.get(cam_id):
        raise HTTPException(404, "找不到這台攝影機")
    if not hub.recorder.url:
        raise HTTPException(404, "還沒有設定錄影機")
    before, after = min(120.0, max(0.0, before)), min(180.0, max(1.0, after))
    if t + after > time.time() - 5:
        raise HTTPException(425, "影片還在錄，等一下再看")
    CLIP_DIR.mkdir(mode=0o700, exist_ok=True)
    for old in CLIP_DIR.glob("*.mp4"):  # 剪好的暫存一小時
        if time.time() - old.stat().st_mtime > 3600:
            old.unlink(missing_ok=True)
    safe = re.sub(r"[^\w-]", "", cam_id)
    path = CLIP_DIR / f"{safe}-{int(t)}-{int(before)}-{int(after)}.mp4"
    if not path.exists():
        try:
            data = await asyncio.to_thread(hub.recorder.clip, cam_id, t - before, t + after)
        except Exception as err:  # noqa: BLE001
            code = getattr(err, "code", None)
            raise HTTPException(404 if code == 404 else 502, "這段時間沒有錄到" if code == 404 else f"錄影機連不上：{getattr(err, 'reason', err)}") from None
        tmp = path.with_suffix(".tmp")
        tmp.write_bytes(data)
        tmp.replace(path)
    hub.usage.hit("view:clip", every=60)
    return FileResponse(path, media_type="video/mp4", headers={"Cache-Control": "private, no-store"})


@app.put("/api/cameras/{cam_id}/lines")
async def cameras_lines(cam_id: str, request: Request, body: dict = Body(...)) -> dict[str, Any]:
    """線：{"lines": [{"id","name","a": [x,y],"b": [x,y],"in": {...},"out": {...}}]}；從線的右邊走到左邊（畫面上箭頭指的方向）算「回來」"""
    _need_view(request)
    cam = hub.cameras.get(cam_id)
    if not cam:
        raise HTTPException(404, "找不到這台攝影機")
    out = []
    for ln in (body.get("lines") or [])[:4]:
        try:
            a = [round(min(1.0, max(0.0, float(v))), 4) for v in ln["a"]][:2]
            b = [round(min(1.0, max(0.0, float(v))), 4) for v in ln["b"]][:2]
        except (KeyError, TypeError, ValueError):
            raise HTTPException(400, "線的位置不對") from None
        if len(a) != 2 or len(b) != 2 or ((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2) ** 0.5 < 0.05:
            continue
        out.append({"id": str(ln.get("id") or uuid.uuid4().hex[:6])[:12], "name": str(ln.get("name") or "線").strip()[:12], "a": a, "b": b,
                    "in": _act(ln.get("in")), "out": _act(ln.get("out"))})
    cam["lines"] = out
    hub.cameras.state.get(cam_id, {}).pop("lines", None)
    hub.cameras.save()
    return {"cameras": hub.cameras.public()}





@app.delete("/api/cameras/{cam_id}")
async def cameras_delete(cam_id: str, request: Request) -> dict[str, Any]:
    _need_view(request)
    cam = hub.cameras.get(cam_id)
    if not cam:
        raise HTTPException(404, "找不到這台攝影機")
    hub.cameras.list.remove(cam)
    hub.cameras.state.pop(cam_id, None)
    hub.cameras.save()
    await hub.changed()
    return {"cameras": hub.cameras.public()}


# ---- 認臉（都要「可以看攝影機」的權限）----


def _faces_report() -> dict[str, Any]:
    known = {p["id"]: p for p in hub.gallery.public()}
    family = [{"id": p["id"], "name": p["name"], "kind": "family", "samples": known.get(p["id"], {}).get("samples", 0),
               "at": known.get(p["id"], {}).get("at")} for p in store.data["people"]]
    guests = [g for g in known.values() if g["kind"] == "guest"]
    return {"family": family, "guests": guests, "actions": store.data["settings"].get("face_actions") or {},
            "enroll": hub.enroll_status(), "result": hub.enroll_result, "error": hub.face_error, "slot": hub.face_slot(),
            "log": list(reversed(hub.face_log.items[-300:]))}


@app.get("/api/faces")
def faces_get(request: Request) -> dict[str, Any]:
    """認得的人（家人、訪客）、認出家人時的動作、登記狀態、最近的認臉紀錄。"""
    _need_view(request)
    return _faces_report()


@app.post("/api/faces/enroll")
async def faces_enroll(request: Request, body: dict = Body(...)) -> dict[str, Any]:
    """開始登記臉：{"person": 家人 ID 或訪客 ID（空白 = 新訪客）, "name": 新訪客的名字, "camera": 攝影機 ID}"""
    _need_view(request)
    cam = hub.cameras.get(str(body.get("camera") or ""))
    if not cam or not cam.get("enabled"):
        raise HTTPException(400, "請選一台啟用中的攝影機")
    pid = str(body.get("person") or "")
    fam = next((p for p in store.data["people"] if p["id"] == pid), None)
    if fam:
        name, kind = fam["name"], "family"
    elif pid in hub.gallery.people and hub.gallery.people[pid].get("kind") == "guest":
        name, kind = hub.gallery.people[pid]["name"], "guest"
    else:
        name = str(body.get("name") or "").strip()[:20]
        if not name:
            raise HTTPException(400, "請填訪客的名字")
        pid, kind = f"g-{uuid.uuid4().hex[:6]}", "guest"
    hub.enroll_start(pid, name, kind, cam["id"])
    return _faces_report()


@app.delete("/api/faces/enroll")
async def faces_enroll_cancel(request: Request) -> dict[str, Any]:
    _need_view(request)
    hub.enroll = None
    return _faces_report()


@app.put("/api/faces/actions")
async def faces_actions(request: Request, body: dict = Body(...)) -> dict[str, Any]:
    """認出家人時：{家人 ID: {"notify": 回家時通知}}（回家要開什麼改在 /api/arrive-rules）"""
    _need_view(request)
    ids = {p["id"] for p in store.data["people"]}
    acts = dict(store.data["settings"].get("face_actions") or {})
    for pid, cfg in body.items():
        if pid not in ids or not isinstance(cfg, dict):
            continue
        cur = dict(acts.get(pid) or {})
        if "notify" in cfg:
            cur["notify"] = bool(cfg["notify"])
        acts[pid] = cur
    store.data["settings"]["face_actions"] = acts
    store.save()
    return _faces_report()


@app.put("/api/faces/{pid}")
async def faces_update(pid: str, request: Request, body: dict = Body(...)) -> dict[str, Any]:
    """訪客：{"name", "notify": 來了要不要通知}"""
    _need_view(request)
    g = hub.gallery.people.get(pid)
    if not g:
        raise HTTPException(404, "找不到")
    if "name" in body and str(body["name"]).strip():
        g["name"] = str(body["name"]).strip()[:20]
    if "notify" in body:
        g["notify"] = bool(body["notify"])
    hub.gallery.save()
    return _faces_report()


@app.delete("/api/faces/{pid}")
async def faces_delete(pid: str, request: Request) -> dict[str, Any]:
    """刪掉這個人的臉部特徵（訪客整個移除）。"""
    _need_view(request)
    if not hub.gallery.remove(pid):
        raise HTTPException(404, "找不到")
    return _faces_report()


@app.get("/api/faces/log/{item_id}.jpg")
async def faces_thumb(item_id: str, request: Request) -> Response:
    """認臉紀錄裡陌生人的小圖。"""
    _need_view(request)
    path = hub.face_log.thumb_path(item_id)
    if not path:
        raise HTTPException(404, "沒有這張圖（可能超過 7 天已經刪掉）")
    return Response(path.read_bytes(), media_type="image/jpeg", headers={"Cache-Control": "private, no-store"})


# ---- 安全連線（HTTPS）----


@app.get("/api/tls")
def tls_info(request: Request) -> dict[str, Any]:
    """HTTPS 的狀態：這次是不是用 HTTPS 連的、埠、根憑證的指紋、伺服器憑證的期限和包含的位址。"""
    try:
        data = tlsmod.info(DATA_DIR) if HTTPS_PORT else {"ready": False}
    except Exception as err:  # noqa: BLE001
        data = {"ready": False, "error": str(err)}
    return {**data, "port": HTTPS_PORT, "secure": request.url.scheme == "https"}


@app.get("/api/tls/ca.crt")
def tls_ca() -> Response:
    """下載家裡專用的根憑證（公開的；私鑰不會離開樹莓派）。"""
    path = DATA_DIR / "tls" / "ca.crt"
    if not path.exists():
        raise HTTPException(404, "還沒有憑證")
    return Response(path.read_bytes(), media_type="application/x-x509-ca-cert",
                    headers={"Content-Disposition": 'attachment; filename="homecontrol-ca.crt"', "Cache-Control": "no-store"})


@app.get("/api/net/plug-health")
def net_plug_health() -> dict[str, Any]:
    """插座連線健檢：最近 30 天每個插座斷了幾次、訊號多強、建議怎麼做。"""
    return {"plugs": hub.plug_health()}


@app.get("/api/report/monthly")
def report_monthly() -> dict[str, Any]:
    """每月報告的內容（設定頁預覽用）：上個月。"""
    return {"text": hub.monthly_text()}


@app.get("/api/net/events")
async def net_events(days: int = 30) -> dict[str, Any]:
    return hub.net_events_report(max(1, min(90, days)))


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
    if "auto_on" in body:  # 大家出門超過 auto_h 小時就自動打開
        away["auto_on"] = bool(body["auto_on"])
    if "auto_h" in body:
        away["auto_h"] = min(72.0, max(1.0, float(body["auto_h"])))
    if "auto_off" in body:  # 有人回家就自動關閉
        away["auto_off"] = bool(body["auto_off"])
    if "enabled" in body:
        away.pop("auto_started", None)
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
    if "new_device_alert" in body:
        settings["new_device_alert"] = bool(body["new_device_alert"])
    if "power_restore" in body:
        settings["power_restore"] = bool(body["power_restore"])
    if "monthly" in body:  # 每月 1 號推播上個月的摘要
        settings["monthly"] = bool(body["monthly"])
    if isinstance(body.get("goodnight"), dict):  # 晚安檢查：{"at": "23:30", "mode": notify/off/none, "keep": [插座 ID…]}
        gn = settings.setdefault("goodnight", {})
        g = body["goodnight"]
        if "at" in g:
            hms = _hms(g["at"])
            if not hms:
                raise HTTPException(400, "時間格式不對")
            gn["at"] = hms[:5]
        if g.get("mode") in ("notify", "off", "none"):
            gn["mode"] = g["mode"]
        if isinstance(g.get("keep"), list):
            gn["keep"] = [str(x) for x in g["keep"] if str(x) in hub.plugs]
    if isinstance(body.get("remind"), dict):  # 主動提醒：開太久、早上會下雨、天氣特報、空品
        rem = settings.setdefault("remind", {})
        for key in ("long_on", "rain", "warn", "air", "anomaly", "tier"):
            if key in body["remind"]:
                rem[key] = bool(body["remind"][key])
    if isinstance(body.get("presence"), dict):
        pres = settings.setdefault("presence", {})
        for key in ("away_scene",):  # 回家要做的事改在「回家自動開」（/api/arrive-rules）
            if key in body["presence"]:
                v = body["presence"][key]
                pres[key] = v if v and store.scene(v) else None
        if "grace_min" in body["presence"]:
            pres["grace_min"] = min(60, max(2, int(body["presence"]["grace_min"])))
        if body["presence"].get("left_on") in ("notify", "off", "none"):  # 沒人在家還有電器開著：通知／自動關／不管
            pres["left_on"] = body["presence"]["left_on"]
        if "risky_off" in body["presence"]:  # 高風險電器：大家出門就關（False = 只緊急通知）
            pres["risky_off"] = bool(body["presence"]["risky_off"])
    if "weather" in body:  # 首頁顯示天氣（每 10 分鐘向氣象署查一次）
        settings["weather"] = bool(body["weather"])
        if settings["weather"]:
            hub.recheck_calendar()
            hub.weather.reset()
    if "life_layout" in body:  # 生活頁的卡片排列：三欄，每欄是卡片代號的順序；hidden 是藏起來的
        lay = body["life_layout"]
        cards = {"alerts", "weather", "bike", "bus", "garbage", "outage"}
        if lay is None:
            settings.pop("life_layout", None)
        elif isinstance(lay, dict) and isinstance(lay.get("cols"), list):
            seen: set[str] = set()
            cols = []
            for col in lay["cols"][:3]:
                cols.append([c for c in (col if isinstance(col, list) else []) if c in cards and not (c in seen or seen.add(c))])
            while len(cols) < 3:
                cols.append([])
            for c in sorted(cards - seen):  # 漏掉的補在最後一欄
                cols[2].append(c)
            settings["life_layout"] = {"cols": cols, "hidden": sorted({c for c in lay.get("hidden") or [] if c in cards})}
    if "home_layout" in body:  # 首頁房間卡片的排列：{欄數: [[區域 id…], …]}；某個欄數給 null 就恢復自動排列
        lay = body["home_layout"]
        cur = dict(settings.get("home_layout") or {})
        if lay is None:
            cur = {}
        elif isinstance(lay, dict):
            ids = {r["id"] for r in store.rooms} | {"_none"}
            for n, cols in lay.items():
                if not (isinstance(n, str) and n.isdigit() and 2 <= int(n) <= 8):
                    continue
                if not isinstance(cols, list):
                    cur.pop(n, None)
                    continue
                seen: set[str] = set()
                cur[n] = [[x for x in (c if isinstance(c, list) else []) if isinstance(x, str) and x in ids and not (x in seen or seen.add(x))]
                          for c in cols[: int(n)]]
        if cur:
            settings["home_layout"] = cur
        else:
            settings.pop("home_layout", None)
    if "home_side" in body:  # 首頁右邊那一欄卡片的順序；null 恢復預設
        side = body["home_side"]
        cards = ("ask", "people", "energy", "next")
        if isinstance(side, list):
            order = [c for c in dict.fromkeys(x for x in side if isinstance(x, str)) if c in cards]
            settings["home_side"] = order + [c for c in cards if c not in order]
        else:
            settings.pop("home_side", None)
    if "weekly" in body:  # 每週日晚上的摘要推播
        settings["weekly"] = bool(body["weekly"])
    if "matter_scenes" in body:  # 情境也放到 Google Home（打開 = 執行）
        settings["matter_scenes"] = bool(body["matter_scenes"])
    if "night_enhance" in body:  # 夜間畫面增強（Jetson 辨識前先提亮；錄影和看到的畫面不變）
        settings["night_enhance"] = bool(body["night_enhance"])
        hub.gpu._pushed = None
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
        bus["routes"] = list(dict.fromkeys(str(r).strip()[:12] for r in body["bus_routes"] if str(r).strip()))[:10]
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


def _locate_person(pid: str) -> dict[str, Any]:
    p = next((x for x in store.data["people"] if x["id"] == pid), None)
    if p is None:
        raise HTTPException(404, "找不到這個人")
    return p


@app.get("/api/locate/{pid}")
async def locate_get(pid: str) -> dict[str, Any]:
    """人在哪個房間（實驗）：每個房間教了幾筆、現在的判斷、是不是正在教。"""
    p = _locate_person(pid)
    counts = hub.locator.counts(p["macs"])
    return {"rooms": [{**r, "count": counts.get(r["id"], 0)} for r in hub.locate_rooms()],
            "where": hub.person_where(p), "training": hub.locator.training_left(p["macs"]),
            "min": LOCATE_MIN, "train_s": LOCATE_TRAIN_S, "online": any(hub.router.online(m) for m in p["macs"])}


@app.post("/api/locate/{pid}/train")
async def locate_train(pid: str, body: dict = Body(...)) -> dict[str, Any]:
    """拿著這個人的手機站在某個房間：記 2 分鐘訊號。"""
    p = _locate_person(pid)
    room = str(body.get("room") or "")
    if room not in {r["id"] for r in hub.locate_rooms()}:
        raise HTTPException(400, "沒有這個房間")
    if not any(hub.router.online(m) for m in p["macs"]):
        raise HTTPException(409, "這個人的手機現在沒連著 Wi-Fi")
    hub.locator.train(p["macs"], room)
    return {"ok": True, "training": hub.locator.training_left(p["macs"])}


@app.delete("/api/locate/{pid}/train")
async def locate_cancel(pid: str) -> dict[str, Any]:
    hub.locator.cancel(_locate_person(pid)["macs"])
    return {"ok": True}


@app.delete("/api/locate/{pid}")
async def locate_forget(pid: str, room: str | None = None) -> dict[str, Any]:
    """清掉教過的訊號（room 不給就全部清掉）。"""
    hub.locator.forget(_locate_person(pid)["macs"], room)
    store.save()
    return {"ok": True}


@app.get("/api/net")
async def net() -> dict[str, Any]:
    return hub.net_report()


@app.patch("/api/net/devices/{mac}")
async def edit_net_device(mac: str, body: dict = Body(...)) -> dict[str, Any]:
    """{"label": 自己取的名字 或 null, "map": 放到訊號地圖, "trusted": 不用配對}"""
    m = _mac(mac)
    if not m:
        raise HTTPException(400, "MAC 格式不對")
    d = store.data["net_devices"].setdefault(m, {"first": time.time()})
    if "label" in body:
        label = str(body["label"] or "").strip()[:30]
        d["label"] = label or None
    if "trusted" in body:
        d["trusted"] = bool(body["trusted"])
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


class _Immutable(StaticFiles):
    """檔名有內容雜湊（改了就換檔名），瀏覽器可以放心存一年、不用每次回來問。"""

    def file_response(self, *args: Any, **kwargs: Any) -> Response:
        resp = super().file_response(*args, **kwargs)
        resp.headers["Cache-Control"] = "public, max-age=31536000, immutable"
        return resp


if (WEB / "assets").is_dir():
    app.mount("/assets", _Immutable(directory=WEB / "assets"), name="web")

app.mount("/static", StaticFiles(directory=STATIC), name="static")


# ---- 功能使用統計、設定進度 ----

USAGE_SKIP = {"usage_hit", "setup_skip"}  # 統計本身不算


@app.post("/api/usage")
async def usage_hit(body: dict = Body(...)) -> dict[str, Any]:
    """畫面回報看了哪些頁：{"keys": ["page:map", …]}（只收 page: 開頭，一次最多 20 個）。"""
    n = 0
    for key in list(body.get("keys") or [])[:20]:
        if isinstance(key, str) and key.startswith("page:") and hub.usage.hit(key):
            n += 1
    return {"ok": True, "count": n}


@app.get("/api/usage")
async def usage_get() -> dict[str, Any]:
    return hub.usage.summary()


def _setup_items() -> list[dict[str, Any]]:
    """還沒設定完的功能：做好了沒、去哪裡設定。畫面另外加「這台裝置用 HTTPS」。"""
    data = store.data
    live = [pid for pid in hub.plugs]
    fp = data["floorplan"]
    placed = {k.replace(":", "").lower() for k in (fp.get("items") or {})}
    placed |= {k[2:].lower() for k in (fp.get("items") or {}) if k.startswith("o:")}
    cams = [c for c in hub.cameras.list if c.get("enabled", True)]
    rooms_cams = [c for c in cams if c.get("role", "room") == "room"]
    entry_cams = [c for c in cams if c.get("role") == "entry"]
    b = hub.backup.report()
    items = [
        {"id": "line", "title": "LINE 通知", "hint": "提醒、攝影機、異常都靠它送到手機", "done": hub.notifier.status()["line"], "href": "#settings/s-notify"},
        {"id": "people", "title": "登記家人的手機", "hint": "知道誰在家：出門自動關、回家開燈、沒人在家時的通知", "done": any(p.get("macs") for p in data["people"]), "href": "#net"},
        {"id": "rooms", "title": "每個插座分好房間", "hint": f"還有 {sum(1 for pid in live if not store.meta(pid).room)} 個沒分", "done": all(store.meta(pid).room for pid in live), "href": "#edit"},
        {"id": "map", "title": "畫家中地圖", "hint": "畫房間、把插座放上去，地圖上就能直接開關", "done": bool(fp.get("rooms")) and all(pid.split("-")[0].lower() in placed or pid.lower() in placed for pid in live), "href": "#map"},
        {"id": "scene", "title": "建一個情境", "hint": "例如「睡覺」一次關掉好幾個插座", "done": bool(data["scenes"]), "href": "#edit"},
        {"id": "schedule", "title": "建一個排程", "hint": "固定時間、日出日落自動開關", "done": bool(store.schedules), "href": "#schedule"},
        {"id": "backup", "title": "自動備份", "hint": "設定壞掉、換樹莓派時可以還原", "done": bool(b.get("configured")) and bool(b.get("count")), "href": "#settings/s-sys"},
    ]
    if cams:
        items.append({"id": "cam_view", "title": "設定誰可以看攝影機", "hint": "只有勾選的裝置能看畫面", "done": bool(hub.cameras.viewers), "href": "#cameras"})
    if rooms_cams:
        left = [c["name"] for c in rooms_cams if not c.get("room")]
        items.append({"id": "cam_room", "title": "攝影機選房間", "hint": f"還沒選：{'、'.join(left)}" if left else "有人就開燈、地圖上顯示有人", "done": not left, "href": "#cameras"})
    if entry_cams:
        doors = [(c, z) for c in entry_cams for z in c.get("zones") or [] if z.get("kind") == "door"]
        left = [f"{c['name']}的{z['name']}" for c, z in doors if not all(camera_mod.ref_counts(z).values())]
        hint = (f"{'、'.join(left)}：門關著時，白天、晚上各記一次" if left else "開門偵測已經可以用") if doors else "在門口攝影機「新增偵測」選「門」，點出門的形狀"
        items.append({"id": "cam_door", "title": "門口攝影機：圈出門、記住關門的樣子", "hint": hint, "done": bool(doors) and not left, "href": "#cameras"})
    if cams:
        items.append({"id": "faces", "title": "登錄家人的臉", "hint": "認出家人就做對應的事，陌生人才通知", "done": any(p.get("kind") == "family" for p in hub.gallery.people.values()), "href": "#cameras"})
    skip = set(data["settings"].get("setup_skip") or [])
    for it in items:
        it["skipped"] = it["id"] in skip and not it["done"]
    return items


@app.get("/api/setup")
async def setup_get() -> dict[str, Any]:
    return {"items": _setup_items()}


@app.put("/api/setup/skip")
async def setup_skip(body: dict = Body(...)) -> dict[str, Any]:
    """{"id": 項目, "skip": true/false}：這項不需要（不再算進進度）。"""
    sid = str(body.get("id") or "")[:20]
    skip = [x for x in store.data["settings"].get("setup_skip") or [] if x != sid]
    if body.get("skip"):
        skip.append(sid)
    store.data["settings"]["setup_skip"] = skip
    store.save()
    return {"items": _setup_items()}


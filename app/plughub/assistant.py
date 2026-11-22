"""問家裡：用 Claude（Anthropic API）打字或說話控制、查詢、建排程。

Claude 只能用這裡開給它的工具，全部走家庭中控原本的功能：
- 讀：插座狀態、用電、開關紀錄、排程、誰在家、訊號地圖
- 做：開關插座、定時關閉、執行情境（有「防呆」的插座、全部關閉 → 交給使用者按確認）
- 建排程、情境：只產生草稿，使用者按「建立」才會真的建立

每次對話會把需要的家裡資料（裝置名稱、開關狀態、誰在家…）送到 Anthropic 處理；
金鑰只存在樹莓派（data/secrets.json），不會回傳給瀏覽器。
"""

from __future__ import annotations

import json
import logging
import time
import uuid
from datetime import date, datetime, timedelta
from typing import TYPE_CHECKING, Any

import anthropic
from anthropic import beta_async_tool

from . import geom

if TYPE_CHECKING:
    from .hub import Hub

_LOGGER = logging.getLogger(__name__)

MODELS = {
    "claude-opus-5-5": {"name": "Claude Opus 5.5", "in": 4.0, "out": 20.0},
    "claude-haiku-5-5": {"name": "Claude Haiku 5.5（省錢）", "in": 0.10, "out": 0.50},
}
DEFAULT_MODEL = "claude-opus-5-5"
DEFAULT_CAP = 5.0  # 每月上限（美元）；家庭中控沒有登入，家裡 Wi-Fi 上的人都能用，所以要有上限
DAYS = "一二三四五六日"

SYSTEM = """你是「家庭中控」的助理，幫一個台灣家庭控制和查詢家裡的 TP-Link 插座。用台灣的繁體中文回答，口語、簡短，像家人在講話；不要用表格和長篇大論。

規則：
- 先用 get_home 看現在的狀態再動手；插座要用 ID 指定（從 get_home 拿）。名字對不上時，選最像的；真的不確定就問，不要亂猜。
- 使用者叫你開、關、定時、執行情境，就直接做（用 set_power、set_timer、run_scene），做完一句話說結果。
- 「全部關閉」用 turn_off_all，它會請使用者確認。
- 有「防呆」的插座，set_power 會回傳「等使用者確認」，照實告訴使用者畫面上有確認按鈕。鎖定的插座不能動。
- 要建立排程或情境時，用 propose_schedule／propose_scene 產生草稿，告訴使用者「按『建立』就會加上去」；不要說已經建好了。
- 問用電、紀錄、誰在家、訊號、動靜，就用對應的查詢工具，回答重點和數字，必要時給一個建議。
- 用電是「開了多久 × 設定的瓦數」估的，不是電表量的，回答時不用每次強調，但被問到準不準時要說。
- 問題沒有現成答案時，自己用查詢工具找資料、組合起來算（例如分別查兩天再比較），不要叫使用者自己去看。
- 真的查不到的事才說不知道，並說明缺什麼資料。"""


class Assistant:
    def __init__(self, hub: "Hub") -> None:
        self.hub = hub

    # ---- 設定 ----

    def _secrets(self) -> dict[str, Any]:
        path = self.hub.store.dir / "secrets.json"
        try:
            return json.loads(path.read_text("utf-8"))
        except Exception:  # noqa: BLE001
            return {}

    def set_key(self, key: str | None) -> None:
        path = self.hub.store.dir / "secrets.json"
        data = self._secrets()
        if key:
            data["anthropic_api_key"] = key.strip()
        else:
            data.pop("anthropic_api_key", None)
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(data), "utf-8")
        tmp.chmod(0o600)
        tmp.replace(path)

    @property
    def configured(self) -> bool:
        return bool(self._secrets().get("anthropic_api_key"))

    def status(self) -> dict[str, Any]:
        s = self.hub.store.data["settings"].get("assistant") or {}
        usage = self.hub.store.data.get("assistant_usage", {})
        month = date.today().strftime("%Y-%m")
        return {
            "configured": self.configured,
            "model": s.get("model") or DEFAULT_MODEL,
            "models": [{"id": k, "name": v["name"]} for k, v in MODELS.items()],
            "month_usd": round(usage.get(month, {}).get("usd", 0.0), 3),
            "month_count": usage.get(month, {}).get("count", 0),
            "cap": s.get("cap", DEFAULT_CAP),
        }

    def _track(self, model: str, usage: Any) -> float:
        price = MODELS.get(model, MODELS[DEFAULT_MODEL])
        tin = (usage.input_tokens or 0) + (usage.cache_creation_input_tokens or 0) * 1.25 + (usage.cache_read_input_tokens or 0) * 0.1
        usd = tin / 1e6 * price["in"] + (usage.output_tokens or 0) / 1e6 * price["out"]
        month = date.today().strftime("%Y-%m")
        all_ = self.hub.store.data.setdefault("assistant_usage", {})
        cur = all_.setdefault(month, {"usd": 0.0, "count": 0})
        cur["usd"] += usd
        for m in [m for m in all_ if m < (date.today() - timedelta(days=400)).strftime("%Y-%m")]:
            del all_[m]
        return usd

    # ---- 對話 ----

    async def chat(self, history: list[dict[str, str]]) -> dict[str, Any]:
        key = self._secrets().get("anthropic_api_key")
        if not key:
            raise RuntimeError("還沒設定 Anthropic API 金鑰")
        model = (self.hub.store.data["settings"].get("assistant") or {}).get("model") or DEFAULT_MODEL
        messages = [{"role": m["role"], "content": str(m["content"])[:4000]}
                    for m in history[-20:] if m.get("role") in ("user", "assistant") and m.get("content")]
        while messages and messages[0]["role"] != "user":
            messages.pop(0)
        if not messages:
            raise ValueError("沒有問題")
        st = self.status()
        if st["cap"] and st["month_usd"] >= st["cap"]:
            raise RuntimeError(f"這個月已經用了 US${st['month_usd']:.2f}，到了上限（設定 → 問家裡 可以調高）")
        actions: list[dict[str, Any]] = []
        tools = self._tools(actions)
        # base_url 只有測試時才會設定（假的 API 伺服器）
        client = anthropic.AsyncAnthropic(api_key=key, timeout=90.0, base_url=self._secrets().get("anthropic_base_url") or None)
        kwargs: dict[str, Any] = {
            "model": model,
            "max_tokens": 4000,
            "system": SYSTEM,
            "tools": tools,
            "messages": messages,
            "output_config": {"effort": "low"},
            "cache_control": {"type": "ephemeral"},
        }
        if model == "claude-opus-5-5":
            # 被安全機制擋下時，由伺服器自動改用其他模型回答
            kwargs["betas"] = ["server-side-fallback-2026-07-01"]
            kwargs["fallbacks"] = "default"
        runner = client.beta.messages.tool_runner(max_iterations=8, **kwargs)
        usd = 0.0
        last = None
        async for message in runner:
            last = message
            usd += self._track(model, message.usage)
        self.hub.store.data["assistant_usage"][date.today().strftime("%Y-%m")]["count"] += 1
        self.hub.store.save()
        if last is None:
            raise RuntimeError("沒有回應")
        if last.stop_reason == "refusal":
            reply = "這個我沒辦法幫忙。"
        else:
            reply = "\n".join(b.text for b in last.content if b.type == "text").strip() or "好了。"
        return {"reply": reply, "actions": actions, "usd": round(usd, 4)}

    # ---- 工具 ----

    def _plug_brief(self, p: Any) -> dict[str, Any]:
        hub = self.hub
        meta = hub.store.meta(p.id)
        now = time.time()
        d: dict[str, Any] = {"id": p.id, "name": hub.name(p), "room": (hub.store.room(meta.room) or {}).get("name"),
                             "online": p.online, "on": p.is_on}
        if p.is_on and hub.store.data["on_since"].get(p.id):
            d["on_minutes"] = round((now - hub.store.data["on_since"][p.id]) / 60)
        timer = hub.store.data["timers"].get(p.id)
        if timer:
            d["auto_off_in_min"] = max(0, round((timer - now) / 60))
        if meta.keep_on:
            d["keep_on"] = True
        if meta.protect:
            d["protect"] = {"confirm": "開關都要確認", "confirm_off": "關閉前要確認", "lock": "鎖定"}.get(meta.protect, meta.protect)
        if meta.watts:
            d["watts"] = meta.watts
        return d

    def _tools(self, actions: list[dict[str, Any]]) -> list[Any]:
        hub = self.hub

        def plug(pid: str) -> Any:
            p = hub.plugs.get(pid)
            if p is None:
                raise ValueError(f"沒有這個插座 ID：{pid}（先用 get_home 查）")
            return p

        def pend(kind: str, label: str, **body: Any) -> dict[str, Any]:
            a = {"id": uuid.uuid4().hex[:8], "kind": kind, "label": label, **body}
            actions.append(a)
            return a

        @beta_async_tool
        async def get_home() -> str:
            """現在家裡的狀態：時間、每個插座（ID、名稱、房間、開關、開了多久、定時、防呆）、情境、誰在家、估計用電。開關或回答問題前先呼叫。"""
            s = hub.snapshot()
            now = datetime.now()
            return json.dumps({
                "now": f"{now:%Y-%m-%d %H:%M} 星期{DAYS[now.weekday()]}",
                "sunrise": s["sun"].get("sunrise"), "sunset": s["sun"].get("sunset"),
                "plugs": [self._plug_brief(p) for p in hub.ordered()],
                "rooms": [r["name"] for r in hub.store.rooms],
                "scenes": [{"id": x["id"], "name": x["name"]} for x in hub.store.scenes],
                "people": [{"name": p["name"], "home": p.get("home")} for p in hub.people_report()],
                "power_watts_estimate": s["summary"]["power"],
                "today_holiday": s["calendar"].get("holiday"),
            }, ensure_ascii=False)

        @beta_async_tool
        async def set_power(plug_ids: list[str], on: bool) -> str:
            """打開或關閉一個或多個插座。

            Args:
                plug_ids: 插座 ID（從 get_home 拿）
                on: true 打開，false 關閉
            """
            from .hub import SOURCE, Locked  # noqa: PLC0415

            SOURCE.set("app")
            out = []
            for pid in plug_ids:
                p = plug(pid)
                meta = hub.store.meta(pid)
                name = hub.name(p)
                if not p.online:
                    out.append(f"{name}：連不上")
                elif p.is_on is on:
                    out.append(f"{name}：本來就{'開' if on else '關'}著")
                elif not on and meta.keep_on:
                    out.append(f"{name}：設成常開，沒有關")
                elif meta.protect == "lock":
                    out.append(f"{name}：鎖定，不能動")
                elif meta.protect == "confirm" or (meta.protect == "confirm_off" and not on):
                    pend("power", f"{'打開' if on else '關閉'} {name}", plug=pid, on=on)
                    out.append(f"{name}：有防呆，等使用者在畫面上按確認")
                else:
                    try:
                        await hub.set_power(pid, on)
                        out.append(f"{name}：已{'打開' if on else '關閉'}")
                    except Locked:
                        out.append(f"{name}：鎖定，不能動")
                    except Exception as err:  # noqa: BLE001
                        out.append(f"{name}：插座沒有回應（{err}）")
            return "\n".join(out)

        @beta_async_tool
        async def set_timer(plug_id: str, minutes: float) -> str:
            """幾分鐘後自動關閉某個插座（關著的會先打開）。minutes 填 0 表示取消定時。

            Args:
                plug_id: 插座 ID
                minutes: 幾分鐘後關閉；0 = 取消
            """
            p = plug(plug_id)
            if hub.store.meta(plug_id).protect == "lock":
                return "鎖定，不能動"
            if minutes <= 0:
                await hub.cancel_timer(plug_id)
                return f"已取消{hub.name(p)}的定時"
            await hub.set_timer(plug_id, min(minutes, 24 * 60) * 60)
            return f"{hub.name(p)}會在 {minutes:g} 分鐘後關閉"

        @beta_async_tool
        async def run_scene(scene_id: str) -> str:
            """執行一個情境（例如出門、睡覺）。

            Args:
                scene_id: 情境 ID（從 get_home 拿）
            """
            from .hub import SOURCE  # noqa: PLC0415

            scene = hub.store.scene(scene_id)
            if not scene:
                return "沒有這個情境"
            SOURCE.set("app")
            done = await hub.run_scene(scene_id, remember="undo")
            await hub.changed()
            return f"執行了「{scene['name']}」，動了 {len(done)} 個插座"

        @beta_async_tool
        async def turn_off_all() -> str:
            """全部關閉（常開的除外）。不會馬上執行，會請使用者在畫面上確認。"""
            on = [hub.name(p) for p in hub.ordered() if p.online and p.is_on and not hub.store.meta(p.id).keep_on]
            if not on:
                return "本來就都關著"
            pend("all_off", f"全部關閉（{len(on)} 個）")
            return f"等使用者確認：會關掉 {'、'.join(on)}"

        @beta_async_tool
        async def get_weather() -> str:
            """家裡附近的天氣（中央氣象署測站實測和鄉鎮預報、環境部空品測站）：現在的溫度、濕度、風速（m/s）、雨量站的今天累積和過去 24 小時雨量、AQI，接下來 24 小時（溫度、體感、降雨機率、天氣），一週（高低溫、降雨機率、紫外線），和「下雨不執行」今天會不會跳過。"""
            c = hub.snapshot()["calendar"]
            if not c.get("weather"):
                return "沒有天氣資料（設定裡關掉了，或還沒查到）"
            return json.dumps({"weather": c["weather"], "rain_skip_today": c.get("rain")}, ensure_ascii=False)

        @beta_async_tool
        async def get_energy() -> str:
            """用電和電費的摘要（估算）：今天、本月、預估月底、比上月同期、各裝置本月排行、最近 14 天每天的全家度數、值得注意的事。
            要看某些裝置、某幾天或某幾個月的細項（例如「今天比昨天多用在哪」），用 query_usage 自己查。"""
            # 和用電頁一樣：插座的使用紀錄太舊（或剛重開還沒讀）就先向插座讀一次
            if not hub._usage or time.time() - hub._usage_at > 600:
                await hub.refresh_usage()
            r = hub.energy_report()
            top = sorted(r["plugs"], key=lambda p: -(p.get("month_kwh") or 0))[:8]
            return json.dumps({
                "price_per_kwh": r["price"], "today": r["today"], "month": r["month"], "projected": r["projected"],
                "same_period_last_month": r["same_period"],
                "top_this_month": [{"name": p["name"], "kwh": p.get("month_kwh"), "cost": p.get("month_cost"),
                                    "avg_hours_per_day_7d": p.get("avg7_h"), "watts": p.get("watts")} for p in top],
                "last_14_days": [{"day": d["day"], "kwh": round(d["kwh"], 2)} for d in r["days"][-14:]],
                "insights": r.get("insights"),
                "now": time.strftime("%Y-%m-%d %H:%M"),
                "note": "度數是估算：開機時間 × 設定的瓦數；watts 是空的裝置沒有度數，只能比開機時間",
            }, ensure_ascii=False, default=str)

        @beta_async_tool
        async def query_usage(start: str, end: str | None = None, plug_ids: list[str] | None = None, by: str = "day") -> str:
            """查每個裝置在一段時間的開機分鐘和估算度數（插座自己記的紀錄）。可以自由組合來回答各種用電問題：
            比較今天和昨天、這週和上週、這個月和上個月，找出哪個裝置變多、哪天特別高。

            Args:
                start: 開始日期 YYYY-MM-DD（by="month" 時用 YYYY-MM）
                end: 結束日期（含），省略就是到今天／這個月
                plug_ids: 只看這些插座（ID 從 get_home 拿）；省略就是全部
                by: "day" 一天一筆（只有最近 30 天）或 "month" 一個月一筆（最近 12 個月）
            """
            if not hub._usage or time.time() - hub._usage_at > 600:
                await hub.refresh_usage()
            month = by == "month"
            fmt_ = "%Y-%m" if month else "%Y-%m-%d"
            try:
                d0 = datetime.strptime(start[:7] if month else start[:10], fmt_).date()
                d1 = datetime.strptime((end[:7] if month else end[:10]), fmt_).date() if end else date.today()
            except ValueError:
                return "日期格式不對：by=day 用 YYYY-MM-DD，by=month 用 YYYY-MM"
            keys: list[str] = []
            if month:
                y, m = d0.year, d0.month
                while (y, m) <= (d1.year, d1.month) and len(keys) < 24:
                    keys.append(f"{y:04d}-{m:02d}")
                    y, m = (y + 1, 1) if m == 12 else (y, m + 1)
            else:
                d = d0
                while d <= d1 and len(keys) < 62:
                    keys.append(d.isoformat())
                    d += timedelta(days=1)
            rows = []
            total = {k: 0.0 for k in keys}
            for plug in hub.ordered():
                if plug_ids and plug.id not in plug_ids:
                    continue
                use = hub._usage.get(plug.id)
                meta = hub.store.meta(plug.id)
                kw = (meta.watts or 0) / 1000
                if use is None:
                    rows.append({"id": plug.id, "name": hub.name(plug), "no_data": True})
                    continue
                src = use["months" if month else "days"]
                mins = {k: src.get(k) for k in keys}
                for k, v in mins.items():
                    total[k] += (v or 0) / 60 * kw
                rows.append({
                    "id": plug.id, "name": hub.name(plug), "room": (hub.store.room(meta.room) or {}).get("name"),
                    "watts": meta.watts,
                    "minutes": mins,
                    "kwh": {k: round(v / 60 * kw, 3) for k, v in mins.items() if v is not None} if meta.watts else None,
                })
            return json.dumps({
                "now": datetime.now().strftime("%Y-%m-%d %H:%M"),
                "devices": rows,
                "total_kwh": {k: round(v, 2) for k, v in total.items()},
                "note": "minutes 是 null 表示插座沒有那段的紀錄（日資料只留約 30 天）；今天還沒過完，比較時要把現在幾點算進去；"
                        "度數 = 開機時間 × 設定的瓦數，watts 是空的就沒有度數。要知道幾點開關的，用 get_history。",
            }, ensure_ascii=False)

        @beta_async_tool
        async def get_history(days: int = 1, plug_id: str | None = None) -> str:
            """開關紀錄（誰在什麼時候開關了哪個插座：App、Google Home、插座按鈕、自動）、Wi-Fi 斷線紀錄、誰在家。

            Args:
                days: 看最近幾天（1～14）
                plug_id: 只看某個插座（可省略）
            """
            days = max(1, min(14, int(days)))
            since = time.time() - days * 86400
            src = {"app": "App", "matter": "Google Home", "button": "插座按鈕或 Kasa App", "auto": "排程／情境／定時", "motion": "動靜自動化"}
            ev = []
            for ts, pid, on, s in hub.store.energy.switches(since):
                if plug_id and pid != plug_id or pid not in hub.plugs:
                    continue
                ev.append(f"{datetime.fromtimestamp(ts):%m/%d %H:%M} {hub.name(hub.plugs[pid])} {'開' if on else '關'}（{src.get(s, s)}）")
            net = [e for e in hub.store.data["net_events"] if (e.get("start") or 0) >= since]
            people = [{"name": p["name"], "home": p.get("home"),
                       "since": datetime.fromtimestamp(p["since"]).strftime("%m/%d %H:%M") if p.get("since") else None}
                      for p in hub.people_report()]
            return json.dumps({"switches": ev[-200:], "wifi_outages": net, "people_now": people}, ensure_ascii=False, default=str)

        @beta_async_tool
        async def get_schedules() -> str:
            """所有排程（家庭中控的，和用 Kasa App 設在插座裡的），含今天會不會跳過。"""
            s = hub.snapshot()
            names = {p.id: hub.name(p) for p in hub.plugs.values()}
            scenes = {x["id"]: x["name"] for x in hub.store.scenes}
            out = []
            for x in s["schedules"]:
                what = f"執行「{scenes.get(x.get('scene'), '?')}」" if x["action"] == "scene" else \
                    f"{'打開' if x['action'] == 'on' else '關閉'} {'、'.join(names.get(p, p) for p in x['plugs'])}"
                out.append({"time": x.get("today") or x["time"], "mode": x.get("time_mode"), "days": "".join(DAYS[d] for d in x["days"]),
                            "what": what, "enabled": x["enabled"], "duration_s": x.get("duration_s"),
                            "skip_holiday": x.get("skip_holiday"), "skip_rain": x.get("skip_rain"), "skip_today": x.get("skip_today")})
            for p in hub.ordered():
                for r in (hub.native.get(p.id) or {}).get("kasa", []):
                    out.append({"plug": hub.name(p), "kasa_app_rule": True, "on": bool(r.get("sact")),
                                "minute": r.get("smin"), "enabled": bool(r.get("enable"))})
            return json.dumps(out, ensure_ascii=False)

        @beta_async_tool
        async def propose_schedule(time_hhmm: str, days: list[int], action: str, plug_ids: list[str] | None = None,
                                   scene_id: str | None = None, duration_minutes: float | None = None,
                                   time_mode: str = "clock", offset_minutes: int = 0,
                                   skip_holiday: bool = False, skip_rain: bool = False) -> str:
            """產生一個排程草稿，使用者按「建立」才會加上去（不會直接建立）。

            Args:
                time_hhmm: 幾點，例如 "07:30"；time_mode 是 sunrise／sunset 時填 "00:00"
                days: 星期幾，0 = 星期一 … 6 = 星期日
                action: "on" 打開、"off" 關閉、"scene" 執行情境
                plug_ids: 要開關的插座 ID（action 是 on／off 時）
                scene_id: 情境 ID（action 是 scene 時）
                duration_minutes: 打開後幾分鐘自動關閉（可省略）
                time_mode: "clock" 固定時間、"sunrise" 日出、"sunset" 日落
                offset_minutes: 日出／日落提早（負）或延後（正）幾分鐘
                skip_holiday: 國定假日不執行
                skip_rain: 下雨不執行（澆水用）
            """
            if action not in ("on", "off", "scene"):
                return "action 要是 on、off 或 scene"
            hh, _, mm = time_hhmm.partition(":")
            try:
                hms = f"{int(hh):02d}:{int(mm or 0):02d}:00"
            except ValueError:
                return "時間格式不對，要像 07:30"
            days = sorted({int(d) for d in days if 0 <= int(d) <= 6})
            if not days:
                return "至少要一天"
            plug_ids = [plug(p).id for p in (plug_ids or [])]
            if action == "scene" and not hub.store.scene(scene_id or ""):
                return "沒有這個情境"
            if action != "scene" and not plug_ids:
                return "要選插座"
            body = {"enabled": True, "time": hms, "days": days, "action": action, "scene": scene_id if action == "scene" else None,
                    "plugs": plug_ids if action != "scene" else [], "restore_at": None,
                    "duration_s": int(duration_minutes * 60) if duration_minutes and action == "on" else None,
                    "backup": True, "time_mode": time_mode if time_mode in ("clock", "sunrise", "sunset") else "clock",
                    "offset_min": int(offset_minutes), "skip_holiday": skip_holiday, "skip_rain": skip_rain}
            when = {"sunrise": "日出", "sunset": "日落"}.get(body["time_mode"])
            when = (f"{when}{'後' if offset_minutes > 0 else '前'} {abs(offset_minutes)} 分" if offset_minutes else when) if when else hms[:5]
            what = f"執行「{hub.store.scene(scene_id)['name']}」" if action == "scene" else \
                f"{'打開' if action == 'on' else '關閉'} {'、'.join(hub.name(hub.plugs[p]) for p in plug_ids)}"
            extra = (f"，{duration_minutes:g} 分鐘後關閉" if body["duration_s"] else "") + \
                ("，國定假日不執行" if skip_holiday else "") + ("，下雨不執行" if skip_rain else "")
            day_txt = "每天" if len(days) == 7 else "平日" if days == [0, 1, 2, 3, 4] else "週末" if days == [5, 6] else \
                "星期" + "、".join(DAYS[d] for d in days)
            pend("schedule", f"{day_txt} {when} {what}{extra}", body=body)
            return "草稿好了，等使用者按「建立」"

        @beta_async_tool
        async def propose_scene(name: str, on_plug_ids: list[str] | None = None, off_plug_ids: list[str] | None = None,
                                others_off: bool = False) -> str:
            """產生一個情境草稿（一鍵開關一組插座），使用者按「建立」才會加上去。

            Args:
                name: 情境名稱，例如「看書」
                on_plug_ids: 要打開的插座 ID
                off_plug_ids: 要關閉的插座 ID
                others_off: 其他沒列到的插座也關掉（預設不動）
            """
            name = name.strip()[:20]
            if not name:
                return "要有名稱"
            acts = {plug(p).id: "on" for p in on_plug_ids or []}
            acts.update({plug(p).id: "off" for p in off_plug_ids or []})
            if not acts:
                return "至少要一個插座"
            on_n = [hub.name(hub.plugs[p]) for p, a in acts.items() if a == "on"]
            off_n = [hub.name(hub.plugs[p]) for p, a in acts.items() if a == "off"]
            label = f"情境「{name}」：" + "；".join(x for x in (f"開 {'、'.join(on_n)}" if on_n else "", f"關 {'、'.join(off_n)}" if off_n else "",
                                                       "其他都關" if others_off else "") if x)
            pend("scene", label, body={"name": name, "icon": "", "actions": acts, "others": "off" if others_off else "keep"})
            return "草稿好了，等使用者按「建立」"

        @beta_async_tool
        async def get_signal_map() -> str:
            """訊號地圖：平面圖上的房間位置、每個裝置的 Wi-Fi 訊號（dBm）、擺在哪、高度、連到哪一台路由器、跟基地台的距離，
            以及最近 24 小時每個裝置附近的動靜（Wi-Fi 感測的擾動，越大越可能有人走動）。用來回答訊號好不好、基地台該放哪、哪裡有動靜。"""
            fp = hub.store.data["floorplan"]
            mpp = (fp.get("meters") or 12) / (fp.get("w") or 1000)
            net = hub.net_report()
            cl = {c["mac"]: c for c in net["clients"]}
            nodes = {n["mac"]: n for n in net["nodes"]}

            def room_at(x: float, y: float) -> str | None:
                r = geom.room_at(fp, x, y)
                return r["name"] if r else None

            aps = []
            for a in fp.get("aps", []):
                it = fp["items"].get(f"ap:{a['id']}")
                if it:
                    aps.append({"name": a["name"], "node": a.get("node"), "_xy": (it["x"], it["y"]), "x_m": round(it["x"] * mpp, 1), "y_m": round(it["y"] * mpp, 1),
                                "height_m": a.get("z") or 1.0, "room": room_at(it["x"], it["y"])})
            hist = hub.sensing_history("24h")
            motion = {d["key"]: [c["motion"] for c in d["cols"] if c["motion"] is not None] for d in hist["devices"]}
            names = {d["key"]: d["name"] for d in hist["devices"]}
            devs = []
            for key, it in fp["items"].items():
                if key.startswith("ap:"):
                    continue
                c = cl.get(key, {})
                rssi = next((p.rssi for p in hub.plugs.values() if p.device_key == key and p.rssi is not None), None) or c.get("rssi")
                mot = motion.get(key, [])
                node = nodes.get(c.get("node") or "")
                ap = next((a for a in aps if a["node"] == c.get("node")), None)
                x, y = it["x"] * mpp, it["y"] * mpp
                devs.append({
                    "name": names.get(key) or c.get("name") or key, "room": room_at(it["x"], it["y"]),
                    "x_m": round(x, 1), "y_m": round(y, 1), "height_m": it.get("z") or 0.3,
                    "rssi_dbm": rssi, "connected_to": node["model"] if node else None,
                    "distance_to_ap_m": round(((ap["x_m"] - x) ** 2 + (ap["y_m"] - y) ** 2) ** 0.5, 1) if ap else None,
                    "walls_to_ap": geom.walls_crossed(fp, it["x"], it["y"], *ap["_xy"]) if ap else None,
                    "link_passes_rooms": geom.rooms_along(fp, it["x"], it["y"], *ap["_xy"]) if ap else None,
                    "motion_24h_max": max(mot) if mot else None,
                    "motion_24h_busy_slots": sum(1 for m in mot if m > 1) if mot else None,
                })
            return json.dumps({
                "map_width_m": fp.get("meters"), "rooms": [{"name": r["name"], "x_m": round(r["x"] * mpp, 1), "y_m": round(r["y"] * mpp, 1),
                                                           "w_m": round(r["w"] * mpp, 1), "h_m": round(r["h"] * mpp, 1)} for r in fp.get("rooms") or []],
                "access_points": [{k: v for k, v in a.items() if k != "_xy"} for a in aps], "devices": devs,
                "walls_drawn": len(fp.get("walls") or []),
                "notes": "rssi：-55 以上很好、-70 以下容易斷線；動靜是 Wi-Fi 感測（實驗），每格 30 分鐘，擾動 > 1 算有明顯動靜。"
                         "walls_to_ap：裝置到它連的基地台中間隔了幾道實牆（門口不算），每道牆大約讓訊號弱 3～6 dB；"
                         "link_passes_rooms：這條訊號線經過的區域，某裝置有動靜時，人應該在這些區域之一",
            }, ensure_ascii=False)

        return [get_home, set_power, set_timer, run_scene, turn_off_all, get_weather, get_energy, query_usage, get_history,
                get_schedules, propose_schedule, propose_scene, get_signal_map]

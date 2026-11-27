"""Claude 從習慣建議自動化：每週日晚上把過去 4 週手動開關、回家的紀錄（文字）給 Claude 看，提出最多 3 條建議（排程、回家規則、動靜規則）。

- 每條建議都用「問家裡」的 propose_* 工具檢查、產生草稿（格式不會錯）；使用者按「建立」才會加上去
- 按「不要」的同樣建議不會再出現
- 金鑰、模型、每月上限跟「問家裡」共用（assistant.py）；沒有金鑰就不做，排程頁照舊顯示原本的「建議的排程」
"""
from __future__ import annotations

import hashlib
import json
import logging
import time
from collections import defaultdict
from datetime import datetime
from typing import TYPE_CHECKING, Any

import anthropic

if TYPE_CHECKING:
    from .hub import Hub

_LOGGER = logging.getLogger(__name__)
LOOKBACK_DAYS = 28
MAX_ITEMS = 3
MANUAL = ("app", "matter", "button")
DAYS = "一二三四五六日"

SYSTEM = """你是「家庭中控」的助理，幫一個台灣家庭從生活習慣找出值得自動化的事。用台灣的繁體中文。
你會拿到過去 4 週每個插座「手動」開關的時間、家人回家的時間、每個插座平均每天開幾小時、已經有的排程和規則、使用者拒絕過的建議。
找出最多 3 條真的有規律、做了會省事的自動化，呼叫 suggest 一次。沒有夠明顯的規律就給空的 items，不要硬湊。

每條 item：
- kind：schedule（固定時間開／關）、arrive（某人回家就開）、motion（房間有人走動就開、沒動靜就關）
- params：跟 propose_schedule／propose_arrive_rule／propose_motion_rule 的參數一樣（插座、家人、房間都用給你的 ID）
- reason：一句話、附次數，例如「過去 4 週的平日，有 17 天在 07:05～07:20 打開，每次開 30 分鐘左右」
規則：
- 至少要 4 週裡有 6 次以上、而且時間集中，才算規律
- 已經有排程或規則在做的不要再建議；使用者拒絕過的、或很像的，不要再建議
- 天黑才開的燈，排程用 time_mode=sunset、回家規則用 when=dark
- 只建議開或關插座的自動化；跟安全有關的（電熱器、熨斗）不要建議自動打開"""

SUGGEST_TOOL = {
    "name": "suggest",
    "description": "建議的自動化（最多 3 條；沒有就給空陣列）",
    "input_schema": {
        "type": "object",
        "properties": {
            "items": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "kind": {"type": "string", "enum": ["schedule", "arrive", "motion"]},
                        "params": {"type": "object", "description": "propose_schedule／propose_arrive_rule／propose_motion_rule 的參數"},
                        "reason": {"type": "string"},
                    },
                    "required": ["kind", "params", "reason"],
                },
            },
        },
        "required": ["items"],
    },
}
TOOL_FOR = {"schedule": "propose_schedule", "arrive": "propose_arrive_rule", "motion": "propose_motion_rule"}


def idea_key(a: dict[str, Any]) -> str:
    return hashlib.sha1(json.dumps([a["kind"], a.get("body")], sort_keys=True, ensure_ascii=False).encode()).hexdigest()[:12]


class Ideas:
    def __init__(self, hub: "Hub") -> None:
        self.hub = hub
        self.busy = False

    @property
    def data(self) -> dict[str, Any]:
        return self.hub.store.data.get("claude_ideas") or {}

    def status(self) -> dict[str, Any]:
        d = self.data
        return {"configured": self.hub.assistant.configured, "busy": self.busy, "t": d.get("t"), "items": d.get("items") or [],
                "error": d.get("error")}

    def due(self, now: datetime | None = None) -> bool:
        """每週日晚上 8 點後一次；從來沒做過就馬上做一次。"""
        now = now or datetime.now()
        if self.busy or not self.hub.assistant.configured or self.hub.store.data["settings"].get("claude_ideas") is False:
            return False
        ran = self.data.get("week")
        if ran is None:
            return True
        return now.weekday() == 6 and now.hour >= 20 and ran != now.strftime("%G-W%V")

    def drop(self, item_id: str, dismiss: bool) -> None:
        d = self.hub.store.data.setdefault("claude_ideas", {})
        items = d.get("items") or []
        hit = next((x for x in items if x["id"] == item_id), None)
        d["items"] = [x for x in items if x["id"] != item_id]
        if hit and dismiss:
            lst = self.hub.store.data["settings"].setdefault("idea_dismissed", [])
            lst.append({"key": hit["key"], "label": hit["label"]})
            del lst[:-100]
        self.hub.store.save()

    # ---- 給 Claude 看的資料 ----

    def context(self) -> dict[str, Any]:
        hub = self.hub
        since = time.time() - LOOKBACK_DAYS * 86400
        manual: dict[str, list[str]] = defaultdict(list)
        for ts, pid, on, src in hub.store.energy.switches(since):
            if src in MANUAL and pid in hub.plugs:
                d = datetime.fromtimestamp(ts)
                manual[pid].append(f"{d:%m/%d}({DAYS[d.weekday()]}) {d:%H:%M} {'開' if on else '關'}")
        rep = {p["id"]: p for p in hub.energy_report().get("plugs") or []}
        plugs = [{"id": p.id, "name": hub.name(p), "room": (hub.store.room(hub.store.meta(p.id).room) or {}).get("name"),
                  "hours_per_day": (rep.get(p.id) or {}).get("avg21_h"), "keep_on": hub.store.meta(p.id).keep_on or None,
                  "manual_switches": manual.get(p.id, [])} for p in hub.ordered()]
        arrivals = [f"{datetime.fromtimestamp(x['t']):%m/%d}({DAYS[datetime.fromtimestamp(x['t']).weekday()]}) {datetime.fromtimestamp(x['t']):%H:%M} {x['name']}" for x in hub.store.data.get("presence_log") or []
                    if x.get("home") is True and x.get("name") and x.get("t", 0) >= since]
        scheds = [{"time": x.get("time"), "time_mode": x.get("time_mode"), "days": x.get("days"), "action": x.get("action"),
                   "plugs": [hub.name(hub.plugs[p]) for p in x.get("plugs") or [] if p in hub.plugs], "enabled": x.get("enabled")}
                  for x in hub.store.schedules]
        return {"now": f"{datetime.now():%Y-%m-%d %H:%M}", "sunset_today": (hub.snapshot().get("sun") or {}).get("sunset"),
                "plugs": plugs, "arrivals": arrivals[-150:], "schedules": scheds,
                "dismissed": [x["label"] for x in hub.store.data["settings"].get("idea_dismissed") or []]}

    async def run(self) -> dict[str, Any]:
        hub, a = self.hub, self.hub.assistant
        self.busy = True
        d = hub.store.data.setdefault("claude_ideas", {})
        d["week"] = datetime.now().strftime("%G-W%V")
        try:
            st = a.status()
            if st["cap"] and st["month_usd"] >= st["cap"]:
                raise RuntimeError("這個月問家裡的費用到上限了")
            actions: list[dict[str, Any]] = []
            tools = {t.name: t for t in a._tools(actions)}
            auto = json.loads(await tools["get_automations"].call({}))
            ctx = {**self.context(), "people": auto["people"], "rooms": auto["rooms"], "arrive_rules": auto["arrive_rules"],
                   "motion_rules": auto["motion_rules"]}
            client = anthropic.AsyncAnthropic(api_key=a._secrets().get("anthropic_api_key"), timeout=120.0,
                                              base_url=a._secrets().get("anthropic_base_url") or None)
            msg = await client.messages.create(model=st["model"], max_tokens=2000, system=SYSTEM, tools=[SUGGEST_TOOL],
                                               tool_choice={"type": "tool", "name": "suggest"},
                                               messages=[{"role": "user", "content": "過去 4 週的紀錄（JSON）：\n" + json.dumps(ctx, ensure_ascii=False)}])
            a._track(st["model"], msg.usage)
            got = next((b.input for b in msg.content if b.type == "tool_use" and b.name == "suggest"), None) or {}
            dismissed = {x["key"] for x in hub.store.data["settings"].get("idea_dismissed") or []}
            items = []
            for it in (got.get("items") or [])[:MAX_ITEMS]:
                tool = tools.get(TOOL_FOR.get(it.get("kind"), ""))
                params = it.get("params") if isinstance(it.get("params"), dict) else {}
                if tool is None:
                    continue
                before = len(actions)
                try:
                    res = await tool.call(params)
                except Exception as err:  # noqa: BLE001  參數不對（插座 ID 錯）：這條不要
                    _LOGGER.info("建議被擋下：%s", err)
                    continue
                if len(actions) == before:
                    _LOGGER.info("建議被擋下：%s", res)
                    continue
                x = actions[-1]
                x.pop("rule_id", None)  # 建議只建新的，不改舊的
                x["reason"] = str(it.get("reason") or "")[:200]
                x["key"] = idea_key(x)
                if x["key"] not in dismissed:
                    items.append(x)
            d.update({"t": round(time.time()), "items": items, "error": None})
        except Exception as err:  # noqa: BLE001
            _LOGGER.warning("Claude 建議自動化失敗：%s", err)
            d.update({"t": round(time.time()), "error": str(err)[:200] or type(err).__name__})
        finally:
            self.busy = False
        hub.store.save()
        return self.status()

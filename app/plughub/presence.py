"""誰在家、出門、回家：從 hub.py 拆出來的一塊（Hub 繼承 PresenceMixin，用到的狀態都還在 Hub 上）。

- 誰在家：手機有沒有連著 Wi-Fi，加上大門口有沒有看到人出去（兩個都對上才算出門）
- 大家都出門了 → 執行「出門」；客廳還有人在動就先等
- 沒人在家電器還開著 → 通知或關掉；高風險電器馬上關
- 回家自動開
"""
from __future__ import annotations

import asyncio
import contextvars
import logging
import time
import uuid
from datetime import datetime
from typing import TYPE_CHECKING, Any

from . import doorcount, zones as zonelib

if TYPE_CHECKING:
    from .hub import Plug

_LOGGER = logging.getLogger("plughub.hub")

PRESENCE_LOG_MAX = 3000  # 誰在家的變化紀錄：最多這麼多筆、最多留 PRESENCE_LOG_DAYS 天（找回家習慣用）
PRESENCE_LOG_DAYS = 60
ARRIVE_LOOK = 15 * 60  # 回家後這麼久內手動打開的插座，算「回家會開的」
ARRIVE_KEEP_OFF = 2 * 3600  # 秒：家裡有人時，這麼久內被人手動關掉的插座，別人回家不去開它
ARRIVE_SOURCES = ("app", "matter", "button")
DOOR_BEFORE = 600  # 秒：手機最後連線前這麼久內（到現在）大門口看到人出去，這個人才算出門（手機常比人早睡著）
DOOR_WAIT = 1800  # 秒：大門口沒看到人出去，手機斷線這麼久、家裡也沒動靜，還是算出門（門口漏看）
PIN_MAX = 12 * 3600  # 秒：手動改成「其實在家」最多維持這麼久
DOOR_LIVE = 60  # 秒：門口的攝影機這麼久內有在追蹤（Jetson 串流），進出人數才算數
ROOM_MOVED = 0.05  # 追蹤中的人，腳離第一次看到的位置這麼遠（畫面寬高的比例）才算真的有人在動
ROOM_SEEN_HOLD = 900  # 秒：房間的攝影機這麼久內看過人，手機都不在 Wi-Fi 也先不當作大家出門（有人關了 Wi-Fi）
DOOR_NEAR = 0.06  # 腳離「大門」區域這麼近（畫面寬高的比例）算在家門口
DOOR_FAR = 0.12  # 腳離「大門」區域這麼遠，算已經離開家門口（樓梯、別戶那頭）
# 這次開關是誰做的（記在開關紀錄裡）：API 進來的會設成 app／matter，其他（排程、情境、定時）是 auto
SOURCE: contextvars.ContextVar[str] = contextvars.ContextVar("source", default="auto")


def arrive_rule(**kw: Any) -> dict[str, Any]:
    """一條「回家自動開」規則（沒給的用預設值）。"""
    r = {"id": uuid.uuid4().hex[:8], "enabled": True, "who": "any", "when": "all", "start": "", "end": "",
         "days": "all", "kind": "plugs", "plugs": [], "scene": None, "for_min": 0, "lights_dark": True, "last": None}
    r.update(kw)
    return r


def _in_window(hm: int, start: str, end: str) -> bool:
    """現在（一天裡的第幾分鐘）在不在 start～end 之間；可以跨午夜（23:00～06:00）；都空白 = 整天。"""
    if not start or not end:
        return True
    a = int(start[:2]) * 60 + int(start[3:5])
    b = int(end[:2]) * 60 + int(end[3:5])
    return a <= hm < b if a <= b else hm >= a or hm < b


class PresenceMixin:
    """Hub 的「誰在家」這一塊。"""

    # ---- 誰在家：手機連線＋大門口看到人出去 ----

    def people_report(self) -> list[dict[str, Any]]:
        out = []
        for p in self.store.data["people"]:
            st = self._presence.get(p["id"], {"home": None, "since": None})
            phone = max((self.router.clients.get(m, {}).get("seen", 0) for m in p["macs"]), default=0)
            out.append({**p, **st, "phone": round(phone) or None, "where": self.person_where(p) if st.get("home") else None})
        return out

    def away_wait(self) -> dict[str, Any] | None:
        """還沒執行「出門」是在等什麼（首頁顯示）；沒有在等就回 None。"""
        people = self.people_report()
        if not people or any(p.get("home") is None for p in people):
            return None
        if self._away_hold is not None:
            return {"names": [], "why": f"{self._room_seen[1] or '攝影機'}還看到有人在動", "until": None}
        stay = [p for p in people if p.get("home") and p.get("stay")]
        if stay and all(p.get("stay") or not p.get("home") for p in people):
            return {"names": [p["name"] for p in stay], "why": "手機斷線了，但大門口沒看到人出去", "until": round(min(p["stay"] for p in stay) + DOOR_WAIT)}
        return None

    def presence_override(self, pid: str, home: bool) -> None:
        """判斷錯了，手動改：「其實在家」會維持到他的手機再連上、大門口再看到人出去、或 12 小時；
        「其實出門了」如果大家都出門了就執行「出門」。不觸發回家規則。"""
        p = next((x for x in self.store.data["people"] if x["id"] == pid), None)
        st = self._presence.get(pid)
        if p is None or st is None:
            raise KeyError(pid)
        now = time.time()
        why = "手動改成在家" if home else "手動改成出門"
        for k in ("stay", "pin", "door_t", "door_cam"):
            st.pop(k, None)
        st.update(home=home, since=now, why=why)
        if home:
            st["pin"] = now
            self._away_hold = None
        self._presence_log({"name": p["name"], "home": home, "why": why})
        self._dirty = True
        if not home and not any(x.get("home") for x in self._presence.values()):
            self._away_hold = None
            self._away_done(self.store.data["settings"].get("presence") or {}, "大家都出門了")

    def away_now(self) -> None:
        """不等了，現在就執行「出門」：還在「先當作在家」的人都改成出門。真的有人在家（手機連著）就不做。"""
        people = self.people_report()
        if any(p.get("home") and not p.get("stay") for p in people):
            raise ValueError("還有人在家")
        now = time.time()
        for p in people:
            st = self._presence[p["id"]]
            if st.get("home"):
                st.pop("stay", None)
                st.update(home=False, since=now, why="手動執行「出門」")
                self._presence_log({"name": p["name"], "home": False, "why": "手動執行「出門」"})
        self._away_hold = None
        self._dirty = True
        self._away_done(self.store.data["settings"].get("presence") or {}, "大家都出門了（手動）")

    def everyone_out(self) -> bool:
        """大家都出門了嗎：每個家人都確定不在家，而且沒有「手機都斷線但家裡好像有人」在等。
        「沒人在家」的通知、警報都問這裡（各判斷各的會一邊修好、另一邊照樣誤報）。"""
        people = self.people_report()
        return bool(people) and all(p.get("home") is False for p in people) and self._away_hold is None

    def _router_presence(self, now: float) -> bool:
        """誰在家：家人的手機有沒有連著 Wi-Fi。離線超過幾分鐘才算出門（手機睡著時偶爾會斷一下）。"""
        people = self.store.data["people"]
        if not people:
            return False
        cfg = self.store.data["settings"].get("presence") or {}
        grace = max(1, float(cfg.get("grace_min") or 10)) * 60
        settled = now - self._router_since >= grace  # 剛連上路由器：只判斷回家，不判斷出門
        before = any(self._presence.get(p["id"], {}).get("home") for p in people)
        changed = False
        arrived = []
        arrived_ids: list[str] = []
        first = False  # 剛開機、第一次知道誰在家
        for p in people:
            last = max((self.router.clients.get(m, {}).get("seen", 0) for m in p["macs"]), default=0)
            home = bool(last and now - last < grace)
            st = self._presence.get(p["id"])
            if st is None:
                self._presence[p["id"]] = {"home": home, "since": now}
                changed = True
                first = True
            elif st["home"] and home and (st.get("stay") or st.get("pin")):  # 「先當作在家」的人手機又連上了
                st.pop("stay", None)
                st.pop("pin", None)
                st["why"] = self._presence_why(p, True, last, grace)
                self._dirty = True
            elif st["home"] != home and (home or settled):
                if not home and st.get("pin"):  # 手動改成「其實在家」：到大門口再看到人出去、或 12 小時為止
                    if now - st["pin"] < PIN_MAX and not any(t >= st["pin"] for t, _ in self._door_outs):
                        continue
                    st.pop("pin")
                extra = "" if home else self._left_check(p, st, last, now)
                if extra is None:  # 手機斷線，但大門口沒看到人出去：先當作還在家
                    continue
                why = self._presence_why(p, home, last, grace) + extra
                st.update(home=home, since=now if home else last, why=why)
                changed = True
                item = {"name": p["name"], "home": home, "why": why}
                if home:
                    st.pop("door_t", None)
                    st.pop("door_cam", None)
                elif st.get("door_t"):
                    item.update(door_t=st["door_t"], cam=st.get("door_cam"))
                self._presence_log(item)
                if home:
                    arrived.append(p["name"])
                    arrived_ids.append(p["id"])
        for pid in [k for k in self._presence if k not in {p["id"] for p in people}]:
            del self._presence[pid]
        if not changed:
            return False
        self._dirty = True
        after = any(self._presence[p["id"]]["home"] for p in people)
        if before and not after:
            ev = self.home_evidence(now, now)
            if ev:
                self._away_hold = now
                why = f"手機都不在 Wi-Fi，但{ev}"
                self._presence_log({"hold": True, "why": why})
                self.notifier.send("手機都不在 Wi-Fi，但家裡有人？", why + "。先不執行「出門」：看到最後一個人從大門出去、或家裡一陣子都沒動靜才執行")
            else:
                self._away_done(cfg, "大家都出門了")
        elif after and not before and arrived:
            self._away_end(arrived)
        if after:
            self._away_hold = None
        if arrived_ids:
            self._arrive(arrived_ids, was_empty=not before)
        return True

    def _left_check(self, p: dict[str, Any], st: dict[str, Any], last: float, now: float) -> str | None:
        """手機斷線了：大門口有沒有看到人出去？兩個都對上才算出門（手機睡著、關 Wi-Fi 不算）。
        回傳要接在原因後面的字；None = 先當作還在家。門口的攝影機沒在追蹤時只看手機（跟以前一樣）。"""
        st.pop("door_t", None)
        st.pop("door_cam", None)
        if now - self._door_live >= DOOR_LIVE:
            st.pop("stay", None)
            return ""
        i = next((i for i, (t, _) in enumerate(self._door_outs) if t >= last - DOOR_BEFORE), None)
        if i is not None:
            t, cam = self._door_outs.pop(i)
            st.pop("stay", None)
            st.update(door_t=round(t), door_cam=cam)
            return f"，大門口 {datetime.fromtimestamp(t).strftime('%H:%M')} 看到人出去"
        if now - last >= DOOR_WAIT and now - self._room_seen[0] >= ROOM_SEEN_HOLD:
            st.pop("stay", None)
            return f"；大門口沒看到人出去，但 {DOOR_WAIT // 60} 分鐘了家裡也沒動靜"
        if st.get("stay") != last:
            st["stay"] = last
            st["why"] = f"手機 {datetime.fromtimestamp(last).strftime('%H:%M')} 後沒連線，但大門口沒看到人出去"
            self._presence_log({"name": p["name"], "stay": True, "why": st["why"]})
            self._dirty = True
        return None

    def _presence_why(self, p: dict[str, Any], home: bool, last: float, grace: float) -> str:
        """誰在家改變的原因（給「最近變化」看）。"""
        if not home:
            at = datetime.fromtimestamp(last).strftime("%H:%M") if last else "—"
            return f"手機超過 {round(grace / 60)} 分鐘沒連線（最後看到 {at}）"
        mac = max(p["macs"], key=lambda m: self.router.clients.get(m, {}).get("seen", 0))
        c = self.router.clients.get(mac, {})
        if c.get("probe") and c["probe"] >= c.get("seen", 0) - 1:
            return "樹莓派直接問到手機"
        node = next((n["model"] for n in self.router.nodes if n["mac"] == c.get("node")), None)
        where = "有線" if c.get("wired") else (c.get("band") or "Wi-Fi")
        return f"手機連上 {node + ' ' if node else ''}{where}"

    def _presence_log(self, item: dict[str, Any]) -> None:
        log = self.store.data.setdefault("presence_log", [])
        now = round(time.time())
        log.append({"t": now, **item})
        del log[:-PRESENCE_LOG_MAX]
        old = sum(1 for x in log if x.get("t", 0) < now - PRESENCE_LOG_DAYS * 86400)
        if old:
            del log[:old]
        self._dirty = True

    # ---- 大家都出門了：執行「出門」；看起來還有人在家就先等 ----

    @property
    def _away_hold(self) -> float | None:
        """手機都不在、但看起來還有人在家：「出門」先不執行（從什麼時候開始等）。存起來：重開後還記得要補執行。"""
        return self.store.data.get("away_hold") or None

    @_away_hold.setter
    def _away_hold(self, t: float | None) -> None:
        if t != self.store.data.get("away_hold"):
            self.store.data["away_hold"] = t
            self._dirty = True

    def _away_done(self, cfg: dict[str, Any], why: str) -> None:
        """確定大家都出門了：執行「出門」。"""
        self._presence_scene(cfg.get("away_scene"), why)

    def _away_hold_check(self, now: float) -> None:
        """先不執行的「出門」：手機還是都不在、也沒有人在家的跡象了，才執行。"""
        if self._away_hold is None:
            return
        if any(st.get("home") for st in self._presence.values()):
            self._away_hold = None
            return
        if self.home_evidence(now, self._away_hold):
            return
        self._away_hold = None
        cfg = self.store.data["settings"].get("presence") or {}
        self._away_done(cfg, "大家都出門了（家裡一陣子沒動靜）")

    def _away_end(self, arrived: list[str]) -> None:
        """有人回家：離家模式開著的話自動關掉。"""
        away = self.store.data["settings"].get("away") or {}
        if not away.get("enabled") or away.get("auto_off", True) is False:
            return
        away["enabled"] = False
        away.pop("auto_started", None)
        self.store.save()
        self.mark_native()
        self.notifier.send("離家模式已關閉", f"{'、'.join(arrived)}回家了，燈不會再隨機開關")

    def home_evidence(self, now: float, since: float) -> str | None:
        """手機都不在 Wi-Fi，但看起來還有人在家的理由（沒有就回 None）：房間的攝影機 15 分鐘內看到人在動。
        大門口看到人出去之前在房間走動的不算（出門前本來就會經過）。"""
        room_t, room_cam = self._room_seen
        left_after = now - self._door_live < DOOR_LIVE and self._door_out and room_t <= self._door_out + 30
        if now - room_t < ROOM_SEEN_HOLD and not left_after:
            return f"{room_cam} {max(1, round((now - room_t) / 60))} 分鐘內看到人"
        return None

    def _room_people(self, cid: str, st: dict[str, Any]) -> int:
        """房間的攝影機現在看到幾個「真的人」：追蹤中、而且從第一次看到的地方移動過的才算。
        一直在同一個位置的多半是被認成人的東西（沙發上的衣服堆）——它會讓「出門」永遠不執行（2026-11-28）。
        沒有追蹤資料（Jetson 沒在看）時，看到人就算 1 個。"""
        if st.get("engine") != "stream":
            self._room_from.pop(cid, None)
            return 1 if st.get("person") else 0
        tracks = [t for t in st.get("tracks") or [] if t.get("foot")]
        was = self._room_from.get(cid) or {}
        first = self._room_from[cid] = {t["id"]: was.get(t["id"], tuple(t["foot"])) for t in tracks}
        return sum(1 for t in tracks if abs(t["foot"][0] - first[t["id"]][0]) + abs(t["foot"][1] - first[t["id"]][1]) > ROOM_MOVED)

    # ---- 大門口：誰進來、誰出去 ----

    @staticmethod
    def _home_door(cam: dict[str, Any]) -> dict[str, Any] | None:
        """這台攝影機畫面裡的家門（「大門」區域）。"""
        return next((z for z in cam.get("zones") or [] if z.get("kind") == "door" and (z.get("id") == "door" or z.get("home"))), None)

    @staticmethod
    def _door_where(cam: dict[str, Any], door: dict[str, Any], foot: tuple[float, float]) -> str | None:
        """腳在哪：「home」家門口、「away」離開的那頭（電梯之類別的門，或離家門夠遠）、None 說不準。
        家門跟電梯緊貼著時，離哪個近算哪個（走進電梯不能當成走進家門）。"""
        d = zonelib.dist(foot, door["poly"])
        other = min((zonelib.dist(foot, z["poly"]) for z in cam.get("zones") or [] if z.get("kind") == "door" and z is not door and z.get("poly")), default=float("inf"))
        if d <= DOOR_NEAR and d < other:
            return "home"
        if d > DOOR_FAR or (other <= DOOR_NEAR and other <= d):
            return "away"
        return None

    def _door_feed(self, cam: dict[str, Any], now: float) -> None:
        """門口的攝影機：每個人從哪出現、在哪消失 → 進來／出去各幾人（doorcount.py）。"""
        door = self._home_door(cam)
        st = self.cameras.state.get(cam["id"], {})
        if door is None or st.get("engine") != "stream":
            self._doorcount.pop(cam["id"], None)  # 沒在追蹤：看到一半的不算
            return
        self._door_live = now
        dc = self._doorcount.setdefault(cam["id"], doorcount.DoorCount())
        last = self._door_seen.get(cam["id"], 0.0)
        for t, pts in st.get("samples") or []:
            if float(t) > last:
                dc.feed(float(t), pts)
                last = float(t)
        self._door_seen[cam["id"]] = last
        ways = [w for w, _ in dc.flush(max(now, last), lambda f: self._door_where(cam, door, f))]
        if not ways:
            return
        n_in, n_out = ways.count("in"), ways.count("out")
        if n_out:
            self._door_out = now
            # 記人消失那一刻往前幾秒（之後看錄影用）
            self._door_outs = [x for x in self._door_outs if now - x[0] < 7200] + [(now - doorcount.GONE, cam["id"])] * n_out
        name = cam.get("name") or cam["id"]
        for way, k in (("in", n_in), ("out", n_out)):
            if k:
                self._presence_log({"door": way, "k": k, "why": name})
        _LOGGER.info("%s：進來 %d 人、出去 %d 人", name, n_in, n_out)

    def _home_door_visit(self, cam: dict[str, Any], v: dict[str, Any]) -> bool:
        """這次一開始或最後，人的腳在家門口（「大門」區域附近）。家裡都沒人時不算（有人闖進家門不能當成家人）。"""
        door = self._home_door(cam)
        feet = v.get("feet") or []
        if door is None or not feet or not any(p.get("home") for p in self.people_report()):
            return False
        near = lambda pts: any(zonelib.near(f, door["poly"], DOOR_NEAR) for f in pts)  # noqa: E731
        t0, t1 = feet[0][0], feet[-1][0]
        first = [pts for t, pts in feet if t - t0 <= 1.0]
        last = [pts for t, pts in feet if t1 - t <= 1.0]
        return any(near(p) for p in first) or any(near(p) for p in last)

    # ---- 沒人在家，電器還開著 ----

    def _check_left_on(self, now: float) -> None:
        """大家都出門 10 分鐘後，還有電器開著：通知（或直接關掉）。常開的、「出門」情境裡設成不動的不算。

        同一次出門，同一個電器只講一次：手機 Wi-Fi 睡著又醒來（短暫「回家」）、樹莓派重開都不會再講；
        有人真的在家待滿 15 分鐘，才算這次出門結束。講過哪些存在樹莓派上。
        """
        people = self.people_report()
        cfg = self.store.data["settings"].get("presence") or {}
        mode = cfg.get("left_on", "notify")
        notice = self.store.data.setdefault("away_notice", {"plugs": [], "at": 0})
        if not people:
            return
        if any(p.get("home") is None for p in people):  # 剛開機還不知道誰在家
            return
        if any(p.get("home") for p in people):
            if self._home_since is None:
                self._home_since = now
            if now - self._home_since >= 900 and (notice["plugs"] or notice.get("risky")):
                notice.update(plugs=[], risky=[], at=0)
                self._dirty = True
            return
        self._home_since = None
        if self.home_evidence(now, max((p.get("since") or 0) for p in people)):  # 手機都不在，但看起來還有人在家：先不講、不關
            return
        # 高風險電器（電暖器、熨斗…）：大家一出門就關，不等 10 分鐘（設定裡可以改成只通知）
        self._risky_left_on(cfg, notice)
        if mode == "none":
            return
        since = max((p.get("since") or 0) for p in people)
        if now - since < 600:
            return
        # 「出門」情境裡設成「不動」的，代表出門時本來就要讓它開著
        away = self.store.scene(cfg.get("away_scene") or "") or {}
        keep = {pid for pid, act in (away.get("actions") or {}).items() if act == "keep"}
        on = [p for p in self.ordered() if p.online and p.is_on and not self.store.meta(p.id).keep_on
              and p.id not in keep and p.id not in notice["plugs"] and p.id not in notice.get("risky", [])]
        if not on:
            return
        notice.update(plugs=sorted(set(notice["plugs"]) | {p.id for p in on}), at=now)
        self._dirty = True
        names = "、".join(self.name(p) for p in on[:8]) + (f" 等 {len(on)} 個" if len(on) > 8 else "")
        if mode == "off":
            async def go() -> None:
                SOURCE.set("auto")
                results = await asyncio.gather(*(self.set_power(p.id, False) for p in on), return_exceptions=True)
                done = sum(1 for r in results if not isinstance(r, Exception))
                self.notifier.send("沒人在家，已經關掉電器", f"關了 {done} 個：{names}")
                await self.changed()

            self._spawn(go())
        else:
            self.notifier.send("沒人在家，但還有電器開著", f"{names}。要關的話打開家庭中控（或把「沒人在家時」設成自動關閉）", "high")

    def _risky_left_on(self, cfg: dict[str, Any], notice: dict[str, Any]) -> None:
        """大家都出門了，高風險電器還開著：關掉（或只通知），緊急通知。同一次出門每個只處理一次。"""
        handled = notice.setdefault("risky", [])
        on = [p for p in self.ordered() if p.online and p.is_on and self.store.meta(p.id).risky
              and not self.store.meta(p.id).keep_on and p.id not in handled]
        if not on:
            return
        notice["risky"] = sorted(set(handled) | {p.id for p in on})
        self._dirty = True
        names = "、".join(self.name(p) for p in on)
        if cfg.get("risky_off", True) is False:
            self.notifier.send("⚠️ 沒人在家，高風險電器還開著", f"{names}，請盡快關掉", "urgent")
            return

        async def go() -> None:
            SOURCE.set("auto")
            results = await asyncio.gather(*(self.set_power(p.id, False) for p in on), return_exceptions=True)
            failed = [self.name(p) for p, r in zip(on, results) if isinstance(r, Exception)]
            done = [self.name(p) for p, r in zip(on, results) if not isinstance(r, Exception)]
            if done:
                self.notifier.send("沒人在家，已關掉高風險電器", "、".join(done), "high")
            if failed:
                self.notifier.send("⚠️ 高風險電器關不掉！", f"{'、'.join(failed)} 沒有回應，請盡快處理", "urgent")
            await self.changed()

        self._spawn(go())

    # ---- 回家自動開：誰（的手機連上 Wi-Fi）回家 → 打開插座或執行情境 ----

    def _migrate_arrive_rules(self) -> None:
        """舊設定搬進規則清單：誰在家的「有人回家時」情境、認臉的「依時段回家動作」（改用 Wi-Fi 判斷）。"""
        rules: list[dict[str, Any]] = []
        pres = self.store.data["settings"].get("presence") or {}
        if pres.get("home_scene") and self.store.scene(pres["home_scene"]):
            rules.append(arrive_rule(who="any", when="dark" if pres.get("home_dark_only") else "all",
                                     kind="scene", scene=pres["home_scene"]))
        slots = {"day": ("range", "06:00", "18:00"), "night": ("dark", "", ""), "late": ("range", "00:00", "06:00")}
        for pid, a in (self.store.data["settings"].get("face_actions") or {}).items():
            picked = {k: a.get(k) for k in slots if a.get(k) and self.store.scene(a[k])}
            if picked and len(set(picked.values())) == 1 and len(picked) == 3:
                rules.append(arrive_rule(who=pid, kind="scene", scene=next(iter(picked.values()))))
                continue
            for k, sc in picked.items():
                when, start, end = slots[k]
                rules.append(arrive_rule(who=pid, when=when, start=start, end=end, kind="scene", scene=sc))
        for a in (self.store.data["settings"].get("face_actions") or {}).values():
            for k in slots:
                a.pop(k, None)
        pres["home_scene"] = None
        self.store.data["arrive_rules"] = rules
        self.store.save()

    def _arrive(self, ids: list[str], was_empty: bool) -> None:
        """有家人的手機連上 Wi-Fi（回家了）：照「回家自動開」的規則做。"""
        rules = self.store.data.get("arrive_rules") or []
        if not rules:
            return
        names = {p["id"]: p["name"] for p in self.store.data["people"]}
        now = datetime.now()
        hm, wd = now.hour * 60 + now.minute, now.weekday()
        for r in rules:
            if not r.get("enabled", True):
                continue
            who = r.get("who") or "any"
            if who != "any" and who not in ids:
                continue
            days = r.get("days") or "all"
            if (days == "weekday" and wd >= 5) or (days == "weekend" and wd < 5):
                continue
            when = r.get("when") or "all"
            if (when == "dark" and not self.is_dark()) or (when == "range" and not _in_window(hm, r.get("start") or "", r.get("end") or "")):
                continue
            who_name = names.get(who) if who != "any" else "、".join(names.get(i, "?") for i in ids)
            r["last"] = round(time.time())
            self._dirty = True
            why = f"{who_name}回家了"
            if r.get("kind") == "scene":
                self._presence_scene(r.get("scene"), why)
            else:
                self._spawn(self._arrive_plugs(r, why, occupied=not was_empty))

    async def _arrive_plugs(self, r: dict[str, Any], why: str, occupied: bool = False) -> None:
        SOURCE.set("auto")
        done = []
        dark = self.is_dark()
        kept_off = self._just_turned_off() if occupied else set()  # 家裡有人：他剛關掉的不要又打開
        for pid in r.get("plugs") or []:
            plug = self.plugs.get(pid)
            if not plug or not plug.online or plug.is_on:
                continue  # 已經開著的不動
            if not dark and r.get("lights_dark", True) and self.is_light(plug):
                continue  # 白天回家不用開燈
            if pid in kept_off:
                continue
            try:
                if r.get("for_min"):
                    await self.set_timer(pid, int(r["for_min"]) * 60)
                else:
                    await self.set_power(pid, True)
                done.append(self.name(plug))
            except Exception as err:  # noqa: BLE001
                _LOGGER.warning("回家自動開沒有打開 %s：%s", pid, err)
        if done:
            what = f"打開{'、'.join(done)}"
            self._presence_log({"scene": what, "why": why, "n": len(done)})
            self.notifier.send(why, f"已經{what}" + (f"，{r['for_min']} 分鐘後自動關" if r.get("for_min") else ""))
            await self.changed()

    def _just_turned_off(self) -> set[str]:
        """最近有人手動關掉、到現在還關著的插座（家裡有人時，別人回家不要又把它打開）。"""
        last: dict[str, tuple[bool, str]] = {}
        for _ts, pid, on, src in self.store.energy.switches(time.time() - ARRIVE_KEEP_OFF):
            last[pid] = (on, src)
        return {pid for pid, (on, src) in last.items() if not on and src in ARRIVE_SOURCES}

    def is_light(self, plug: Plug) -> bool:
        """這個插座接的是燈嗎：自己選的圖示，或照名稱猜。"""
        icon = self.store.meta(plug.id).icon or ""
        if icon:
            return any(k in icon for k in ("lamp", "light", "led", "bulb"))
        name = self.name(plug).lower()
        return "燈" in name or "lamp" in name or "light" in name

    def arrive_suggestions(self) -> list[dict[str, Any]]:
        """回家習慣：某人回家後 15 分鐘內，常手動打開同一個插座（至少 3 次、超過 4 成），而且還沒有規則管 → 建議做成規則。"""
        people = {p["name"]: p["id"] for p in self.store.data["people"]}
        log = [x for x in self.store.data.get("presence_log") or [] if x.get("home") is True and x.get("name") in people]
        if not log:
            return []
        sw = [x for x in self.store.energy.switches(log[0]["t"] - 120) if x[2] and x[3] in ARRIVE_SOURCES]
        covered = {(r.get("who"), pid) for r in self.store.data.get("arrive_rules") or [] if r.get("kind") == "plugs" for pid in r.get("plugs") or []}
        out = []
        for name, pid in people.items():
            times = [x["t"] for x in log if x["name"] == name]
            hits: dict[str, int] = {}
            for t in times:
                for plug in {p for ts, p, _on, _src in sw if t - 120 <= ts <= t + ARRIVE_LOOK}:
                    hits[plug] = hits.get(plug, 0) + 1
            for plug, n in hits.items():
                if n >= 3 and n / len(times) > 0.4 and plug in self.plugs and (pid, plug) not in covered and ("any", plug) not in covered:
                    out.append({"who": pid, "name": name, "plug": plug, "plug_name": self.name(self.plugs[plug]), "hits": n, "n": len(times)})
        return sorted(out, key=lambda x: -x["hits"] / x["n"])

    def _presence_scene(self, scene_id: str | None, why: str) -> None:
        scene = self.store.scene(scene_id) if scene_id else None
        if scene is None:
            return

        async def go() -> None:
            SOURCE.set("auto")
            done = await self.run_scene(scene["id"])
            self._presence_log({"scene": scene["name"], "why": why, "n": len(done)})
            self.notifier.send(why, f"已經執行「{scene['name']}」" + (f"，動了 {len(done)} 個插座" if done else "（插座本來就是這樣）"))
            await self.changed()

        self._spawn(go())

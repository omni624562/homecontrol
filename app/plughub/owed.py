"""欠著的開關：自動化（出門關電、晚安、排程）要開／關的插座剛好連不上、或沒回應，
先記下來，連回來就補做——不然那一個就這樣漏掉，也沒人知道。

- 要「關」的最多欠 12 小時；要「開」的只欠 15 分鐘（隔太久才突然打開反而嚇人）
- 這段時間有人自己開關過那個插座（App、Google Home、按插座上的按鈕）→ 以人為準，不補了
- 「沒人在家」才要關的：有人回家了就不補
- 存在 store 裡，樹莓派重開也還記得
"""
from __future__ import annotations

import asyncio
import logging
import time
from typing import Any

from .presence import SOURCE

_LOGGER = logging.getLogger("plughub.hub")

OWE_OFF_MAX = 12 * 3600
OWE_ON_MAX = 15 * 60
OWE_RETRY = 60  # 秒：補做失敗，隔這麼久再試


class OwedMixin:
    """Hub 的「欠著補做」這一塊。"""

    def _owed(self) -> dict[str, dict[str, Any]]:
        return self.store.data.setdefault("owed", {})

    def _owed_drop(self, pid: str) -> None:
        if self.store.data.get("owed", {}).pop(pid, None) is not None:
            self._dirty = True

    async def switch_all(self, wants: dict[str, bool], why: str, cond: str = "", for_s: float = 0) -> tuple[list[str], list[str]]:
        """把 wants 裡的插座開或關（本來就是那樣的不動；鎖定的不動）。
        連不上、沒回應的欠著。回傳（做成的, 欠著的）插座 ID。"""
        from .hub import Locked  # noqa: PLC0415

        done: list[str] = []
        owed: list[str] = []
        todo: list[tuple[str, bool]] = []
        for pid, on in wants.items():
            plug = self.plugs.get(pid)
            if plug is None or plug.is_on is on:  # 連不上、但斷線前就是那樣的也不用欠
                continue
            if plug.online:
                todo.append((pid, on))
            else:
                owed.append(pid)
        results = await asyncio.gather(*(self.set_power(pid, on) for pid, on in todo), return_exceptions=True)
        for (pid, _on), r in zip(todo, results):
            if isinstance(r, Locked):
                continue
            (owed if isinstance(r, Exception) else done).append(pid)
        now = time.time()
        for pid in owed:
            self._owed()[pid] = {"on": wants[pid], "why": why, "at": now, "cond": cond, "src": SOURCE.get(), "for_s": for_s}
            _LOGGER.info("%s：%s 連不上，先欠著", why, self.name(self.plugs[pid]))
        if owed:
            self._dirty = True
        return done, owed

    def owed_text(self, ids: list[str]) -> str:
        """通知裡的那一句。"""
        if not ids:
            return ""
        on = self._owed().get(ids[0], {}).get("on")
        return f"{'、'.join(self.name(self.plugs[i]) for i in ids)} 連不上，還沒{'開' if on else '關'}；連回來會自動補{'開' if on else '關'}"

    async def _owed_tick(self) -> None:
        """插座連回來了：把欠著的補做。過期的、已經不用做的拿掉。"""
        owed = self.store.data.get("owed")
        if not owed or getattr(self, "_owed_busy", False):
            return
        now = time.time()
        someone_home = any(p.get("home") for p in self.people_report())
        todo: dict[str, dict[str, Any]] = {}
        for pid, o in list(owed.items()):
            plug = self.plugs.get(pid)
            if plug is None or now - o["at"] > (OWE_ON_MAX if o["on"] else OWE_OFF_MAX) or (o.get("cond") == "away" and someone_home):
                self._owed_drop(pid)
            elif plug.online and plug.is_on is o["on"]:
                self._owed_drop(pid)
            elif plug.online and now - o.get("tried", 0) >= OWE_RETRY:
                todo[pid] = o
        if not todo:
            return
        self._owed_busy = True
        try:
            made: dict[tuple[bool, str], list[str]] = {}
            for pid, o in todo.items():
                SOURCE.set(o.get("src") or "auto")
                try:
                    if o["on"] and o.get("for_s"):
                        await self.set_timer(pid, o["for_s"])
                    else:
                        await self.set_power(pid, o["on"])
                    self._owed_drop(pid)
                    made.setdefault((o["on"], o["why"]), []).append(self.name(self.plugs[pid]))
                except Exception as err:  # noqa: BLE001
                    o["tried"] = now
                    _LOGGER.info("補做沒成功 %s：%s", pid, err)
            for (on, why), names in made.items():
                word = "開" if on else "關"
                self.notifier.send(f"已經補{word}", f"{'、'.join(names)} 連回來了，已經補{word}（{why}的時候它連不上）")
            if made:
                await self.changed()
        finally:
            self._owed_busy = False

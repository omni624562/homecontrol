"""卡住偵測：主程式（排程每秒跑一次）超過 STALL_S 秒沒動，就通知並結束程式，
讓 Docker（restart: unless-stopped）自動重新啟動。

重新啟動後會再通知一次「已經恢復」。另外 /api/health 給 Docker 的 healthcheck 看。
"""

from __future__ import annotations

import json
import logging
import os
import threading
import time
from pathlib import Path
from typing import Callable

_LOGGER = logging.getLogger(__name__)

STALL_S = 120  # 主程式多久沒動算卡住
CHECK_S = 10


class Watchdog:
    def __init__(self, data_dir: Path, notify: Callable[[str, str], None], clock=time.monotonic) -> None:
        self.mark = data_dir / "watchdog.json"
        self.notify = notify  # 同步送出（卡住時主程式不能幫忙）
        self.clock = clock
        self.beat = clock()
        self.started = time.time()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self.exit: Callable[[int], None] = os._exit

    def tick(self) -> None:
        self.beat = self.clock()

    def stalled_for(self) -> float:
        return self.clock() - self.beat

    def healthy(self) -> bool:
        return self.stalled_for() < STALL_S

    def start(self) -> None:
        self.beat = self.clock()
        self._thread = threading.Thread(target=self._run, name="watchdog", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()

    def after_restart(self) -> str | None:
        """上次是卡住被重新啟動的話，回傳原因（並清掉紀錄）。"""
        try:
            data = json.loads(self.mark.read_text("utf-8"))
        except (OSError, ValueError):
            return None
        self.mark.unlink(missing_ok=True)
        return str(data.get("reason") or "卡住了")

    def check_once(self) -> bool:
        """卡住就處理並回傳 True。"""
        stalled = self.stalled_for()
        if stalled < STALL_S:
            return False
        reason = f"主程式 {round(stalled)} 秒沒有反應"
        _LOGGER.error("%s，重新啟動", reason)
        try:
            self.mark.write_text(json.dumps({"reason": reason, "at": time.time()}, ensure_ascii=False), "utf-8")
        except OSError:
            pass
        try:
            self.notify("家庭中控卡住了", f"{reason}，正在自動重新啟動")
        except Exception:  # noqa: BLE001
            _LOGGER.exception("卡住通知送不出去")
        self.exit(3)
        return True

    def _run(self) -> None:
        while not self._stop.wait(CHECK_S):
            if self.check_once():
                return

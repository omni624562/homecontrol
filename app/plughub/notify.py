"""通知：用 ntfy（https://ntfy.sh）推播到手機。

手機裝 ntfy App，訂閱一個只有你知道的主題名稱，再把同一個名稱填到儀表板的
「設定 → 手機通知」。沒填就不發通知。
"""

from __future__ import annotations

import asyncio
import base64
import logging
import urllib.request
from typing import Callable

_LOGGER = logging.getLogger(__name__)
NTFY_SERVER = "https://ntfy.sh"


class Notifier:
    def __init__(self, topic: Callable[[], str]) -> None:
        self._topic = topic

    def send(self, title: str, message: str, priority: str = "default") -> None:
        topic = (self._topic() or "").strip()
        _LOGGER.info("通知：%s｜%s", title, message)
        if not topic:
            return
        asyncio.get_running_loop().run_in_executor(None, _post, topic, title, message, priority)


def _post(topic: str, title: str, message: str, priority: str) -> None:
    req = urllib.request.Request(
        f"{NTFY_SERVER}/{topic}",
        data=message.encode("utf-8"),
        headers={
            # HTTP 標頭只能放 ASCII，中文標題用 RFC 2047 編碼
            "Title": "=?UTF-8?B?" + base64.b64encode(title.encode()).decode() + "?=",
            "Priority": priority,
            "Tags": "electric_plug",
        },
        method="POST",
    )
    try:
        urllib.request.urlopen(req, timeout=10).read()
    except Exception as err:  # noqa: BLE001
        _LOGGER.warning("ntfy 通知失敗：%s", err)

"""通知：用 LINE 官方的 Messaging API 推播到手機（不用另外裝 App）。

在 LINE Developers 建一個自己的機器人（Messaging API channel），把 Channel access token
貼到儀表板的「設定 → 提醒與通知」，再用 LINE 加這個機器人好友。加了好友的人都會收到。
權杖只存在樹莓派（data/secrets.json），不會回傳給瀏覽器。

舊版畫面填的 ntfy 主題還是會送（有填才送）。
"""

from __future__ import annotations

import base64
import json
import logging
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Callable

_LOGGER = logging.getLogger(__name__)
NTFY_SERVER = "https://ntfy.sh"
LINE_API = "https://api.line.me/v2/bot"
_MARK = {"high": "❗ ", "urgent": "🚨 "}


class LineError(Exception):
    pass


def _line(token: str, path: str, body: dict | None = None) -> dict:
    req = urllib.request.Request(
        f"{LINE_API}/{path}",
        data=None if body is None else json.dumps(body).encode("utf-8"),
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        method="GET" if body is None else "POST",
    )
    try:
        raw = urllib.request.urlopen(req, timeout=10).read()
        return json.loads(raw or b"{}")
    except urllib.error.HTTPError as err:
        try:
            msg = json.loads(err.read()).get("message", "")
        except Exception:  # noqa: BLE001
            msg = ""
        if err.code == 401:
            raise LineError("LINE 不接受這組權杖，請確認貼的是 Channel access token（長期）") from None
        if err.code == 429:
            raise LineError("這個月的 LINE 免費則數用完了，下個月才會恢復") from None
        raise LineError(f"LINE 回覆錯誤 {err.code}{f'：{msg}' if msg else ''}") from None
    except Exception as err:  # noqa: BLE001
        raise LineError(f"連不上 LINE：{type(err).__name__}") from None


class Notifier:
    def __init__(self, topic: Callable[[], str], secrets_path: Path) -> None:
        self._topic = topic
        self._path = secrets_path
        self.error: str | None = None  # 最近一次 LINE 推播失敗的原因
        self._info: tuple[float, dict] | None = None

    # ---- 權杖 ----
    def _secrets(self) -> dict:
        try:
            return json.loads(self._path.read_text("utf-8"))
        except Exception:  # noqa: BLE001
            return {}

    def _token(self) -> str:
        return self._secrets().get("line_token") or ""

    def set_token(self, token: str) -> dict[str, Any]:
        """空字串 = 刪掉。存之前先問 LINE 這組權杖對不對。"""
        token = token.strip()
        name = ""
        if token:
            name = _line(token, "info").get("displayName", "")
        data = self._secrets()
        if token:
            data["line_token"] = token
            data["line_name"] = name
        else:
            data.pop("line_token", None)
            data.pop("line_name", None)
        tmp = self._path.with_suffix(".tmp")
        tmp.write_text(json.dumps(data), "utf-8")
        tmp.chmod(0o600)
        tmp.replace(self._path)
        self.error = None
        self._info = None
        return self.status()

    def status(self) -> dict[str, Any]:
        s = self._secrets()
        return {"line": bool(s.get("line_token")), "name": s.get("line_name") or "", "error": self.error}

    def usage(self) -> dict[str, Any]:
        """這個月用了幾則、上限幾則、幾個好友會收到（問 LINE，10 分鐘內不重問）。"""
        token = self._token()
        if not token:
            return {}
        if self._info and time.time() - self._info[0] < 600:
            return self._info[1]
        out: dict[str, Any] = {}
        quota = _line(token, "message/quota")
        out["limit"] = quota.get("value") if quota.get("type") == "limited" else None
        out["used"] = _line(token, "message/quota/consumption").get("totalUsage")
        self._info = (time.time(), out)
        return out

    # ---- 送出 ----
    def send(self, title: str, message: str, priority: str = "default") -> None:
        """可以從任何執行緒呼叫（垃圾車、停水停電是在背景執行緒裡查的）。"""
        _LOGGER.info("通知：%s｜%s", title, message)
        topic = (self._topic() or "").strip()
        if topic:
            threading.Thread(target=_ntfy, args=(topic, title, message, priority), daemon=True).start()
        if self._token():
            threading.Thread(target=self._push, args=(title, message, priority), daemon=True).start()

    def push_now(self, title: str, message: str) -> None:
        """馬上送、失敗就丟出原因（測試用）。"""
        token = self._token()
        if not token:
            raise LineError("還沒有設定 LINE 權杖")
        _line(token, "message/broadcast", {"messages": [{"type": "text", "text": f"{title}\n{message}"[:4900]}]})
        self.error = None
        self._info = None

    def _push(self, title: str, message: str, priority: str) -> None:
        try:
            self.push_now(_MARK.get(priority, "") + title, message)
        except LineError as err:
            self.error = str(err)
            _LOGGER.warning("LINE 通知失敗：%s", err)


def _ntfy(topic: str, title: str, message: str, priority: str) -> None:
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

"""Claude 看影像：事件的那幾張畫面送到 Anthropic（Claude），寫一句話描述、給緊急事件第二意見、每天的摘要寫成一段話、看不出多了什麼時判斷。

隱私：
- 總開關（settings.claude_vision.on）關著就完全不送；每一項各有開關；只送「可以送」的攝影機（cams）
- 只在事件發生時送那幾張，縮成 SEND_W 寬；不持續上傳
- 金鑰、模型、每月上限跟「問家裡」共用（assistant.py），用量另外記「看了幾次」
任何錯誤（沒網路、超過上限、被擋）都回傳 None：呼叫的地方照舊用原本的文字。
"""
from __future__ import annotations

import base64
import logging
from datetime import date
from typing import TYPE_CHECKING, Any

import anthropic

from .assistant import DEFAULT_MODEL

if TYPE_CHECKING:
    from .hub import Hub

_LOGGER = logging.getLogger(__name__)
SEND_W = 800
FEATURES = ("describe", "ask", "second", "story", "classify")
DEFAULTS = {"on": False, "describe": True, "ask": True, "second": False, "story": True, "classify": False, "cams": []}
SYSTEM = ("你在幫一個台灣家庭看自家攝影機的畫面。用台灣的繁體中文，口語、簡短、具體（顏色、動作、東西），不要猜身分、不要編造畫面裡沒有的事；"
          "看不清楚就說看不清楚。不要用表格或列點。")


def shrink(jpeg: bytes, width: int = SEND_W) -> bytes:
    """縮成 width 寬（省 token、少送細節）。"""
    import cv2
    import numpy as np

    img = cv2.imdecode(np.frombuffer(jpeg, np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        return jpeg
    if img.shape[1] > width:
        img = cv2.resize(img, (width, round(img.shape[0] * width / img.shape[1])), interpolation=cv2.INTER_AREA)
    ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 80])
    return buf.tobytes() if ok else jpeg


def image_block(jpeg: bytes) -> dict[str, Any]:
    return {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": base64.standard_b64encode(shrink(jpeg)).decode()}}


class ClaudeVision:
    def __init__(self, hub: "Hub") -> None:
        self.hub = hub
        self.error: str | None = None

    @property
    def cfg(self) -> dict[str, Any]:
        return {**DEFAULTS, **(self.hub.store.data["settings"].get("claude_vision") or {})}

    def allowed(self, feature: str, cam_id: str | None = None) -> bool:
        """這一項現在可以送畫面嗎：總開關、這一項、這台攝影機、有金鑰、還沒到上限。"""
        c = self.cfg
        if not c["on"] or not c.get(feature) or not self.hub.assistant.configured:
            return False
        if cam_id is not None and cam_id not in (c.get("cams") or []):
            return False
        st = self.hub.assistant.status()
        return not (st["cap"] and st["month_usd"] >= st["cap"])

    def status(self) -> dict[str, Any]:
        month = date.today().strftime("%Y-%m")
        u = self.hub.store.data.get("assistant_usage", {}).get(month, {})
        return {**self.cfg, "configured": self.hub.assistant.configured, "looks": u.get("vision", 0), "error": self.error,
                "model": self.hub.assistant.status()["model"], "month_usd": self.hub.assistant.status()["month_usd"]}

    async def look(self, feature: str, cam_id: str | None, jpegs: list[bytes], prompt: str, max_tokens: int = 400) -> str | None:
        """送幾張畫面＋問題，回 Claude 的一段話；不能送或失敗 → None。"""
        if not self.allowed(feature, cam_id):
            return None
        a = self.hub.assistant
        model = (self.hub.store.data["settings"].get("assistant") or {}).get("model") or DEFAULT_MODEL
        content: list[dict[str, Any]] = [image_block(j) for j in jpegs[:4]] + [{"type": "text", "text": prompt}]
        kwargs: dict[str, Any] = {"model": model, "max_tokens": max_tokens, "system": SYSTEM, "messages": [{"role": "user", "content": content}],
                                  "output_config": {"effort": "low"}}
        try:
            client = anthropic.AsyncAnthropic(api_key=a._secrets().get("anthropic_api_key"), timeout=60.0, base_url=a._secrets().get("anthropic_base_url") or None)
            if model == "claude-opus-5-5":
                resp = await client.beta.messages.create(betas=["server-side-fallback-2026-07-01"], fallbacks="default", **kwargs)
            else:
                resp = await client.messages.create(**kwargs)
        except anthropic.APIError as err:
            self.error = str(err)[:200]
            _LOGGER.warning("Claude 看影像失敗：%s", err)
            return None
        a._track(model, resp.usage)
        month = date.today().strftime("%Y-%m")
        cur = self.hub.store.data.setdefault("assistant_usage", {}).setdefault(month, {"usd": 0.0, "count": 0})
        cur["vision"] = cur.get("vision", 0) + 1
        self.hub._dirty = True
        self.error = None
        if resp.stop_reason == "refusal":
            return None
        text = "".join(b.text for b in resp.content if b.type == "text").strip()
        return text or None

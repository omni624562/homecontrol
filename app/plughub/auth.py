"""配對：只有配對過的手機、電腦才能用 API。

以前區網裡任何裝置都能開關插座、改設定、呼叫「問家裡」。現在每台裝置要先輸入一次
6 位數配對碼，之後瀏覽器記住一個長期有效的通行證（cookie，只存它的雜湊在 data/auth.json）。

配對碼從哪裡來（10 分鐘有效、用一次就失效）：
- 已經配對的裝置：設定 → 已配對的裝置 → 新增裝置
- 配對畫面按「傳配對碼到手機通知」（LINE）；伺服器的紀錄檔也會印出來
- 樹莓派上：docker exec plughub python -m plughub.auth

樹莓派本機（Matterbridge 外掛、nginx 問通行證）不用配對。
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import secrets
import sys
import time
import uuid
from pathlib import Path
from typing import Any

CODE_TTL = 10 * 60
MAX_FAILS = 5  # 10 分鐘內輸錯這麼多次就暫停 5 分鐘
FAIL_WINDOW = 10 * 60
LOCK_S = 5 * 60
COOKIE = "plughub_token"
COOKIE_MAX_AGE = 10 * 365 * 86400


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


class Auth:
    def __init__(self, data_dir: Path, clock=time.time) -> None:
        self.path = data_dir / "auth.json"
        self.code_path = data_dir / "pair_code.json"  # 命令列產生的配對碼（另一個程序）
        self.clock = clock
        self.devices: list[dict[str, Any]] = []
        self._code: tuple[str, float] | None = None
        self._fails: list[float] = []
        self._locked_until = 0.0
        self._last_save = 0.0
        try:
            self.devices = json.loads(self.path.read_text("utf-8")).get("devices", [])
        except (OSError, ValueError):
            self.devices = []

    # ---- 存檔 ----

    def save(self) -> None:
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps({"devices": self.devices}, ensure_ascii=False, indent=1), "utf-8")
        os.chmod(tmp, 0o600)
        tmp.replace(self.path)
        self._last_save = self.clock()

    # ---- 配對碼 ----

    def new_code(self) -> str:
        code = f"{secrets.randbelow(10**6):06d}"
        self._code = (code, self.clock() + CODE_TTL)
        return code

    def code_left(self) -> int:
        if not self._code:
            return 0
        return max(0, round(self._code[1] - self.clock()))

    def _file_code(self) -> tuple[str, float] | None:
        try:
            d = json.loads(self.code_path.read_text("utf-8"))
            return d["hash"], float(d["expires"])
        except (OSError, ValueError, KeyError, TypeError):
            return None

    def locked_for(self) -> int:
        return max(0, round(self._locked_until - self.clock()))

    def pair(self, code: str, name: str = "", ua: str = "") -> tuple[str, dict[str, Any]] | None:
        """配對碼對了就回傳（通行證, 裝置）；錯了回傳 None。"""
        now = self.clock()
        if self.locked_for():
            return None
        code = "".join(ch for ch in str(code) if ch.isdigit())
        ok = False
        if self._code and self._code[1] > now and hmac.compare_digest(code, self._code[0]):
            ok = True
            self._code = None
        else:
            fc = self._file_code()
            if fc and fc[1] > now and hmac.compare_digest(_hash(code), fc[0]):
                ok = True
                self.code_path.unlink(missing_ok=True)
        if not ok:
            self._fails = [t for t in self._fails if now - t < FAIL_WINDOW] + [now]
            if len(self._fails) >= MAX_FAILS:
                self._locked_until = now + LOCK_S
                self._fails = []
            return None
        self._fails = []
        token = secrets.token_urlsafe(32)
        device = {
            "id": uuid.uuid4().hex[:8],
            "name": (name or "").strip()[:40] or _guess_name(ua),
            "hash": _hash(token),
            "created": round(now),
            "last_seen": round(now),
        }
        self.devices.append(device)
        self.save()
        return token, device

    # ---- 檢查通行證 ----

    def check(self, token: str | None) -> dict[str, Any] | None:
        if not token:
            return None
        h = _hash(token)
        for d in self.devices:
            if hmac.compare_digest(d["hash"], h):
                now = self.clock()
                d["last_seen"] = round(now)
                if now - self._last_save > 3600:  # 最後使用時間不用每次都寫
                    self.save()
                return d
        return None

    def remove(self, device_id: str) -> bool:
        before = len(self.devices)
        self.devices = [d for d in self.devices if d["id"] != device_id]
        if len(self.devices) != before:
            self.save()
            return True
        return False

    def rename(self, device_id: str, name: str) -> bool:
        for d in self.devices:
            if d["id"] == device_id:
                d["name"] = name.strip()[:40] or d["name"]
                self.save()
                return True
        return False

    def set_remote(self, device_id: str, on: bool) -> bool:
        """「在外面也能用」：只有打開的裝置能從家裡以外的網路連進來。"""
        for d in self.devices:
            if d["id"] == device_id:
                d["remote"] = bool(on)
                self.save()
                return True
        return False

    def public(self, current: str | None = None) -> list[dict[str, Any]]:
        return [
            {"id": d["id"], "name": d["name"], "created": d["created"], "last_seen": d["last_seen"], "current": d["id"] == current, "mac": d.get("mac"),
             "remote": bool(d.get("remote")), "last_remote": d.get("last_remote")}
            for d in self.devices
        ]


def _guess_name(ua: str) -> str:
    ua = ua or ""
    for key, name in (("iPhone", "iPhone"), ("iPad", "iPad"), ("Android", "Android 手機"), ("Macintosh", "Mac"), ("Windows", "Windows 電腦"), ("Linux", "Linux 電腦")):
        if key in ua:
            return name
    return "裝置"


def main() -> None:
    """樹莓派上產生配對碼：docker exec plughub python -m plughub.auth"""
    data = Path(os.environ.get("PLUGHUB_DATA", "/data"))
    code = f"{secrets.randbelow(10**6):06d}"
    path = data / "pair_code.json"
    path.write_text(json.dumps({"hash": _hash(code), "expires": time.time() + CODE_TTL}), "utf-8")
    os.chmod(path, 0o600)
    print(f"配對碼：{code}（10 分鐘內有效，用一次就失效）", file=sys.stdout)


if __name__ == "__main__":
    main()

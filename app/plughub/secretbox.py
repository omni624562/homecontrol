"""把帳密加密後才寫進檔案（Fernet：AES-128-CBC＋HMAC）。

金鑰在 data/secret.key（600，第一次自動產生），不會備份到 NAS：備份檔裡只有加密過的帳密，被拿走也看不到。
還原到新的樹莓派時沒有金鑰，攝影機帳密要重新輸入一次。
"""
from __future__ import annotations

import logging
import os
from pathlib import Path

_LOGGER = logging.getLogger(__name__)
PREFIX = "enc1:"


class SecretBox:
    def __init__(self, key_path: Path) -> None:
        self.path = key_path
        self._f = None

    def _fernet(self):
        from cryptography.fernet import Fernet

        if self._f is None:
            try:
                key = self.path.read_bytes().strip()
            except FileNotFoundError:
                key = Fernet.generate_key()
                tmp = self.path.with_suffix(".tmp")
                tmp.write_bytes(key)
                os.chmod(tmp, 0o600)
                tmp.replace(self.path)
            self._f = Fernet(key)
        return self._f

    def seal(self, text: str) -> str:
        return PREFIX + self._fernet().encrypt(text.encode()).decode()

    def open(self, sealed: str) -> str | None:
        """解不開（金鑰不對、壞掉）→ None。"""
        from cryptography.fernet import InvalidToken

        if not sealed.startswith(PREFIX):
            return None
        try:
            return self._fernet().decrypt(sealed[len(PREFIX):].encode()).decode()
        except (InvalidToken, ValueError):
            return None

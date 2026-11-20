"""每天自動備份 data/ 到 NAS（或任何掛進容器 /backup 的資料夾）。

- 每天 03:30 打包成 plughub-YYYY-MM-DD.tar.gz，留最近 KEEP 份
- energy.db 用 SQLite 的線上備份（不會備到寫一半的資料庫）
- 下載來的快取（天氣、路線、垃圾車…）不備份，重新啟動會再抓
- 失敗會通知（LINE／ntfy），設定頁顯示上次備份的時間

還原：停掉容器，把備份檔解開到 app/data/，再啟動。
"""

from __future__ import annotations

import io
import logging
import os
import sqlite3
import tarfile
import tempfile
import time
from datetime import date, datetime
from pathlib import Path
from typing import Any

_LOGGER = logging.getLogger(__name__)

KEEP = 30
PREFIX = "plughub-"
# 可以重新下載的快取，不用備份
SKIP = {
    "alerts_cache.json", "bus_routes.json", "garbage_arrivals.json", "garbage_lines.json",
    "roads.json", "usage_cache.json", "weather_cache.json", "pair_code.json",
}


def target_dir() -> Path | None:
    """備份放哪裡：/backup（docker-compose 掛進來的）底下的 PLUGHUB_BACKUP_SUBDIR；沒有掛就不備份。"""
    root = Path(os.environ.get("PLUGHUB_BACKUP_ROOT", "/backup"))
    if not root.is_dir():
        return None
    sub = os.environ.get("PLUGHUB_BACKUP_SUBDIR", "").strip("/")
    return root / sub if sub else root


def _sqlite_copy(src: Path) -> bytes:
    with tempfile.TemporaryDirectory() as tmp:
        out = Path(tmp) / src.name
        a, b = sqlite3.connect(src), sqlite3.connect(out)
        try:
            a.backup(b)
        finally:
            a.close()
            b.close()
        return out.read_bytes()


def make_backup(data_dir: Path, dest: Path, today: date | None = None, keep: int = KEEP) -> Path:
    """打包 data_dir 到 dest；回傳備份檔路徑。失敗丟出例外。"""
    today = today or date.today()
    dest.mkdir(parents=True, exist_ok=True)
    final = dest / f"{PREFIX}{today.isoformat()}.tar.gz"
    tmp = dest / f".{final.name}.part"
    with tarfile.open(tmp, "w:gz") as tar:
        for path in sorted(data_dir.rglob("*")):
            rel = path.relative_to(data_dir)
            if not path.is_file() or rel.name in SKIP or rel.suffix in (".tmp", ".part") or rel.name.endswith(("-wal", "-shm", "-journal")):
                continue
            if rel.suffix == ".db":
                blob = _sqlite_copy(path)
                info = tarfile.TarInfo(str(rel))
                info.size = len(blob)
                info.mtime = int(path.stat().st_mtime)
                info.mode = 0o644
                tar.addfile(info, io.BytesIO(blob))
            else:
                try:
                    tar.add(path, arcname=str(rel), recursive=False)
                except FileNotFoundError:  # 打包時剛好被換掉
                    continue
    # 確認打包得出來的檔案讀得回來
    with tarfile.open(tmp, "r:gz") as tar:
        names = tar.getnames()
    if "store.json" not in names and (data_dir / "store.json").exists():
        tmp.unlink(missing_ok=True)
        raise RuntimeError("備份裡沒有 store.json")
    tmp.replace(final)
    prune(dest, keep)
    return final


def prune(dest: Path, keep: int = KEEP) -> list[Path]:
    old = sorted(p for p in dest.glob(f"{PREFIX}*.tar.gz"))[:-keep] if keep > 0 else []
    for p in old:
        p.unlink(missing_ok=True)
    return old


class Backup:
    """每天固定時間備份一次；狀態給設定頁看。"""

    HOUR, MINUTE = 3, 30

    def __init__(self, data_dir: Path, notify) -> None:
        self.data_dir = data_dir
        self.notify = notify  # (title, message) -> None
        self.last: dict[str, Any] = {}
        self._done_day: str | None = None
        self.busy = False
        self._listing: dict[str, Any] | None = None

    def _scan(self) -> dict[str, Any]:
        """看備份資料夾裡有幾份（NAS 上，不要每次畫面更新都去讀）。"""
        dest = target_dir()
        try:
            files = sorted(dest.glob(f"{PREFIX}*.tar.gz")) if dest and dest.is_dir() else []
        except OSError:
            files = []
        self._listing = {
            "configured": dest is not None,
            "dir": os.environ.get("PLUGHUB_BACKUP_LABEL") or (str(dest) if dest else None),
            "count": len(files),
            "latest": files[-1].name if files else None,
        }
        return self._listing

    def report(self) -> dict[str, Any]:
        return {**(self._listing or self._scan()), **self.last, "busy": self.busy}

    def due(self, now: datetime) -> bool:
        day = now.date().isoformat()
        if self._done_day is None:  # 剛啟動：今天已經備份過就不再備
            latest = self._scan()["latest"]
            self._done_day = latest[len(PREFIX):len(PREFIX) + 10] if latest else ""
        return self._done_day != day and (now.hour, now.minute) >= (self.HOUR, self.MINUTE)

    def run(self, now: datetime | None = None) -> dict[str, Any]:
        """同步執行（放到 thread 裡跑）。"""
        now = now or datetime.now()
        self._done_day = now.date().isoformat()
        dest = target_dir()
        if dest is None:
            self.last = {"ok": False, "at": time.time(), "error": "沒有設定備份資料夾"}
            return self.last
        self.busy = True
        try:
            path = make_backup(self.data_dir, dest, now.date())
            self.last = {"ok": True, "at": time.time(), "file": path.name, "size": path.stat().st_size, "error": None}
            _LOGGER.info("備份完成：%s（%d KB）", path, path.stat().st_size // 1024)
        except Exception as err:  # noqa: BLE001
            self.last = {"ok": False, "at": time.time(), "error": str(err)[:200]}
            _LOGGER.exception("備份失敗")
            self.notify("備份失敗", f"家庭中控今天沒有備份成功：{str(err)[:120]}")
        finally:
            self.busy = False
            self._scan()
        return self.last

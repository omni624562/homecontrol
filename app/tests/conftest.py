"""測試共用：每個測試用自己的暫存 data/ 資料夾，不碰真的插座、不上網。"""

from __future__ import annotations

import importlib
import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


@pytest.fixture
def data_dir(tmp_path: Path) -> Path:
    d = tmp_path / "data"
    d.mkdir()
    return d


@pytest.fixture
def app_module(data_dir: Path, monkeypatch: pytest.MonkeyPatch):
    """重新載入 plughub.main，讓它用暫存的 data/（不啟動背景工作、不找插座）。"""
    monkeypatch.setenv("PLUGHUB_DATA", str(data_dir))
    monkeypatch.setenv("PLUGHUB_BACKUP_ROOT", str(data_dir.parent / "backup"))
    for name in [m for m in sys.modules if m.startswith("plughub")]:
        del sys.modules[name]
    return importlib.import_module("plughub.main")

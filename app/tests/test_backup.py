import sqlite3
import tarfile
from datetime import date, datetime

from plughub import backup


def _seed(data_dir):
    (data_dir / "store.json").write_text('{"rooms": []}', "utf-8")
    (data_dir / "weather_cache.json").write_text("{}", "utf-8")  # 快取：不備份
    (data_dir / "matterbridge" / "storage").mkdir(parents=True)
    (data_dir / "matterbridge" / "storage" / "fabric.json").write_text("x", "utf-8")
    db = sqlite3.connect(data_dir / "energy.db")
    db.execute("CREATE TABLE t (v INTEGER)")
    db.execute("INSERT INTO t VALUES (42)")
    db.commit()
    return db  # 備份時資料庫還開著


def test_backup_contents(data_dir, tmp_path):
    db = _seed(data_dir)
    dest = tmp_path / "nas"
    out = backup.make_backup(data_dir, dest, date(2026, 11, 20))
    db.close()
    assert out.name == "plughub-2026-11-20.tar.gz"
    with tarfile.open(out) as tar:
        names = set(tar.getnames())
        assert {"store.json", "energy.db", "matterbridge/storage/fabric.json"} <= names
        assert "weather_cache.json" not in names
        tar.extract("energy.db", tmp_path / "restore")
    got = sqlite3.connect(tmp_path / "restore" / "energy.db").execute("SELECT v FROM t").fetchone()
    assert got == (42,)
    assert not list(dest.glob(".*.part"))


def test_prune_keeps_latest(data_dir, tmp_path):
    _seed(data_dir).close()
    dest = tmp_path / "nas"
    for d in range(1, 8):
        backup.make_backup(data_dir, dest, date(2026, 11, d), keep=3)
    assert sorted(p.name for p in dest.glob("*.tar.gz")) == [
        "plughub-2026-11-05.tar.gz", "plughub-2026-11-06.tar.gz", "plughub-2026-11-07.tar.gz"]


def test_daily_schedule_and_failure_notice(data_dir, tmp_path, monkeypatch):
    _seed(data_dir).close()
    monkeypatch.setenv("PLUGHUB_BACKUP_ROOT", str(tmp_path / "nas"))
    (tmp_path / "nas").mkdir()
    notes = []
    b = backup.Backup(data_dir, lambda t, m: notes.append(t))
    assert not b.due(datetime(2026, 11, 20, 3, 29))
    assert b.due(datetime(2026, 11, 20, 3, 30))
    assert b.run(datetime(2026, 11, 20, 3, 30))["ok"]
    assert not b.due(datetime(2026, 11, 20, 23, 0))  # 一天一次
    assert b.due(datetime(2026, 11, 21, 3, 30))
    # 重新啟動：今天已經備份過就不再備
    assert not backup.Backup(data_dir, print).due(datetime(2026, 11, 20, 12, 0))
    assert b.report()["count"] == 1

    # NAS 不見了：通知
    monkeypatch.setenv("PLUGHUB_BACKUP_SUBDIR", "x")
    (tmp_path / "nas" / "x").write_text("不是資料夾")
    assert not b.run(datetime(2026, 11, 21, 3, 30))["ok"]
    assert notes == ["備份失敗"]


def test_not_configured(data_dir, tmp_path, monkeypatch):
    monkeypatch.setenv("PLUGHUB_BACKUP_ROOT", str(tmp_path / "missing"))
    b = backup.Backup(data_dir, print)
    assert b.report()["configured"] is False
    assert b.run()["ok"] is False


def test_verify_ok_and_broken(data_dir, tmp_path):
    import pytest

    db = _seed(data_dir)
    out = backup.make_backup(data_dir, tmp_path / "nas", date(2026, 11, 20))
    db.close()
    backup.verify(out)  # 還原得回來
    bad = tmp_path / "bad.tar.gz"
    with tarfile.open(bad, "w:gz") as tar:
        (tmp_path / "store.json").write_text("{not json", "utf-8")
        tar.add(tmp_path / "store.json", "store.json")
    with pytest.raises(ValueError):
        backup.verify(bad)
    empty = tmp_path / "empty.tar.gz"
    with tarfile.open(empty, "w:gz"):
        pass
    with pytest.raises(RuntimeError):
        backup.verify(empty)

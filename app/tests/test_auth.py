import json

from plughub import auth as authmod
from plughub.auth import Auth


class Clock:
    def __init__(self):
        self.t = 1_000_000.0

    def __call__(self):
        return self.t


def test_pair_with_code_once(data_dir):
    a = Auth(data_dir)
    code = a.new_code()
    assert len(code) == 6 and code.isdigit()
    got = a.pair(code, "媽媽的手機")
    assert got
    token, dev = got
    assert dev["name"] == "媽媽的手機"
    assert a.check(token)["id"] == dev["id"]
    # 用過就失效
    assert a.pair(code) is None


def test_token_not_stored_in_plain(data_dir):
    a = Auth(data_dir)
    token, _ = a.pair(a.new_code())
    text = (data_dir / "auth.json").read_text("utf-8")
    assert token not in text
    # 重新載入（重新啟動）還認得
    assert Auth(data_dir).check(token)


def test_code_expires(data_dir):
    clock = Clock()
    a = Auth(data_dir, clock=clock)
    code = a.new_code()
    clock.t += authmod.CODE_TTL + 1
    assert a.pair(code) is None


def test_wrong_codes_lock(data_dir):
    clock = Clock()
    a = Auth(data_dir, clock=clock)
    code = a.new_code()
    wrong = "000000" if code != "000000" else "111111"
    for _ in range(authmod.MAX_FAILS):
        assert a.pair(wrong) is None
    assert a.locked_for() > 0
    # 鎖住的時候，正確的也不行
    assert a.pair(code) is None
    clock.t += authmod.LOCK_S + 1
    assert a.pair(code)


def test_cli_code_file(data_dir, monkeypatch, capsys):
    monkeypatch.setenv("PLUGHUB_DATA", str(data_dir))
    authmod.main()
    code = capsys.readouterr().out.split("：")[1][:6]
    a = Auth(data_dir)
    assert a.pair(code)
    assert not (data_dir / "pair_code.json").exists()


def test_remove_and_rename(data_dir):
    a = Auth(data_dir)
    token, dev = a.pair(a.new_code(), ua="Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)")
    assert dev["name"] == "iPhone"
    assert a.rename(dev["id"], "爸爸")
    assert json.loads((data_dir / "auth.json").read_text("utf-8"))["devices"][0]["name"] == "爸爸"
    assert a.remove(dev["id"])
    assert a.check(token) is None
    assert a.check(None) is None

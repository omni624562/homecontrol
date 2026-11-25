"""網路攝影機認人：狀態判斷、房間動靜、沒人在家的通知、API（不連真的攝影機）。"""
from __future__ import annotations

import json
import sys
import time

from plughub import camera


def test_track_needs_two_hits_and_holds():
    st: dict = {}
    assert camera.track(st, 0.8, 0) is None  # 一張不算
    assert camera.track(st, 0.1, 1) is None
    assert camera.track(st, 0.7, 2) == "on"  # 最近 3 張有 2 張
    assert st["person"] and st["since"] == 2
    assert camera.track(st, 0.1, 10) is None  # 還沒過 15 秒
    assert camera.track(st, 0.1, 2 + camera.HOLD) == "off"
    assert not st["person"]


def test_cameras_public_hides_password(tmp_path):
    (tmp_path / "cameras.json").write_text(json.dumps({"cameras": [{"id": "a", "name": "客廳", "host": "10.0.0.5", "user": "u", "pwd": "秘密", "room": "r1"}]}), "utf-8")
    cams = camera.Cameras(tmp_path)
    pub = cams.public()
    assert "pwd" not in pub[0] and "user" not in pub[0] and pub[0]["enabled"] and pub[0]["alert"]
    cams.state["a"] = {"person": True}
    assert cams.rooms_with_person() == {"r1": ["客廳"]}
    cams.list[0]["enabled"] = False
    assert cams.rooms_with_person() == {}


def test_check_scores_and_errors(tmp_path, monkeypatch):
    cams = camera.Cameras(tmp_path)
    cam = {"id": "a", "host": "10.0.0.5", "name": "門口"}
    scores = iter([0.9, 0.9])
    monkeypatch.setattr(camera, "snapshot", lambda c: b"\xff\xd8jpeg")
    monkeypatch.setattr(cams.detector, "scores", lambda jpg: {"person": next(scores), "cat": 0.0, "dog": 0.0})
    assert cams.check(cam, 0) is None
    assert cams.check(cam, 1) == "on"

    def boom(c):
        raise RuntimeError("帳號或密碼不對")

    monkeypatch.setattr(camera, "snapshot", boom)
    assert cams.check(cam, 2) == "off"  # 連不上：當作人走了
    st = cams.state["a"]
    assert st["ok"] is False and st["error"] == "帳號或密碼不對"
    assert cams.check(cam, 3) is None  # 30 秒內不再試


def _hub(app_module, monkeypatch):
    hub = app_module.hub
    sent = []
    monkeypatch.setattr(hub.notifier, "send", lambda *a, **k: sent.append(a))
    hub.cameras.list = [{"id": "c1", "name": "客廳攝影機", "host": "10.0.0.5", "room": "r1", "enabled": True, "alert": True}]
    return hub, sent


def test_room_motion_includes_camera(app_module, monkeypatch):
    hub, _ = _hub(app_module, monkeypatch)
    v = hub.room_motion()["r1"]  # 沒看到人也在清單裡（動靜規則才選得到這間）
    assert v["score"] == 0 and v["cover"] >= 1 and v["person"] is False
    hub.cameras.state["c1"] = {"person": True}
    v = hub.room_motion()["r1"]
    assert v["score"] >= 1.0 and v["camera"] == ["客廳攝影機"] and v["person"] is True


def test_camera_alert_waits_for_family_wifi(app_module, monkeypatch):
    hub, sent = _hub(app_module, monkeypatch)
    probed = []

    async def fake_probe():
        probed.append(1)
        hub._probe_busy = False

    monkeypatch.setattr(hub, "_probe_people", fake_probe)
    monkeypatch.setattr(hub, "_spawn", lambda coro: __import__("asyncio").run(coro))
    cam = hub.cameras.list[0]
    hub.store.data["people"] = [{"id": "x", "name": "X", "macs": []}]
    t = time.time()
    hub._presence["x"] = {"home": True, "since": 1.0}
    hub._camera_seen(cam, t)  # 有人在家：不管
    assert hub._cam_pending == {}
    # 沒人在家看到人，1 分鐘後 X 的手機連上 Wi-Fi：是家人，不通知
    hub._presence["x"] = {"home": False, "since": 1.0}
    hub._camera_seen(cam, t)
    assert probed and "c1" in hub._cam_pending
    hub._camera_pending(t + 30)
    assert sent == []
    hub._presence["x"] = {"home": True, "since": t + 60}
    hub._camera_pending(t + 60)
    assert sent == [] and hub._cam_pending == {}
    # 沒人在家看到人，3 分鐘都沒有家人的手機：緊急通知（10 分鐘內不重複）
    hub._presence["x"] = {"home": False, "since": t + 100}
    hub._camera_seen(cam, t + 200)
    hub._camera_pending(t + 200 + 179)
    assert sent == []
    hub._camera_pending(t + 200 + 180)
    assert len(sent) == 1 and "攝影機看到人" in sent[0][0] and "Wi-Fi" in sent[0][1] and sent[0][2] == "urgent"
    hub._camera_seen(cam, t + 400)
    assert hub._cam_pending == {}
    # 那個人一直斷斷續續被看到（間隔不到 1 小時）：同一件事，不再通知
    for k in range(1, 6):
        hub._camera_seen(cam, t + 400 + k * 900)
        hub._camera_pending(t + 400 + k * 900 + 200)
    assert len(sent) == 1 and hub._cam_pending == {}
    # 1 小時都沒看到人之後再看到：新的一件事
    hub._camera_seen(cam, t + 400 + 5 * 900 + 3601)
    assert "c1" in hub._cam_pending
    hub._camera_pending(t + 400 + 5 * 900 + 3601 + 180)
    assert len(sent) == 2
    # 家人的手機連上 Wi-Fi：之後再發生也是新的一件事
    hub._presence["x"] = {"home": True, "since": t + 9000}
    hub._camera_pending(t + 9000)
    assert hub._cam_quiet == {}
    hub._presence["x"] = {"home": False, "since": t + 9100}
    cam["alert"] = False
    hub._cam_alert.clear()
    hub._camera_seen(cam, t + 2000)
    assert hub._cam_pending == {}


def test_api_cameras(app_module, monkeypatch):
    from fastapi.testclient import TestClient

    c = TestClient(app_module.app, base_url="http://hub:8100")
    token, _ = app_module.auth.pair(app_module.auth.new_code())
    c.cookies.set("plughub_token", token)
    cam_mod = sys.modules["plughub.camera"]

    def fake_info(cam):
        if cam["pwd"] != "ok":
            raise RuntimeError("帳號或密碼不對")
        return {"model": "Z2", "name": "IN_HOUSE"}

    monkeypatch.setattr(cam_mod, "dev_info", fake_info)
    sent = []
    monkeypatch.setattr(app_module.hub.notifier, "send", lambda *a, **k: sent.append(a))
    # 還沒開通：不能加攝影機
    acc = c.get("/api/cameras").json()["access"]
    assert acc["can_view"] is False and "candidates" not in acc
    assert c.post("/api/cameras", json={"host": "10.0.0.5", "user": "u", "pwd": "ok"}).status_code == 403
    # 驗證碼送到手機通知 → 輸入 → 開通
    assert c.post("/api/cameras/access/send-code").status_code == 200
    code = app_module.hub.cameras.code._code[0]
    assert code in sent[-1][1]
    assert c.post("/api/cameras/access/claim", json={"code": "000000" if code != "000000" else "111111"}).status_code == 400
    acc = c.post("/api/cameras/access/claim", json={"code": code}).json()["access"]
    assert acc["can_view"] is True and acc["viewers"][0]["id"] == acc["me"]
    assert c.post("/api/cameras", json={"host": "10.0.0.5", "user": "u", "pwd": "bad"}).status_code == 400
    r = c.post("/api/cameras", json={"host": "10.0.0.5", "user": "u", "pwd": "ok"})
    assert r.status_code == 200
    cam = r.json()["camera"]
    assert cam["name"] == "IN_HOUSE" and cam["model"] == "Z2" and "pwd" not in cam
    app_module.store.data["floorplan"] = {"rooms": [{"id": "r1", "name": "客廳"}]}
    r = c.put(f"/api/cameras/{cam['id']}", json={"room": "r1", "alert": False})
    got = r.json()["cameras"][0]
    assert got["room"] == "r1" and got["alert"] is False
    assert c.put(f"/api/cameras/{cam['id']}", json={"room": "nope"}).json()["cameras"][0]["room"] is None
    raw = (app_module.store.dir / "cameras.json").read_text("utf-8")
    saved = json.loads(raw)
    assert "pwd" not in saved["cameras"][0] and saved["cameras"][0]["pwd_enc"].startswith("enc1:") and '"ok"' not in raw  # 加密後才存
    assert camera_reload(app_module.store.dir)[0]["pwd"] == "ok"
    assert "pwd" not in json.dumps(c.get("/api/cameras").json())
    monkeypatch.setattr(cam_mod, "snapshot", lambda c: b"\xff\xd8jpeg")
    r = c.get(f"/api/cameras/{cam['id']}/snapshot.jpg")
    assert r.status_code == 200 and r.headers["content-type"] == "image/jpeg" and r.headers["cache-control"] == "no-store"
    assert r.headers.get("content-encoding") is None
    assert TestClient(app_module.app, base_url="http://hub:8100").get(f"/api/cameras/{cam['id']}/snapshot.jpg").status_code == 401
    # 另一台配對過、但沒權限的裝置：看不到畫面、改不了設定
    other = TestClient(app_module.app, base_url="http://hub:8100")
    tok2, dev2 = app_module.auth.pair(app_module.auth.new_code())
    other.cookies.set("plughub_token", tok2)
    assert other.get(f"/api/cameras/{cam['id']}/snapshot.jpg").status_code == 403
    assert other.put(f"/api/cameras/{cam['id']}", json={"alert": True}).status_code == 403
    assert other.put("/api/cameras/access", json={"viewers": [dev2["id"]]}).status_code == 403
    # 有權限的人把它加進名單
    ids = [v["id"] for v in c.get("/api/cameras").json()["access"]["viewers"]] + [dev2["id"], "bogus"]
    acc = c.put("/api/cameras/access", json={"viewers": ids}).json()["access"]
    assert [v["id"] for v in acc["viewers"]] == ids[:2]
    assert other.get(f"/api/cameras/{cam['id']}/snapshot.jpg").status_code == 200
    assert c.delete(f"/api/cameras/{cam['id']}").json()["cameras"] == []


def test_access_code_locks_after_fails():
    now = [0.0]
    ac = camera.AccessCode(clock=lambda: now[0])
    code = ac.new()
    wrong = "000000" if code != "000000" else "111111"
    for _ in range(camera.AccessCode.MAX_FAILS):
        assert not ac.claim(wrong)
    assert ac.locked_for() > 0 and not ac.claim(code)  # 鎖住時對的也不行（而且這組碼作廢）
    now[0] += camera.AccessCode.LOCK + 1
    assert not ac.claim(code)
    code = ac.new()
    now[0] += camera.AccessCode.TTL + 1
    assert not ac.claim(code)  # 過期


def test_same_phone_paired_and_trusted_is_merged(app_module):
    """同一支手機有通行證（配對）、又是「誰在家」登記的家人手機：權限名單只列一次，兩個代號都有權限。"""
    from fastapi.testclient import TestClient

    main = app_module
    c = TestClient(main.app, base_url="http://hub:8100")
    token, dev = main.auth.pair(main.auth.new_code(), name="ERIC PHONE")
    c.cookies.set("plughub_token", token)
    dev["mac"] = "EA:1C:F4:0C:26:B4"
    main.store.data["people"] = [{"id": "e", "name": "ERIC", "macs": ["EA:1C:F4:0C:26:B4"]}]
    main.hub.cameras.viewers = [dev["id"]]
    acc = c.get("/api/cameras").json()["access"]
    names = [x["name"] for x in acc["candidates"]]
    assert "ERIC PHONE（ERIC的手機）" in names and "ERIC的手機" not in names
    assert acc["me"] == dev["id"] and [v["id"] for v in acc["viewers"]] == [dev["id"]]
    assert main._same("mac:EA:1C:F4:0C:26:B4") == {"mac:EA:1C:F4:0C:26:B4", dev["id"]}
    # 勾選合併的那一個：兩個代號都進名單
    acc = c.put("/api/cameras/access", json={"viewers": [dev["id"]]}).json()["access"]
    assert set(main.hub.cameras.viewers) == {dev["id"], "mac:EA:1C:F4:0C:26:B4"}


def test_mask_and_role_defaults(app_module, monkeypatch):
    import io

    from fastapi.testclient import TestClient
    from PIL import Image

    img = Image.new("RGB", (100, 50), (255, 0, 0))
    buf = io.BytesIO()
    img.save(buf, "JPEG")
    out = Image.open(io.BytesIO(camera.mask(buf.getvalue(), [[0, 0, 0.5, 1]])))
    left, right = out.getpixel((10, 25)), out.getpixel((90, 25))
    assert abs(left[0] - 128) < 20 and right[0] > 200  # 左半邊塗灰、右半邊不動

    c = TestClient(app_module.app, base_url="http://hub:8100")
    token, dev = app_module.auth.pair(app_module.auth.new_code())
    c.cookies.set("plughub_token", token)
    app_module.hub.cameras.viewers = [dev["id"]]
    app_module.hub.cameras.list = [{"id": "g", "name": "大門口", "host": "x", "enabled": True, "fall": True}]
    got = c.put("/api/cameras/g", json={"role": "entry", "defaults": True, "ignore": [[0.6, 0.3, 0.4, 0.5], [0, 0, 0.01, 0.5]]}).json()["cameras"][0]
    assert got["role"] == "entry" and got["fall"] is False and got["faces"] is True
    assert got["ignore"] == [[[0.6, 0.3], [1.0, 0.3], [1.0, 0.8], [0.6, 0.8]]]  # 方框換成 4 個角；太小的不收
    tri = [[0.1, 0.1], [0.5, 0.2], [0.2, 0.7]]
    got = c.put("/api/cameras/g", json={"ignore": [tri, [[0, 0], [0.01, 0.01]]]}).json()["cameras"][0]
    assert got["ignore"] == [tri]
    assert c.put("/api/cameras/g/door", json={"poly": [[0.1, 0.1], [0.3, 0.15], [0.3, 0.8]]}).status_code in (404, 405)  # 舊的「門」API 拿掉了：門是區域的一種


def test_old_door_moves_into_zones(tmp_path):
    import json

    from plughub import camera

    (tmp_path / "cameras.json").write_text(json.dumps({"cameras": [
        {"id": "g", "name": "大門口", "host": "x", "zones": [{"id": "z1", "name": "區域 1", "kind": "door", "poly": [[0.3, 0], [0.4, 0], [0.4, 0.4]], "linger": 0, "act": {"notify": "off", "scene": None, "dark": False}}],
         "door": {"rect": [0.1, 0.2, 0.1, 0.4], "poly": [[0.1, 0.2], [0.2, 0.2], [0.2, 0.6], [0.1, 0.6]], "refs": ["a", "b"], "notify": "always", "scene": "s1"}},
        {"id": "r", "name": "客廳", "host": "y", "door": None}], "viewers": []}), "utf-8")
    cams = camera.Cameras(tmp_path)
    g = cams.get("g")
    assert "door" not in g
    assert [z["id"] for z in g["zones"]] == ["door", "z1"]
    d = g["zones"][0]
    assert d["name"] == "大門" and d["kind"] == "door" and d["refs"] == ["a", "b"] and d["act"] == {"notify": "always", "scene": "s1", "dark": True}
    assert camera.ref_counts(d) == {"day": 2, "night": 0}
    assert cams.get("r")["zones"] == []
    cams.save()
    again = camera.Cameras(tmp_path).get("g")
    assert [z["id"] for z in again["zones"]] == ["door", "z1"]  # 存過之後再讀：不會重複搬
    pub = cams.public()[0]
    assert "door" not in pub and pub["zones"][0]["day"] == 2 and pub["zones"][0]["night"] == 0


def test_door_refs_keep_day_and_night():
    from plughub.hub import _add_ref

    z = {"kind": "door", "refs": ["d1"]}
    _add_ref(z, "d2", "day", 2)
    _add_ref(z, "d3", "day", 2)
    _add_ref(z, "n1", "night", 2)
    assert z["refs"] == ["d2", "d3", "n1"] and z["ref_when"] == ["day", "day", "night"]  # 白天記再多，晚上那張也不會被擠掉
    o = {"kind": "object", "refs": []}
    for k in range(5):
        _add_ref(o, f"o{k}", "night" if k % 2 else "day", 3)
    assert o["refs"] == ["o2", "o3", "o4"] and o["ref_when"] == ["day", "night", "day"]


def test_is_night():
    import io

    from PIL import Image

    from plughub import vision

    def jpg(img):
        b = io.BytesIO()
        img.save(b, "JPEG")
        return b.getvalue()

    color = Image.new("RGB", (160, 90), (200, 120, 60))
    gray = Image.new("RGB", (160, 90), (110, 110, 110))
    assert not vision.is_night(jpg(color))
    assert vision.is_night(jpg(gray))



def camera_reload(d):
    return camera.Cameras(d).list


def test_camera_credentials_encrypted_at_rest(tmp_path):
    (tmp_path / "cameras.json").write_text(json.dumps({"cameras": [{"id": "a", "name": "門口", "host": "10.0.0.5", "user": "admin", "pwd": "秘密123"}]}), "utf-8")
    cams = camera.Cameras(tmp_path)  # 舊的明碼：讀進來就改存成加密的
    assert cams.list[0]["pwd"] == "秘密123" and cams.list[0]["user"] == "admin"
    raw = (tmp_path / "cameras.json").read_text("utf-8")
    assert "秘密123" not in raw and "admin" not in raw and "pwd_enc" in raw
    assert (tmp_path / "secret.key").stat().st_mode & 0o777 == 0o600
    assert camera.Cameras(tmp_path).list[0]["pwd"] == "秘密123"
    (tmp_path / "secret.key").unlink()  # 金鑰不見了（例如還原到新的樹莓派）：不會當掉，帳密變空的等重新輸入
    assert camera.Cameras(tmp_path).list[0]["pwd"] == ""


def test_backup_skips_secret_key():
    from plughub import backup

    assert "secret.key" in backup.SKIP

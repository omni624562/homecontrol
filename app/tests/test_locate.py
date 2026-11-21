"""人在哪個房間：教過的房間指紋 vs 最近的訊號。"""

import random

from plughub.locate import MIN_SAMPLES, Locator

MAIN, NODE, PHONE = "60:CF:84:41:27:D0", "FC:34:97:8A:E6:A8", "EA:1C:F4:0C:26:B4"


def teach(loc, room, node, mu, t0, n=40, sd=2):
    rnd = random.Random(room)
    loc.train([PHONE], room, seconds=n * 4 + 1, now=t0)
    for i in range(n):
        loc.feed(PHONE, t0 + i * 4, node, round(rnd.gauss(mu, sd)))
    return t0 + n * 4 + 10


def live(loc, node, rssi, t0, n=8):
    for i in range(n):
        loc.feed(PHONE, t0 + i * 4, node, rssi + (i % 3) - 1)
    return t0 + n * 4


def test_picks_trained_room():
    loc = Locator({})
    t = teach(loc, "客廳", MAIN, -45, 1000)
    t = teach(loc, "主臥", MAIN, -70, t)
    t = teach(loc, "廚房", NODE, -50, t)
    assert loc.counts([PHONE]) == {"客廳": 40, "主臥": 40, "廚房": 40}
    end = live(loc, MAIN, -46, t + 500)
    e = loc.estimate(PHONE, end)
    assert e["room"] == "客廳" and e["p"] > 0.9
    end = live(loc, NODE, -52, end + 200)
    assert loc.estimate(PHONE, end)["room"] == "廚房"
    end = live(loc, MAIN, -69, end + 200)
    assert loc.estimate(PHONE, end)["room"] == "主臥"


def test_unsure_between_similar_rooms():
    loc = Locator({})
    t = teach(loc, "臥室1", MAIN, -60, 1000)
    t = teach(loc, "臥室2", MAIN, -61, t)
    end = live(loc, MAIN, -60, t + 500, n=4)
    e = loc.estimate(PHONE, end)
    assert e["room"] is None and {x["room"] for x in e["top"][:2]} == {"臥室1", "臥室2"}


def test_needs_training_and_recent_data():
    loc = Locator({})
    assert loc.estimate(PHONE, 100) is None
    loc.train([PHONE], "客廳", seconds=20, now=0)
    for i in range(MIN_SAMPLES - 5):
        loc.feed(PHONE, i + 1, MAIN, -50)
    assert loc.estimate(PHONE, 30) is None  # 教得不夠
    t = teach(loc, "客廳", MAIN, -50, 100)
    assert loc.estimate(PHONE, t + 1000) is None  # 最近沒有訊號


def test_training_stops_and_forget():
    loc = Locator({})
    loc.train([PHONE], "客廳", seconds=10, now=0)
    loc.feed(PHONE, 5, MAIN, -50)
    loc.feed(PHONE, 20, MAIN, -50)  # 過了時間：不收、也結束
    assert loc.counts([PHONE]) == {"客廳": 1} and PHONE not in loc.training
    assert loc.feed(PHONE, 20, MAIN, -50) is False  # 同一個時間點不重複
    loc.forget([PHONE], "客廳")
    assert loc.counts([PHONE]) == {}


def test_api(app_module):
    from fastapi.testclient import TestClient

    hub = app_module.hub
    hub.store.data["people"] = [{"id": "p1", "name": "ERIC", "macs": [PHONE]}]
    hub.store.data["floorplan"] = {"rooms": [{"id": "r1", "name": "臥室"}, {"id": "r2", "name": "臥室"}, {"id": "r3", "name": "客廳"}]}
    app_module._is_local = lambda request: True
    c = TestClient(app_module.app)
    r = c.get("/api/locate/p1").json()
    assert [x["name"] for x in r["rooms"]] == ["臥室 1", "臥室 2", "客廳"] and r["where"] is None
    assert c.post("/api/locate/p1/train", json={"room": "r3"}).status_code == 409  # 手機沒連線
    import time
    hub.router.clients = {PHONE: {"mac": PHONE, "seen": time.time(), "node": MAIN, "rssi": -50, "live": time.time()}}
    assert c.post("/api/locate/p1/train", json={"room": "nope"}).status_code == 400
    r = c.post("/api/locate/p1/train", json={"room": "r3"}).json()
    assert r["training"]["room"] == "r3"
    hub._router_locate()
    assert c.get("/api/locate/p1").json()["rooms"][2]["count"] == 1
    assert c.delete("/api/locate/p1/train").json()["ok"]
    assert c.delete("/api/locate/p1").json()["ok"]
    assert c.get("/api/locate/nobody").status_code == 404

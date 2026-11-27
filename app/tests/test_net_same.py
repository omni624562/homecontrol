"""同一台裝置的有線、無線（兩個 MAC）合成一筆。"""
from __future__ import annotations

import sys


def c(mac, name, wired, online, seen, label=None, ip=None, band=None):
    return {"mac": mac, "name": name, "label": label, "wired": wired, "online": online, "seen": seen, "ip": ip, "band": band,
            "node": None, "node_model": None, "node_main": None, "ssid": None, "rssi": None, "person": None, "today_bytes": None}


def test_merge_prefers_online_wired(app_module):
    merge = sys.modules["plughub.hub"].merge_same
    wifi = c("AA", "NAN LAPTOP", False, False, 100, label="NAN LAPTOP", band="5G")
    lan = c("BB", "LAPTOP-NAN", True, True, 200, ip="10.0.2.138")
    out = merge([wifi, lan, c("CC", "TV", False, True, 1)], {"BB": "AA"})
    assert [x["mac"] for x in out] == ["AA", "CC"]
    m = out[0]
    assert m["name"] == "NAN LAPTOP" and m["online"] and m["wired"] and m["ip"] == "10.0.2.138" and m["seen"] == 200
    assert {(x["mac"], x["main"]) for x in m["links"]} == {("AA", True), ("BB", False)}
    assert merge([wifi, lan], {"BB": "ZZ"}) == [wifi, lan]  # 主 MAC 不在：不動


def test_api_merge_and_split(app_module):
    from fastapi.testclient import TestClient

    cl = TestClient(app_module.app, base_url="http://hub:8100")
    token, _ = app_module.auth.pair(app_module.auth.new_code())
    cl.cookies.set("plughub_token", token)
    a, b = "AA:AA:AA:00:00:01", "BB:BB:BB:00:00:02"
    assert cl.patch(f"/api/net/devices/{a}", json={"label": "NAN LAPTOP"}).status_code == 200
    assert cl.patch(f"/api/net/devices/{b}", json={"same_as": b}).status_code == 400  # 不能併給自己
    r = cl.patch(f"/api/net/devices/{b}", json={"same_as": a}).json()
    lap = [x for x in r["clients"] if x["mac"] in (a, b)]
    assert len(lap) == 1 and lap[0]["mac"] == a and len(lap[0]["links"]) == 2
    r = cl.patch(f"/api/net/devices/{b}", json={"same_as": None}).json()
    assert not any(x.get("links") for x in r["clients"])

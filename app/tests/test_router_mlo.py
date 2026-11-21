import time

from plughub.router import Router, mlo_links

MAIN, LINK = "EA:1C:F4:0C:26:B4", "EA:1C:F4:0C:26:B5"
NAMES = {MAIN: {"name": "Pixel-11-Pro", "mlo_2G_mac": LINK, "mlo_5G_mac": LINK, "mlo_5G1_mac": "",
                "mlo_all_mac": f"<{MAIN}<{LINK}"},
         "AA:BB:CC:DD:EE:FF": {"name": "TV"}}


def make():
    return Router(lambda: {}, "/dev/null", lambda _: None)


def test_mlo_links():
    assert mlo_links(MAIN, NAMES[MAIN]) == {LINK}
    assert mlo_links("AA:BB:CC:DD:EE:FF", NAMES["AA:BB:CC:DD:EE:FF"]) == set()


def test_link_mac_counts_as_main():
    r = make()
    r._read_names(NAMES)
    r._apply_live({r.canon(LINK.lower()): ("wl1", -45)})
    assert r.online(MAIN)
    assert LINK not in r.clients


def test_old_link_entry_merged():
    r = make()
    r.clients = {LINK: {"mac": LINK, "seen": time.time(), "band": "5G"},
                 MAIN: {"mac": MAIN, "seen": time.time() - 9000, "ip": "10.0.2.111"}}
    r._read_names(NAMES)
    assert LINK not in r.clients
    assert r.online(MAIN) and r.clients[MAIN]["ip"] == "10.0.2.111"


def test_clientlist_link_mac():
    r = make()
    r._read_names(NAMES)
    r._read_list({"60:CF:84:41:27:D0": {"5G": {LINK: {"ip": "", "rssi": "-45"}}}})
    assert r.online(MAIN) and LINK not in r.clients


def test_live_before_names():
    r = make()
    live = {r.canon(LINK): ("wl1", -45)}  # 對照表還沒到
    r._read_names(NAMES)
    r._apply_live(live)
    assert LINK not in r.clients and r.online(MAIN)

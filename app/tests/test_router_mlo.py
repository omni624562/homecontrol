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


def test_mlo_all_and_conflicts_ignored():
    r = make()
    r._read_names({
        # 虛擬機那筆的 mlo_all_mac 列著筆電的 MAC：不用 mlo_all_mac
        "00:15:5D:02:F0:02": {"name": "HyperV", "mlo_all_mac": "<1A:C1:D4:BF:1E:38<1A:C1:D4:BF:1E:39"},
        # 兩台都說 …:39 是它的：不合併
        "B0:3C:DC:D9:C2:4A": {"name": "LAPTOP", "mlo_5G_mac": "1A:C1:D4:BF:1E:39"},
        "1A:C1:D4:BF:1E:38": {"name": "android", "mlo_5G_mac": "1A:C1:D4:BF:1E:39"},
        # link MAC 自己也是一台裝置：不合併
        "AA:00:00:00:00:01": {"name": "x", "mlo_5G_mac": "AA:00:00:00:00:02"},
        "AA:00:00:00:00:02": {"name": "y"},
        **NAMES,
    })
    assert r.alias == {LINK: MAIN}

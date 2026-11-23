from plughub import roommotion

# 兩間房（左、右），中間一道牆、門在上面；基地台在左間
FP = {
    "w": 1000, "meters": 10,
    "rooms": [{"id": "L", "name": "左", "x": 0, "y": 0, "w": 500, "h": 300}, {"id": "R", "name": "右", "x": 500, "y": 0, "w": 500, "h": 300}],
    "walls": [{"id": "w", "x1": 500, "y1": 0, "x2": 500, "y2": 300}],
    "doors": [{"id": "d", "wall": "w", "t": 0.1, "w": 40}],
    "aps": [{"id": "a", "name": "AP", "node": "N"}, {"id": "b", "name": "沒對上", "node": None}],
    "items": {"ap:a": {"x": 100, "y": 150}, "ap:b": {"x": 900, "y": 150}, "k1": {"x": 400, "y": 150}, "k2": {"x": 900, "y": 250}, "k3": {"x": 50, "y": 50}},
}
NODES = {"k1": "N", "k2": "N", "k3": None}


def test_links_weights():
    lks = {lk["key"]: lk for lk in roommotion.links(FP, NODES)}
    assert set(lks) == {"k1", "k2"}  # k3 不知道連哪台
    assert set(lks["k1"]["w"]) == {"L"}
    assert lks["k1"]["walls"] == 0
    assert lks["k2"]["walls"] == 1
    assert set(lks["k2"]["w"]) == {"L", "R"}


def test_scores_hot_quiet():
    lks = roommotion.links(FP, NODES)
    s = roommotion.scores(lks, {"k1": 0.0, "k2": 2.0})
    assert s["R"]["hot"] == ["k2"]
    assert s["R"]["score"] > s["L"]["score"]  # 裝置在右間：右間分到最多；左間還有一條安靜的線
    assert abs(sum(lk["w"].get("R", 0) + lk["w"].get("L", 0) for lk in lks if lk["key"] == "k1") - 1) < 0.01  # 沒穿牆：份量合計 1
    s = roommotion.scores(lks, {"k1": None, "k2": None})
    assert s == {}


def test_fuse_boost_and_quiet():
    now = 10_000.0
    dist = {"A": 0.5, "B": 0.5, "C": 0.0}
    out, boosted = roommotion.fuse(dist, {"A": now - 30}, {"A": 1, "B": 1}, now - 3600, now)
    assert boosted == ["A"] and out["A"] > 0.6 and abs(sum(out.values()) - 1) < 1e-9
    # B 有線看得到、一直很安靜 → 扣一點；剛開始看（不到 10 分鐘）不扣
    out, _ = roommotion.fuse({"A": 0.5, "B": 0.5}, {}, {"B": 1}, now - 3600, now)
    assert out["A"] > out["B"]
    out, _ = roommotion.fuse({"A": 0.5, "B": 0.5}, {}, {"B": 1}, now - 60, now)
    assert out["A"] == out["B"]


def test_in_window():
    from plughub.hub import _in_window
    assert _in_window(5, "", "")
    assert _in_window(23 * 60 + 30, "23:00", "06:00") and _in_window(5 * 60, "23:00", "06:00")
    assert not _in_window(12 * 60, "23:00", "06:00")
    assert _in_window(12 * 60, "08:00", "18:00") and not _in_window(18 * 60, "08:00", "18:00")


def test_links_skip_outlet_points():
    """多孔插座每一孔的點（o:…）不是 Wi-Fi 裝置，不畫線。"""
    from plughub import roommotion

    fp = {"w": 1000, "meters": 10, "rooms": [{"id": "r", "name": "客廳", "x": 0, "y": 0, "w": 1000, "h": 700}],
          "aps": [{"id": "a", "node": "N"}], "items": {"ap:a": {"x": 100, "y": 100}, "DEV": {"x": 500, "y": 300}, "o:DEV-01": {"x": 600, "y": 300}}}
    keys = [lk["key"] for lk in roommotion.links(fp, {"DEV": "N", "o:DEV-01": "N"})]
    assert keys == ["DEV"]

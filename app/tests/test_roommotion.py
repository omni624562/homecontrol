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
    assert s["R"]["score"] == 2.0 and s["R"]["hot"] == ["k2"]
    assert s["L"]["score"] < s["R"]["score"]  # 左間有一條安靜的線，拉低
    s = roommotion.scores(lks, {"k1": None, "k2": None})
    assert s == {}

"""點一下就框（MobileSAM）：遮罩 → 多邊形、候選挑選、API 權限。"""
from __future__ import annotations

import numpy as np

from plughub import segment


def _rect(h, w, x0, y0, x1, y1):
    m = np.zeros((h, w), np.uint8)
    m[y0:y1, x0:x1] = 1
    return m


def test_to_poly_rect():
    poly = segment.to_poly(_rect(100, 200, 20, 10, 60, 90))
    assert len(poly) == 4
    xs, ys = sorted(p[0] for p in poly), sorted(p[1] for p in poly)
    assert abs(xs[0] - 0.1) < 0.01 and abs(xs[-1] - 0.295) < 0.01
    assert abs(ys[0] - 0.1) < 0.01 and abs(ys[-1] - 0.89) < 0.01


def test_to_poly_caps_points():
    m = np.zeros((300, 300), np.uint8)
    import cv2

    cv2.circle(m, (150, 150), 100, 1, -1)  # 圓：簡化後角不會太多
    assert 3 <= len(segment.to_poly(m)) <= segment.MAX_PTS
    assert segment.to_poly(np.zeros((10, 10), np.uint8)) is None


def test_pick_sorts_and_dedupes():
    h, w = 100, 100
    big = _rect(h, w, 10, 10, 60, 60)  # 0.25
    same = _rect(h, w, 10, 10, 61, 61)  # 跟 big 差不多大：留分數高的
    small = _rect(h, w, 20, 20, 30, 40)  # 0.02
    tiny = _rect(h, w, 0, 0, 1, 1)  # 太小
    whole = np.ones((h, w), np.uint8)  # 整個畫面
    out = segment.pick([big, same, small, tiny, whole], [0.8, 0.9, 0.7, 0.99, 0.99])
    assert [o["area"] for o in out] == [0.02, 0.2601]
    assert out[1]["score"] == 0.9


def _client(app_module):
    from fastapi.testclient import TestClient

    c = TestClient(app_module.app, base_url="http://hub:8100")
    token, dev = app_module.auth.pair(app_module.auth.new_code())
    c.cookies.set("plughub_token", token)
    return c, dev


def test_segment_api(app_module, monkeypatch):
    from plughub import camera as cam_mod

    hub = app_module.hub
    hub.cameras.list = [{"id": "g", "name": "大門口", "host": "x", "enabled": True}]
    c, dev = _client(app_module)
    other, _ = _client(app_module)
    hub.cameras.viewers = [dev["id"]]
    assert other.post("/api/cameras/g/segment", json={"x": 0.5, "y": 0.5}).status_code == 403

    monkeypatch.setattr(app_module.segment_mod, "available", lambda: False)
    assert c.post("/api/cameras/g/segment", json={"x": 0.5, "y": 0.5}).status_code == 503

    monkeypatch.setattr(app_module.segment_mod, "available", lambda: True)
    shots = []
    monkeypatch.setattr(cam_mod, "snapshot", lambda cam: shots.append(1) or b"jpeg")
    seg = app_module.segmenter
    monkeypatch.setattr(seg, "encode", lambda key, jpeg: seg._emb.__setitem__(key, (__import__("time").time(), None, (10, 10))))
    monkeypatch.setattr(seg, "segment", lambda key, x, y: [{"poly": [[x, y], [1, y], [1, 1]], "area": 0.1, "score": 0.9}])
    assert c.post("/api/cameras/nope/segment", json={"x": 0.5, "y": 0.5}).status_code == 404
    assert c.post("/api/cameras/g/segment", json={"x": "a"}).status_code == 400
    r = c.post("/api/cameras/g/segment", json={"x": 0.3, "y": 2}).json()
    assert r["shapes"][0]["poly"][0] == [0.3, 1.0]
    c.post("/api/cameras/g/segment", json={"x": 0.4, "y": 0.4})
    assert len(shots) == 1  # 60 秒內同一台：不用再抓畫面、再編碼
    c.post("/api/cameras/g/segment", json={"x": 0.4, "y": 0.4, "fresh": True})
    assert len(shots) == 2

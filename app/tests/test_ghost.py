"""門口攝影機：一直不動、分數不高的「人」（鞋子、雨傘）不算有人（vision/ghost.py，純 Python）。"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "vision"))
import ghost  # noqa: E402

SHOE = [0.208, 0.637, 0.064, 0.135]


def p(score, box=SHOE):
    return {"name": "person", "score": score, "box": list(box)}


def test_still_low_score_becomes_ghost():
    g = ghost.Ghosts()
    out = [g.filter([p(0.57)], t) for t in range(0, 200, 5)]
    assert out[0]  # 第一眼還不知道是東西
    assert all(o == [] for o in out[2:])  # 幾秒都沒動：是東西，不算人


def test_real_person_on_the_spot_still_counts():
    g = ghost.Ghosts()
    for t in range(0, 200, 5):
        g.filter([p(0.6)], t)
    assert g.filter([p(0.86)], 200) == [p(0.86)]  # 分數高：真的人站到那裡
    walk = [0.5, 0.3, 0.06, 0.13]
    assert g.filter([p(0.6, walk)], 201)  # 別的位置的低分的人照算


def test_moving_low_score_person_counts():
    g = ghost.Ghosts()
    for i in range(100):  # 走路：每 0.2 秒移一點
        assert g.filter([p(0.6, [0.1 + i * 0.005, 0.4, 0.06, 0.13])], i * 0.2)


def test_forgotten_after_gone():
    g = ghost.Ghosts()
    for t in range(0, 200, 5):
        g.filter([p(0.6)], t)
    assert g.filter([p(0.6)], 200 + ghost.GHOST_FORGET_S + 10)  # 東西拿走很久了，再看到要重新觀察


def test_mask_whole_day_includes_the_start():
    t, cls, score, box = [], [], [], []
    for s in range(0, 600, 10):  # 鞋子 10 分鐘
        t.append(1000 + s), cls.append("person"), score.append(0.58), box.append(SHOE)
    t.append(1300), cls.append("person"), score.append(0.9), box.append([0.2, 0.2, 0.1, 0.3])  # 真的人
    t.append(1310), cls.append("dog"), score.append(0.5), box.append(SHOE)
    m = ghost.mask(t, cls, score, box)
    assert all(m[:60])  # 連一開始確認的那幾秒也拿掉
    assert m[60] is False and m[61] is False

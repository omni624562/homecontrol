from plughub import geom

FP = {
    "rooms": [
        {"name": "L 房", "x": 0, "y": 0, "w": 200, "h": 200, "pts": [[0, 0], [200, 0], [200, 100], [100, 100], [100, 200], [0, 200]]},
        {"name": "右", "x": 200, "y": 0, "w": 100, "h": 200},
    ],
    "walls": [{"id": "w1", "x1": 200, "y1": 0, "x2": 200, "y2": 200}, {"id": "w2", "x1": 250, "y1": 0, "x2": 250, "y2": 200}],
    "doors": [{"id": "d1", "wall": "w1", "t": 0.25, "w": 40, "flip": 0}],
}


def test_in_room_l_shape():
    assert geom.in_room(FP["rooms"][0], 50, 150)
    assert not geom.in_room(FP["rooms"][0], 150, 150)  # 切掉的那一角
    assert geom.room_at(FP, 150, 150) is None
    assert geom.room_at(FP, 250, 150)["name"] == "右"


def test_walls_crossed_door_does_not_count():
    assert geom.walls_crossed(FP, 50, 150, 280, 150) == 2
    assert geom.walls_crossed(FP, 50, 50, 230, 50) == 0  # 從門口穿過去
    assert geom.walls_crossed(FP, 50, 50, 280, 50) == 1
    assert geom.walls_crossed({}, 0, 0, 100, 100) == 0


def test_rooms_along():
    assert geom.rooms_along(FP, 50, 50, 280, 50) == ["L 房", "右"]
    assert geom.rooms_along(FP, 50, 150, 50, 10) == ["L 房"]

"""常來的人：門口沒認出是誰的「有人來」，記下外觀特徵（Jetson SigLIP 2）和一張全身小圖，7 天內同一個人來 3 次以上就自動成一群，
讓家人取名字（清潔阿姨、送貨的…）。取了名字的再來，紀錄寫他的名字，不當陌生人、也不會「同一個陌生人又來了」。

存在 data/visitors.json（特徵是數字，看不出原本的樣子）和 data/faces_thumbs/visitor_*.jpg（全身小圖），都 7 天後刪；取了名字的只留平均特徵。
"""
from __future__ import annotations

import json
import os
import time
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any

from .reid import SAME, _unit, mean_emb

KEEP_S = 7 * 86400
GROUP_MIN = 3


class Visitors:
    def __init__(self, data_dir: Path) -> None:
        self.path = data_dir / "visitors.json"
        self.thumbs = data_dir / "faces_thumbs"
        try:
            d = json.loads(self.path.read_text("utf-8"))
        except (FileNotFoundError, ValueError):
            d = {}
        self.visits: list[dict[str, Any]] = d.get("visits") or []  # {"id", "t", "cam", "emb", "thumb"}
        self.named: list[dict[str, Any]] = d.get("named") or []  # {"id", "name", "emb", "n"}

    def save(self) -> None:
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps({"visits": self.visits, "named": self.named}), "utf-8")
        os.chmod(tmp, 0o600)
        tmp.replace(self.path)

    def prune(self, now: float | None = None) -> None:
        now = now or time.time()
        for v in [v for v in self.visits if now - v["t"] > KEEP_S]:
            if v.get("thumb"):
                (self.thumbs / v["thumb"]).unlink(missing_ok=True)
        self.visits = [v for v in self.visits if now - v["t"] <= KEEP_S]

    def match_named(self, emb: Any) -> dict[str, Any] | None:
        e = _unit(emb)
        best = max(self.named, key=lambda n: float(e @ _unit(n["emb"])), default=None)
        return best if best is not None and float(e @ _unit(best["emb"])) >= SAME else None

    def add(self, cam: str, t: float, emb: Any, thumb: bytes | None) -> None:
        vid = uuid.uuid4().hex[:10]
        name = None
        if thumb:
            self.thumbs.mkdir(exist_ok=True)
            name = f"visitor_{vid}.jpg"
            (self.thumbs / name).write_bytes(thumb)
            os.chmod(self.thumbs / name, 0o600)
        self.visits.append({"id": vid, "t": round(t), "cam": cam, "emb": [round(float(x), 4) for x in _unit(emb)], "thumb": name})
        self.prune(t)
        self.save()

    def groups(self) -> list[dict[str, Any]]:
        """7 天內來過的不認得的人，外觀像的分成一群（貪婪法）；來 GROUP_MIN 次以上的才列出來。"""
        import numpy as np

        groups: list[dict[str, Any]] = []
        for v in sorted(self.visits, key=lambda x: x["t"]):
            e = _unit(v["emb"])
            best = max(groups, key=lambda g: float(e @ g["emb"]), default=None)
            if best is not None and float(e @ best["emb"]) >= SAME:
                best["visits"].append(v)
                best["emb"] = _unit(np.mean([_unit(x["emb"]) for x in best["visits"]], axis=0))
            else:
                groups.append({"emb": e, "visits": [v]})
        out = []
        for g in groups:
            vs = g["visits"]
            if len(vs) < GROUP_MIN:
                continue
            days = sorted({datetime.fromtimestamp(v["t"]).strftime("%a") for v in vs})
            hours = sorted(datetime.fromtimestamp(v["t"]).hour for v in vs)
            out.append({"id": vs[0]["id"], "count": len(vs), "visit_ids": [v["id"] for v in vs], "first": vs[0]["t"], "last": vs[-1]["t"],
                        "weekdays": [datetime.fromtimestamp(v["t"]).weekday() for v in vs], "hours": [hours[0], hours[-1]],
                        "thumbs": [v["thumb"] for v in vs if v.get("thumb")][-3:], "_days": days})
        return sorted(out, key=lambda g: -g["count"])

    def name_group(self, gid: str, name: str) -> dict[str, Any] | None:
        g = next((g for g in self.groups() if g["id"] == gid), None)
        if g is None:
            return None
        ids = set(g["visit_ids"])
        n = {"id": uuid.uuid4().hex[:8], "name": name.strip()[:12], "emb": [round(float(x), 4) for x in mean_emb([v["emb"] for v in self.visits if v["id"] in ids])], "n": len(ids)}
        self.named.append(n)
        for v in [v for v in self.visits if v["id"] in ids]:  # 分好的那些拿掉（小圖也刪）
            if v.get("thumb"):
                (self.thumbs / v["thumb"]).unlink(missing_ok=True)
        self.visits = [v for v in self.visits if v["id"] not in ids]
        self.save()
        return n

    def forget(self, nid: str) -> bool:
        before = len(self.named)
        self.named = [n for n in self.named if n["id"] != nid]
        self.save()
        return len(self.named) != before

import { useEffect, useRef, useState } from "react";
import { fmt } from "@/lib/format";
import { doorGeom, inRoom, mapShort, nearSeg, roomPath, roomPts, sigQ, shortName, tidyPts, topEdge, withPts, type Floorplan, type FpRoom, type FpWall, type MapDev, type MapLink, type Pt } from "@/lib/map-model";
import { deviceIcon } from "@/components/icons";
import type { Plug } from "@/lib/types";
import { cn } from "@/lib/utils";
import { covColor, type CoverCell } from "@/lib/coverage";

export type MapSel = { kind: "room" | "ap" | "dev" | "wall" | "door"; id: string } | null;
// 編輯工具：選取／畫牆／放門
export type MapTool = "select" | "wall" | "door" | "window";
export type MapLayer = "signal" | "coverage" | "motion";
// 建議的位置（虛線）：基地台搬到這裡、或在這裡加一個插座；to：連到哪裡（畫虛線）
export interface MapGhost { id: string; kind: "ap" | "plug"; x: number; y: number; label: string; to?: { x: number; y: number } }
// 地圖上的人：猜到在哪個區域（sure=false 是把握不夠，只是最可能的那間）
export type MapPerson = { id: string; name: string; room: string; roomName: string; sure: boolean; p: number; motion?: boolean };
// corner／edge：拖區域的第 i 個轉角、第 i 道牆（轉角 i 到 i+1）
type Drag = { kind: "item" | "room" | "corner" | "edge" | "wall" | "wallEnd" | "door" | "label"; id: string; i?: number };

const STROKE: Record<string, string> = { good: "var(--primary)", mid: "color-mix(in srgb, var(--primary) 45%, var(--card))", weak: "var(--color-orange-500, #f97316)" };
const WARN = "var(--color-orange-500, #f97316)";
export const ROOM_ACTIVE = 0.4; // 跟伺服器 roommotion.ACTIVE 一樣
export const ROOM_STRONG = 1.0;

// 裝置名稱：太長就截短；多孔插座的本體寫「排插・幾孔」（每一孔另外有自己的點）
const devName = (d: MapDev) => (d.plugs.length > 1 ? `排插・${d.plugs.length} 孔` : shortName(d.name, 6));

// 多孔插座每一孔的點：地圖上的代碼「o:插座 ID」
const outletKey = (p: Plug) => `o:${p.id}`;
const OUT_R = 14; // 每孔圓點的半徑（跟裝置圓點差不多大，好按）

type XY = { x: number; y: number };

// 兩條線段有沒有交叉（擺預設位置時，不要隔著牆）
function crosses(a: XY, b: XY, c: XY, d: XY) {
  const o = (p: XY, q: XY, r: XY) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  return o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0;
}

// 還沒擺過的孔：平均排在本體四周，避開牆和地圖邊緣（先選下方，再兩側，最後上方）
function outletRing(fp: Floorplan, at: XY, n: number): XY[] {
  const R = 76, M = 30;
  const order = [90, 45, 135, 0, 180, 315, 225, 270];
  const ok = (deg: number) => {
    const q = { x: at.x + Math.cos((deg * Math.PI) / 180) * R, y: at.y + Math.sin((deg * Math.PI) / 180) * R };
    if (q.x < M || q.y < M || q.x > fp.w - M || q.y > fp.h - M) return false;
    return !(fp.walls || []).some((w) => crosses(at, q, { x: w.x1, y: w.y1 }, { x: w.x2, y: w.y2 }));
  };
  const good = order.filter(ok);
  const pool = good.length >= n ? good : [...good, ...order.filter((d) => !good.includes(d))];
  const picked: number[] = [pool[0]];
  const gap = (a: number, b: number) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));
  while (picked.length < n) {
    let best = pool.find((d) => !picked.includes(d))!;
    for (const d of pool) if (!picked.includes(d) && Math.min(...picked.map((x) => gap(x, d))) > Math.min(...picked.map((x) => gap(x, best)))) best = d;
    picked.push(best);
  }
  return picked.sort((a, b) => a - b).map((deg) => ({ x: at.x + Math.cos((deg * Math.PI) / 180) * R, y: at.y + Math.sin((deg * Math.PI) / 180) * R }));
}

// 地圖本體：區域、訊號光暈、連線、基地台、裝置；編輯時可以拖曳
export function MapCanvas({
  fp, devs, links, layer, edit, sel, motion, roomHeat = {}, cover, ghosts = [], people = [], tool = "select", onChange, onDragEnd, onPick, onTip, powerOf, onPower,
}: {
  fp: Floorplan;
  devs: MapDev[];
  links: MapLink[];
  layer: MapLayer;
  edit: boolean;
  sel: MapSel;
  motion: Record<string, number | null>;
  roomHeat?: Record<string, number | null>;
  cover?: { cells: CoverCell[]; step: number } | null;
  ghosts?: MapGhost[];
  people?: MapPerson[];
  tool?: MapTool;
  onChange: (fp: Floorplan) => void;
  onDragEnd: () => void;
  onPick: (s: MapSel) => void;
  onTip: (t: string | null) => void;
  // 地圖上直接開關插座：裝置圓點右上角的小電源鈕（看的時候才有）
  powerOf?: (p: Plug) => boolean;
  onPower?: (p: Plug) => void;
}) {
  const svg = useRef<SVGSVGElement>(null);
  const [px, setPx] = useState(900);
  const fpRef = useRef(fp);
  fpRef.current = fp;
  const [zoom, setZoom] = useState<{ s: number; cx?: number; cy?: number }>({ s: 1 });
  const touches = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ d0: number; s0: number; cx: number; cy: number; px0: number; py0: number } | null>(null);

  // 標記大小跟著畫面寬度：手機上地圖縮得很小，標記要放大才看得到
  useEffect(() => {
    const el = svg.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setPx(el.clientWidth || 900));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const W = fp.w;
  const H = fp.h;
  // 看的時候只顯示有畫東西的範圍（牆、區域、裝置），旁邊留一點邊；編輯時整張畫布都在，才能往空白處畫
  const vb = (() => {
    const xs: number[] = [], ys: number[] = [];
    for (const w of fp.walls || []) { xs.push(w.x1, w.x2); ys.push(w.y1, w.y2); }
    for (const r of fp.rooms || []) for (const [x, y] of roomPts(r)) { xs.push(x); ys.push(y); }
    for (const it of Object.values(fp.items)) { xs.push(it.x); ys.push(it.y); }
    if (edit || fp.image || xs.length < 2) return { x: 0, y: 0, w: W, h: H };
    const pad = Math.max(24, W * 0.03);
    const x0 = Math.max(0, Math.min(...xs) - pad), y0 = Math.max(0, Math.min(...ys) - pad);
    const x1 = Math.min(W, Math.max(...xs) + pad), y1 = Math.min(H, Math.max(...ys) + pad * 1.8);
    return x1 - x0 < W * 0.3 || y1 - y0 < H * 0.3 ? { x: 0, y: 0, w: W, h: H } : { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  })();
  // 放大縮小：zoom.s 倍、以 (cx, cy) 為中心；看的時候兩指縮放、放大後單指拖曳，也可以按 ＋／－
  const zs = Math.max(1, Math.min(5, zoom.s));
  const zw = vb.w / zs, zh = vb.h / zs;
  const zx = Math.max(vb.x, Math.min(vb.x + vb.w - zw, (zoom.cx ?? vb.x + vb.w / 2) - zw / 2));
  const zy = Math.max(vb.y, Math.min(vb.y + vb.h - zh, (zoom.cy ?? vb.y + vb.h / 2) - zh / 2));
  const view = { x: zx, y: zy, w: zw, h: zh };
  // 標記的字在畫面上大約 12px：k = 地圖單位／畫面像素 × 1.1（放大時字不會跟著變大，點之間的距離變大）
  const k = Math.max(1, Math.min(2.6, (vb.w / px) * 1.1)) / zs;
  const showNames = k < 2.3; // 手機上整張縮小時只畫圖示，放大一點就出現名字
  const rooms = fp.rooms || [];
  const placed = devs.filter((d) => fp.items[d.key]);

  // 看的時候（不是編輯）：疊在一起的裝置稍微推開，數字才看得清楚；Wi-Fi 基地台不動。實際位置不變
  const pos: Record<string, { x: number; y: number }> = {};
  for (const d of placed) pos[d.key] = { x: fp.items[d.key].x, y: fp.items[d.key].y };
  // 多孔插座的每一孔（本體擺上去了才畫）
  const outlets = placed.filter((d) => d.plugs.length > 1).flatMap((d) => {
    const ring = outletRing(fp, fp.items[d.key], d.plugs.length);
    return d.plugs.map((p, i) => {
      const key = outletKey(p);
      const at = fp.items[key] || ring[i];
      return { key, p, d, x: at.x, y: at.y };
    });
  });
  // 看的時候每一孔也一起參加「疊在一起就推開」
  if (!edit) for (const o of outlets) pos[o.key] = { x: o.x, y: o.y };
  if (!edit) {
    // 每個裝置連同下面的名字當成一個方框（中心在圓圈下方一點），重疊就往重疊比較少的方向推開
    const bw = (showNames ? 66 : 34) * k, bh = (showNames ? 48 : 34) * k, cy = (showNames ? 9 : 0) * k;
    const fixed = fp.aps.map((a) => fp.items[`ap:${a.id}`]).filter(Boolean);
    const keys = Object.keys(pos);
    for (let it = 0; it < 200; it++) {
      let moved = false;
      for (let i = 0; i < keys.length; i++) {
        const a = pos[keys[i]];
        for (let j = i + 1; j < keys.length; j++) {
          const b = pos[keys[j]];
          const dx = b.x - a.x, dy = b.y - a.y;
          const ox = bw - Math.abs(dx), oy = bh - Math.abs(dy);
          if (ox <= 0 || oy <= 0) continue;
          // 沿著兩個裝置的連線方向推開（一直線排隊的會散開成一圈，比較不會卡住）
          let ux = dx, uy = dy;
          const len = Math.hypot(ux, uy);
          if (len < 0.01) { ux = j % 2 ? 1 : -1; uy = 0.6; } else { ux /= len; uy /= len; }
          const p = Math.min(ox, oy) / 2 + 0.5;
          a.x -= ux * p; a.y -= uy * p; b.x += ux * p; b.y += uy * p;
          moved = true;
        }
        for (const f of fixed) {
          const dx = a.x - f.x, dy = (a.y + cy) - (f.y + 8 * k);
          const ox = (bw + 80 * k) / 2 - Math.abs(dx), oy = (bh + 54 * k) / 2 - Math.abs(dy);
          if (ox <= 0 || oy <= 0) continue;
          if (ox < oy) a.x += (ox + 0.5) * (dx >= 0 ? 1 : -1);
          else a.y += (oy + 0.5) * (dy >= 0 ? 1 : -1);
          moved = true;
        }
        a.x = Math.max(bw / 2, Math.min(W - bw / 2, a.x));
        a.y = Math.max(16 * k, Math.min(H - bh + 16 * k, a.y));
      }
      if (!moved) break;
    }
  }
  const glowR = Math.max(60, Math.min(220, 2.2 / ((fp.meters || 12) / W)));

  // ---- 字的位置：房間名稱、家人名牌、裝置名稱都先試幾個地方，挑不會蓋到圓點、基地台或別的字的 ----
  type Box = { x0: number; y0: number; x1: number; y1: number };
  const overlap = (a: Box, b: Box) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
  const textW = (t: string, size: number) => [...t].reduce((a, c) => a + (c.charCodeAt(0) < 256 ? 0.6 : 1.02), 0) * size;
  const taken: Box[] = [];
  const disc = (x: number, y: number, r: number): Box => ({ x0: x - r, y0: y - r, x1: x + r, y1: y + r });
  for (const d of placed) taken.push(disc(pos[d.key].x, pos[d.key].y, 17 * k));
  for (const a of fp.aps) {
    const it = fp.items[`ap:${a.id}`];
    if (!it) continue;
    taken.push(disc(it.x, it.y, 21 * k));
    if (showNames) {
      const w = textW(shortName(a.name, 9), 11.5 * k);
      taken.push({ x0: it.x - w / 2, y0: it.y + 22 * k, x1: it.x + w / 2, y1: it.y + 38 * k });
    }
  }
  const free = (b: Box) => !taken.some((t) => overlap(t, b));
  const inside = (r: FpRoom, b: Box) => inRoom(r, b.x0, b.y0) && inRoom(r, b.x1, b.y0) && inRoom(r, b.x0, b.y1) && inRoom(r, b.x1, b.y1);
  // 先找區域裡的空位；沒有就試區域外面的備案；都不行才疊在區域裡第一個位置
  const pickBox = (r: FpRoom, cands: Box[], outside: Box[] = []) =>
    cands.find((b) => inside(r, b) && free(b)) ?? outside.find((b) => free(b) && b.x0 >= 0 && b.y0 >= 0 && b.x1 <= W && b.y1 <= H) ?? cands.find((b) => inside(r, b)) ?? cands[0];

  const roomLabel: Record<string, { x: number; y: number }> = {};
  for (const r of rooms) {
    const w = textW(r.name, 15 * k), hh = 19 * k;
    const extra = layer === "motion" && !edit && (roomHeat[r.id] ?? 0) >= ROOM_ACTIVE ? 18 * k : 0;
    const top = topEdge(r), m = 12 * k;
    const at = (x: number, y: number): Box => ({ x0: x - 2 * k, y0: y, x1: x + w + 2 * k, y1: y + hh + extra });
    const b = r.label
      ? at(r.x + r.label[0], r.y + r.label[1])
      : pickBox(r, [
          at(top.left + m, top.y + 8 * k), at(top.right - m - w, top.y + 8 * k),
          at(r.x + m, r.y + r.h - m - hh - extra), at(r.x + r.w - m - w, r.y + r.h - m - hh - extra),
          at(r.x + r.w / 2 - w / 2, r.y + r.h / 2 - hh / 2),
        ]);
    roomLabel[r.id] = { x: b.x0 + 2 * k, y: b.y0 };
    taken.push(b);
  }

  const badgeAt: Record<string, { x: number; y: number }> = {};
  if (!edit) {
    for (const r of rooms) {
      const here = people.filter((p) => p.room === r.id);
      if (!here.length) continue;
      const ws = here.map((p) => textW(p.sure ? p.name : `${p.name}?`, 12 * k) + 24 * k);
      const total = ws.reduce((a, b) => a + b, 0) + 6 * k * (ws.length - 1), hh = 22 * k, m = 8 * k, top = topEdge(r);
      const at = (x: number, y: number): Box => ({ x0: x, y0: y, x1: x + total, y1: y + hh });
      const b = pickBox(
        r,
        [at(top.right - m - total, top.y + m), at(top.left + m, top.y + m), at(r.x + r.w - m - total, r.y + r.h - m - hh), at(r.x + m, r.y + r.h - m - hh), at(r.x + r.w / 2 - total / 2, r.y + r.h / 2 - hh / 2)],
        [at(top.right - total, top.y - hh - 4 * k), at(top.left, top.y - hh - 4 * k), at(r.x + r.w / 2 - total / 2, r.y + r.h + 4 * k)],
      );
      taken.push(b);
      let x = b.x0;
      here.forEach((p, i) => {
        badgeAt[p.id] = { x, y: b.y0 };
        x += ws[i] + 6 * k;
      });
    }
  }

  type DevLabel = { dx: number; dy: number; anchor: "middle" | "start" | "end" };
  const devLabel: Record<string, DevLabel> = {};
  for (const d of placed) {
    const c = pos[d.key];
    const w = textW(devName(d), 11.5 * k), h = 15 * k;
    const opts: (DevLabel & { b: Box })[] = [
      { dx: 0, dy: 31, anchor: "middle", b: { x0: c.x - w / 2, y0: c.y + 20 * k, x1: c.x + w / 2, y1: c.y + 20 * k + h } },
      { dx: 0, dy: -23, anchor: "middle", b: { x0: c.x - w / 2, y0: c.y - 35 * k, x1: c.x + w / 2, y1: c.y - 35 * k + h } },
      { dx: 21, dy: 4, anchor: "start", b: { x0: c.x + 20 * k, y0: c.y - 7 * k, x1: c.x + 20 * k + w, y1: c.y + 8 * k } },
      { dx: -21, dy: 4, anchor: "end", b: { x0: c.x - 20 * k - w, y0: c.y - 7 * k, x1: c.x - 20 * k, y1: c.y + 8 * k } },
    ];
    const o = showNames && !edit ? opts.find((x) => free(x.b) && x.b.x0 >= 0 && x.b.x1 <= W && x.b.y1 <= H) ?? opts[0] : opts[0];
    if (showNames) taken.push(o.b);
    devLabel[d.key] = o;
  }

  const point = (e: { clientX: number; clientY: number }) => {
    const el = svg.current!;
    const pt = el.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    return pt.matrixTransform(el.getScreenCTM()!.inverse());
  };

  // 對齊：靠近別的轉角的 x／y 就吸過去（牆才對得齊），不然取 5 的倍數
  const snapper = (f: Floorplan, skip: string) => {
    const xs: number[] = [], ys: number[] = [];
    for (const r of f.rooms || []) if (r.id !== skip) for (const [x, y] of roomPts(r)) { xs.push(x); ys.push(y); }
    for (const w of f.walls || []) if (w.id !== skip) { xs.push(w.x1, w.x2); ys.push(w.y1, w.y2); }
    const near = (v: number, list: number[]) => {
      let best = Math.round(v / 5) * 5, gap = 8 * k;
      for (const c of list) if (Math.abs(c - v) < gap) { gap = Math.abs(c - v); best = c; }
      return best;
    };
    return { x: (v: number) => near(v, xs), y: (v: number) => near(v, ys) };
  };

  const startDrag = (e: React.PointerEvent, d: Drag) => {
    if (!edit) return;
    e.preventDefault();
    e.stopPropagation();
    const f0 = fpRef.current;
    const start = point(e);
    if (d.kind === "wall" || d.kind === "wallEnd" || d.kind === "door") return dragWall(d, f0, start);
    const origItem = d.kind === "item" ? { ...(f0.items[d.id] || outlets.find((o) => o.key === d.id) || { x: 0, y: 0 }) } : null;
    const origRoom = d.kind === "item" ? null : f0.rooms!.find((r) => r.id === d.id)!;
    const P = origRoom ? roomPts(origRoom) : [];
    const snap = snapper(f0, d.id);
    const parent = d.id.startsWith("o:") ? outlets.find((o) => o.key === d.id)?.d.key : null;
    onPick(d.kind === "item" ? (d.id.startsWith("ap:") ? { kind: "ap", id: d.id.slice(3) } : { kind: "dev", id: parent || d.id }) : { kind: "room", id: d.id });
    const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
    const setRoom = (f: Floorplan, fn: (r: FpRoom) => FpRoom) => onChange({ ...f, rooms: f.rooms!.map((r) => (r.id === d.id ? fn(r) : r)) });
    const move = (ev: PointerEvent) => {
      const pt = point(ev);
      const dx = pt.x - start.x;
      const dy = pt.y - start.y;
      const f = fpRef.current;
      if (origItem) {
        onChange({ ...f, items: { ...f.items, [d.id]: { ...(f.items[d.id] || {}), x: clamp(origItem.x + dx, 0, f.w), y: clamp(origItem.y + dy, 0, f.h) } } });
        return;
      }
      const o = origRoom!;
      if (d.kind === "label") {
        const base = o.label || [roomLabel[o.id].x - o.x, roomLabel[o.id].y - o.y];
        setRoom(f, (r) => ({ ...r, label: [clamp(base[0] + dx, 0, r.w), clamp(base[1] + dy, 0, r.h)] }));
        return;
      }
      if (d.kind === "room") {
        const mx = clamp(dx, -o.x, f.w - o.x - o.w), my = clamp(dy, -o.y, f.h - o.y - o.h);
        setRoom(f, (r) => ({ ...r, x: o.x + mx, y: o.y + my, w: o.w, h: o.h, pts: o.pts ? o.pts.map(([x, y]) => [x + mx, y + my] as Pt) : null }));
        return;
      }
      const n = P.length, i = d.i!;
      const Q = P.map((q) => [...q] as Pt);
      if (d.kind === "corner") {
        // 拖轉角：相鄰的兩道牆跟著移，牆保持水平、垂直（長方形就是改大小）
        const nx = clamp(snap.x(P[i][0] + dx), 0, f.w), ny = clamp(snap.y(P[i][1] + dy), 0, f.h);
        for (const j of [(i + n - 1) % n, (i + 1) % n]) {
          if (P[j][0] === P[i][0]) Q[j][0] = nx;
          else if (P[j][1] === P[i][1]) Q[j][1] = ny;
        }
        Q[i] = [nx, ny];
      } else {
        // 拖牆：整道牆往垂直方向推、拉
        const j = (i + 1) % n;
        if (P[i][0] === P[j][0]) Q[i][0] = Q[j][0] = clamp(snap.x(P[i][0] + dx), 0, f.w);
        else Q[i][1] = Q[j][1] = clamp(snap.y(P[i][1] + dy), 0, f.h);
      }
      setRoom(f, (r) => withPts(r, Q));
    };
    const end = () => {
      removeEventListener("pointermove", move);
      removeEventListener("pointerup", end);
      removeEventListener("pointercancel", end);
      if (d.kind === "corner" || d.kind === "edge") {
        const f = fpRef.current;
        const r = f.rooms!.find((x) => x.id === d.id);
        if (r) setRoom(f, (x) => withPts(x, tidyPts(roomPts(r))));
      }
      onDragEnd();
    };
    addEventListener("pointermove", move);
    addEventListener("pointerup", end);
    addEventListener("pointercancel", end);
  };

  // 拖牆（整道移動）、拖牆的端點、拖門（沿著牆滑）
  const dragWall = (d: Drag, f0: Floorplan, start: { x: number; y: number }) => {
    const snap = snapper(f0, d.id);
    const door = d.kind === "door" ? (f0.doors || []).find((x) => x.id === d.id) : null;
    const w0 = (f0.walls || []).find((x) => x.id === (door ? door.wall : d.id));
    if (!w0) return;
    onPick({ kind: door ? "door" : "wall", id: d.id });
    const move = (ev: PointerEvent) => {
      const pt = point(ev);
      const f = fpRef.current;
      if (door) {
        const t = nearSeg(pt.x, pt.y, w0).t;
        onChange({ ...f, doors: (f.doors || []).map((x) => (x.id === door.id ? { ...x, t } : x)) });
        return;
      }
      let nw: FpWall;
      if (d.kind === "wall") {
        const dx = snap.x(w0.x1 + pt.x - start.x) - w0.x1, dy = snap.y(w0.y1 + pt.y - start.y) - w0.y1;
        nw = { ...w0, x1: w0.x1 + dx, y1: w0.y1 + dy, x2: w0.x2 + dx, y2: w0.y2 + dy };
      } else {
        // 端點：另一端不動；接近水平、垂直就拉直（按住 Shift 可以斜的）
        const [ox, oy] = d.i ? [w0.x1, w0.y1] : [w0.x2, w0.y2];
        let x = snap.x(pt.x), y = snap.y(pt.y);
        if (!ev.shiftKey) { if (Math.abs(x - ox) >= Math.abs(y - oy)) y = oy; else x = ox; }
        nw = d.i ? { ...w0, x2: x, y2: y } : { ...w0, x1: x, y1: y };
      }
      onChange({ ...f, walls: (f.walls || []).map((x) => (x.id === w0.id ? nw : x)) });
    };
    const end = () => {
      removeEventListener("pointermove", move);
      removeEventListener("pointerup", end);
      removeEventListener("pointercancel", end);
      onDragEnd();
    };
    addEventListener("pointermove", move);
    addEventListener("pointerup", end);
    addEventListener("pointercancel", end);
  };

  // 畫牆：按下去拖到另一端放開（會對齊別的牆和轉角；水平、垂直，按住 Shift 可以斜的）
  const [draft, setDraft] = useState<FpWall | null>(null);
  const meterU = W / (fp.meters || 12); // 一公尺是幾個地圖單位
  const toolDown = (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const f0 = fpRef.current;
    const p0 = point(e);
    if (tool === "door" || tool === "window") {
      // 放門窗：點在牆上（或牆附近）
      let best: { w: FpWall; t: number; d: number } | null = null;
      for (const w of f0.walls || []) {
        const n = nearSeg(p0.x, p0.y, w);
        if (n.d < 16 * k && (!best || n.d < best.d)) best = { w, t: n.t, d: n.d };
      }
      const win = tool === "window";
      if (!best) return onTip(win ? "窗要放在牆上：點一道牆" : "門要放在牆上：點一道牆");
      const id = `d${Date.now().toString(36)}`;
      const nd = win ? { id, wall: best.w.id, t: best.t, w: Math.round(1.2 * meterU), flip: 0, kind: "win" as const } : { id, wall: best.w.id, t: best.t, w: Math.round(0.9 * meterU), flip: 0 };
      onChange({ ...f0, doors: [...(f0.doors || []), nd] });
      onPick({ kind: "door", id });
      onDragEnd();
      return;
    }
    const snap = snapper(f0, "");
    const x1 = snap.x(p0.x), y1 = snap.y(p0.y);
    const id = `w${Date.now().toString(36)}`;
    let cur: FpWall = { id, x1, y1, x2: x1, y2: y1 };
    setDraft(cur);
    const move = (ev: PointerEvent) => {
      const pt = point(ev);
      let x = snap.x(pt.x), y = snap.y(pt.y);
      if (!ev.shiftKey) { if (Math.abs(x - x1) >= Math.abs(y - y1)) y = y1; else x = x1; }
      cur = { ...cur, x2: x, y2: y };
      setDraft(cur);
    };
    const end = () => {
      removeEventListener("pointermove", move);
      removeEventListener("pointerup", end);
      removeEventListener("pointercancel", end);
      setDraft(null);
      if (Math.hypot(cur.x2 - cur.x1, cur.y2 - cur.y1) < 10) return;
      const f = fpRef.current;
      onChange({ ...f, walls: [...(f.walls || []), cur] });
      onPick({ kind: "wall", id: cur.id });
      onDragEnd();
    };
    addEventListener("pointermove", move);
    addEventListener("pointerup", end);
    addEventListener("pointercancel", end);
  };

  // 在轉角按兩下：切掉這個角（三分之一見方），變成 L 形；再拖新的轉角調整缺口
  const cutCorner = (id: string, i: number) => {
    const f = fpRef.current;
    const r = f.rooms!.find((x) => x.id === id);
    if (!r) return;
    const P = roomPts(r);
    if (P.length >= 22) return;
    const n = P.length, a = P[(i + n - 1) % n], b = P[i], c = P[(i + 1) % n];
    const p1: Pt = [Math.round(b[0] + (a[0] - b[0]) / 3), Math.round(b[1] + (a[1] - b[1]) / 3)];
    const p3: Pt = [Math.round(b[0] + (c[0] - b[0]) / 3), Math.round(b[1] + (c[1] - b[1]) / 3)];
    const p2: Pt = [p1[0] + p3[0] - b[0], p1[1] + p3[1] - b[1]];
    const Q = [...P.slice(0, i), p1, p2, p3, ...P.slice(i + 1)];
    onChange({ ...f, rooms: f.rooms!.map((x) => (x.id === id ? withPts(x, tidyPts(Q)) : x)) });
    onDragEnd();
  };

  // 在牆的中點按兩下：這道牆多兩個轉角，中間那段就能拉出凹口、凸出去（做成 L 形、凹字形）
  const splitEdge = (id: string, i: number) => {
    const f = fpRef.current;
    const r = f.rooms!.find((x) => x.id === id);
    if (!r) return;
    const P = roomPts(r);
    if (P.length >= 24) return;
    const a = P[i], b = P[(i + 1) % P.length];
    const at = (t: number): Pt => [Math.round(a[0] + (b[0] - a[0]) * t), Math.round(a[1] + (b[1] - a[1]) * t)];
    const Q = [...P.slice(0, i + 1), at(1 / 3), at(2 / 3), ...P.slice(i + 1)];
    onChange({ ...f, rooms: f.rooms!.map((x) => (x.id === id ? { ...withPts(x, Q), pts: Q } : x)) });
    onDragEnd();
  };

  const showLinks = edit || layer === "motion";

  // 看的時候：兩指縮放、放大後單指拖曳（沒放大時單指留給頁面上下捲）
  const zoomTo = (s: number, cx?: number, cy?: number) => setZoom((z) => (s <= 1.02 ? { s: 1 } : { s: Math.min(5, s), cx: cx ?? z.cx ?? view.x + view.w / 2, cy: cy ?? z.cy ?? view.y + view.h / 2 }));
  const gStart = () => {
    const pts = [...touches.current.values()];
    const c = pts.length === 2 ? { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 } : pts[0];
    const m = point({ clientX: c.x, clientY: c.y });
    gesture.current = { d0: pts.length === 2 ? Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) : 0, s0: zs, cx: view.x + view.w / 2, cy: view.y + view.h / 2, px0: c.x, py0: c.y };
    return m;
  };
  const onDown = (e: React.PointerEvent) => {
    if (edit || e.pointerType === "mouse" && zs <= 1) return;
    touches.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (touches.current.size === 2 || zs > 1) gStart();
  };
  const onMove = (e: React.PointerEvent) => {
    if (edit || !touches.current.has(e.pointerId)) return;
    touches.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = gesture.current;
    if (!g) return;
    const pts = [...touches.current.values()];
    const upp = view.w / Math.max(1, px); // 地圖單位／畫面像素
    if (pts.length === 2 && g.d0) {
      const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      const c = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
      setZoom({ s: Math.max(1, Math.min(5, (g.s0 * d) / g.d0)), cx: g.cx - (c.x - g.px0) * upp, cy: g.cy - (c.y - g.py0) * upp });
    } else if (pts.length === 1 && zs > 1) {
      setZoom({ s: zs, cx: g.cx - (pts[0].x - g.px0) * upp, cy: g.cy - (pts[0].y - g.py0) * upp });
    }
  };
  const onUp = (e: React.PointerEvent) => {
    touches.current.delete(e.pointerId);
    gesture.current = null;
    if (touches.current.size) gStart();
    if (zoom.s < 1.05 && zoom.s !== 1) setZoom({ s: 1 });
  };

  return (
    <div className="relative">
    <svg
      ref={svg}
      viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
      role="img"
      aria-label="訊號地圖"
      className={cn("block h-auto w-full rounded-xl bg-muted select-none", edit || zs > 1 ? "touch-none" : "touch-pan-y")}
      onClick={(e) => e.target === e.currentTarget && !edit && onPick(null)}
      onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}
      onWheel={(e) => { if (!e.ctrlKey && !e.metaKey) return; e.preventDefault(); const m = point(e); zoomTo(zs * (e.deltaY < 0 ? 1.15 : 1 / 1.15), m.x, m.y); }}
    >
      <defs>
        <filter id="map-cov-blur" x="-5%" y="-5%" width="110%" height="110%"><feGaussianBlur stdDeviation={(cover?.step || 20) * 0.6} /></filter>
        <clipPath id="map-rooms">{rooms.map((r) => <path key={r.id} d={roomPath(r)} />)}</clipPath>
        {(["good", "mid", "weak"] as const).map((q) => (
          <radialGradient key={q} id={`map-g-${q}`}>
            <stop offset="0" stopColor={STROKE[q]} stopOpacity={0.22} />
            <stop offset="1" stopColor={STROKE[q]} stopOpacity={0} />
          </radialGradient>
        ))}
      </defs>
      {fp.image && <image href={`/api/floorplan/image?v=${encodeURIComponent(fp.image)}`} x={0} y={0} width={W} height={H} preserveAspectRatio="xMidYMid meet" opacity={0.55} />}
      <g>{rooms.map((r) => <path key={r.id} d={roomPath(r)} className="fill-card" />)}</g>
      {layer === "signal" && (
        <g clipPath="url(#map-rooms)">
          {placed.filter((d) => d.online && d.rssi != null).map((d) => (
            <circle key={d.key} cx={fp.items[d.key].x} cy={fp.items[d.key].y} r={glowR.toFixed(0)} fill={`url(#map-g-${sigQ(d.rssi!)})`} />
          ))}
        </g>
      )}
      {layer === "coverage" && !edit && cover && (
        <g clipPath="url(#map-rooms)" filter="url(#map-cov-blur)" className="pointer-events-none">
          {cover.cells.map((c, i) => {
            return <rect key={i} x={c.x - cover.step / 2 - 0.5} y={c.y - cover.step / 2 - 0.5} width={cover.step + 1} height={cover.step + 1} fill={covColor(c.v)} />;
          })}
        </g>
      )}
      {layer === "motion" && !edit && rooms.map((r) => {
        // 房間的動靜：整間染成橘色，越熱越深
        const h = roomHeat[r.id];
        return h != null && h >= 0.25 ? <path key={`heat-${r.id}`} d={roomPath(r)} fill={WARN} fillOpacity={Math.min(0.4, 0.04 + h * 0.2)} className="pointer-events-none" /> : null;
      })}
      {rooms.map((r) => {
        const isSel = edit && sel?.kind === "room" && sel.id === r.id;
        const h = layer === "motion" && !edit ? roomHeat[r.id] : null;
        const lb = roomLabel[r.id];
        return (
          <g key={r.id}>
            <path
              d={roomPath(r)}
              fill="transparent"
              className={cn(isSel ? "stroke-primary" : "stroke-border", edit && "cursor-move")}
              strokeWidth={isSel ? 3 : 1.5}
              onPointerDown={(e) => startDrag(e, { kind: "room", id: r.id })}
            />
            <text x={lb.x} y={lb.y + 16 * k} className={cn("fill-muted-foreground font-semibold select-none", edit ? "cursor-move" : "pointer-events-none")} style={{ fontSize: 15 * k }}
              onPointerDown={(e) => startDrag(e, { kind: "label", id: r.id })}>{edit && <title>拖曳可以移動名稱</title>}{r.name}</text>
            {h != null && h >= ROOM_ACTIVE && (
              <text x={lb.x} y={lb.y + 34 * k} className="pointer-events-none font-semibold" fill={WARN} style={{ fontSize: 12 * k }}>{h >= ROOM_STRONG ? "有人走動" : "有動靜"}</text>
            )}
          </g>
        );
      })}
      {!edit && rooms.map((r) => {
        // 人：名牌放在上面算好的空位（預設區域右上角），同一間有好幾個人就排成一列
        const here = people.filter((p) => p.room === r.id);
        return here.map((p) => {
          const label = p.sure ? p.name : `${p.name}?`;
          const w = textW(label, 12 * k) + 24 * k, h = 22 * k;
          const { x, y: by } = badgeAt[p.id];
          const top = { y: by - 8 * k };
          const tip = (p.sure ? `${p.name} 大概在${p.roomName}（${Math.round(p.p * 100)}% 把握）` : `${p.name} 可能在${p.roomName}（${Math.round(p.p * 100)}%，不確定）`) + (p.motion ? "・那間剛有動靜" : "");
          return (
            <g key={p.id} opacity={p.sure ? 1 : 0.6} onMouseEnter={() => onTip(tip)} onMouseLeave={() => onTip(null)}>
              <title>{tip}</title>
              <rect x={x} y={top.y + 8 * k} width={w} height={h} rx={h / 2} className={p.sure ? "fill-foreground" : "fill-card stroke-foreground"}
                strokeWidth={1.5 * k} strokeDasharray={p.sure ? undefined : `${3 * k} ${3 * k}`} />
              <circle cx={x + 11 * k} cy={top.y + 8 * k + h / 2} r={3.5 * k} className="fill-emerald-500" />
              <text x={x + 18 * k} y={top.y + 8 * k + h / 2 + 4.3 * k} className={cn("font-semibold", p.sure ? "fill-background" : "fill-foreground")} style={{ fontSize: 12 * k }}>{label}</text>
            </g>
          );
        });
      })}
      {(() => {
        // 實牆（門的地方挖空）和門
        const walls = fp.walls || [];
        const doors = (fp.doors || []).map((dr) => ({ dr, w: walls.find((x) => x.id === dr.wall) })).filter((x) => x.w);
        const thick = Math.max(6, 3 * k);
        const all = draft ? [...walls, draft] : walls;
        if (!all.length) return null;
        return (
          <g>
            <mask id="map-door-gaps" maskUnits="userSpaceOnUse" x={0} y={0} width={W} height={H}>
              <rect x={0} y={0} width={W} height={H} fill="white" />
              {doors.map(({ dr, w }) => { const g = doorGeom(w!, dr); return <line key={dr.id} x1={g.a[0]} y1={g.a[1]} x2={g.b[0]} y2={g.b[1]} stroke="black" strokeWidth={thick + 4} />; })}
            </mask>
            <g mask="url(#map-door-gaps)">
              {all.map((w) => {
                const isSel = edit && sel?.kind === "wall" && sel.id === w.id;
                return (
                  <line key={w.id} x1={w.x1} y1={w.y1} x2={w.x2} y2={w.y2} strokeLinecap="square" strokeWidth={thick}
                    className={cn(isSel ? "stroke-primary" : "stroke-foreground/75", w === draft && "opacity-60")} />
                );
              })}
            </g>
            {doors.map(({ dr, w }) => {
              const g = doorGeom(w!, dr);
              const isSel = edit && sel?.kind === "door" && sel.id === dr.id;
              if (dr.kind) {
                // 窗：牆上的細框＋中間一條玻璃；落地窗再加兩片錯開的拉門
                const L = Math.hypot(g.b[0] - g.a[0], g.b[1] - g.a[1]) || 1;
                const nx = -(g.b[1] - g.a[1]) / L, ny = (g.b[0] - g.a[0]) / L;
                const o = thick / 2;
                const ln = (s0: number, s1: number, off: number, sw: number, key: string) => (
                  <line key={key} x1={g.a[0] + (g.b[0] - g.a[0]) * s0 + nx * off} y1={g.a[1] + (g.b[1] - g.a[1]) * s0 + ny * off}
                    x2={g.a[0] + (g.b[0] - g.a[0]) * s1 + nx * off} y2={g.a[1] + (g.b[1] - g.a[1]) * s1 + ny * off} strokeWidth={sw} />
                );
                const thin = Math.max(1.2, 0.7 * k);
                return (
                  <g key={dr.id} fill="none" strokeLinecap="butt">
                    <g className={isSel ? "stroke-primary" : "stroke-foreground/70"}>
                      {ln(0, 1, o, thin, "o1")}
                      {ln(0, 1, -o, thin, "o2")}
                      <line x1={g.a[0] + nx * o} y1={g.a[1] + ny * o} x2={g.a[0] - nx * o} y2={g.a[1] - ny * o} strokeWidth={thin} />
                      <line x1={g.b[0] + nx * o} y1={g.b[1] + ny * o} x2={g.b[0] - nx * o} y2={g.b[1] - ny * o} strokeWidth={thin} />
                    </g>
                    <g className={isSel ? "stroke-primary" : "stroke-sky-500"}>
                      {dr.kind === "fwin" ? (
                        <>
                          {ln(0, 0.55, o * 0.35, Math.max(2, 1.2 * k), "p1")}
                          {ln(0.45, 1, -o * 0.35, Math.max(2, 1.2 * k), "p2")}
                        </>
                      ) : ln(0, 1, 0, Math.max(1.5, 0.9 * k), "g")}
                    </g>
                  </g>
                );
              }
              return (
                <g key={dr.id} className={isSel ? "stroke-primary" : "stroke-foreground/60"} fill="none">
                  <line x1={g.hinge[0]} y1={g.hinge[1]} x2={g.open[0]} y2={g.open[1]} strokeWidth={Math.max(2.5, 1.4 * k)} strokeLinecap="round" />
                  <path d={`M${g.open[0]},${g.open[1]} A${g.w},${g.w} 0 0 ${g.sweep} ${g.shut[0]},${g.shut[1]}`} strokeWidth={Math.max(1.2, 0.8 * k)} strokeDasharray={`${4 * k} ${3 * k}`} />
                </g>
              );
            })}
            {edit && tool === "select" && walls.map((w) => (
              <line key={`hit-${w.id}`} x1={w.x1} y1={w.y1} x2={w.x2} y2={w.y2} stroke="transparent" strokeWidth={16 * k} className="cursor-move"
                onPointerDown={(e) => startDrag(e, { kind: "wall", id: w.id })}><title>牆：拖曳移動</title></line>
            ))}
            {edit && tool === "select" && doors.map(({ dr, w }) => {
              const g = doorGeom(w!, dr);
              return (
                <circle key={`hit-${dr.id}`} cx={(g.a[0] + g.b[0]) / 2} cy={(g.a[1] + g.b[1]) / 2} r={Math.max(g.w / 2, 12 * k)} fill="transparent"
                  className={Math.abs(w!.x1 - w!.x2) > Math.abs(w!.y1 - w!.y2) ? "cursor-ew-resize" : "cursor-ns-resize"}
                  onPointerDown={(e) => startDrag(e, { kind: "door", id: dr.id })}><title>{dr.kind ? "窗" : "門"}：沿著牆拖曳</title></circle>
              );
            })}
          </g>
        );
      })()}
      {showLinks && (
        <g>
          {links.map((l) => {
            const m = motion[l.dev.key];
            const hot = layer === "motion" && !edit && m != null && m > 0.15;
            return (
              <line
                key={l.dev.key}
                x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2}
                strokeLinecap="round"
                stroke={hot ? WARN : "var(--muted-foreground)"}
                strokeWidth={((hot ? 3 + Math.min(m!, 3) * 1.5 : 2.5) * k).toFixed(1)}
                strokeDasharray={hot ? undefined : l.q === "ok" ? "10 8" : l.q === "poor" ? "3 9" : undefined}
                opacity={hot ? Math.min(1, 0.35 + m! / 3) : l.q === "good" ? 0.6 : l.q === "ok" ? 0.45 : 0.3}
              />
            );
          })}
        </g>
      )}
      {!edit && ghosts.map((g) => (
        <g key={g.id} className="pointer-events-none">
          {g.to && <line x1={g.to.x} y1={g.to.y} x2={g.x} y2={g.y} className={g.kind === "ap" ? "stroke-primary" : "stroke-emerald-600"} strokeWidth={2 * k} strokeDasharray={`${6 * k} ${5 * k}`} opacity={0.8} />}
          <g transform={`translate(${g.x} ${g.y}) scale(${k.toFixed(2)})`}>
            <circle r={g.kind === "ap" ? 18 : 15} className={cn("fill-card", g.kind === "ap" ? "stroke-primary" : "stroke-emerald-600")} strokeWidth={2.5} strokeDasharray="5 4" fillOpacity={0.85} />
            {g.kind === "ap" ? (
              <path d="M-9,-1 Q0,-10 9,-1 M-5,3 Q0,-2 5,3" fill="none" className="stroke-primary" strokeWidth={2.2} strokeLinecap="round" />
            ) : (
              <path d="M-6,0 H6 M0,-6 V6" className="stroke-emerald-600" strokeWidth={2.5} strokeLinecap="round" />
            )}
            <text y={g.kind === "ap" ? 34 : 30} textAnchor="middle" className={cn("font-semibold", g.kind === "ap" ? "fill-primary" : "fill-emerald-700 dark:fill-emerald-400")}
              style={{ fontSize: 11.5, paintOrder: "stroke", stroke: "var(--card)", strokeWidth: 3, strokeLinejoin: "round" }}>{g.label}</text>
          </g>
        </g>
      ))}
      {fp.aps.filter((a) => fp.items[`ap:${a.id}`]).map((a) => {
        const it = fp.items[`ap:${a.id}`];
        const isSel = sel?.kind === "ap" && sel.id === a.id;
        return (
          <g
            key={a.id}
            transform={`translate(${it.x} ${it.y}) scale(${k.toFixed(2)})`}
            className={edit ? "cursor-grab" : "cursor-pointer"}
            onPointerDown={(e) => startDrag(e, { kind: "item", id: `ap:${a.id}` })}
            onClick={() => !edit && onPick({ kind: "ap", id: a.id })}
            onMouseEnter={() => onTip(a.name)}
            onMouseLeave={() => onTip(null)}
          >
            <circle r={18} className="fill-primary stroke-card" strokeWidth={isSel ? 6 : 3} style={{ filter: "drop-shadow(0 2px 4px rgb(37 99 235 / .35))" }} />
            <path d="M-9,-1 Q0,-10 9,-1 M-5,3 Q0,-2 5,3" fill="none" className="stroke-card" strokeWidth={2.2} strokeLinecap="round" />
            <circle cy={7} r={2.3} className="fill-card" />
            {(showNames || isSel) && (
              <text y={34} textAnchor="middle" className="fill-primary font-semibold" style={{ fontSize: 11.5, paintOrder: "stroke", stroke: "var(--card)", strokeWidth: 3, strokeLinejoin: "round" }}>{shortName(a.name, 9)}</text>
            )}
          </g>
        );
      })}
      {outlets.map((o) => {
        const at = pos[o.d.key];
        const me = pos[o.key] || o;
        const on = !!powerOf?.(o.p);
        const Icon = deviceIcon(o.p.name);
        const tip = `${o.p.name}（${devName(o.d)}的一孔）：${!o.p.online ? "連不上" : on ? "開著" : "關著"}`;
        return (
          <g key={o.key}>
            <line x1={at.x} y1={at.y} x2={me.x} y2={me.y} stroke="var(--muted-foreground)" strokeOpacity={0.45} strokeWidth={1.2 * k} strokeDasharray={`${3 * k} ${3 * k}`} />
            <g transform={`translate(${me.x} ${me.y}) scale(${k.toFixed(2)})`} className={edit ? "cursor-grab" : "cursor-pointer"}
              role={edit ? undefined : "button"} aria-label={edit ? undefined : `${tip}，點一下${on ? "關閉" : "打開"}`}
              onPointerDown={(e) => startDrag(e, { kind: "item", id: o.key })}
              onClick={(e) => { if (edit || !onPower || !o.p.online) return; e.stopPropagation(); onPower(o.p); }}
              onMouseEnter={() => onTip(tip)} onMouseLeave={() => onTip(null)}>
              <title>{tip}</title>
              <circle r={OUT_R + 7} fill="transparent" />
              <circle r={OUT_R} className={on ? "fill-primary" : "fill-card"} stroke={on ? "var(--card)" : "var(--muted-foreground)"} strokeWidth={on ? 2 : 1.5}
                strokeDasharray={o.p.online ? undefined : "3 2"} style={{ filter: "drop-shadow(0 1px 2px rgb(15 23 42 / .22))" }} />
              <Icon x={-8} y={-8} width={16} height={16} strokeWidth={2.2} color={on ? "var(--primary-foreground)" : "var(--muted-foreground)"} aria-hidden />
              {showNames && (
                <text y={OUT_R + 14} textAnchor="middle" className="fill-foreground font-semibold" style={{ fontSize: 11, paintOrder: "stroke", stroke: "var(--card)", strokeWidth: 3, strokeLinejoin: "round" }}>{mapShort(o.p)}</text>
              )}
            </g>
          </g>
        );
      })}
      {placed.map((d) => {
        const it = pos[d.key];
        const m = motion[d.key];
        const q = d.online && d.rssi != null ? sigQ(d.rssi) : null;
        const isSel = sel?.kind === "dev" && sel.id === d.key;
        const hot = layer === "motion" && m != null && m > 0.15;
        const tip = `${d.full}：${d.online ? `訊號 ${d.rssi ?? "—"} dBm` : "離線"}${m != null ? `・擾動 ${fmt(m, 1)}` : ""}`;
        return (
          <g
            key={d.key}
            transform={`translate(${it.x} ${it.y}) scale(${k.toFixed(2)})`}
            className={edit ? "cursor-grab" : "cursor-pointer"}
            onPointerDown={(e) => startDrag(e, { kind: "item", id: d.key })}
            onClick={() => !edit && onPick({ kind: "dev", id: d.key })}
            onMouseEnter={() => onTip(tip)}
            onMouseLeave={() => onTip(null)}
          >
            <title>{tip}</title>
            {hot && <circle r={19 + Math.min(m!, 3) * 5} fill={WARN} fillOpacity={Math.min(1, m! / 3) * 0.3 + 0.12} />}
            <circle
              r={15}
              className="fill-card"
              stroke={!d.online ? "var(--muted-foreground)" : q ? STROKE[q] : "var(--primary)"}
              strokeDasharray={d.online ? undefined : "3 3"}
              strokeWidth={isSel || hot ? 4 : 2.5}
              style={{ filter: "drop-shadow(0 1px 2px rgb(15 23 42 / .18))" }}
            />
            <text y={5} textAnchor="middle" className={cn("font-bold tabular-nums", q === "weak" ? "fill-orange-600" : "fill-foreground")} style={{ fontSize: 11 }}>
              {layer === "motion" ? (m == null ? "·" : fmt(m, 1)) : d.rssi ?? "—"}
            </text>
            {!edit && onPower && d.online && d.plugs.length === 1 && (() => {
              const pl = d.plugs[0];
              const pw = !!powerOf?.(pl);
              const label = `${d.name}：${pw ? "開著，點一下關閉" : "關著，點一下打開"}`;
              return (
                <g transform="translate(13 -13)" className="cursor-pointer" role="button" aria-label={label}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => { e.stopPropagation(); onPower(pl); }}>
                  <title>{label}</title>
                  <circle r={13} fill="transparent" />
                  <circle r={8.5} className={pw ? "fill-primary" : "fill-card"} stroke={pw ? "var(--card)" : "var(--muted-foreground)"} strokeWidth={pw ? 2 : 1.5}
                    style={{ filter: "drop-shadow(0 1px 1.5px rgb(15 23 42 / .25))" }} />
                  <path d="M0 -4.2 V-0.6 M-2.9 -2.6 A3.9 3.9 0 1 0 2.9 -2.6" fill="none" strokeWidth={1.6} strokeLinecap="round"
                    stroke={pw ? "var(--primary-foreground)" : "var(--muted-foreground)"} />
                </g>
              );
            })()}
            {(showNames || isSel) && (
              <text x={devLabel[d.key].dx} y={devLabel[d.key].dy} textAnchor={devLabel[d.key].anchor} className="fill-muted-foreground font-medium" style={{ fontSize: 11.5, paintOrder: "stroke", stroke: "var(--card)", strokeWidth: 3, strokeLinejoin: "round" }}>{devName(d)}</text>
            )}
          </g>
        );
      })}
      {edit && sel?.kind === "room" && (() => {
        // 選取的區域：轉角（圓點）和每道牆的中點（短條）可以拖
        const r = rooms.find((x) => x.id === sel.id);
        if (!r) return null;
        const P = roomPts(r);
        return (
          <g>
            {P.map((a, i) => {
              const b = P[(i + 1) % P.length];
              const vert = a[0] === b[0];
              const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
              if (len < 24 * k) return null;
              const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
              const lw = 22 * k, th = 8 * k;
              return (
                <rect key={`e${i}`} x={mx - (vert ? th : lw) / 2} y={my - (vert ? lw : th) / 2} width={vert ? th : lw} height={vert ? lw : th} rx={th / 2}
                  className={cn("fill-card stroke-primary", vert ? "cursor-ew-resize" : "cursor-ns-resize")} strokeWidth={2 * k}
                  onPointerDown={(e) => startDrag(e, { kind: "edge", id: r.id, i })} onDoubleClick={() => splitEdge(r.id, i)}>
                  <title>拖這道牆推、拉；按兩下多兩個轉角（做 L 形）</title>
                </rect>
              );
            })}
            {P.map(([x, y], i) => (
              <circle key={`c${i}`} cx={x} cy={y} r={7 * k} className="cursor-move fill-primary stroke-card" strokeWidth={2.5 * k}
                onPointerDown={(e) => startDrag(e, { kind: "corner", id: r.id, i })} onDoubleClick={() => cutCorner(r.id, i)}>
                <title>拖轉角改形狀、大小；按兩下切掉這個角（變 L 形）</title>
              </circle>
            ))}
          </g>
        );
      })()}
      {edit && tool === "select" && sel?.kind === "wall" && (() => {
        const w = (fp.walls || []).find((x) => x.id === sel.id);
        if (!w) return null;
        return [[w.x1, w.y1], [w.x2, w.y2]].map(([x, y], i) => (
          <circle key={i} cx={x} cy={y} r={7 * k} className="cursor-move fill-primary stroke-card" strokeWidth={2.5 * k}
            onPointerDown={(e) => startDrag(e, { kind: "wallEnd", id: w.id, i })}><title>拖端點改長度</title></circle>
        ));
      })()}
      {edit && tool !== "select" && (
        <rect x={0} y={0} width={W} height={H} fill="transparent" className="cursor-crosshair" onPointerDown={toolDown} />
      )}
    </svg>
    {/* 放大縮小（手機也可以兩指縮放；電腦按住 Ctrl 滾輪） */}
    <div className="absolute right-2 bottom-2 flex flex-col overflow-hidden rounded-lg border bg-background/90 shadow-sm backdrop-blur">
      <button type="button" aria-label="放大地圖" title="放大" onClick={() => zoomTo(zs * 1.5)} className="flex size-9 items-center justify-center text-lg font-semibold hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">＋</button>
      <button type="button" aria-label="縮小地圖" title="縮小" disabled={zs <= 1} onClick={() => zoomTo(zs / 1.5)} className="flex size-9 items-center justify-center border-t text-lg font-semibold hover:bg-muted disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">－</button>
      {zs > 1 && <button type="button" aria-label="看全部" title="看全部" onClick={() => setZoom({ s: 1 })} className="flex h-8 items-center justify-center border-t px-1 text-[11px] hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">全部</button>}
    </div>
    </div>
  );
}

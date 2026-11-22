// 訊號地圖：資料結構和計算（不含畫面）
import type { Plug, Room } from "@/lib/types";

// pts：不是長方形的區域（L 形、凹字形…），每個轉角一個點、牆都是水平或垂直；x、y、w、h 是外框
export type Pt = [number, number];
export interface FpRoom { id: string; name: string; x: number; y: number; w: number; h: number; pts?: Pt[] | null }

// 區域的轉角（長方形就是四個角，順時針）
export const roomPts = (r: FpRoom): Pt[] => (r.pts && r.pts.length >= 4 ? r.pts : [[r.x, r.y], [r.x + r.w, r.y], [r.x + r.w, r.y + r.h], [r.x, r.y + r.h]]);

// 拿掉重複的點、和一直線上中間的點（推平的凹口會自動消失）
export function tidyPts(pts: Pt[]): Pt[] {
  let p = pts.map(([x, y]) => [Math.round(x), Math.round(y)] as Pt);
  for (let changed = true; changed && p.length > 4; ) {
    changed = false;
    for (let i = 0; i < p.length; i++) {
      const a = p[(i + p.length - 1) % p.length], b = p[i], c = p[(i + 1) % p.length];
      if ((a[0] === b[0] && b[0] === c[0]) || (a[1] === b[1] && b[1] === c[1]) || (b[0] === c[0] && b[1] === c[1])) {
        p = p.filter((_, j) => j !== i);
        changed = true;
        break;
      }
    }
  }
  return p;
}

// 依轉角更新外框；剛好是長方形就不存 pts
export function withPts(r: FpRoom, pts: Pt[]): FpRoom {
  const xs = pts.map((q) => q[0]), ys = pts.map((q) => q[1]);
  const x = Math.min(...xs), y = Math.min(...ys);
  const box = { ...r, x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
  return { ...box, pts: pts.length === 4 ? null : pts };
}

// 轉角稍微圓一點的外框路徑（凹進去的角也適用）
export function roomPath(r: FpRoom, rad = 10): string {
  const p = roomPts(r);
  const n = p.length;
  let d = "";
  for (let i = 0; i < n; i++) {
    const a = p[(i + n - 1) % n], b = p[i], c = p[(i + 1) % n];
    const l1 = Math.hypot(b[0] - a[0], b[1] - a[1]), l2 = Math.hypot(c[0] - b[0], c[1] - b[1]);
    const t = Math.min(rad, l1 / 2, l2 / 2);
    const s0: Pt = [b[0] + ((a[0] - b[0]) / (l1 || 1)) * t, b[1] + ((a[1] - b[1]) / (l1 || 1)) * t];
    const s1: Pt = [b[0] + ((c[0] - b[0]) / (l2 || 1)) * t, b[1] + ((c[1] - b[1]) / (l2 || 1)) * t];
    d += `${i ? "L" : "M"}${s0[0]},${s0[1]} Q${b[0]},${b[1]} ${s1[0]},${s1[1]} `;
  }
  return d + "Z";
}

// 最上面那道牆（放名稱、人的名牌）：左端、右端
export function topEdge(r: FpRoom): { y: number; left: number; right: number } {
  const p = roomPts(r);
  let best = { y: Infinity, left: 0, right: 0 };
  for (let i = 0; i < p.length; i++) {
    const a = p[i], b = p[(i + 1) % p.length];
    if (a[1] !== b[1]) continue;
    const left = Math.min(a[0], b[0]), right = Math.max(a[0], b[0]);
    if (a[1] < best.y || (a[1] === best.y && right - left > best.right - best.left)) best = { y: a[1], left, right };
  }
  return best.y === Infinity ? { y: r.y, left: r.x, right: r.x + r.w } : best;
}
// 實牆：一條線段；門：開在某道牆上，t = 門的中心在牆的哪裡（0～1），w = 門寬（地圖單位），flip = 開的方向（0～3：哪一側、鉸鏈在哪頭）
export interface FpWall { id: string; x1: number; y1: number; x2: number; y2: number }
// kind：win 一般窗、fwin 落地窗，沒有就是門
export interface FpDoor { id: string; wall: string; t: number; w: number; flip?: number; kind?: "win" | "fwin" }
export interface FpAp { id: string; name: string; ssid?: string | null; node?: string | null; z?: number | null }
export interface FpItem { x: number; y: number; z?: number | null }
export interface Floorplan {
  w: number;
  h: number;
  meters?: number;
  rooms: FpRoom[] | null;
  walls?: FpWall[];
  doors?: FpDoor[];
  items: Record<string, FpItem>;
  aps: FpAp[];
  auto_nodes?: string[];
  image?: string | null;
}

export interface NetNode { mac: string; model: string; ip?: string; main: boolean }
export interface NetClient { mac: string; name: string; online: boolean; rssi: number | null; ssid: string | null; node: string | null; map: boolean; plug: string | null }
export interface MapSense {
  enabled?: boolean;
  devices?: { key: string; name: string; now: number | null }[];
  net?: { nodes?: NetNode[]; clients?: NetClient[] } | null;
  rooms?: Record<string, { score: number; cover: number; hot: string[] }>;
}

// 動靜回放：每 bucket 秒一格
export interface MapReplay { start: number; bucket: number; n: number; devices: Record<string, (number | null)[]>; rooms: Record<string, (number | null)[]> }

export interface MapDev {
  key: string;
  name: string;
  full: string;
  plugs: Plug[];
  rssi: number | null;
  online: boolean;
  room: string | null;
  ssid: string | null;
  node: string | null;
  router?: boolean;
}

// walls：中間隔了幾道實牆（從門口穿過去的不算）；rooms：線經過的區域名稱（照順序）
export interface MapLink { dev: MapDev; ap: FpAp; x1: number; y1: number; x2: number; y2: number; L: number; band: number; walls: number; rooms: string[]; q: "good" | "ok" | "poor"; guess: boolean }

// 高度（公尺）
export const DEV_Z = 0.3;
export const AP_Z = 1.0;
export const BAND: [number, number] = [0.8, 1.6]; // 人的腰到胸
export const DEV_HEIGHTS: [number, string][] = [[0.3, "牆上的插座孔"], [0.75, "桌上"], [1.2, "櫃子上"], [1.8, "高處"]];
export const AP_HEIGHTS: [number, string][] = [[0.3, "地上"], [0.75, "桌上"], [1, "矮櫃上"], [1.8, "高櫃上"], [2.5, "天花板"]];

export const sigQ = (v: number) => (v >= -55 ? "good" : v >= -70 ? "mid" : "weak");

// 名字太長就截短：中文字算 1、英數算 0.55
export function shortName(name: string, max: number) {
  let w = 0;
  let out = "";
  for (const ch of name) {
    w += ch.codePointAt(0)! <= 0x24f ? 0.55 : 1;
    if (w > max) return `${out.trimEnd()}…`;
    out += ch;
  }
  return out;
}

// 每台插座一個標記（排插算一台）；加上從路由器加到地圖的裝置（電視、電腦…）
export function mapDevices(plugs: Plug[], sense: MapSense | null): MapDev[] {
  const devs = new Map<string, MapDev>();
  for (const p of plugs) {
    const key = p.device || p.id;
    if (!devs.has(key)) devs.set(key, { key, plugs: [], rssi: p.rssi ?? null, online: p.online, room: p.room, name: "", full: "", ssid: null, node: null });
    const d = devs.get(key)!;
    d.plugs.push(p);
    d.online = d.online || p.online;
  }
  const net = sense?.net;
  const cl = Object.fromEntries((net?.clients || []).map((c) => [c.mac, c]));
  for (const d of devs.values()) {
    d.name = d.plugs.length > 1 ? `${d.plugs[0].name} +${d.plugs.length - 1}` : d.plugs[0].name;
    d.full = d.plugs.map((p) => p.name).join("、");
    d.ssid = d.plugs.find((p) => p.net?.ssid)?.net?.ssid || null;
    d.node = cl[d.key]?.online ? cl[d.key].node : null;
  }
  for (const c of net?.clients || []) {
    if (!c.map || c.plug || devs.has(c.mac)) continue;
    devs.set(c.mac, { key: c.mac, plugs: [], name: c.name, full: c.name, rssi: c.online ? c.rssi : null, online: c.online, room: null, ssid: c.ssid, node: c.online ? c.node : null, router: true });
  }
  return [...devs.values()];
}

// 用家庭中控的區域排出草圖，裝置放進各自的區域（reset：裝置也重新放，基地台保留）
export function autoLayout(fp: Floorplan, homeRooms: Room[], devs: MapDev[], reset: boolean): Floorplan {
  const rooms = homeRooms.length ? homeRooms : [{ id: "all", name: "家" }];
  const cols = rooms.length > 4 ? 3 : 2;
  const rowsN = Math.ceil(rooms.length / cols);
  const pad = 16;
  const cw = (fp.w - pad * (cols + 1)) / cols;
  const ch = (fp.h - pad * (rowsN + 1)) / rowsN;
  const out: Floorplan = {
    ...fp,
    rooms: rooms.map((r, i) => ({ id: r.id, name: r.name, x: pad + (i % cols) * (cw + pad), y: pad + Math.floor(i / cols) * (ch + pad), w: cw, h: ch })),
    items: reset ? Object.fromEntries(Object.entries(fp.items).filter(([k]) => k.startsWith("ap:"))) : { ...fp.items },
  };
  for (const room of out.rooms!) {
    const inRoom = devs.filter((d) => (d.room || "") === room.id || room.id === "all");
    inRoom.forEach((d, i) => {
      if (out.items[d.key]) return;
      const n = inRoom.length;
      const c = Math.ceil(Math.sqrt(n));
      const r = Math.ceil(n / c);
      out.items[d.key] = { x: room.x + ((i % c) + 0.5) * (room.w / c), y: room.y + 30 + (Math.floor(i / c) + 0.5) * ((room.h - 30) / r) };
    });
  }
  return out;
}

// 從路由器讀到的每一台（主路由器、節點）自動放上地圖；回傳 null 表示不用改
export function autoAps(fp: Floorplan, nodes: NetNode[], devs: MapDev[]): Floorplan | null {
  if (!fp.rooms || !nodes.length) return null;
  const done = new Set([...(fp.auto_nodes || []), ...fp.aps.map((a) => a.node).filter(Boolean) as string[]]);
  const todo = nodes.filter((n) => !done.has(n.mac));
  if (!todo.length) return null;
  const out: Floorplan = { ...fp, aps: fp.aps.map((a) => ({ ...a })), items: { ...fp.items } };
  // 已經自己擺了、還沒指定是哪一台的基地台：依序對上（主路由器先），不另外加
  const free = out.aps.filter((a) => !a.node && out.items[`ap:${a.id}`]);
  todo.sort((a, b) => Number(b.main) - Number(a.main));
  todo.forEach((n, i) => {
    const own = free.shift();
    if (own) {
      own.node = n.mac;
      if (/^Wi-Fi 基地台 \d+$/.test(own.name)) own.name = n.model;
      return;
    }
    const near = devs.filter((d) => d.node === n.mac && out.items[d.key]).map((d) => out.items[d.key]);
    const x = near.length ? near.reduce((t, it) => t + it.x, 0) / near.length : out.w * (0.3 + 0.4 * i);
    const y = near.length ? near.reduce((t, it) => t + it.y, 0) / near.length : out.h * 0.15;
    const id = `n${n.mac.replace(/:/g, "").slice(-6).toLowerCase()}`;
    out.aps.push({ id, name: n.model, node: n.mac, z: AP_Z });
    out.items[`ap:${id}`] = { x, y };
  });
  out.auto_nodes = [...done, ...todo.map((n) => n.mac)];
  return out;
}

// 每台裝置到它連的 Wi-Fi 基地台的連線：路徑有多長經過人的腰到胸（0.8～1.6 公尺），越長越適合偵測走動
export function mapLinks(fp: Floorplan, devs: MapDev[]): MapLink[] {
  const mpp = (fp.meters || 12) / fp.w;
  const aps = fp.aps.filter((a) => (a.ssid || a.node) && fp.items[`ap:${a.id}`]);
  const links: MapLink[] = [];
  for (const d of devs) {
    const it = fp.items[d.key];
    if (!it || (!d.ssid && !d.node)) continue;
    let cands = d.node ? aps.filter((a) => a.node === d.node) : [];
    if (!cands.length && d.ssid) cands = aps.filter((a) => !a.node && a.ssid === d.ssid);
    if (!cands.length) continue;
    const dist = (a: FpAp) => Math.hypot(fp.items[`ap:${a.id}`].x - it.x, fp.items[`ap:${a.id}`].y - it.y);
    const ap = cands.reduce((b, a) => (dist(a) < dist(b) ? a : b));
    const at = fp.items[`ap:${ap.id}`];
    const L = dist(ap) * mpp;
    const zp = it.z ?? DEV_Z;
    const za = ap.z ?? AP_Z;
    let f: number;
    if (Math.abs(za - zp) < 0.01) f = zp >= BAND[0] && zp <= BAND[1] ? 1 : 0;
    else {
      const t1 = (BAND[0] - zp) / (za - zp);
      const t2 = (BAND[1] - zp) / (za - zp);
      f = Math.max(0, Math.min(1, Math.max(t1, t2)) - Math.max(0, Math.min(t1, t2)));
    }
    const band = f * L;
    const walls = wallsCrossed(fp, it.x, it.y, at.x, at.y);
    // 每穿過兩道牆降一級：訊號被牆吃掉，人走過去的跳動比較不明顯，而且分不出是哪一間
    const lv = Math.max(0, (band >= 2 ? 2 : band >= 0.8 ? 1 : 0) - Math.floor(walls / 2));
    links.push({
      dev: d, ap, x1: it.x, y1: it.y, x2: at.x, y2: at.y, L, band, walls, rooms: roomsAlong(fp, it.x, it.y, at.x, at.y),
      q: (["poor", "ok", "good"] as const)[lv], guess: cands.length > 1,
    });
  }
  return links;
}

// 存到伺服器的內容（座標取整數）
export function fpPayload(fp: Floorplan) {
  const R = Math.round;
  return {
    w: fp.w,
    h: fp.h,
    meters: fp.meters || 12,
    rooms: (fp.rooms || []).map((r) => ({ ...r, x: R(r.x), y: R(r.y), w: R(r.w), h: R(r.h), pts: r.pts ? r.pts.map(([x, y]) => [R(x), R(y)]) : null })),
    items: Object.fromEntries(Object.entries(fp.items).map(([k, v]) => [k, { x: R(v.x), y: R(v.y), z: v.z ?? null }])),
    walls: (fp.walls || []).map((x) => ({ ...x, x1: R(x.x1), y1: R(x.y1), x2: R(x.x2), y2: R(x.y2) })),
    doors: (fp.doors || []).map((x) => ({ ...x, kind: x.kind || undefined, t: Math.round(x.t * 1000) / 1000, w: R(x.w), flip: x.flip || 0 })),
    aps: fp.aps,
    auto_nodes: fp.auto_nodes || [],
  };
}

// 門在畫面上的位置：開口兩端、鉸鏈、門板打開的那一端（畫門板和弧線用）
export function doorGeom(wall: FpWall, door: FpDoor) {
  const L = Math.hypot(wall.x2 - wall.x1, wall.y2 - wall.y1) || 1;
  const ux = (wall.x2 - wall.x1) / L, uy = (wall.y2 - wall.y1) / L;
  const half = Math.min(door.w, L) / 2;
  const c = Math.max(half, Math.min(L - half, door.t * L));
  const a: Pt = [wall.x1 + ux * (c - half), wall.y1 + uy * (c - half)];
  const b: Pt = [wall.x1 + ux * (c + half), wall.y1 + uy * (c + half)];
  const f = door.flip || 0;
  const side = f & 1 ? -1 : 1;
  const [hinge, shut] = f & 2 ? [b, a] : [a, b];
  const w = half * 2;
  const open: Pt = [hinge[0] - uy * side * w, hinge[1] + ux * side * w];
  const cross = (open[0] - hinge[0]) * (shut[1] - hinge[1]) - (open[1] - hinge[1]) * (shut[0] - hinge[0]);
  return { a, b, hinge, open, shut, w, sweep: cross > 0 ? 1 : 0 };
}

// 點到線段最近的地方：t（0～1）和距離
export function nearSeg(x: number, y: number, w: FpWall) {
  const dx = w.x2 - w.x1, dy = w.y2 - w.y1;
  const L2 = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((x - w.x1) * dx + (y - w.y1) * dy) / L2));
  return { t, d: Math.hypot(x - (w.x1 + dx * t), y - (w.y1 + dy * t)) };
}

// 線段 p1-p2 和 p3-p4 交叉的話，回傳交點在兩條線上的位置（0～1）
function segHit(x1: number, y1: number, x2: number, y2: number, x3: number, y3: number, x4: number, y4: number) {
  const d = (x2 - x1) * (y4 - y3) - (y2 - y1) * (x4 - x3);
  if (Math.abs(d) < 1e-9) return null;
  const s = ((x3 - x1) * (y4 - y3) - (y3 - y1) * (x4 - x3)) / d;
  const u = ((x3 - x1) * (y2 - y1) - (y3 - y1) * (x2 - x1)) / d;
  return s > 0 && s < 1 && u >= 0 && u <= 1 ? { s, u } : null;
}

// 兩點之間隔了幾道實牆；剛好從門口或窗戶穿過去的不算
export function wallsCrossed(fp: Floorplan, x1: number, y1: number, x2: number, y2: number): number {
  let n = 0;
  for (const w of fp.walls || []) {
    const hit = segHit(x1, y1, x2, y2, w.x1, w.y1, w.x2, w.y2);
    if (!hit) continue;
    const L = Math.hypot(w.x2 - w.x1, w.y2 - w.y1) || 1;
    const at = hit.u * L;
    const open = (fp.doors || []).some((dr) => {
      if (dr.wall !== w.id) return false;
      const half = Math.min(dr.w, L) / 2;
      const c = Math.max(half, Math.min(L - half, dr.t * L));
      return at >= c - half && at <= c + half;
    });
    if (!open) n++;
  }
  return n;
}

// 點在不在區域裡（區域可以是 L 形）
export function inRoom(r: FpRoom, x: number, y: number): boolean {
  if (x < r.x || x > r.x + r.w || y < r.y || y > r.y + r.h) return false;
  const p = roomPts(r);
  let inside = false;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    const [xi, yi] = p[i], [xj, yj] = p[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// 線經過哪些區域（從起點到終點的順序）
export function roomsAlong(fp: Floorplan, x1: number, y1: number, x2: number, y2: number): string[] {
  const out: string[] = [];
  const steps = Math.max(2, Math.ceil(Math.hypot(x2 - x1, y2 - y1) / 8));
  for (let i = 0; i <= steps; i++) {
    const x = x1 + ((x2 - x1) * i) / steps, y = y1 + ((y2 - y1) * i) / steps;
    const r = (fp.rooms || []).find((q) => inRoom(q, x, y));
    if (r && !out.includes(r.name)) out.push(r.name);
  }
  return out;
}

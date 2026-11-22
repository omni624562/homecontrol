// 預估 Wi-Fi 覆蓋：用插座實際量到的訊號校正一個簡單的模型，再推算家裡每個角落
//   訊號（dBm）= P0（每台基地台）− 10 × n × log10(距離公尺) − 每道牆 W dB
// n、W 用試的（找誤差最小的一組），P0 是每台基地台自己的平均。高度不算。
import { inRoom, wallsCrossed, type Floorplan, type FpRoom, type MapLink } from "@/lib/map-model";

// res：每台裝置實際量到的比模型預估好（正）或差（負）多少 dB，用來修正它附近的預估
export interface SigModel { p0: Record<string, number>; n: number; wall: number; rmse: number | null; samples: number; fitted: boolean; res: { x: number; y: number; r: number }[] }
export interface CoverCell { x: number; y: number; v: number; ap: string; room: string }

const DEF = { n: 2.5, wall: 5, p0: -32 };
const mOf = (fp: Floorplan) => (fp.meters || 12) / fp.w;
const apPos = (fp: Floorplan, id: string) => fp.items[`ap:${id}`];
const pathLoss = (n: number, dM: number) => 10 * n * Math.log10(Math.max(0.5, dM));

export function fitModel(fp: Floorplan, links: MapLink[]): SigModel | null {
  const aps = fp.aps.filter((a) => apPos(fp, a.id));
  if (!aps.length) return null;
  const pts = links
    .filter((l) => l.dev.online && l.dev.rssi != null && l.dev.rssi < 0)
    .map((l) => ({ ap: l.ap.id, d: l.L, walls: wallsCrossed(fp, l.x1, l.y1, l.x2, l.y2), rssi: l.dev.rssi!, x: l.x1, y: l.y1 }));
  if (pts.length < 3) return { p0: Object.fromEntries(aps.map((a) => [a.id, DEF.p0])), n: DEF.n, wall: DEF.wall, rmse: null, samples: pts.length, fitted: false, res: [] };
  let best: SigModel | null = null;
  let bestErr = Infinity;
  // 範圍限制在室內常見的物理值：資料少、又都很近的時候，才不會算出「牆不擋訊號」這種往外推會太樂觀的結果
  for (let n = 2; n <= 3.61; n += 0.2) {
    for (let wall = 2; wall <= 10; wall += 1) {
      const sum: Record<string, [number, number]> = {};
      for (const p of pts) {
        const s = (sum[p.ap] ||= [0, 0]);
        s[0] += p.rssi + pathLoss(n, p.d) + wall * p.walls;
        s[1]++;
      }
      const p0: Record<string, number> = {};
      for (const [k, [t, c]] of Object.entries(sum)) p0[k] = t / c;
      let err = 0;
      for (const p of pts) err += (p.rssi - (p0[p.ap] - pathLoss(n, p.d) - wall * p.walls)) ** 2;
      // 稍微偏好常見的值（n 2.5、牆 5 dB），資料少的時候不會跑到奇怪的極端
      const score = err + pts.length * 0.15 * ((n - 2.5) ** 2 * 4 + ((wall - 5) / 5) ** 2);
      if (score < bestErr) {
        bestErr = score;
        best = { p0, n: Math.round(n * 10) / 10, wall, rmse: Math.sqrt(err / pts.length), samples: pts.length, fitted: true, res: [] };
      }
    }
  }
  // 沒有裝置連的基地台：用其他台的平均
  const vals = Object.values(best!.p0);
  const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
  for (const a of aps) if (best!.p0[a.id] == null) best!.p0[a.id] = avg;
  const b = best!;
  b.res = pts.map((p) => ({ x: p.x, y: p.y, r: p.rssi - (b.p0[p.ap] - pathLoss(b.n, p.d) - b.wall * p.walls) }));
  return b;
}

// 實測修正：附近（約 1.5 公尺內）裝置的實測差距，越近影響越大；隔一道牆影響剩三成多，離裝置遠的地方回到模型
const corrCache = new WeakMap<SigModel, Map<string, number>>();
function correction(fp: Floorplan, m: SigModel, x: number, y: number): number {
  if (!m.res.length) return 0;
  let cache = corrCache.get(m);
  if (!cache) corrCache.set(m, (cache = new Map()));
  const key = `${Math.round(x)},${Math.round(y)}`;
  const hit = cache.get(key);
  if (hit != null) return hit;
  const mpp = mOf(fp);
  let num = 0, den = 0.4;
  for (const p of m.res) {
    const d = Math.hypot(p.x - x, p.y - y) * mpp;
    if (d > 4) continue;
    const w = Math.exp(-((d / 1.5) ** 2)) * 0.35 ** wallsCrossed(fp, x, y, p.x, p.y);
    num += w * p.r;
    den += w;
  }
  const v = num / den;
  cache.set(key, v);
  return v;
}

export function predictAt(fp: Floorplan, m: SigModel, apId: string, x: number, y: number, at?: { x: number; y: number }): number {
  const p = at || apPos(fp, apId);
  const d = Math.hypot(p.x - x, p.y - y) * mOf(fp);
  return m.p0[apId] - pathLoss(m.n, d) - m.wall * wallsCrossed(fp, x, y, p.x, p.y);
}

// 區域裡的格子點（step 地圖單位一格）
export function roomCells(fp: Floorplan, step: number): { x: number; y: number; room: FpRoom }[] {
  const out: { x: number; y: number; room: FpRoom }[] = [];
  for (let y = step / 2; y < fp.h; y += step) {
    for (let x = step / 2; x < fp.w; x += step) {
      const room = (fp.rooms || []).find((r) => inRoom(r, x, y));
      if (room) out.push({ x, y, room });
    }
  }
  return out;
}

// 每格收到最強的那台基地台的訊號；override：假設某台基地台搬到別的地方
export function coverage(fp: Floorplan, m: SigModel, step: number, override?: { ap: string; x: number; y: number }): CoverCell[] {
  const aps = fp.aps.filter((a) => apPos(fp, a.id) && m.p0[a.id] != null);
  return roomCells(fp, step).map(({ x, y, room }) => {
    let v = -Infinity, ap = "";
    for (const a of aps) {
      const at = override && override.ap === a.id ? override : undefined;
      const s = predictAt(fp, m, a.id, x, y, at);
      if (s > v) { v = s; ap = a.id; }
    }
    return { x, y, v: v + correction(fp, m, x, y), ap, room: room.id };
  });
}

// 最弱的 10% 地方的訊號（越高越好）
export const low10 = (cells: CoverCell[]) => {
  if (!cells.length) return -100;
  const v = cells.map((c) => c.v).sort((a, b) => a - b);
  return v[Math.floor(v.length * 0.1)];
};

export interface ApSuggest { ap: string; x: number; y: number; room: string; now: number; then: number; moveM: number }

// 這台基地台搬到哪裡，整個家最弱的 10% 改善最多（只試區域裡的點）
export function bestApSpot(fp: Floorplan, m: SigModel, apId: string): ApSuggest | null {
  const cur = apPos(fp, apId);
  if (!cur) return null;
  const step = Math.max(30, fp.w / 30);
  const now = low10(coverage(fp, m, step));
  let best: { x: number; y: number; room: string; v: number } | null = null;
  for (const c of roomCells(fp, step * 1.5)) {
    const v = low10(coverage(fp, m, step, { ap: apId, x: c.x, y: c.y }));
    if (!best || v > best.v + 0.01) best = { x: c.x, y: c.y, room: c.room.name, v };
  }
  if (!best) return null;
  return { ap: apId, x: best.x, y: best.y, room: best.room, now, then: best.v, moveM: Math.hypot(best.x - cur.x, best.y - cur.y) * mOf(fp) };
}

export interface GapSpot { room: string; roomName: string; x: number; y: number; ap: string; rssi: number }

// 偵測死角：沒有訊號線經過（或只擦過）的房間，建議在哪裡加一個插座
// 挑房間裡靠牆的點：到訊號最好的基地台那條線在這間走最長，而且訊號要夠（-75 以上）
export function gapSpots(fp: Floorplan, m: SigModel, covered: Record<string, { cover: number }>): GapSpot[] {
  const out: GapSpot[] = [];
  const aps = fp.aps.filter((a) => apPos(fp, a.id) && m.p0[a.id] != null);
  if (!aps.length) return out;
  const step = Math.max(20, fp.w / 60);
  for (const r of fp.rooms || []) {
    if ((covered[r.id]?.cover ?? 0) >= 0.3) continue;
    let best: (GapSpot & { score: number }) | null = null;
    const inset = Math.min(30, r.w / 4, r.h / 4);
    const cand: [number, number][] = [];
    for (let x = r.x + inset; x <= r.x + r.w - inset; x += step) cand.push([x, r.y + inset], [x, r.y + r.h - inset]);
    for (let y = r.y + inset; y <= r.y + r.h - inset; y += step) cand.push([r.x + inset, y], [r.x + r.w - inset, y]);
    for (const [x, y] of cand) {
      if (!inRoom(r, x, y)) continue;
      let ap = "", v = -Infinity;
      for (const a of aps) {
        const s = predictAt(fp, m, a.id, x, y);
        if (s > v) { v = s; ap = a.id; }
      }
      const at = apPos(fp, ap);
      // 線在這間走了多長
      let inside = 0;
      const n = 40;
      for (let i = 0; i < n; i++) {
        const t = (i + 0.5) / n;
        if (inRoom(r, x + (at.x - x) * t, y + (at.y - y) * t)) inside++;
      }
      const score = (inside / n) * Math.hypot(at.x - x, at.y - y) - (v < -75 ? (-75 - v) * 20 : 0);
      if (!best || score > best.score) best = { room: r.id, roomName: r.name, x, y, ap, rssi: v, score };
    }
    if (best) out.push({ room: best.room, roomName: best.roomName, x: best.x, y: best.y, ap: best.ap, rssi: best.rssi });
  }
  return out;
}

export const covQ = (v: number) => (v >= -55 ? 0 : v >= -65 ? 1 : v >= -72 ? 2 : 3);
export const COV_TEXT = ["很強", "好", "普通", "弱"];

// 連續的顏色：深藍（很強）→ 淡藍 → 黃 → 橘（弱）；回傳 [r, g, b, 透明度]
const STOPS: [number, number, number, number, number][] = [
  [-45, 37, 99, 235, 0.5], [-56, 96, 165, 250, 0.28], [-63, 191, 219, 254, 0.18], [-68, 251, 191, 36, 0.38], [-76, 249, 115, 22, 0.6],
];
export function covColor(v: number): string {
  if (v >= STOPS[0][0]) return `rgba(${STOPS[0].slice(1, 4).join(",")},${STOPS[0][4]})`;
  for (let i = 1; i < STOPS.length; i++) {
    const [v1, ...a] = STOPS[i - 1], [v2, ...b] = STOPS[i];
    if (v >= v2) {
      const t = (v1 - v) / (v1 - v2);
      const c = a.map((x, j) => x + (b[j] - x) * t);
      return `rgba(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])},${c[3].toFixed(2)})`;
    }
  }
  const z = STOPS[STOPS.length - 1];
  return `rgba(${z.slice(1, 4).join(",")},${z[4]})`;
}

export interface FarAp { key: string; name: string; ap: string; alt: string; rssi: number; est: number }

// 連到比較遠的基地台：旁邊另一台預估好很多（至少 minGain dB），而且現在訊號不算好（-60 以下）
// 預估也算進一點這台裝置自己的實測偏差（例如放在櫃子裡，連哪台都會差一點）；只算三成，
// 因為偏差多半是「到現在這台的路上」模型沒算準（例如牆比較厚），換一台基地台就不一定有
export function farApHints(fp: Floorplan, m: SigModel, links: MapLink[], minGain = 8): FarAp[] {
  const aps = fp.aps.filter((a) => apPos(fp, a.id) && m.p0[a.id] != null);
  const out: FarAp[] = [];
  for (const l of links) {
    const rssi = l.dev.rssi;
    if (l.guess || !l.dev.online || rssi == null || rssi >= 0 || rssi > -60 || m.p0[l.ap.id] == null) continue;
    const bias = 0.3 * Math.max(-10, Math.min(10, rssi - predictAt(fp, m, l.ap.id, l.x1, l.y1)));
    let best: { id: string; v: number } | null = null;
    for (const a of aps) {
      if (a.id === l.ap.id) continue;
      const v = predictAt(fp, m, a.id, l.x1, l.y1) + bias;
      if (!best || v > best.v) best = { id: a.id, v };
    }
    if (best && best.v - rssi >= minGain) out.push({ key: l.dev.key, name: l.dev.full, ap: l.ap.id, alt: best.id, rssi, est: Math.round(Math.min(-35, best.v)) });
  }
  return out.sort((a, b) => b.est - b.rssi - (a.est - a.rssi));
}

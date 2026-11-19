// 訊號地圖：資料結構和計算（不含畫面）
import type { Plug, Room } from "@/lib/types";

export interface FpRoom { id: string; name: string; x: number; y: number; w: number; h: number }
export interface FpAp { id: string; name: string; ssid?: string | null; node?: string | null; z?: number | null }
export interface FpItem { x: number; y: number; z?: number | null }
export interface Floorplan {
  w: number;
  h: number;
  meters?: number;
  rooms: FpRoom[] | null;
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
}

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

export interface MapLink { dev: MapDev; ap: FpAp; x1: number; y1: number; x2: number; y2: number; L: number; band: number; q: "good" | "ok" | "poor"; guess: boolean }

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

// 用家庭中控的房間排出草圖，裝置放進各自的房間（reset：裝置也重新放，基地台保留）
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
    links.push({ dev: d, ap, x1: it.x, y1: it.y, x2: at.x, y2: at.y, L, band, q: band >= 2 ? "good" : band >= 0.8 ? "ok" : "poor", guess: cands.length > 1 });
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
    rooms: (fp.rooms || []).map((r) => ({ ...r, x: R(r.x), y: R(r.y), w: R(r.w), h: R(r.h) })),
    items: Object.fromEntries(Object.entries(fp.items).map(([k, v]) => [k, { x: R(v.x), y: R(v.y), z: v.z ?? null }])),
    aps: fp.aps,
    auto_nodes: fp.auto_nodes || [],
  };
}

// 路由器讀到的網路裝置
import { Cctv, HardDrive, HelpCircle, Laptop, Printer, Smartphone, Speaker, Tablet, Tv, Watch, Wifi, type LucideIcon } from "lucide-react";
import { fmt, pad2 } from "@/lib/format";

export interface NetClient {
  mac: string;
  name: string;
  router_name: string | null;
  label: string | null;
  vendor: string | null;
  guess: string | null; // 樹莓派在家裡網路直接問出來的（例如「Foscam 攝影機」）
  guess_kind: string | null;
  ip: string | null;
  node: string | null;
  band: string | null;
  ssid: string | null;
  rssi: number | null;
  wired: boolean;
  online: boolean;
  seen: number | null;
  first: number | null;
  map: boolean;
  trusted?: boolean;
  person: string | null;
  plug: string | null;
  today_bytes: number | null;
  // 同一台的有線、無線合成一筆時，每個 MAC 的連線（main = 這一筆的 MAC）
  links?: { mac: string; wired: boolean; band: string | null; ip: string | null; online: boolean; seen: number | null; main: boolean }[];
}

export interface NetData {
  configured: boolean;
  ok: boolean;
  error: string | null;
  now: number;
  nodes: { mac: string; model: string; ip: string; main: boolean }[];
  clients: NetClient[];
}

export type Kind = "phone" | "tablet" | "watch" | "computer" | "tv" | "speaker" | "camera" | "nas" | "printer" | "network" | "other";
export const KIND: Record<Kind, { icon: LucideIcon; label: string }> = {
  phone: { icon: Smartphone, label: "手機" },
  tablet: { icon: Tablet, label: "平板" },
  watch: { icon: Watch, label: "手錶" },
  computer: { icon: Laptop, label: "電腦" },
  tv: { icon: Tv, label: "電視" },
  speaker: { icon: Speaker, label: "音箱" },
  camera: { icon: Cctv, label: "攝影機" },
  nas: { icon: HardDrive, label: "NAS" },
  printer: { icon: Printer, label: "印表機" },
  network: { icon: Wifi, label: "網路設備" },
  other: { icon: HelpCircle, label: "不明裝置" },
};

export function devKind(c: Pick<NetClient, "label" | "name" | "router_name" | "vendor"> & { guess_kind?: string | null }): Kind {
  if (c.guess_kind && c.guess_kind in KIND) return c.guess_kind as Kind;
  const t = `${c.label || ""} ${c.name || ""} ${c.router_name || ""} ${c.vendor || ""}`.toLowerCase();
  if (/watch/.test(t)) return "watch";
  if (/\btab\b|tab-|ipad|pad\b/.test(t)) return "tablet";
  if (/iphone|pixel|galaxy|phone|redmi|xiaomi|oppo|vivo|huawei|sm-[a-z]/.test(t)) return "phone";
  if (/msft|windows|laptop|desktop|macbook|imac|hyperv|ubuntu|\bpc\b|raspberry/.test(t)) return "computer";
  if (/\btv\b|nvidia|shield|chromecast|roku|bravia|apple tv/.test(t)) return "tv";
  if (/google|nest|echo|alexa|homepod|speaker/.test(t)) return "speaker";
  if (/\basus\b|rt-[a-z]{2}\d|router|tp-link deco|mesh|zyxel|synology|qnap|netgear/.test(t)) return "network";
  if (/android|dhcpcd/.test(t)) return "phone";
  return "other";
}

// 路由器給的名字看不懂（MAC、android-dhcp-12、MSFT 5.0…）
export const isRawName = (n?: string | null) => !n || /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/i.test(n) || /^(android-dhcp|dhcpcd|msft|espressif|unknown)/i.test(n);
export const netName = (c: Pick<NetClient, "label" | "name">) => c.label || c.name;
export const fmtBytes = (b: number) => (b >= 1e9 ? `${fmt(b / 1e9, 1)} GB` : b >= 1e6 ? `${fmt(b / 1e6, 0)} MB` : `${fmt(Math.max(1, b / 1e3), 0)} KB`);

// 「5G・castle・-57 dBm」
export function netWhere(c: NetClient) {
  const hidden = (x?: string | null) => !x || /^[0-9A-F]{32}$/.test(x);
  const parts: string[] = [];
  if (c.wired) parts.push("有線");
  else if (c.band) parts.push(`${c.band}${hidden(c.ssid) ? "" : `・${c.ssid}`}`);
  if (!c.wired && c.rssi != null && c.online) parts.push(`${c.rssi} dBm`);
  return parts.join("・");
}

// 今天的只顯示時間，其他天加日期
export function netAgo(t: number | null | undefined, now: number) {
  if (!t) return "";
  const d = new Date(t * 1000);
  const same = d.toDateString() === new Date(now * 1000).toDateString();
  return `${same ? "" : `${d.getMonth() + 1}/${d.getDate()} `}${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

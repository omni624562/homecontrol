// 數字、時間的顯示

export const fmt = (v: number | null | undefined, digits = 0) =>
  v === null || v === undefined ? "—" : Number(v).toLocaleString("zh-TW", { minimumFractionDigits: digits, maximumFractionDigits: digits });

export const fmtWatts = (w: number | null | undefined) =>
  w === null || w === undefined ? "—" : w >= 1000 ? `${fmt(w / 1000, 2)} kW` : `${fmt(w, w < 10 ? 1 : 0)} W`;

// 精確的時間長度：600 →「10 分鐘」、90 →「1 分 30 秒」
export function fmtSec(sec: number) {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h) return m ? `${h} 小時 ${m} 分` : `${h} 小時`;
  if (m) return s ? `${m} 分 ${s} 秒` : `${m} 分鐘`;
  return `${s} 秒`;
}

// 大概的時間長度：「3 天 1 小時」「2 小時 10 分」「25 分鐘」
export function fmtDur(sec: number) {
  sec = Math.max(0, sec);
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d) return h ? `${d} 天 ${h} 小時` : `${d} 天`;
  if (h) return m ? `${h} 小時 ${m} 分` : `${h} 小時`;
  return `${Math.max(1, m)} 分鐘`;
}

// 倒數：10 分鐘內顯示到秒
export const fmtLeft = (sec: number) => (sec < 600 ? fmtSec(sec) : fmtDur(sec));

export const pad2 = (n: number) => String(n).padStart(2, "0");
export const hhmm = (d: Date) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
export const WEEK = "日一二三四五六";

// 今天／明天／週幾
export function dayLabel(iso: string) {
  const d = new Date(`${iso}T12:00`);
  const today = new Date(new Date().toDateString());
  const i = Math.floor((d.getTime() - today.getTime()) / 864e5);
  return i === 0 ? "今天" : i === 1 ? "明天" : `週${WEEK[d.getDay()]}`;
}

// 分鐘數：「45 分鐘」「3 小時 20 分」
export const fmtMin = (m: number) => (m < 60 ? `${Math.round(m)} 分鐘` : `${Math.floor(m / 60)} 小時${Math.round(m % 60) ? ` ${Math.round(m % 60)} 分` : ""}`);

// 公車預估到站：秒 → 「進站中」「4 分」；負的是狀態
export function busEta(sec: number | null): string {
  if (sec == null) return "—";
  if (sec >= 0) return sec < 60 ? "進站中" : `${Math.round(sec / 60)} 分`;
  return ({ "-1": "未發車", "-2": "不停靠", "-3": "末班已過", "-4": "今日未營運" } as Record<string, string>)[String(sec)] || "—";
}

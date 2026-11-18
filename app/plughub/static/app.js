// 插座 App：手機、平板、電腦共用的網頁介面。
//
// 設計原則：看得到的就是全部 —— 開關就是開關、按一次就執行（按錯可以「復原」）。
// 改名、換房間、調順序都在「編輯」裡：拖拉右邊的 ⠿ 把手（插座可以拖到別的房間）。
//
// 版面：手機一欄 + 下方分頁列；平板兩欄 + 下方分頁列；電腦左側選單 + 兩到三欄。
// 狀態：先拿 /api/state，之後伺服器有變動就從 /api/events 推過來。

import { ICONS } from "./icons.js";

// 提示條只用在「畫面上看不到結果」或「需要注意」的時候；直接看得到的操作不跳提示
const TOAST_MS = 2500;
const TOAST_UNDO_MS = 4000;
const DAYS = ["一", "二", "三", "四", "五", "六", "日"]; // 0 = 星期一（跟伺服器一樣）
const TIMER_OPTIONS = [300, 600, 1800, 3600, 7200]; // 秒
const SHORT_OPTIONS = [30, 60, 120, 180, 300, 600, 900, 1800, 3600]; // 有最長時間（澆水）用的
const WATT_PRESETS = [
  ["燈", 10],
  ["風扇", 40],
  ["電腦", 60],
  ["電視", 100],
  ["電暖器", 1000],
];
const SCENE_ICONS = ["mdi:logout", "mdi:home", "mdi:weather-night", "mdi:white-balance-sunny", "mdi:television", "mdi:lightbulb", "mdi:star-outline"];
const TABS = [
  ["plugs", "首頁", "mdi:home"],
  ["schedule", "排程", "mdi:clock-outline"],
  ["energy", "用電", "mdi:chart-bar"],
  ["settings", "設定", "mdi:cog-outline"],
];
const NO_ROOM = "";

// ───────────── 小工具 ─────────────

// 只更新有變的地方（不整個重畫）：畫面不會閃、捲動位置／滑鼠停留／打開的選單都不受影響
function morph(el, html) {
  const tpl = document.createElement("template");
  tpl.innerHTML = html;
  morphChildren(el, tpl.content);
}

const nodeKey = (n) => (n.nodeType === 1 ? `${n.nodeName}|${n.getAttribute("data-id") ?? n.getAttribute("data-v") ?? ""}|${n.getAttribute("data-a") ?? n.getAttribute("data-c") ?? ""}` : n.nodeType);

function morphChildren(from, to) {
  const a = [...from.childNodes];
  const b = [...to.childNodes];
  b.forEach((y, i) => {
    const x = a[i];
    if (!x) from.appendChild(y);
    else if (nodeKey(x) !== nodeKey(y)) from.replaceChild(y, x);
    else morphNode(x, y);
  });
  for (let i = b.length; i < a.length; i++) a[i].remove();
}

function morphNode(x, y) {
  if (x.nodeType !== 1) {
    if (x.nodeValue !== y.nodeValue) x.nodeValue = y.nodeValue;
    return;
  }
  for (const { name, value } of [...y.attributes]) if (x.getAttribute(name) !== value) x.setAttribute(name, value);
  for (const { name } of [...x.attributes]) if (!y.hasAttribute(name)) x.removeAttribute(name);
  const focused = x === x.getRootNode().activeElement;
  if (x.tagName === "INPUT") {
    const want = y.getAttribute("value") ?? "";
    if (!focused && x.value !== want) x.value = want;
    return;
  }
  if (x.tagName === "SELECT") {
    if (focused) return; // 使用者正在選，不要動
    const want = y.querySelector("option[selected]")?.value ?? y.querySelector("option")?.value;
    morphChildren(x, y);
    if (want !== undefined && x.value !== want) x.value = want;
    return;
  }
  morphChildren(x, y);
}

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const ic = (name) => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="${ICONS[name] || ICONS["mdi:power-plug"]}"/></svg>`;

const fmt = (v, digits = 0) =>
  v === null || v === undefined ? "—" : Number(v).toLocaleString("zh-TW", { minimumFractionDigits: digits, maximumFractionDigits: digits });

const fmtWatts = (w) => (w === null || w === undefined ? "—" : w >= 1000 ? `${fmt(w / 1000, 2)} kW` : `${fmt(w, w < 10 ? 1 : 0)} W`);

// 秒數 → 「2 小時 10 分」
// 精確的時間長度：600 →「10 分鐘」、90 →「1 分 30 秒」、45 →「45 秒」
function fmtSec(sec) {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const x = sec % 60;
  const text = [h && `${h} 小時`, m && `${m} 分`, x && `${x} 秒`].filter(Boolean).join(" ") || "0 秒";
  return !h && !x && m ? `${m} 分鐘` : text;
}

// 倒數：10 分鐘內顯示到秒
const fmtMin = (m) => (m < 60 ? `${m} 分鐘` : `${Math.floor(m / 60)} 小時${m % 60 ? ` ${m % 60} 分` : ""}`);
const fmtLeft = (sec) => (sec < 600 ? fmtSec(sec) : fmtDur(sec));

function fmtDur(sec) {
  sec = Math.max(0, Math.round(sec));
  if (sec < 60) return "不到 1 分鐘";
  const m = Math.floor(sec / 60) % 60;
  const h = Math.floor(sec / 3600) % 24;
  const d = Math.floor(sec / 86400);
  if (d) return `${d} 天${h ? ` ${h} 小時` : ""}`;
  if (h) return `${h} 小時${m ? ` ${m} 分` : ""}`;
  return `${m} 分鐘`;
}

// 排程時間：一律存成 "HH:MM:SS"；顯示時秒數是 0 就省略
const hms = (v) => {
  const [h = 0, m = 0, sec = 0] = String(v || "").split(":").map(Number);
  return [h, m, sec].map((n) => String(n || 0).padStart(2, "0")).join(":");
};
// 時間／長度選擇器：滾輪（像手機鬧鐘）。手指上下滑、滑鼠滾輪、點數字、鍵盤 ↑ ↓ 都可以
const pad2 = (n) => String(n).padStart(2, "0");
const fmtBytes = (b) => (b >= 1e9 ? `${fmt(b / 1e9, 1)} GB` : b >= 1e6 ? `${fmt(b / 1e6, 0)} MB` : `${fmt(Math.max(1, b / 1e3), 0)} KB`);
// 訊號強度分三級：強 / 普通 / 弱（低於 -70 容易斷線）
const sigQ = (v) => (v >= -55 ? "good" : v >= -70 ? "mid" : "weak");
// 名字太長就截短：中文字算 1、英數算 0.55
function shortName(name, max) {
  let w = 0;
  let out = "";
  for (const ch of name) {
    w += /[\u0000-\u024f]/.test(ch) ? 0.55 : 1;
    if (w > max) return `${out.trimEnd()}…`;
    out += ch;
  }
  return out;
}
const splitSec = (sec) => ({ h: Math.floor(sec / 3600), m: Math.floor((sec % 3600) / 60), s: sec % 60 });
const WHEEL_ROW = 40; // 每一格的高度（px）
function wheelCol(key, unit, n, v, label, suffix = "") {
  const items = Array.from({ length: n }, (_, i) => `<div class="wi" data-a="wi" data-v="${i}">${pad2(i)}</div>`).join("");
  return `<div class="wseg"><div class="wcol" tabindex="0" role="spinbutton" aria-label="${label}" aria-valuemin="0" aria-valuemax="${n - 1}" aria-valuenow="${v}" data-wheel="${key}:${unit}" data-val="${v}">${items}</div>${suffix ? `<span class="wlab">${suffix}</span>` : ""}</div>`;
}
// 幾點：時 : 分 : 秒
function clockPicker(key, t, rows = 5) {
  const [h, m, x] = hms(t).split(":").map(Number);
  return `<div class="wheel r${rows}">${wheelCol(key, "h", 24, h, "時")}<span class="wsep">:</span>${wheelCol(key, "m", 60, m, "分")}<span class="wsep">:</span>${wheelCol(key, "s", 60, x, "秒")}</div>`;
}
// 多久：時 分 秒
function durPicker(key, sec, rows = 3) {
  const v = splitSec(sec || 0);
  return `<div class="wheel dur r${rows}">${wheelCol(key, "h", 24, v.h, "小時", "時")}${wheelCol(key, "m", 60, v.m, "分鐘", "分")}${wheelCol(key, "s", 60, v.s, "秒", "秒")}</div>`;
}
// 日出日落：opt 1 = 日出、2 = 日落；val = 提早（負）／延後（正）幾分鐘
const sunLabel = (opt, val) => `${opt === 1 ? "日出" : "日落"}${val ? `${val < 0 ? "前" : "後"} ${Math.abs(val)} 分` : ""}`;
const sunIcon = (opt) => (opt === 1 ? "mdi:white-balance-sunny" : "mdi:weather-night");
const hhmm = (m) => `${pad2(Math.floor(m / 60))}:${pad2(m % 60)}`;
const hmsSec = (t) => {
  const [h, m, x] = hms(t).split(":").map(Number);
  return h * 3600 + m * 60 + x;
};
// 插座的 wday（星期日開始）↔ 我們的星期（0 = 星期一）
const kasaDays = (wday) => wday.map((v, i) => (v ? (i + 6) % 7 : -1)).filter((d) => d >= 0).sort();
const toKasaWday = (days) => [0, 1, 2, 3, 4, 5, 6].map((i) => (days.includes((i + 6) % 7) ? 1 : 0));
// 訊號地圖的高度（公尺）
const DEV_Z = 0.3;
const AP_Z = 1.0;
const BAND = [0.8, 1.6]; // 人的腰到胸
const DEV_HEIGHTS = [[0.3, "牆上的插座孔"], [0.75, "桌上"], [1.2, "櫃子上"], [1.8, "高處"]];
const AP_HEIGHTS = [[0.3, "地上"], [0.75, "桌上"], [1, "矮櫃上"], [1.8, "高櫃上"], [2.5, "天花板"]];

// 長條圖：items = [{ v, tip, label, now }]；平均線不算還沒過完的最後一根
function barPlot(items, unit) {
  const max = Math.max(0.001, ...items.map((x) => x.v));
  const done = items.slice(0, -1);
  const avg = done.length ? done.reduce((a, x) => a + x.v, 0) / done.length : 0;
  const slots = items
    .map((x) => `<div class="slot ${x.now ? "now" : ""}" data-tip="${esc(x.tip)}"><i style="height:${Math.max(x.v > 0 ? 1.5 : 0, (x.v / max) * 100)}%"></i></div>`)
    .join("");
  const labels = items.map((x) => `<span>${x.label}</span>`).join("");
  return {
    avg,
    html: `<div class="plot"><div class="cols">${slots}</div>${avg ? `<div class="avgline" style="bottom:${(avg / max) * 100}%"><span>平均 ${fmt(avg, 1)} ${unit}</span></div>` : ""}</div><div class="xl">${labels}</div>`,
  };
}
// 只有時、分（離家模式、插座內建排程）
function hmPicker(key, t) {
  const [h, m] = String(t || "00:00").split(":").map(Number);
  return `<div class="wheel r3">${wheelCol(key, "h", 24, h, "時")}<span class="wsep">:</span>${wheelCol(key, "m", 60, m, "分")}</div>`;
}
// Wi-Fi 訊號：dBm → 等級
function signal(rssi) {
  if (rssi == null) return null;
  const level = rssi >= -55 ? 4 : rssi >= -67 ? 3 : rssi >= -75 ? 2 : 1;
  return { level, text: ["", "差", "普通", "良好", "很好"][level] };
}
// Wi-Fi 加密方式（插座回報的 key_type）
const KEY_TYPES = ["沒有加密", "WEP", "WPA", "WPA2"];
const keyName = (k) => KEY_TYPES[k] ?? (k > 3 ? "WPA2 以上" : "—");
const bars = (level) => `<span class="bars l${level}" aria-hidden="true"><i></i><i></i><i></i><i></i></span>`;
const PROTECT = [
  ["", "不需要", "一般的燈、風扇"],
  ["confirm_off", "關閉前確認", "電腦、電視盒：突然斷電可能遺失資料"],
  ["confirm", "開關都確認", "電暖器、熨斗、水泵"],
  ["lock", "鎖定", "路由器、NAS、冰箱：App、Google Home、情境、排程、全部關閉都不能開關"],
];
const showT = (t) => (t && t.endsWith(":00") ? t.slice(0, 5) : t || "");
const clockSec = (epoch) => new Date(epoch * 1000).toLocaleTimeString("zh-TW", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
const clock = (epoch) => new Date(epoch * 1000).toLocaleTimeString("zh-TW", { hour: "2-digit", minute: "2-digit", hour12: false });

function daysText(days) {
  const sorted = [...days].sort();
  const key = sorted.join();
  if (key === "0,1,2,3,4,5,6") return "每天";
  if (key === "0,1,2,3,4") return "平日";
  if (key === "5,6") return "週末";
  if (!days.length) return "沒有選日子";
  return "星期" + sorted.map((d) => DAYS[d]).join("、");
}

// 依名稱猜圖示
function deviceIcon(name) {
  const n = String(name).toLowerCase();
  if (/燈|lamp|light/.test(n)) return "mdi:lightbulb";
  if (/風扇|電扇|fan/.test(n)) return "mdi:fan";
  if (/電視|tv|螢幕|screen|monitor/.test(n)) return "mdi:television";
  if (/澆水|water/.test(n)) return "mdi:water";
  if (/電腦|筆電|laptop|pc/.test(n)) return "mdi:laptop";
  return "mdi:power-plug";
}

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let msg = `${res.status}`;
    try {
      msg = (await res.json()).detail || msg;
    } catch {}
    throw new Error(msg);
  }
  return res.json();
}

// 記住上次看的分頁（瀏覽器不讓存也沒關係）
const memo = {
  get(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {}
  },
};

// ───────────── 樣式 ─────────────

const STYLE = `
  /* ═════════ 設計基準（色彩、字級、圓角、陰影）═════════ */
  :host {
    /* 中性色 */
    --bg: #f4f5f7; --card: #ffffff; --raised: #ffffff;
    --text: #0f172a; --text2: #334155; --muted: #64748b; --faint: #94a3b8;
    --line: #e8ebf0; --soft: #f1f3f6; --soft2: #e2e6eb; --hover: #f7f8fa;
    /* 語意色 */
    --on: #f59e0b; --on-soft: #fff4dc; --on-text: #b45309;
    --accent: #2563eb; --accent-hover: #1d4ed8; --accent-soft: #e8efff; --accent-text: #1d4ed8;
    --danger: #dc2626; --danger-soft: #fdecec;
    --timer: #7c3aed; --timer-soft: #f1ebff;
    --warn: #ea580c; --ok: #16a34a; --ok-soft: #e3f6e9;
    /* 形狀 */
    --r-xs: 8px; --r-sm: 10px; --r-md: 14px; --r-lg: 18px; --r-xl: 22px;
    --shadow: 0 0 0 1px rgba(15,23,42,.04), 0 1px 2px rgba(15,23,42,.05);
    --shadow-md: 0 0 0 1px rgba(15,23,42,.05), 0 4px 12px -2px rgba(15,23,42,.08);
    --shadow-lg: 0 0 0 1px rgba(15,23,42,.06), 0 24px 48px -12px rgba(15,23,42,.28);
    --tabbar: 64px; --ease: cubic-bezier(.2,.8,.2,1);
    display: block; color: var(--text); background: var(--bg); min-height: 100vh;
    font-family: system-ui, -apple-system, "Segoe UI", "Noto Sans TC", "PingFang TC", "Microsoft JhengHei UI", "Microsoft JhengHei", Roboto, sans-serif;
    font-size: 15px; line-height: 1.45; font-weight: 400;
    -webkit-font-smoothing: antialiased; -webkit-tap-highlight-color: transparent;
  }
  @media (prefers-color-scheme: dark) {
    :host {
      --bg: #0b0d11; --card: #15181e; --raised: #1b1f26;
      --text: #f1f5f9; --text2: #cbd5e1; --muted: #94a3b8; --faint: #64748b;
      --line: #242932; --soft: #20242c; --soft2: #2e333d; --hover: #1b1f26;
      --on-soft: rgba(245,158,11,.16); --on-text: #fbbf24;
      --accent: #60a5fa; --accent-hover: #93c5fd; --accent-soft: rgba(96,165,250,.14); --accent-text: #93c5fd;
      --danger: #f87171; --danger-soft: rgba(248,113,113,.12);
      --timer: #a78bfa; --timer-soft: rgba(167,139,250,.16);
      --warn: #fb923c; --ok: #4ade80; --ok-soft: rgba(74,222,128,.13);
      --shadow: 0 0 0 1px rgba(255,255,255,.05);
      --shadow-md: 0 0 0 1px rgba(255,255,255,.06), 0 6px 16px -4px rgba(0,0,0,.5);
      --shadow-lg: 0 0 0 1px rgba(255,255,255,.07), 0 24px 48px -12px rgba(0,0,0,.7);
    }
  }
  * { box-sizing: border-box; }
  button, select, input { font: inherit; color: inherit; }
  button { background: none; border: 0; padding: 0; cursor: pointer; }
  button:disabled { cursor: default; opacity: .4; }
  :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  :focus:not(:focus-visible) { outline: none; }
  .tab:focus-visible { outline-offset: -2px; }
  .i { width: 20px; height: 20px; fill: currentColor; flex: none; display: block; }
  ::-webkit-scrollbar { width: 10px; height: 10px; }
  ::-webkit-scrollbar-thumb { background: var(--soft2); border-radius: 10px; border: 3px solid transparent; background-clip: content-box; }
  ::-webkit-scrollbar-track { background: transparent; }

  /* ═════════ 外框：手機、平板 ═════════ */
  .content { padding: 0 16px calc(var(--tabbar) + 32px + env(safe-area-inset-bottom)); }
  .page { max-width: 1200px; margin: 0 auto; padding-top: max(16px, env(safe-area-inset-top)); }
  .side { display: none; }
  .tabbar {
    position: fixed; left: 0; right: 0; bottom: 0; z-index: 20;
    display: flex; justify-content: space-around; align-items: stretch;
    height: calc(var(--tabbar) + env(safe-area-inset-bottom)); padding-bottom: env(safe-area-inset-bottom);
    background: color-mix(in srgb, var(--card) 88%, transparent); backdrop-filter: saturate(1.6) blur(16px); -webkit-backdrop-filter: saturate(1.6) blur(16px);
    border-top: 1px solid var(--line);
  }
  .tab { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 3px; font-size: 11.5px; font-weight: 600; color: var(--faint); transition: color .15s; }
  .tab .i { width: 24px; height: 24px; }
  .tab.sel { color: var(--accent); }
  @media (min-width: 720px) {
    .content { padding-left: 28px; padding-right: 28px; }
    .tab { flex-direction: row; gap: 8px; font-size: 14px; }
    .tab .i { width: 22px; height: 22px; }
  }

  /* ═════════ 電腦：左側選單 ═════════ */
  @media (min-width: 1100px) {
    .tabbar { display: none; }
    .side {
      display: flex; flex-direction: column; gap: 2px; position: fixed; left: 0; top: 0; bottom: 0; width: 240px;
      padding: 20px 12px; background: var(--card); border-right: 1px solid var(--line); z-index: 20;
    }
    .side .logo { display: flex; align-items: center; gap: 11px; padding: 4px 8px 24px; }
    .side .logo .i { width: 36px; height: 36px; padding: 7px; border-radius: 11px; background: linear-gradient(140deg, #fbbf24, #f59e0b 55%, #ea8a06); color: #fff; box-shadow: 0 2px 6px -1px rgba(245,158,11,.45); }
    .side .logo b { display: block; font-size: 16px; font-weight: 700; letter-spacing: .5px; line-height: 1.2; }
    .side .logo small { display: block; font-size: 11.5px; font-weight: 500; color: var(--muted); letter-spacing: .3px; }
    .side .tab { flex: none; flex-direction: row; justify-content: flex-start; gap: 12px; height: 40px; padding: 0 12px; border-radius: var(--r-sm); font-size: 14.5px; font-weight: 500; color: var(--muted); }
    .side .tab .i { width: 20px; height: 20px; }
    .side .tab.sel { background: var(--accent-soft); color: var(--accent-text); font-weight: 600; }
    .side .conn { margin-top: auto; padding: 10px 12px; font-size: 12.5px; color: var(--muted); display: flex; gap: 8px; align-items: center; border-top: 1px solid var(--line); padding-top: 14px; }
    .content { margin-left: 240px; padding: 0 40px 56px; }
    .page { padding-top: 32px; }
  }
  @media (hover: hover) {
    .side .tab:hover:not(.sel) { background: var(--hover); color: var(--text); }
    .row.tap:hover, .sched:hover { background: var(--hover); }
    .scene:hover { box-shadow: var(--shadow-md); transform: translateY(-1px); }
    .btn:hover { background: var(--soft2); }
    .btn.primary:hover { background: var(--accent-hover); }
    .btn.danger:hover { background: color-mix(in srgb, var(--danger) 16%, transparent); }
    .chip:hover:not(.sel), .opt:hover { background: var(--soft2); }
    .pill:hover { filter: brightness(.97); }
    .tm:hover:not(.act), .sh .x:hover, .grip:hover { background: var(--soft); color: var(--text); }
    .link:hover { text-decoration: underline; text-underline-offset: 3px; }
  }
  .led { width: 8px; height: 8px; border-radius: 50%; background: var(--ok); flex: none; display: inline-block; box-shadow: 0 0 0 3px var(--ok-soft); }
  .led.bad { background: var(--danger); box-shadow: 0 0 0 3px var(--danger-soft); }

  /* ═════════ 頁首、按鈕 ═════════ */
  .ph { display: flex; align-items: flex-end; gap: 12px; margin: 6px 2px 18px; }
  .ph h1 { font-size: 28px; line-height: 1.2; font-weight: 700; letter-spacing: -.4px; margin: 0; }
  .ph .sub { font-size: 14px; color: var(--muted); margin-top: 4px; }
  .ph .sub b { color: var(--on-text); font-weight: 600; }
  .ph .right { margin-left: auto; display: flex; gap: 8px; align-items: center; }
  .link { color: var(--accent); font-size: 15px; font-weight: 600; padding: 6px 4px; }
  .btn {
    display: inline-flex; align-items: center; justify-content: center; gap: 6px; height: 40px; padding: 0 16px;
    border-radius: var(--r-sm); font-size: 14.5px; font-weight: 600; background: var(--soft); color: var(--text);
    white-space: nowrap; text-decoration: none; transition: background .15s, transform .1s;
  }
  .btn:active { transform: scale(.98); }
  .btn.primary { background: var(--accent); color: #fff; }
  .btn.danger { background: var(--danger-soft); color: var(--danger); }
  .btn.sm { height: 32px; padding: 0 12px; font-size: 13.5px; border-radius: var(--r-xs); }
  .btn.big { height: 48px; border-radius: var(--r-md); font-size: 15.5px; width: 100%; }
  .btn .i { width: 18px; height: 18px; }
  .banner { margin: 0 0 14px; padding: 12px 14px; border-radius: var(--r-md); background: var(--danger-soft); color: var(--danger); font-weight: 600; font-size: 14px; display: flex; gap: 8px; align-items: center; }
  .hint { margin: 0 0 14px; padding: 12px 14px; border-radius: var(--r-md); background: var(--accent-soft); color: var(--accent-text); font-size: 14px; line-height: 1.55; }

  /* ═════════ 情境 ═════════ */
  .scenes { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-bottom: 18px; }
  .scene {
    background: var(--card); border-radius: var(--r-lg); min-height: 82px; padding: 10px 4px; box-shadow: var(--shadow);
    display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 7px;
    font-size: 13.5px; font-weight: 600; transition: transform .15s var(--ease), box-shadow .15s; text-align: center; min-width: 0; color: var(--text);
  }
  .scene .si { width: 38px; height: 38px; border-radius: 12px; display: flex; align-items: center; justify-content: center; background: var(--accent-soft); color: var(--accent); }
  .scene .si .i { width: 20px; height: 20px; }
  .scene.danger { color: var(--danger); }
  .scene.danger .si { background: var(--danger-soft); color: var(--danger); }
  .scene:active { transform: scale(.97); }
  .scene span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; padding: 0 4px; }
  @media (min-width: 720px) {
    .scenes { grid-template-columns: repeat(auto-fill, minmax(168px, 1fr)); }
    .scene { flex-direction: row; justify-content: flex-start; padding: 12px 14px; min-height: 64px; font-size: 14.5px; gap: 12px; }
  }

  /* ═════════ 卡片與列 ═════════ */
  .grid { columns: 1; column-gap: 16px; }
  @media (min-width: 720px) { .grid { columns: 2; } }
  @media (min-width: 1500px) { .grid.wide { columns: 3; } }
  .card { background: var(--card); border-radius: var(--r-xl); box-shadow: var(--shadow); overflow: hidden; margin: 0 0 16px; break-inside: avoid; }
  .ch { display: flex; align-items: center; gap: 10px; padding: 14px 14px 8px 16px; min-height: 58px; }
  .ch .ri { width: 32px; height: 32px; border-radius: 10px; background: var(--accent-soft); color: var(--accent); display: flex; align-items: center; justify-content: center; flex: none; }
  .ch .ri .i { width: 18px; height: 18px; }
  .ch .n { font-size: 16.5px; font-weight: 650; letter-spacing: -.1px; white-space: nowrap; }
  .ch .c { font-size: 13px; color: var(--muted); white-space: nowrap; font-variant-numeric: tabular-nums; }
  .ch .end { margin-left: auto; display: flex; gap: 6px; align-items: center; }
  .pill { height: 32px; display: inline-flex; align-items: center; font-size: 13.5px; font-weight: 600; border-radius: var(--r-xs); padding: 0 12px; background: var(--soft); white-space: nowrap; }
  .pill.danger { color: var(--danger); background: var(--danger-soft); }
  .pill.on { color: var(--on-text); background: var(--on-soft); }
  .pill.quiet { background: transparent; color: var(--muted); gap: 5px; padding: 0 10px; }
  .pill.quiet .i { width: 15px; height: 15px; }
  .pill.quiet:hover { background: var(--soft); color: var(--text); }
  .pill.accent { color: var(--accent-text); background: var(--accent-soft); }
  .desc { font-size: 14px; color: var(--muted); line-height: 1.55; margin: 0; }
  .card > .desc { padding: 0 16px 16px; }

  .row { display: flex; align-items: center; gap: 12px; min-height: 60px; padding: 8px 12px 8px 16px; position: relative; width: 100%; text-align: left; transition: background .12s; }
  .row + .row::before { content: ""; position: absolute; left: 68px; right: 0; top: 0; border-top: 1px solid var(--line); }
  .row.tap { cursor: pointer; user-select: none; -webkit-user-select: none; }
  .di { width: 40px; height: 40px; border-radius: 12px; background: var(--soft); color: var(--faint); display: flex; align-items: center; justify-content: center; flex: none; transition: background .2s, color .2s; }
  .di .i { width: 20px; height: 20px; }
  .on > .di { background: var(--on-soft); color: var(--on); }
  .nm { flex: 1; min-width: 0; text-align: left; }
  .nm .a { font-size: 15.5px; font-weight: 600; display: flex; align-items: center; gap: 6px; min-width: 0; color: var(--text); }
  .nm .a > span:first-child { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .nm .b { font-size: 13px; color: var(--faint); margin-top: 1px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-variant-numeric: tabular-nums; }
  .on .nm .b { color: var(--on-text); }
  .nm .b.warn { color: var(--warn); }
  .nm .b.timer { color: var(--timer); }
  .nm .b.bad { color: var(--danger); }
  .row.offline .nm .a { color: var(--muted); }
  .tm { width: 38px; height: 38px; border-radius: 50%; display: flex; align-items: center; justify-content: center; color: var(--faint); flex: none; transition: background .15s, color .15s; }
  .tm .i { width: 20px; height: 20px; }
  .tm.act { background: var(--timer-soft); color: var(--timer); }
  /* 開關（iOS 風格） */
  .sw { width: 50px; height: 30px; border-radius: 15px; background: var(--soft2); position: relative; flex: none; transition: background .2s var(--ease); }
  .sw::after { content: ""; position: absolute; width: 26px; height: 26px; border-radius: 50%; background: #fff; top: 2px; left: 2px; box-shadow: 0 1px 3px rgba(0,0,0,.2), 0 1px 1px rgba(0,0,0,.08); transition: transform .2s var(--ease); }
  .on > .sw, .sw.on { background: var(--on); }
  .on > .sw::after, .sw.on::after { transform: translateX(20px); }
  .row.pending .sw { opacity: .55; }
  .empty { padding: 32px 20px; text-align: center; color: var(--muted); font-size: 14.5px; line-height: 1.6; }

  /* 編輯模式 */
  .grip { width: 36px; height: 40px; margin-right: -4px; border-radius: var(--r-xs); display: flex; align-items: center; justify-content: center; flex: none; color: var(--faint); cursor: grab; touch-action: none; user-select: none; -webkit-user-select: none; }
  .grip .i { width: 20px; height: 20px; }
  .is-dragging, .is-dragging * { cursor: grabbing !important; user-select: none; -webkit-user-select: none; }
  .dragging { opacity: .3; }
  .ghost { position: fixed; z-index: 50; margin: 0 !important; pointer-events: none; background: var(--raised); border-radius: var(--r-md); box-shadow: var(--shadow-lg); overflow: hidden; transform: rotate(.6deg) scale(1.02); }
  .ghost::before { display: none; }
  select.pick, .gsel {
    appearance: none; -webkit-appearance: none; border: 0; cursor: pointer; color: var(--text2); font-weight: 500;
    background: var(--soft) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24'%3E%3Cpath fill='%2394a3b8' d='M7 10l5 5 5-5z'/%3E%3C/svg%3E") no-repeat right 8px center;
  }
  select.pick { height: 30px; border-radius: var(--r-xs); padding: 0 26px 0 10px; font-size: 13px; max-width: 100%; flex: none; }
  .nm select.pick { margin-top: 6px; }
  .pen { color: var(--faint); display: inline-flex; }
  .pen .i { width: 15px; height: 15px; }
  .nm > button.a { max-width: 100%; }
  .add { display: flex; align-items: center; justify-content: center; gap: 6px; width: 100%; height: 52px; border-radius: var(--r-lg); border: 1.5px dashed var(--soft2); color: var(--muted); font-size: 14.5px; font-weight: 600; margin: 0 0 16px; break-inside: avoid; transition: background .15s, color .15s; }
  .add:hover { background: var(--card); color: var(--accent); border-color: var(--accent); }
  .card .add { border: 0; border-top: 1px solid var(--line); border-radius: 0; margin: 0; height: 50px; color: var(--accent); }
  .card .add:hover { background: var(--hover); }

  /* ═════════ 排程 ═════════ */
  .sched { display: flex; align-items: center; gap: 16px; padding: 14px 14px 14px 18px; width: 100%; text-align: left; position: relative; cursor: pointer; transition: background .12s; }
  .sched + .sched::before { content: ""; position: absolute; left: 18px; right: 0; top: 0; border-top: 1px solid var(--line); }
  .sched .t { font-size: 28px; font-weight: 600; font-variant-numeric: tabular-nums; letter-spacing: -.5px; min-width: 110px; flex: none; line-height: 1.1; }
  .sched .t small { font-size: 15px; font-weight: 500; color: var(--muted); letter-spacing: 0; }
  .sched .d { flex: 1; min-width: 0; }
  .sched .tag { display: inline-flex; align-items: center; gap: 3px; margin-top: 4px; font-size: 11.5px; font-weight: 500; color: var(--muted); background: var(--soft); border-radius: 6px; padding: 2px 7px 2px 5px; }
  .sched .tag .i { width: 13px; height: 13px; }
  .sched .tag { white-space: nowrap; max-width: 100%; }
  .sched .tag.home { background: var(--accent-soft); color: var(--accent-text); }
  .sched .sun { display: inline-flex; align-items: center; gap: 3px; margin-right: 6px; color: var(--on-text); font-weight: 600; }
  .sched .sun .i { width: 15px; height: 15px; }
  .offset { display: flex; align-items: center; gap: 10px; }
  .offset .btn { width: 56px; height: 56px; font-size: 18px; border-radius: var(--r-md); }
  .offset .ov { flex: 1; text-align: center; background: var(--soft); border-radius: var(--r-md); padding: 8px; }
  .offset .ov b { display: inline-flex; align-items: center; gap: 6px; font-size: 18px; font-weight: 600; }
  .offset .ov b .i { width: 20px; height: 20px; color: var(--on); }
  .offset .ov span { display: block; font-size: 13px; color: var(--muted); margin-top: 2px; }
  .bstat { display: flex; align-items: center; gap: 6px; font-size: 13px; color: var(--muted); }
  .bstat .i { width: 16px; height: 16px; }
  .bstat.ok { color: var(--ok); } .bstat.bad { color: var(--warn); }
  .sched .tag .i:last-child:not(:first-child) { margin-left: 1px; }
  .sched .tag.warn { background: color-mix(in srgb, var(--warn) 14%, transparent); color: var(--warn); margin-left: 4px; }
  .sched.off .tag { opacity: .8; }
  .sched .d .x { font-size: 14.5px; font-weight: 600; }
  .sched .d .y { font-size: 13px; color: var(--muted); margin-top: 2px; line-height: 1.45; }
  .sched.off .t, .sched.off .d { opacity: .45; }
  .templates { display: flex; flex-wrap: wrap; gap: 8px; padding: 0 16px 16px; }

  /* ═════════ 用電 ═════════ */
  .stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; padding: 6px 16px 18px; }
  .stat .l { font-size: 12.5px; color: var(--muted); font-weight: 500; }
  .stat .v { font-size: 22px; font-weight: 650; margin-top: 2px; font-variant-numeric: tabular-nums; letter-spacing: -.3px; }
  .stat .v small { font-size: 12.5px; color: var(--muted); font-weight: 500; margin-left: 2px; }
  .chart { display: flex; align-items: flex-end; gap: 6px; height: 150px; padding: 0 16px 16px; }
  .bar { flex: 1; height: 100%; display: flex; flex-direction: column; justify-content: flex-end; align-items: center; gap: 6px; }
  .bar div { width: 100%; max-width: 28px; background: color-mix(in srgb, var(--on) 35%, transparent); border-radius: 5px 5px 2px 2px; min-height: 2px; }
  .bar.today div { background: var(--on); }
  .bar span { font-size: 10.5px; color: var(--faint); font-variant-numeric: tabular-nums; white-space: nowrap; height: 14px; }
  .chart.days { gap: 3px; }
  .chart.months .bar div { max-width: 22px; }
  /* ═════════ 用電 dashboard ═════════ */
  .dash { display: grid; gap: 16px; grid-template-columns: 1fr; }
  .kpis.mini4 { margin: 4px 0 12px; }
  .kpis.mini4 .kpi { background: var(--soft); box-shadow: none; padding: 12px 14px; }
  .kpis.mini4 .kv { font-size: 22px; }
  .card.flat { box-shadow: none; border: 1px solid var(--line); margin: 0; }
  .card.flat .ch { padding-left: 14px; }
  .dash > .card { margin: 0; }
  .kpis { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .kpi { background: var(--card); border-radius: var(--r-lg); box-shadow: var(--shadow); padding: 14px 16px; min-width: 0; }
  .kpi .kl { font-size: 12.5px; color: var(--muted); font-weight: 500; }
  .kpi .kv { font-size: 28px; font-weight: 700; letter-spacing: -.6px; line-height: 1.2; margin-top: 4px; font-variant-numeric: tabular-nums; display: flex; align-items: center; gap: 2px; }
  .kpi .kv small { font-size: 14px; font-weight: 500; color: var(--muted); letter-spacing: 0; }
  .kpi .kv .i { width: 26px; height: 26px; }
  .kpi .kv.up { color: var(--warn); } .kpi .kv.down { color: var(--ok); }
  .kpi .ks { font-size: 12px; color: var(--muted); margin-top: 4px; line-height: 1.4; }
  .readout-line { padding: 0 16px; font-size: 12.5px; color: var(--muted); min-height: 18px; font-variant-numeric: tabular-nums; }
  .plot { position: relative; height: 150px; margin: 10px 16px 0; border-bottom: 1px solid var(--soft2); }
  .plot .cols { display: flex; align-items: stretch; gap: 3px; height: 100%; }
  .plot .slot { flex: 1; display: flex; align-items: flex-end; justify-content: center; min-width: 0; }
  .plot .slot i { width: 100%; max-width: 24px; border-radius: 4px 4px 0 0; background: color-mix(in srgb, var(--on) 45%, transparent); }
  .plot .slot.now i { background: var(--on); }
  .plot .slot.hot i { background: var(--on-text); }
  .avgline { position: absolute; left: 0; right: 0; border-top: 1px solid var(--muted); opacity: .6; pointer-events: none; }
  .avgline span { position: absolute; right: 0; bottom: 2px; font-size: 11px; color: var(--text2); background: var(--card); padding: 0 4px; border-radius: 4px; }
  .xl { display: flex; gap: 3px; margin: 5px 16px 16px; }
  .xl span { flex: 1; text-align: center; font-size: 10.5px; color: var(--faint); font-variant-numeric: tabular-nums; white-space: nowrap; min-width: 0; }
  .hbars { padding: 0 16px 16px; display: grid; gap: 12px; }
  .hb .hl { display: flex; justify-content: space-between; font-size: 14px; }
  .hb .hl b { font-weight: 600; font-variant-numeric: tabular-nums; }
  .hb .ht { height: 8px; border-radius: 4px; background: var(--soft); margin-top: 6px; overflow: hidden; }
  .hb .ht i { display: block; height: 100%; border-radius: 4px; background: var(--on); }
  .hb .hs { font-size: 12px; color: var(--muted); margin-top: 4px; font-variant-numeric: tabular-nums; }
  .ins { display: flex; align-items: center; gap: 10px; padding: 10px 16px; font-size: 14px; line-height: 1.45; position: relative; }
  .ins + .ins::before { content: ""; position: absolute; left: 52px; right: 0; top: 0; border-top: 1px solid var(--line); }
  .ins.tap { cursor: pointer; } .ins.tap:hover { background: var(--hover); }
  .ins > span:nth-child(2) { flex: 1; }
  .ins > .i { color: var(--faint); width: 18px; height: 18px; }
  .ii { width: 28px; height: 28px; border-radius: 8px; display: flex; align-items: center; justify-content: center; flex: none; background: color-mix(in srgb, var(--warn) 14%, transparent); color: var(--warn); }
  .ii.unset { background: var(--accent-soft); color: var(--accent-text); }
  .ii .i { width: 17px; height: 17px; }
  .d-insights .desc { padding: 0 16px 16px; display: flex; gap: 6px; align-items: center; }
  .d-insights .desc .i { color: var(--ok); width: 18px; height: 18px; }
  .heat { display: grid; grid-template-columns: minmax(70px, 120px) repeat(30, 1fr); gap: 2px; padding: 8px 16px 16px; align-items: center; }
  .heat > span { font-size: 10.5px; color: var(--faint); text-align: center; font-variant-numeric: tabular-nums; height: 14px; }
  .heat .hname { font-size: 12.5px; color: var(--text2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; padding-right: 8px; }
  .heat > i { height: 18px; border-radius: 3px; background: var(--soft); }
  .heat > i.on { background: color-mix(in srgb, var(--accent) calc(var(--a) * 100%), var(--soft)); }
  .heat > i.hot { outline: 2px solid var(--text); outline-offset: 0; }
  .heat.sense { gap: 1px; }
  .heat.sense > i { height: 16px; border-radius: 2px; }
  .heat.sense > i.none { background: transparent; }
  .heat.sense > i:not(.on):not(.none) { background: var(--soft); }
  .heat.sense > i.on { background: color-mix(in srgb, var(--warn) calc(var(--a) * 100%), var(--soft)); }
  .legend.warm i { background: color-mix(in srgb, var(--warn) calc(var(--a) * 100%), var(--soft)); }
  .heat.sense { padding-right: 12px; }
  .heat .snow { font-size: 11.5px; text-align: right; color: var(--muted); font-variant-numeric: tabular-nums; padding-left: 4px; }
  .heat .snow.hot { color: var(--warn); font-weight: 600; }
  .legend { display: inline-flex; align-items: center; gap: 3px; font-size: 11.5px; color: var(--muted); }
  .legend i { width: 14px; height: 10px; border-radius: 2px; background: color-mix(in srgb, var(--accent) calc(var(--a) * 100%), var(--soft)); }
  .dl { font-size: 12px; font-weight: 600; margin-left: 6px; color: var(--muted); }
  .dl.up { color: var(--warn); } .dl.down { color: var(--ok); }
  /* 趨勢卡：圖會長高，和旁邊的卡底部切齊 */
  .d-trend { display: flex; flex-direction: column; }
  .d-trend .plot { flex: 1 1 150px; height: 150px; }
  @media (min-width: 720px) {
    .kpis { grid-template-columns: repeat(4, 1fr); }
    .dash { grid-template-columns: 1fr 1fr; align-items: start; }
    .dash > .kpis, .dash > .d-trend, .dash > .d-heat, .dash > .d-rank, .dash > .d-tariff { grid-column: span 2; }
    .dash > .d-rooms, .dash > .d-insights { align-self: stretch; }
  }
  @media (min-width: 1100px) {
    .dash { grid-template-columns: repeat(12, 1fr); }
    .dash > .kpis, .dash > .d-heat, .dash > .d-insights { grid-column: span 12; }
    .dash > .d-trend { grid-column: span 8; align-self: stretch; }
    .dash > .d-rooms { grid-column: span 4; }
    .dash > .d-rank { grid-column: span 7; }
    .dash > .d-tariff { grid-column: span 5; }
  }
  .hero { display: flex; align-items: flex-end; gap: 16px; padding: 18px 16px 16px; flex-wrap: wrap; }
  .hero .l { font-size: 13px; color: var(--muted); font-weight: 500; }
  .hero .big { font-size: 40px; font-weight: 700; letter-spacing: -1px; line-height: 1.1; font-variant-numeric: tabular-nums; }
  .hero .s { font-size: 14px; color: var(--muted); font-variant-numeric: tabular-nums; }
  .hero .hside { margin-left: auto; display: grid; gap: 4px; min-width: 150px; }
  .hero .hside div { display: flex; justify-content: space-between; gap: 12px; font-size: 13px; }
  .hero .hside span { color: var(--muted); }
  .hero .hside b { font-weight: 600; font-variant-numeric: tabular-nums; }
  .erow .share { height: 4px; border-radius: 2px; background: var(--soft); margin-top: 6px; overflow: hidden; }
  .erow .share i { display: block; height: 100%; background: var(--on); border-radius: 2px; }
  .ev { text-align: right; flex: none; display: flex; flex-direction: column; align-items: flex-end; font-variant-numeric: tabular-nums; }
  .ev b { font-size: 15px; font-weight: 600; }
  .ev small { font-size: 12.5px; color: var(--muted); }
  .ev .muted { color: var(--faint); font-size: 13px; }

  /* ═════════ 設定列 ═════════ */
  .set { display: flex; align-items: center; gap: 14px; padding: 13px 16px; position: relative; }
  .set + .set::before { content: ""; position: absolute; left: 16px; right: 0; top: 0; border-top: 1px solid var(--line); }
  .set { flex-wrap: wrap; }
  .set .tx { flex: 1 1 200px; min-width: 0; }
  .set .l { font-size: 15px; font-weight: 600; }
  .set .s { font-size: 13px; color: var(--muted); margin-top: 2px; line-height: 1.45; }
  .num { display: flex; align-items: center; gap: 4px; flex: none; }
  .num button { width: 34px; height: 34px; border-radius: var(--r-xs); background: var(--soft); font-size: 18px; font-weight: 500; }
  .num input { width: 64px; height: 34px; border: 0; border-radius: var(--r-xs); background: var(--soft); text-align: center; font-size: 15px; font-weight: 600; font-variant-numeric: tabular-nums; }
  .num .u { font-size: 13px; color: var(--muted); min-width: 26px; }
  .text { height: 44px; border: 1px solid transparent; border-radius: var(--r-sm); background: var(--soft); padding: 0 12px; font-size: 15px; width: 100%; min-width: 0; transition: border-color .15s, background .15s, box-shadow .15s; }
  .text:focus { outline: none; background: var(--card); border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
  select.text {
    appearance: none; -webkit-appearance: none; cursor: pointer; padding-right: 34px;
    background: var(--soft) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='14' height='14' viewBox='0 0 24 24'%3E%3Cpath fill='%2394a3b8' d='M7 10l5 5 5-5z'/%3E%3C/svg%3E") no-repeat right 12px center;
  }
  .inline { display: flex; gap: 8px; padding: 0 16px 14px; }
  .readout { font-size: 14.5px; font-weight: 600; text-align: right; font-variant-numeric: tabular-nums; }
  .readout small { display: block; font-size: 12px; color: var(--muted); font-weight: 400; }
  .badge { font-size: 12px; font-weight: 600; padding: 3px 8px; border-radius: 6px; background: var(--soft); color: var(--muted); white-space: nowrap; }
  .badge.ok { background: var(--ok-soft); color: var(--ok); }
  .badge.timer { background: var(--timer-soft); color: var(--timer); }
  .badge.wait { background: var(--accent-soft); color: var(--accent-text); }
  .pair { display: flex; gap: 18px; align-items: center; flex-wrap: wrap; padding: 4px 16px 8px; }
  .pair img { width: 164px; height: 164px; border-radius: var(--r-md); background: #fff; flex: none; box-shadow: var(--shadow); padding: 6px; }
  .pair-code { font-size: 22px; font-weight: 650; letter-spacing: 1px; font-variant-numeric: tabular-nums; user-select: all; }
  .steps { margin: 6px 16px 12px; padding-left: 20px; font-size: 14px; line-height: 1.7; color: var(--muted); }
  .steps b { color: var(--text); font-weight: 600; }
  code { font-size: 12.5px; background: var(--soft); padding: 2px 6px; border-radius: 6px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }

  /* ═════════ 面板：手機從下面滑上來；平板、電腦置中對話框 ═════════ */
  .wrap { position: fixed; inset: 0; z-index: 40; background: rgba(15,23,42,.42); display: flex; align-items: flex-end; justify-content: center; animation: fade .18s; }
  .sheet {
    width: 100%; max-height: 92vh; overflow: auto; background: var(--card); border-radius: var(--r-xl) var(--r-xl) 0 0;
    padding: 0 20px calc(20px + env(safe-area-inset-bottom)); animation: up .26s var(--ease); overscroll-behavior: contain;
    box-shadow: var(--shadow-lg); scrollbar-width: none;
  }
  .sheet::-webkit-scrollbar { display: none; }
  .grab { position: sticky; top: 0; z-index: 3; height: 18px; margin: 0 -20px; background: var(--card); display: flex; justify-content: center; align-items: center; }
  .grab::before { content: ""; width: 36px; height: 5px; border-radius: 3px; background: var(--soft2); }
  @media (min-width: 720px) {
    .wrap { align-items: center; padding: 24px; }
    .sheet { width: min(520px, 100%); max-height: min(86vh, 900px); border-radius: var(--r-xl); padding: 0 24px 24px; animation: pop .2s var(--ease); }
    .sheet.wide { width: min(640px, 100%); }
    .grab { display: none; }
  }
  /* 電腦、橫放平板：編輯面板分左右兩欄，一頁看完 */
  @media (min-width: 900px) {
    .sheet.xwide { width: min(1040px, 100%); max-height: min(92vh, 960px); }
    .cols { display: grid; grid-template-columns: 1fr 1fr; gap: 32px; align-items: start; }
    .col > .q:first-child { margin-top: 18px; }
    .grab { display: none; }
    .xwide .wheel.r5 { --rows: 3; }
    .xwide .cols { align-items: stretch; }
    .xwide .col { display: flex; flex-direction: column; }
    .xwide .col > .group:last-child, .xwide .col > .protect:last-child { flex: 1; }
    .xwide .col > .protect:last-child { align-content: stretch; }
    .xwide .col > .link { align-self: flex-start; }
    .xwide .chip:not(.day) { height: 32px; font-size: 13.5px; padding: 0 12px; }
    .xwide .group-title { margin: 10px 2px 6px; }
    .xwide .q { margin-top: 16px; }
    .xwide .mini { height: 30px; }
    .xwide .srooms { display: grid; grid-template-columns: 1fr 1fr; gap: 0 32px; align-items: start; }
    .xwide .srooms .group-title.cont { display: flex; }
    .xwide .srooms .scol > .group-title:first-child { margin-top: 0; }
    .xwide .srow { padding: 3px 0; }
    .xwide .srow .di { width: 28px; height: 28px; }
    .xwide .srow .di .i { width: 16px; height: 16px; }
    .xwide .srow .nm .a { font-size: 14.5px; }
    .xwide .srow .seg { padding: 2px; }
    .xwide .srow .seg button { padding: 4px 9px; font-size: 13px; }
    .xwide .srooms .group-title { margin: 8px 2px 4px; }

    .xwide .gi { min-height: 46px; padding-top: 8px; padding-bottom: 8px; }
    .xwide .meta { margin-top: 10px; }
  }
  @keyframes fade { from { opacity: 0; } }
  @keyframes up { from { transform: translateY(48px); opacity: .5; } }
  @keyframes pop { from { transform: translateY(8px) scale(.98); opacity: 0; } }
  /* 面板標題固定在上面 */
  .sh { position: sticky; top: 18px; z-index: 2; display: flex; align-items: center; gap: 12px; margin: 0 -20px; padding: 6px 20px 14px; background: var(--card); border-bottom: 1px solid transparent; }
  @media (min-width: 720px) { .sh { top: 0; margin: 0 -24px; padding: 20px 24px 14px; } }
  .sh .di { width: 44px; height: 44px; border-radius: 13px; }
  .sh .di .i { width: 22px; height: 22px; }
  .sh .t { font-size: 18px; font-weight: 650; letter-spacing: -.2px; line-height: 1.25; }
  .sh .s { font-size: 13px; color: var(--muted); margin-top: 1px; }
  .sh .m { font-size: 11.5px; color: var(--faint); margin-top: 1px; font-variant-numeric: tabular-nums; }
  .sh .x { margin-left: auto; width: 36px; height: 36px; border-radius: 50%; background: var(--soft); color: var(--muted); display: flex; align-items: center; justify-content: center; flex: none; transition: background .15s; }
  .sh .x .i { width: 18px; height: 18px; }
  /* 區塊標題 */
  .q { font-size: 13px; font-weight: 600; color: var(--muted); margin: 22px 2px 8px; letter-spacing: .2px; }
  .q small { font-weight: 400; color: var(--faint); margin-left: 4px; }
  .sh + .q { margin-top: 8px; }
  .opts { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
  .opt { min-height: 48px; border-radius: var(--r-md); background: var(--soft); display: flex; align-items: center; justify-content: center; gap: 6px; font-size: 15px; font-weight: 600; padding: 6px; text-align: center; transition: background .15s, transform .1s; font-variant-numeric: tabular-nums; }
  .opt:active { transform: scale(.97); background: var(--timer); color: #fff; }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; }
  .chip { height: 36px; padding: 0 14px; border-radius: 999px; background: var(--soft); font-size: 14px; font-weight: 500; display: inline-flex; gap: 4px; align-items: center; transition: background .15s, color .15s; color: var(--text2); }
  .chip.sel { background: var(--accent); color: #fff; }
  .chip.day { width: 40px; height: 40px; justify-content: center; padding: 0; font-weight: 600; }
  .chip .i { width: 16px; height: 16px; }
  .seg { display: flex; background: var(--soft); border-radius: var(--r-sm); padding: 3px; gap: 2px; flex: none; }
  .seg button { font-size: 13.5px; font-weight: 600; padding: 7px 10px; border-radius: 8px; color: var(--muted); transition: background .15s, color .15s; }
  .seg button.sel { background: var(--card); color: var(--text); box-shadow: 0 1px 2px rgba(15,23,42,.12), 0 0 0 .5px rgba(15,23,42,.04); }
  .seg button.sel.on { background: var(--on); color: #fff; }
  .seg button.sel.off { background: #334155; color: #fff; }
  .seg.full { width: 100%; }
  .seg.full button { flex: 1; height: 38px; padding: 0 6px; }
  .group-title { display: flex; align-items: center; font-size: 12.5px; font-weight: 600; color: var(--muted); margin: 16px 2px 8px; }
  .group-title .link { margin-left: auto; font-size: 13px; padding: 2px 4px; }
  .group-title.cont { display: none; }
  /* 主要按鈕固定在下面 */
  .actions { position: sticky; bottom: calc(-20px - env(safe-area-inset-bottom)); z-index: 2; display: flex; gap: 10px; margin: 22px -20px 0; padding: 14px 20px calc(16px + env(safe-area-inset-bottom)); background: var(--card); border-top: 1px solid var(--line); }
  @media (min-width: 720px) { .actions { bottom: -24px; margin: 24px -24px 0; padding: 14px 24px 20px; } }
  .actions .btn { flex: 1; height: 46px; border-radius: var(--r-md); font-size: 15px; }
  .actions .btn.danger { flex: none; background: transparent; padding: 0 16px; }
  .actions .btn.danger:hover { background: var(--danger-soft); }
  .actions .btn:not(.primary):not(.danger) { flex: none; padding: 0 20px; }
  .field { display: flex; align-items: center; gap: 8px; }
  .field .btn { height: 44px; }
  .note { font-size: 13px; color: var(--muted); line-height: 1.55; margin: 10px 2px 0; }
  .err { color: var(--danger); font-weight: 600; font-size: 13.5px; margin-top: 12px; }
  .err:empty { display: none; }
  .srow { display: flex; align-items: center; gap: 10px; padding: 8px 0; border-top: 1px solid var(--line); }
  .srow .nm .a { font-size: 15px; }
  .srow .di { width: 34px; height: 34px; border-radius: 10px; }
  /* 提示框 */
  .callout { display: flex; align-items: center; gap: 12px; margin: 4px 0 10px; padding: 12px 14px; border-radius: var(--r-md); background: var(--accent-soft); color: var(--accent-text); }
  .callout > .i { width: 22px; height: 22px; }
  .callout > div { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  .callout b { font-weight: 600; font-size: 14.5px; font-variant-numeric: tabular-nums; }
  .callout span { font-size: 13px; opacity: .85; }
  .callout.timer { background: var(--timer-soft); color: var(--timer); }
  .callout.bad { background: var(--danger-soft); color: var(--danger); }
  .group.power { margin: 2px 0 6px; }
  .group + .group, .protect + .group, .group + .protect, .callout + .group, .group.power + .callout { margin-top: 12px; }
  .callout { margin-top: 12px; }
  .group.power .gl { font-weight: 600; }
  .opts.four { grid-template-columns: repeat(4, 1fr); }
  .link.sm { font-size: 13.5px; padding: 10px 2px 8px; display: inline-block; }
  .lockmark { width: 50px; display: flex; justify-content: center; color: var(--faint); flex: none; }
  .lockmark .i { width: 20px; height: 20px; }
  .lead { font-size: 15px; line-height: 1.6; color: var(--text2); margin: 4px 2px 0; }
  .bul { margin: 10px 0 0; padding-left: 20px; color: var(--text2); font-size: 14px; line-height: 1.75; }
  .btn.danger.solid { background: var(--danger); color: #fff; }
  .protect { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  .pr { text-align: left; padding: 11px 12px; border-radius: var(--r-md); background: var(--soft); border: 1.5px solid transparent; display: flex; flex-direction: column; gap: 3px; transition: background .15s, border-color .15s; }
  .pr b { font-size: 14.5px; font-weight: 600; display: flex; align-items: center; gap: 4px; }
  .pr b .i { width: 15px; height: 15px; }
  .pr span { font-size: 12px; color: var(--muted); line-height: 1.4; }
  .pr.sel { background: var(--accent-soft); border-color: var(--accent); }
  .pr.sel b { color: var(--accent-text); }
  .gv { font-size: 14px; color: var(--text2); display: inline-flex; align-items: center; gap: 6px; flex: none; font-variant-numeric: tabular-nums; }
  .gv.muted { color: var(--faint); }
  .gl small.warn, .gv.warn { color: var(--warn); }
  .netwarn { display: flex; gap: 6px; align-items: flex-start; margin-top: 6px; font-size: 13px; color: var(--warn); line-height: 1.45; }
  .netwarn .i { width: 16px; height: 16px; margin-top: 1px; flex: none; }
  .netwarn b { font-weight: 600; }
  .gv.kasa { text-align: right; line-height: 1.5; display: block; }
  .gv.ok { color: var(--ok); } .gv.warn { color: var(--warn); }
  .bars { display: inline-flex; align-items: flex-end; gap: 2px; height: 14px; }
  .bars i { width: 3px; background: var(--soft2); border-radius: 1px; }
  .bars i:nth-child(1) { height: 25%; } .bars i:nth-child(2) { height: 50%; } .bars i:nth-child(3) { height: 75%; } .bars i:nth-child(4) { height: 100%; }
  .bars.l1 i:nth-child(-n+1), .bars.l2 i:nth-child(-n+2), .bars.l3 i:nth-child(-n+3), .bars.l4 i { background: var(--text2); }
  .bars.l1 i:nth-child(1) { background: var(--danger); }
  .mini { display: flex; align-items: flex-end; gap: 3px; height: 44px; }
  .mini div { flex: 1; height: 100%; display: flex; align-items: flex-end; }
  .mini i { width: 100%; min-height: 2px; border-radius: 2px; background: color-mix(in srgb, var(--accent) 35%, transparent); }
  .mini .today i { background: var(--accent); }
  .range { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  .rl { font-size: 12.5px; color: var(--muted); margin: 0 2px 6px; }
  .range .wcol { width: 56px; }
  .tapset { width: 100%; text-align: left; cursor: pointer; }
  .tapset > .i { color: var(--faint); }
  .tapset:hover { background: var(--hover); }
  .desc.foot { display: flex; gap: 8px; align-items: flex-start; font-size: 12.5px; padding: 10px 18px 14px; border-top: 1px solid var(--line); }
  .desc.foot .i { width: 16px; height: 16px; color: var(--ok); margin-top: 2px; }
  .meta { font-size: 12px; color: var(--faint); margin: 18px 2px 0; text-align: center; font-variant-numeric: tabular-nums; }
  .callout .btn { background: var(--card); color: var(--text); }
  /* 分組清單（像手機的設定頁） */
  .group { background: var(--soft); border-radius: var(--r-md); overflow: hidden; }
  .gi { display: flex; align-items: center; gap: 12px; min-height: 52px; padding: 10px 14px; position: relative; }
  .gi + .gi::before { content: ""; position: absolute; left: 14px; right: 0; top: 0; border-top: 1px solid var(--soft2); }
  .gi.col { flex-direction: column; align-items: stretch; gap: 10px; padding-top: 4px; }
  .gi.col::before { display: none; }
  .gt { flex: 1; min-width: 0; }
  .gl { font-size: 15px; font-weight: 500; flex: 1; min-width: 0; }
  .gl small { display: block; font-size: 12px; color: var(--muted); font-weight: 400; }
  .gs { font-size: 12.5px; color: var(--muted); margin-top: 1px; line-height: 1.4; }
  .gsel { height: 34px; border-radius: var(--r-xs); padding: 0 28px 0 10px; font-size: 14px; max-width: 60%; background-color: var(--card); }
  .group .tp { background: var(--card); }
  .group .chip:not(.sel) { background: var(--card); box-shadow: var(--shadow); }
  .group .chip:not(.sel):hover { background: var(--hover); }

  /* ═════════ 時間選擇器（滾輪） ═════════ */
  .wheel { --row: 40px; --rows: 5; position: relative; display: flex; justify-content: center; align-items: stretch; height: calc(var(--rows) * var(--row)); border-radius: var(--r-lg); background: var(--soft); overflow: hidden; user-select: none; -webkit-user-select: none; }
  .wheel.r3 { --rows: 3; }
  .wheel::before { content: ""; position: absolute; left: 10px; right: 10px; top: 50%; height: var(--row); transform: translateY(-50%); border-radius: 10px; background: var(--card); box-shadow: var(--shadow); pointer-events: none; }
  .wseg { position: relative; display: flex; align-items: center; }
  .wcol {
    position: relative; height: 100%; width: 68px; overflow-y: scroll; scroll-snap-type: y mandatory; overscroll-behavior: contain;
    padding: calc((var(--rows) - 1) / 2 * var(--row)) 0; scrollbar-width: none; outline: none; cursor: grab;
    -webkit-mask-image: linear-gradient(to bottom, transparent 0, rgba(0,0,0,.35) 18%, #000 40%, #000 60%, rgba(0,0,0,.35) 82%, transparent 100%);
    mask-image: linear-gradient(to bottom, transparent 0, rgba(0,0,0,.35) 18%, #000 40%, #000 60%, rgba(0,0,0,.35) 82%, transparent 100%);
  }
  .wheel.r3 .wcol { -webkit-mask-image: linear-gradient(to bottom, rgba(0,0,0,.25), #000 34%, #000 66%, rgba(0,0,0,.25)); mask-image: linear-gradient(to bottom, rgba(0,0,0,.25), #000 34%, #000 66%, rgba(0,0,0,.25)); }
  .wcol::-webkit-scrollbar { display: none; }
  .wcol:focus-visible { box-shadow: inset 0 0 0 2px var(--accent); border-radius: 10px; }
  .wi { height: var(--row); display: flex; align-items: center; justify-content: center; scroll-snap-align: center; font-size: 22px; font-weight: 500; font-variant-numeric: tabular-nums; color: var(--text); cursor: pointer; }
  .wheel.r5 .wi { font-size: 24px; }
  .wsep { position: relative; align-self: center; font-size: 22px; font-weight: 500; color: var(--faint); margin-top: -3px; }
  .wheel.dur { gap: 4px; }
  .wheel.dur .wcol { width: 52px; }
  .wlab { position: relative; font-size: 14px; font-weight: 500; color: var(--muted); width: 26px; }
  .group .wheel { background: var(--card); }
  .group .wheel::before { background: var(--soft); box-shadow: none; }
  @media (min-width: 720px) { .wcol { width: 76px; } }

  /* ═════════ 排程建議 ═════════ */
  .set.sugg { flex-wrap: wrap; row-gap: 10px; }
  .set.sugg .tx { flex: 1 1 260px; }
  .set.sugg .acts { display: flex; gap: 8px; margin-left: auto; }
  .set.sugg .sun { display: inline-flex; align-items: center; gap: 2px; }
  .set.sugg .sun .i { width: 15px; height: 15px; }
  .netwarn.past { color: var(--muted); }
  .usage { display: grid; gap: 4px; }
  .urow { display: grid; grid-template-columns: minmax(80px, 34%) 1fr auto; gap: 10px; align-items: center; padding: 6px 0; text-align: left; cursor: pointer; }
  .urow .un { font-size: 14px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .urow .ubar { height: 8px; border-radius: 4px; background: var(--soft); overflow: hidden; }
  .urow .ubar i { display: block; height: 100%; border-radius: 4px; background: var(--accent); }
  .urow .uv { font-size: 13px; color: var(--muted); font-variant-numeric: tabular-nums; min-width: 56px; text-align: right; }
  .cbox .cd { white-space: pre-line; }
  .card > .callout { margin: 0 16px 12px; }
  .sched .tag.warn { white-space: normal; }
  .mapside .ch .x { width: 32px; height: 32px; border-radius: 50%; background: var(--soft); color: var(--muted); display: flex; align-items: center; justify-content: center; }
  .mapside .ch .x .i { width: 18px; height: 18px; }
  .netdev .l { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 6px; }
  .netdev .tag, .set .tag { display: inline-flex; align-items: center; gap: 3px; font-size: 11.5px; font-weight: 500; color: var(--muted); background: var(--soft); border-radius: 6px; padding: 2px 7px 2px 5px; }
  .set .tag .i { width: 13px; height: 13px; }
  .set .tag.new { background: var(--accent-soft); color: var(--accent-text); padding: 2px 7px; }
  .ch .n small { font-weight: 500; color: var(--muted); font-size: 12.5px; margin-left: 6px; }

  /* ═════════ 訊號地圖 ═════════ */
  .link.back { display: inline-flex; align-items: center; gap: 0; padding: 0 0 4px; font-size: 14px; }
  .link.back .i { width: 18px; height: 18px; margin-left: -4px; }
  .mapgrid { display: grid; gap: 16px; grid-template-columns: 1fr; align-items: start; }
  @media (min-width: 1100px) { .mapgrid { grid-template-columns: 1fr 320px; } }
  .mapcard { margin: 0; }
  .mapside { margin: 0; }
  .mapside .pad { padding: 0 16px 16px; }
  .mapside .chips.pad { padding: 0 16px 16px; }
  .maptools { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; padding: 14px 16px 6px; }
  .maptools .end { margin-left: auto; }
  .mapwrap { padding: 4px 16px 16px; }
  svg.map { width: 100%; height: auto; display: block; border-radius: var(--r-md); background: var(--soft); touch-action: none; user-select: none; -webkit-user-select: none; }
  svg.map .bgimg { opacity: .55; }
  svg.map .room rect:first-child { fill: transparent; stroke: var(--line); stroke-width: 1.5; }
  svg.map .roomsbg rect { fill: var(--card); }
  svg.map .room.sel rect:first-child { stroke: var(--accent); stroke-width: 3; }
  svg.map .room .rl { font-weight: 600; fill: var(--muted); }
  svg.map .g-good stop { stop-color: var(--accent); }
  svg.map .g-mid stop { stop-color: color-mix(in srgb, var(--accent) 45%, var(--card)); }
  svg.map .g-weak stop { stop-color: var(--warn); }
  svg.map radialGradient stop:first-child { stop-opacity: .2; }
  svg.map radialGradient stop:last-child { stop-opacity: 0; }
  svg.map .room .rh { fill: var(--accent); cursor: nwse-resize; }
  svg.map.editing .room rect:first-child { cursor: move; }
  svg.map .mk .dot { fill: var(--card); stroke: var(--accent); stroke-width: 2.5; filter: drop-shadow(0 1px 2px rgba(15,23,42,.18)); }
  svg.map .mk.mid .dot { stroke: color-mix(in srgb, var(--accent) 50%, var(--card)); }
  svg.map .mk.weak .dot { stroke: var(--warn); }
  svg.map .mk.off .dot { stroke: var(--faint); stroke-dasharray: 3 3; }
  svg.map .mk.sel .dot { stroke-width: 4; }
  svg.map .mk .v { font-size: 11px; font-weight: 700; text-anchor: middle; fill: var(--text); font-variant-numeric: tabular-nums; }
  svg.map .mk.weak .v { fill: var(--warn); }
  svg.map .n { font-size: 11.5px; font-weight: 500; text-anchor: middle; fill: var(--text2); paint-order: stroke; stroke: var(--card); stroke-width: 3px; stroke-linejoin: round; }
  svg.map .n.apn { font-weight: 650; fill: var(--accent-text); }
  svg.map .halo { fill: var(--warn); fill-opacity: calc(var(--a) * .45 + .1); }
  svg.map .ap .bg { fill: var(--accent); stroke: var(--card); stroke-width: 3; filter: drop-shadow(0 2px 4px rgba(37,99,235,.35)); }
  svg.map .ap.sel .bg { stroke: var(--accent-soft); stroke-width: 5; }
  svg.map .ap .w { fill: none; stroke: var(--card); stroke-width: 2.2; stroke-linecap: round; }
  svg.map .ap .wd { fill: var(--card); }
  svg.map.editing .mk, svg.map.editing .ap { cursor: grab; }
  svg.map .mk.hot .dot { stroke-width: 4; }
  svg.map .link { stroke: var(--text2); stroke-linecap: round; opacity: .55; }
  svg.map .link.ok { opacity: .4; stroke-dasharray: 10 8; }
  svg.map .link.poor { opacity: .25; stroke-dasharray: 3 9; }
  svg.map .link.hot { stroke: var(--warn); opacity: var(--a); stroke-dasharray: none; }
  .legend.lk { margin-left: 12px; gap: 6px; }
  .legend.sig { gap: 5px; }
  .legend.sig b { width: 10px; height: 10px; border-radius: 50%; border: 2.5px solid var(--accent); background: var(--card); margin-left: 6px; }
  .legend.sig b.mid { border-color: color-mix(in srgb, var(--accent) 50%, var(--card)); }
  .legend.sig b.weak { border-color: var(--warn); }
  .legend.lk b { display: inline-block; width: 18px; height: 0; border-top: 2.5px solid var(--text2); opacity: .6; margin-left: 4px; }
  .legend.lk b.poor { border-top-style: dotted; opacity: .4; }
  .mapside .gsel { width: 100%; max-width: none; }
  .mapside .field .unit { color: var(--muted); font-size: 14px; }
  .mapside input.num { max-width: 110px; }

  /* ═════════ 確認對話框 ═════════ */
  .cwrap { position: fixed; inset: 0; z-index: 60; background: rgba(15,23,42,.45); display: flex; align-items: center; justify-content: center; padding: 24px; animation: fade .15s; }
  .cbox { width: min(400px, 100%); background: var(--card); border-radius: var(--r-xl); padding: 22px 22px 18px; box-shadow: var(--shadow-lg); animation: pop .18s var(--ease); }
  .cbox .ct { font-size: 17px; font-weight: 650; line-height: 1.35; }
  .cbox .cd { font-size: 14px; color: var(--muted); line-height: 1.55; margin-top: 8px; }
  .cbox .cact { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 20px; }
  .cbox .cact .btn { height: 44px; border-radius: var(--r-md); }

  /* ═════════ 提示條 ═════════ */
  .toast {
    position: fixed; left: 16px; right: 16px; bottom: calc(var(--tabbar) + 14px + env(safe-area-inset-bottom)); z-index: 50;
    background: #0f172a; color: #f8fafc; border-radius: var(--r-md); padding: 12px 14px 12px 16px; display: flex; align-items: center; gap: 12px;
    font-size: 14.5px; font-weight: 500; box-shadow: 0 12px 32px -8px rgba(15,23,42,.45); animation: up .24s var(--ease);
  }
  .toast button { margin-left: auto; color: #fbbf24; font-weight: 600; display: flex; gap: 4px; align-items: center; white-space: nowrap; padding: 6px 8px; border-radius: var(--r-xs); }
  .toast button:hover { background: rgba(255,255,255,.08); }
  .toast button .i { width: 17px; height: 17px; }
  @media (min-width: 720px) { .toast { left: 50%; right: auto; transform: translateX(-50%); width: max-content; min-width: 360px; max-width: 560px; animation: fade .2s; } }
  @media (min-width: 1100px) { .toast { bottom: 28px; margin-left: 120px; } }

`;

// ───────────── 主程式 ─────────────

class PlugApp extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this.shadowRoot.innerHTML = `<style>${STYLE}</style><div class="root"></div><div class="sheet-host"></div><div class="confirm-host"></div><div class="toast-host"></div>`;
    this._root = this.shadowRoot.querySelector(".root");
    this._sheetHost = this.shadowRoot.querySelector(".sheet-host");
    this._toastHost = this.shadowRoot.querySelector(".toast-host");
    this._confirmHost = this.shadowRoot.querySelector(".confirm-host");
    this._s = null; // 伺服器給的狀態
    this._skew = 0; // 伺服器時間 - 本機時間（秒）
    this._connected = false;
    this._pending = new Map(); // 插座 ID → 剛按下、伺服器還沒確認的目標狀態
    this._order = null; // 剛調好、伺服器還沒確認的插座順序
    this._roomOrder = null;
    this._edit = false;
    this._sheet = null;
    this._tab = this._tabFromHash() || memo.get("plughub-tab") || "plugs";
  }

  connectedCallback() {
    const root = this.shadowRoot;
    root.addEventListener("click", (e) => this._onClick(e));
    root.addEventListener("change", (e) => this._onChange(e));
    root.addEventListener("keydown", (e) => this._onKey(e));
    // 滾輪停下來時讀取中間那一格（scroll 事件不會冒泡，用 capture 接）
    root.addEventListener("scroll", (e) => e.target.classList?.contains("wcol") && this._wheelScroll(e.target), true);
    // 圖表：滑過長條／格子時，上方那一行顯示讀數；離開圖表就回到預設文字
    root.addEventListener("pointerover", (e) => {
      const viz = e.target.closest?.(".viz");
      if (!viz) return;
      const line = viz.querySelector(".readout-line");
      const t = e.target.closest("[data-tip]");
      if (line) line.textContent = t ? t.dataset.tip : line.dataset.default;
      viz.querySelectorAll(".hot").forEach((x) => x !== t && x.classList.remove("hot"));
      t?.classList.add("hot");
    });
    root.addEventListener("pointerout", (e) => {
      const viz = e.target.closest?.(".viz");
      if (!viz || viz.contains(e.relatedTarget)) return;
      const line = viz.querySelector(".readout-line");
      if (line) line.textContent = line.dataset.default;
      viz.querySelectorAll(".hot").forEach((x) => x.classList.remove("hot"));
    });
    root.addEventListener("pointerdown", (e) => {
      // 滑鼠按住滾輪上下拖，跟手機用手指滑一樣
      const wc = e.target.closest?.(".wcol");
      if (wc && e.pointerType === "mouse" && e.button === 0) return this._wheelDrag(e, wc);
      const md = e.target.closest?.("[data-mdrag]");
      if (md && this._mapEdit) return this._mapDragStart(e, md);
      const grip = e.target.closest?.("[data-drag]");
      if (grip) this._dragStart(e, grip);
    });
    window.addEventListener("resize", () => this._tab === "map" && this._render());
    window.addEventListener("hashchange", () => {
      const tab = this._tabFromHash();
      if (tab && tab !== this._tab) this._go(tab, false);
    });
    // 「開了多久」「還有幾分鐘」每 30 秒更新一次
    setInterval(() => this._update(), 30000);
    // 10 分鐘內的倒數每秒更新（澆水可以設到秒）
    setInterval(() => {
      if (this._drag || !this._s) return;
      const now = this._now();
      if (!this._s.plugs.some((p) => p.timer && p.timer - now < 600 && p.timer - now > -5)) return;
      const active = this.shadowRoot.activeElement;
      const typing = active && /INPUT|SELECT|TEXTAREA/.test(active.tagName);
      if (!(typing && this._root.contains(active))) this._render();
      if (this._sheet?.type === "timer" && !(typing && this._sheetHost.contains(active))) this._renderSheet();
    }, 1000);
    this._load();
  }

  _tabFromHash() {
    const h = location.hash.slice(1);
    return TABS.some(([k]) => k === h) || h === "map" || h === "net" ? h : null;
  }

  _go(tab, replace = true) {
    this._tab = tab;
    this._edit = false;
    memo.set("plughub-tab", tab);
    if (replace && location.hash.slice(1) !== tab) history.replaceState(null, "", `#${tab}`);
    this._render();
    window.scrollTo(0, 0);
  }

  // ───────────── 連線 ─────────────

  async _load() {
    try {
      this._setState(await api("GET", "/api/state"));
      // 從主畫面長按圖示的捷徑打開：執行那個情境（只執行一次，網址馬上清掉）
      const run = new URLSearchParams(location.search).get("run");
      if (run) {
        history.replaceState(null, "", location.pathname + location.hash);
        if (this._scenes.some((x) => x.id === run)) this._runScene(run);
      }
    } catch {
      this._connected = false;
      this._render();
    }
    this._listen();
  }

  _listen() {
    this._es?.close();
    const es = new EventSource("/api/events");
    this._es = es;
    es.onmessage = (ev) => this._setState(JSON.parse(ev.data));
    es.onopen = () => {
      this._connected = true;
      this._update();
    };
    es.onerror = () => {
      this._connected = false;
      this._update();
    };
    // 手機從背景回來時重新連線
    document.addEventListener(
      "visibilitychange",
      () => {
        if (document.visibilityState === "visible" && es.readyState === EventSource.CLOSED) this._listen();
      },
      { once: true },
    );
  }

  _setState(s) {
    this._s = s;
    this._skew = (s.now || Date.now() / 1000) - Date.now() / 1000;
    this._connected = true;
    for (const p of s.plugs) {
      if (this._pending.has(p.id) && this._pending.get(p.id) === p.is_on) this._pending.delete(p.id);
    }
    if (this._order && s.plugs.map((p) => p.id).join() === this._order.join()) this._order = null;
    if (this._roomOrder && s.rooms.map((r) => r.id).join() === this._roomOrder.join()) this._roomOrder = null;
    this._update();
  }

  _now() {
    return Date.now() / 1000 + this._skew;
  }

  _update() {
    if (this._drag) return; // 拖拉中不要重畫，放開後會重畫
    const active = this.shadowRoot.activeElement;
    const typing = active && /INPUT|SELECT|TEXTAREA/.test(active.tagName);
    if (!(typing && this._root.contains(active))) this._render();
    // 面板裡正在輸入就不重畫面板
    if (this._sheet?.live && !(typing && this._sheetHost.contains(active))) this._renderSheet();
  }

  // ───────────── 資料 ─────────────

  get _plugs() {
    const plugs = this._s?.plugs || [];
    if (!this._order) return plugs;
    const rank = new Map(this._order.map((id, i) => [id, i]));
    return plugs.slice().sort((a, b) => (rank.get(a.id) ?? 1e9) - (rank.get(b.id) ?? 1e9));
  }

  get _rooms() {
    const rooms = this._s?.rooms || [];
    if (!this._roomOrder) return rooms;
    const rank = new Map(this._roomOrder.map((id, i) => [id, i]));
    return rooms.slice().sort((a, b) => (rank.get(a.id) ?? 1e9) - (rank.get(b.id) ?? 1e9));
  }

  get _scenes() {
    return this._s?.scenes || [];
  }

  _room(id) {
    return (this._s?.rooms || []).find((r) => r.id === id);
  }

  _plug(id) {
    return (this._s?.plugs || []).find((p) => p.id === id);
  }

  _roomOf(p) {
    return p.room && this._room(p.room) ? p.room : NO_ROOM;
  }

  _isOn(p) {
    return this._pending.has(p.id) ? this._pending.get(p.id) : !!p.is_on;
  }

  // 依房間分組；還沒分房間的放最前面
  _groups(includeEmpty = false) {
    const plugs = this._plugs;
    const groups = [];
    const loose = plugs.filter((p) => this._roomOf(p) === NO_ROOM);
    if (loose.length) groups.push({ id: NO_ROOM, name: "還沒分房間", icon: "mdi:help-circle-outline", plugs: loose });
    for (const r of this._rooms) {
      const list = plugs.filter((p) => p.room === r.id);
      if (list.length || includeEmpty) groups.push({ ...r, plugs: list });
    }
    return groups;
  }

  // ───────────── 畫面 ─────────────

  _render() {
    const nav = TABS.map(
      ([key, label, icon]) =>
        `<button class="tab ${(["map", "net"].includes(this._tab) ? "settings" : this._tab) === key ? "sel" : ""}" data-a="tab" data-v="${key}" ${(["map", "net"].includes(this._tab) ? "settings" : this._tab) === key ? 'aria-current="page"' : ""}>${ic(icon)}<span>${label}</span></button>`,
    ).join("");
    const conn = `<div class="conn"><span class="led ${this._connected ? "" : "bad"}"></span>${this._connected ? "已連線" : "連線中斷"}</div>`;
    let page;
    if (!this._s) {
      page = `<div class="ph"><div><h1>我的家</h1></div></div><div class="card"><div class="empty">${this._connected ? "載入中…" : "連不上插座伺服器。<br>確認這台裝置和樹莓派在同一個網路。"}</div></div>`;
    } else {
      const pages = {
        plugs: () => (this._edit ? this._editPage() : this._plugsPage()),
        schedule: () => this._schedulePage(),
        energy: () => this._energyPage(),
        settings: () => this._settingsPage(),
        map: () => this._mapPage(),
        net: () => this._netPage(),
      };
      page = (pages[this._tab] || pages.plugs)();
    }
    const banner = this._s && !this._connected ? `<div class="banner">${ic("mdi:cloud-off-outline")}連不上插座伺服器，重新連線中…</div>` : "";
    const html = `
      <nav class="side" aria-label="選單"><div class="logo">${ic("mdi:home-automation")}<div><b>家庭中控</b><small>Home Hub</small></div></div>${nav}${conn}</nav>
      <main class="content"><div class="page">${banner}${page}</div></main>
      <nav class="tabbar" aria-label="選單">${nav}</nav>`;
    if (html === this._lastHtml) return; // 沒有變就不動畫面
    this._lastHtml = html;
    if (this._root.firstElementChild) morph(this._root, html);
    else this._root.innerHTML = html;
  }

  // ── 插座 ──

  _plugsPage() {
    const plugs = this._plugs;
    const onCount = plugs.filter((p) => p.online && this._isOn(p)).length;
    const head = `
      <div class="ph">
        <div><h1>我的家</h1><div class="sub">${onCount ? `<b>${onCount} 個開著</b>・` : ""}共 ${plugs.length} 個裝置</div></div>
        <div class="right"><button class="link" data-a="edit">編輯</button></div>
      </div>`;
    if (!plugs.length) {
      return `${head}<div class="card"><div class="empty">還沒找到插座。<br>確認插座已經接上家裡的 Wi-Fi。<br><br><button class="btn primary" data-a="discover">${ic("mdi:magnify")}現在找</button></div></div>`;
    }
    const scenes = this._scenes
      .map((sc) => `<button class="scene" data-a="scene" data-v="${esc(sc.id)}"><div class="si">${ic(sc.icon)}</div><span>${esc(sc.name)}</span></button>`)
      .join("");
    return `${head}
      <div class="scenes">
        <button class="scene danger" data-a="all-off"><div class="si">${ic("mdi:power")}</div><span>全部關閉</span></button>
        ${scenes}
      </div>
      <div class="grid wide">${this._groups().map((g) => this._roomCard(g)).join("")}</div>`;
  }

  _roomCard(g) {
    const on = g.plugs.filter((p) => p.online && this._isOn(p));
    const canOff = on.some((p) => !p.keep_on);
    // 有開著的 → 整間關閉；全部關著 → 整間打開（按鈕不會消失）
    const canOn = g.plugs.some((p) => p.online && !this._isOn(p));
    const off =
      g.id === NO_ROOM
        ? ""
        : canOff
          ? `<button class="pill quiet" data-a="room-off" data-v="${esc(g.id)}">${ic("mdi:power")}全關</button>`
          : canOn
            ? `<button class="pill quiet" data-a="room-on" data-v="${esc(g.id)}">${ic("mdi:power")}全開</button>`
            : "";
    const hint = g.id === NO_ROOM ? `<p class="desc">按右上角「編輯」可以把它們分到房間。</p>` : "";
    return `
      <section class="card">
        <div class="ch"><div class="ri">${ic(g.icon || "mdi:home-outline")}</div><div class="n">${esc(g.name)}</div>
          <div class="c">${on.length}／${g.plugs.length} 開著</div><div class="end">${off}</div></div>
        ${hint}
        ${g.plugs.map((p) => this._plugRow(p)).join("")}
      </section>`;
  }

  _plugRow(p) {
    const name = esc(p.name);
    if (!p.online) {
      return `
        <div class="row offline tap" data-a="dev" data-v="${esc(p.id)}" role="button" tabindex="0" aria-label="${name}：連不上">
          <div class="di">${ic("mdi:wifi-off")}</div>
          <div class="nm"><div class="a"><span>${name}</span></div><div class="b bad">連不上</div></div>
        </div>`;
    }
    const on = this._isOn(p);
    const now = this._now();
    // 關著的只顯示名稱；有值得注意的事才多一行
    let sub = p.max_on_s ? `最長開 ${fmtSec(p.max_on_s)}` : "";
    let cls = "";
    if (on && p.timer) {
      sub = `${fmtLeft(p.timer - now)}後自動關閉`;
      cls = "timer";
    } else if (on) {
      const since = p.on_since ? now - p.on_since : null;
      const long = since && !p.keep_on && since > (this._s.settings.long_on_hours || 6) * 3600;
      const watts = p.power !== null && p.power !== undefined ? `・${fmtWatts(p.power)}` : "";
      sub = (since === null ? "開著" : since < 60 ? "剛打開" : `開了 ${fmtDur(since)}${long ? "・很久沒關了" : ""}`) + watts + (p.keep_on ? "・常開" : "");
      if (long) cls = "warn";
    }
    return `
      <div class="row tap ${on ? "on" : ""} ${this._pending.has(p.id) ? "pending" : ""}" data-a="dev" data-v="${esc(p.id)}" role="button" tabindex="0" aria-label="${name}的詳細資料">
        <div class="di">${ic(deviceIcon(p.name))}</div>
        <div class="nm"><div class="a"><span>${name}</span></div>${sub ? `<div class="b ${cls}">${esc(sub)}</div>` : ""}</div>
        ${
          p.protect === "lock"
            ? `<span class="lockmark" title="已鎖定">${ic("mdi:lock")}</span>`
            : `<button class="sw" data-a="toggle" data-v="${esc(p.id)}" role="switch" aria-checked="${on}" aria-label="${name}"></button>`
        }
      </div>`;
  }

  // ── 編輯 ──

  _editPage() {
    const scenes = this._scenes;
    const sceneRows = scenes
      .map(
        (sc, i) => `
        <div class="row" data-k="scene" data-id="${esc(sc.id)}">
          <div class="di">${ic(sc.icon)}</div>
          <button class="nm" data-a="scene-edit" data-v="${esc(sc.id)}"><div class="a"><span>${esc(sc.name)}</span></div><div class="b">${this._sceneSummary(sc)}</div></button>
          ${this._grip("scene", sc.id, sc.name)}
        </div>`,
      )
      .join("");
    const rooms = this._rooms;
    const cards = this._groups(true)
      .map((g) => {
        const roomBtns =
          g.id === NO_ROOM ? "" : `<button class="pill quiet" data-a="room-edit" data-v="${esc(g.id)}">改名</button>${this._grip("room", g.id, g.name)}`;
        const rows = g.plugs.length
          ? g.plugs
              .map((p) => {
                const opts = [`<option value="">還沒分房間</option>`, ...rooms.map((r) => `<option value="${esc(r.id)}" ${p.room === r.id ? "selected" : ""}>${esc(r.name)}</option>`)].join("");
                return `
                <div class="row" data-k="plug" data-id="${esc(p.id)}">
                  <div class="di">${ic(deviceIcon(p.name))}</div>
                  <div class="nm">
                    <button class="a" data-a="plug-edit" data-v="${esc(p.id)}"><span>${esc(p.name)}</span>${p.keep_on ? '<span class="badge">常開</span>' : ""}${p.max_on_s ? `<span class="badge timer">最長 ${fmtSec(p.max_on_s)}</span>` : ""}</button>
                  </div>
                  ${this._grip("plug", p.id, p.name)}
                </div>`;
              })
              .join("")
          : `<p class="desc empty">還沒有插座。把插座拖到這裡，或用插座名稱下面的選單換過來。</p>`;
        return `
          <section class="card" data-room="${esc(g.id)}" ${g.id === NO_ROOM ? "" : 'data-k="room"'} data-id="${esc(g.id)}">
            <div class="ch"><div class="ri">${ic(g.icon || "mdi:home-outline")}</div><div class="n">${esc(g.name)}</div><div class="end">${roomBtns}</div></div>
            ${rows}
          </section>`;
      })
      .join("");
    return `
      <div class="ph">
        <div><h1>編輯</h1><div class="sub">改名稱、換房間、拖拉調順序</div></div>
        <div class="right"><button class="btn primary" data-a="edit-done">完成</button></div>
      </div>
      <div class="hint">按住右邊的 ⠿ 拖拉排順序，也可以把裝置拖到別的房間。點名稱修改設定。</div>
      <div class="grid wide">
        <section class="card" data-scenes>
          <div class="ch"><div class="ri">${ic("mdi:star-outline")}</div><div class="n">情境</div></div>
          ${sceneRows}
          <button class="add" data-a="scene-new">${ic("mdi:plus")}新增情境</button>
        </section>
        ${cards}
        <button class="add" data-a="room-new">${ic("mdi:plus")}新增房間</button>
      </div>`;
  }

  // 情境內容摘要：「打開 2・關閉 9」
  _sceneSummary(sc) {
    const acts = Object.values(sc.actions || {});
    const on = acts.filter((a) => a === "on").length;
    const off = acts.filter((a) => a === "off").length;
    const parts = [on && `打開 ${on} 個`, off && `關閉 ${off} 個`].filter(Boolean);
    return parts.length ? parts.join("・") : "還沒設定";
  }

  // 拖拉把手；鍵盤用 ↑ ↓ 也能移動
  _grip(kind, id, name) {
    return `<span class="grip" data-drag="${kind}" data-v="${esc(id)}" tabindex="0" role="button" aria-label="拖拉調整「${esc(name)}」的順序（或按 ↑ ↓）">${ic("mdi:drag")}</span>`;
  }

  // ── 拖拉排序（滑鼠、觸控都用 pointer events）──

  _dragStart(e, grip) {
    if (e.button > 0 || this._drag) return;
    const kind = grip.dataset.drag;
    const item = grip.closest(`[data-k="${kind}"]`);
    if (!item) return;
    e.preventDefault();
    const box = item.getBoundingClientRect();
    const ghost = item.cloneNode(true);
    ghost.classList.add("ghost");
    Object.assign(ghost.style, { width: `${box.width}px`, height: `${box.height}px`, left: `${box.left}px`, top: `${box.top}px` });
    this._root.append(ghost);
    item.classList.add("dragging");
    this._root.classList.add("is-dragging");
    this._drag = { kind, id: grip.dataset.v, item, ghost, dx: e.clientX - box.left, dy: e.clientY - box.top, x: e.clientX, y: e.clientY, moved: false };
    // 監聽整個視窗：拖拉時項目會在畫面上搬家，綁在把手上的話事件會斷掉（卡住）
    const id = e.pointerId;
    const move = (ev) => {
      if (ev.pointerId !== id) return;
      if (ev.pointerType === "mouse" && ev.buttons === 0) return end(); // 在視窗外放開了
      ev.preventDefault();
      this._dragMove(ev);
    };
    const end = (ev) => {
      if (ev && "pointerId" in ev && ev.pointerId !== id) return;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      window.removeEventListener("blur", end);
      this._dragEnd();
    };
    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    window.addEventListener("blur", end);
    navigator.vibrate?.(10);
    this._dragScroll();
  }

  _dragMove(e) {
    const d = this._drag;
    if (!d) return;
    d.x = e.clientX;
    d.y = e.clientY;
    d.moved = true;
    d.ghost.style.left = `${d.x - d.dx}px`;
    d.ghost.style.top = `${d.y - d.dy}px`;
    this._dragPlace();
  }

  // 依手指位置，把原本的項目搬到新位置（畫面立刻看到結果）
  _dragPlace() {
    const d = this._drag;
    const under = this.shadowRoot.elementFromPoint(d.x, d.y);
    if (!under) return;
    const before = (el) => {
      const r = el.getBoundingClientRect();
      return d.y < r.top + r.height / 2;
    };
    if (d.kind === "plug") {
      const card = under.closest("[data-room]");
      if (!card) return;
      const row = under.closest('[data-k="plug"]');
      if (row && row !== d.item) {
        row.parentNode.insertBefore(d.item, before(row) ? row : row.nextSibling);
      } else if (!row) {
        const rows = [...card.querySelectorAll('[data-k="plug"]')].filter((x) => x !== d.item);
        card.querySelector(".desc.empty")?.remove();
        if (!rows.length) card.append(d.item);
        else if (d.y < rows[0].getBoundingClientRect().top) rows[0].before(d.item);
        else if (d.y > rows[rows.length - 1].getBoundingClientRect().bottom) rows[rows.length - 1].after(d.item);
      }
    } else if (d.kind === "scene") {
      const row = under.closest('[data-k="scene"]');
      if (row && row !== d.item) row.parentNode.insertBefore(d.item, before(row) ? row : row.nextSibling);
    } else {
      const card = under.closest('[data-k="room"]');
      if (card && card !== d.item) card.parentNode.insertBefore(d.item, before(card) ? card : card.nextSibling);
    }
  }

  // 拖到畫面上下邊緣時自動捲動
  _dragScroll() {
    const d = this._drag;
    if (!d) return;
    const edge = 70;
    const h = window.innerHeight;
    const speed = d.y < edge ? -(edge - d.y) / 4 : d.y > h - edge ? (d.y - (h - edge)) / 4 : 0;
    if (speed && d.moved) {
      window.scrollBy(0, speed);
      this._dragPlace();
    }
    requestAnimationFrame(() => this._dragScroll());
  }

  _dragEnd() {
    const d = this._drag;
    if (!d) return;
    this._drag = null;
    d.ghost.remove();
    this._lastHtml = null; // 拖拉時動過畫面，放開後一定要重新比對
    d.item.classList.remove("dragging");
    this._root.classList.remove("is-dragging");
    const ids = (sel) => [...this._root.querySelectorAll(sel)].map((el) => el.dataset.id);
    if (d.kind === "scene") {
      const order = ids('[data-k="scene"]');
      if (order.join() !== this._scenes.map((x) => x.id).join()) {
        this._s.scenes = order.map((x) => this._scenes.find((sc) => sc.id === x));
        this._safe(() => api("POST", "/api/order", { scenes: order }));
      }
    } else if (d.kind === "room") {
      const order = ids('[data-k="room"]');
      if (order.join() !== this._rooms.map((r) => r.id).join()) {
        this._roomOrder = order;
        this._safe(() => api("POST", "/api/order", { rooms: order }));
      }
    } else {
      const order = ids('[data-k="plug"]');
      const plug = this._plug(d.id);
      const room = d.item.closest("[data-room]")?.dataset.room ?? NO_ROOM;
      const roomChanged = plug && this._roomOf(plug) !== room;
      if (roomChanged) plug.room = room || null;
      const changed = order.join() !== this._plugs.map((p) => p.id).join();
      if (changed) this._order = order;
      this._safe(async () => {
        if (roomChanged) await api("PATCH", `/api/plugs/${d.id}`, { room: room || null });
        if (changed) await api("POST", "/api/order", { plugs: order });
      });
    }
    this._render();
  }

  // ── 排程 ──

  _schedulePage() {
    const scheds = this._s.schedules || [];
    // 家庭中控的排程和插座裡（Kasa App 設的）排程放在同一個清單，依時間排
    const items = scheds.map((x) => ({ sec: hmsSec(x.today || x.time), html: this._schedRow(x) }));
    for (const p of this._plugs) for (const r of p.native?.kasa || []) if (r.repeat) items.push({ sec: this._ruleMin(r) * 60 + 0.5, html: this._kasaRow(p, r) });
    const rows = items.sort((a, b) => a.sec - b.sec).map((x) => x.html).join("");
    const timers = this._plugs.filter((p) => p.timer && p.online && this._isOn(p));
    const now = this._now();
    const timerRows = timers

          .map(
            (p) => `
          <div class="row on">
            <div class="di">${ic(deviceIcon(p.name))}</div>
            <div class="nm"><div class="a"><span>${esc(p.name)}</span></div><div class="b timer">還有 ${fmtLeft(p.timer - now)}・${clockSec(p.timer)} 關閉</div></div>
            <button class="pill" data-a="timer-cancel" data-v="${esc(p.id)}">取消</button>
          </div>`,
          )
          .join("");
    // 手機上排程清單很長，建議放最上面才看得到
    const narrow = innerWidth < 720;
    const empty = `
      <p class="desc" style="padding:0 16px 12px">還沒有排程。可以從這些開始：</p>
      <div class="templates">
        <button class="chip" data-a="sched-template" data-v="night">每晚 23:00 關燈、早上再開</button>
        <button class="chip" data-a="sched-template" data-v="leave">平日 08:30 執行「出門」</button>
        <button class="chip" data-a="sched-template" data-v="water">每天 06:30 澆水 1 分鐘</button>
      </div>`;
    return `
      <div class="ph">
        <div><h1>排程</h1><div class="sub">在固定的時間自動開關插座</div></div>
        <div class="right"><button class="btn primary" data-a="sched-new">${ic("mdi:plus")}新增</button></div>
      </div>
      <div class="grid">
        ${narrow ? this._habitCard() : ""}
        <section class="card">
          <div class="ch"><div class="ri">${ic("mdi:calendar-clock")}</div><div class="n">排程</div>${this._dayOffBtn()}</div>
          ${this._calendarLine()}
          ${rows || empty}
          ${this._habitLearning()}
          ${rows ? `<p class="desc foot">${ic("mdi:shield-check-outline")}家庭中控的排程也會寫進插座，樹莓派離線時照樣執行。標「插座內建」的是用 Kasa App 設的，存在插座裡，在這裡一樣可以開關、修改、刪除。</p>` : ""}
        </section>
        ${narrow ? "" : this._habitCard()}
        ${this._awayCard()}
        ${
          timers.length
            ? `<section class="card">
          <div class="ch"><div class="ri" style="background:var(--timer-soft);color:var(--timer)">${ic("mdi:timer-outline")}</div><div class="n">定時關閉中</div></div>
          ${timerRows}
        </section>`
            : ""
        }
      </div>`;
  }

  // 從手動開關的習慣建議排程
  _habitList() {
    return ((this._s.habits || {}).suggestions || []).filter((x) => this._plug(x.plug)).slice(0, 5);
  }

  _habitCard() {
    const list = this._habitList();
    if (!list.length) return "";
    const sun = this._s.sun || {};
    const rows = list
      .map((x) => {
        const p = this._plug(x.plug);
        const opt = x.mode === "sunrise" ? 1 : x.mode === "sunset" ? 2 : 0;
        const base = opt === 1 ? sun.sunrise : sun.sunset;
        const when = opt ? `<span class="sun">${ic(sunIcon(opt))}${sunLabel(opt, x.offset_min)}</span>` : x.time;
        const today = opt && base != null ? `（今天約 ${hhmm(base + x.offset_min)}）` : "";
        const verb = x.action === "on" ? "打開" : "關閉";
        return `
          <div class="set sugg">
            <div class="tx"><div class="l">${daysText(x.days)} ${when}${today} ${verb}${esc(p.name)}</div>
              <div class="s">過去 ${x.of} 天裡有 ${x.hits} 天，你都差不多在這時候手動${verb}它</div></div>
            <div class="acts"><button class="btn sm" data-a="habit-no" data-v="${esc(x.key)}">不用</button>
            <button class="btn sm primary" data-a="habit-yes" data-v="${esc(x.key)}">做成排程</button></div>
          </div>`;
      })
      .join("");
    return `
      <section class="card">
        <div class="ch"><div class="ri">${ic("mdi:calendar-clock")}</div><div class="n">建議的排程</div><div class="end"><span class="badge wait">${list.length}</span></div></div>
        ${rows}
        <p class="desc foot">從你手動開關的紀錄找出來的（App、Google Home、插座上的按鈕都算）。按「不用」之後就不會再建議這一條。</p>
      </section>`;
  }

  // 還在學：資料不夠時說明一下，讓人知道之後會有建議
  _habitLearning() {
    const h = this._s.habits || {};
    if (this._habitList().length || (h.days || 0) >= 14) return "";
    return `<p class="desc foot">${ic("mdi:calendar-clock")}正在記錄你手動開關的習慣${h.days ? `（已經 ${h.days} 天）` : ""}；某個插座常在差不多的時間被開關，大約一週後會出現「建議的排程」。</p>`;
  }

  // 家庭中控排程的標籤：順便顯示有沒有寫進插座當備援
  _backupTag(x) {
    const home = (text) => `<div class="tag home">${ic("mdi:home-automation")}家庭中控${text ? `・${text}` : ""}</div>`;
    const b = x.backup_status || { total: 0, ok: 0, issues: [] };
    if (!x.enabled || !b.total) return home(x.backup === false ? "不備援" : "");
    if (x.backup === false) return home("不備援");
    if (b.ok === b.total) return home(`備援 ${ic("mdi:check")}`);
    if (b.issues.every((i) => i.pending)) return home("備援同步中");
    return `${home("")}<div class="tag warn">${ic("mdi:alert-circle-outline")}備援 ${b.ok}／${b.total}</div>`;
  }

  // 插座裡（Kasa App 設的）排程：和家庭中控的排程同樣呈現，可以直接開關、修改
  _kasaKey(p, r) {
    return [p.id, r.sact, r.opt, r.val, r.wday.join("")].join("|");
  }

  // 規則今天是第幾分鐘（日出日落用插座算的，或樹莓派算的）
  _ruleMin(r) {
    if (!r.opt) return r.val;
    const base = r.opt === 1 ? this._s.sun?.sunrise : this._s.sun?.sunset;
    return base != null ? base + r.val : r.smin || 0;
  }

  _ruleText(r) {
    return r.opt ? `${sunLabel(r.opt, r.val)}（今天 ${hhmm(this._ruleMin(r))}）` : hhmm(r.val);
  }

  _ruleMatch(r) {
    return { sact: r.sact, opt: r.opt, val: r.val, wday: r.wday };
  }

  _kasaRule(key) {
    const [pid, sact, opt, val, wday] = key.split("|");
    const p = this._plug(pid);
    const r = (p?.native?.kasa || []).find((x) => x.sact === Number(sact) && x.opt === Number(opt) && x.val === Number(val) && x.wday.join("") === wday);
    return p && r ? { p, r } : null;
  }

  _kasaRow(p, r) {
    const key = esc(this._kasaKey(p, r));
    const days = daysText(kasaDays(r.wday));
    // 插座自己執行，樹莓派擋不住：和防呆設定衝突時要提醒
    const warn = !r.enable
      ? ""
      : p.protect === "lock"
        ? "裝置已鎖定，但這條排程仍會開關它"
        : p.keep_on && !r.sact
          ? "裝置設為常開，但這條排程仍會關掉它"
          : "";
    return `
      <div class="sched ${r.enable ? "" : "off"}" data-a="kasa-edit" data-v="${key}" role="button" tabindex="0">
        <div class="t">${hhmm(this._ruleMin(r))}</div>
        <div class="d"><div class="x">${r.opt ? `<span class="sun">${ic(sunIcon(r.opt))}${sunLabel(r.opt, r.val)}</span>` : ""}${days}${r.enable ? "" : "・已暫停"}</div><div class="y">${r.sact ? "打開" : "關閉"} ${esc(p.name)}</div>
          <div class="tag">${ic("mdi:power-plug-outline")}插座內建・Kasa App</div>${warn ? `<div class="tag warn">${ic("mdi:alert-circle-outline")}${warn}</div>` : ""}</div>
        <button class="sw ${r.enable ? "on" : ""}" data-a="kasa-toggle" data-v="${key}" role="switch" aria-checked="${!!r.enable}" aria-label="啟用排程"></button>
      </div>`;
  }

  _kasaSheet(s) {
    const d = s.draft;
    const p = this._plug(d.pid);
    if (!p) return null;
    const days = DAYS.map((label, i) => `<button class="chip day ${d.days.includes(i) ? "sel" : ""}" data-a="kasa-day" data-v="${i}" aria-pressed="${d.days.includes(i)}">${label}</button>`).join("");
    const act = [[1, "打開"], [0, "關閉"]].map(([k, label]) => `<button class="${d.sact === k ? "sel" : ""}" data-a="kasa-act" data-v="${k}">${label}</button>`).join("");
    return `
      ${this._sheetHead(deviceIcon(p.name), "插座內建排程", `${p.name}・用 Kasa App 設的，存在插座裡`)}
      <div class="group power"><div class="gi"><div class="gt"><div class="gl">啟用</div></div>
        <button class="sw ${d.enable ? "on" : ""}" data-a="kasa-enable" role="switch" aria-checked="${d.enable}" aria-label="啟用"></button></div></div>
      <div class="cols"><div class="col">
      <div class="q">什麼時候 <small>插座的排程只到分鐘</small></div>
      ${this._timeModeHtml(d.mode, "kasa-mode")}
      ${d.mode === "clock" ? hmPicker("kasa_time", d.time) : this._offsetHtml(d.mode, d.offset, "kasa-offset")}
      </div><div class="col">
      <div class="q">哪幾天 <small>${daysText(d.days)}</small></div>
      <div class="chips">${days}</div>
      <div class="q">要做什麼</div>
      <div class="seg full">${act}</div>
      <p class="note">改的是插座裡的設定，Kasa App 也會看到一樣的內容。插座自己執行，不需要樹莓派，但也<b>不會</b>遵守鎖定、常開這些防呆設定。</p>
      <div class="group" style="margin-top:14px"><div class="gi"><div class="gt"><div class="gl">改由家庭中控管理</div><div class="gs">轉成家庭中控的排程：可以設到秒、套用防呆和最長開啟時間，樹莓派離線時一樣由插座接手</div></div>
        <button class="btn sm" data-a="kasa-adopt" data-v="${esc(s.key)}" data-confirm="轉成家庭中控的排程？" data-confirm-text="會建立一條一樣的家庭中控排程，並刪掉插座裡原本這條（Kasa App 也會看不到它）。" data-confirm-ok="轉換" data-confirm-safe="1">轉換</button></div></div>
      </div></div>
      <div class="err"></div>
      <div class="actions"><button class="btn danger" data-a="kasa-delete" data-confirm="刪除這條插座內建排程？" data-confirm-text="插座裡的這條排程會被刪掉，Kasa App 也會看不到它，不能復原。">刪除</button><button class="btn primary" data-a="kasa-save">儲存</button></div>`;
  }

  // 每台插座（不是每個孔）的網路、韌體狀況，以及和大多數不一樣的地方
  _netReport() {
    const devices = new Map();
    for (const p of this._plugs) {
      if (!p.net || !p.online) continue;
      if (!devices.has(p.device)) devices.set(p.device, { net: p.net, plugs: [] });
      devices.get(p.device).plugs.push(p);
    }
    const count = {};
    for (const d of devices.values()) if (d.net.ssid) count[d.net.ssid] = (count[d.net.ssid] || 0) + 1;
    const main = Object.entries(count).sort((a, b) => b[1] - a[1])[0]?.[0];
    const issues = [];
    for (const d of devices.values()) {
      const names = d.plugs.map((p) => p.name).join("、");
      const label = d.plugs.length > 1 ? `${d.net.model || "排插"}（${names}）` : names;
      // 兩個 Wi-Fi 名稱都是同一台路由器發的（從路由器讀到的）就不算問題
      const sameRouter = [main, d.net.ssid].every((x) => (this._s.router?.ssids || []).includes(x));
      if (main && d.net.ssid && d.net.ssid !== main && !sameRouter) issues.push({ label, text: `連到另一個 Wi-Fi「${d.net.ssid}」，其他裝置都在「${main}」` });
      // 路由器上的 Wi-Fi 都是 WPA2／WPA3（從路由器讀到的），插座回報的舊數字就不用管
      const routerSsid = (this._s.router?.ssids || []).includes(d.net.ssid);
      if (d.net.key_type != null && d.net.key_type < 3 && !routerSsid) issues.push({ label, text: `Wi-Fi 加密是 ${keyName(d.net.key_type)}，比較容易被破解，建議改用 WPA2 以上` });
      if ((d.net.fw_updates || []).length) issues.push({ label, text: `有新韌體 ${d.net.fw_updates[0].version || ""}` });
    }
    const fwUnknown = [...devices.values()].some((d) => d.net.fw_check === "unavailable");
    return { main, devices: devices.size, issues, fwUnknown };
  }

  _netCheckHtml() {
    const r = this._netReport();
    if (!r.devices) return "";
    const ok = !r.issues.length;
    return `
      <div class="set">
        <div class="tx"><div class="l">網路與韌體檢查</div>
          <div class="s">${ok ? `${r.devices} 台插座都連在「${esc(r.main || "")}」，加密 WPA2，韌體${r.fwUnknown ? "無法檢查（已斷開 TP-Link 雲端）" : "都是最新"}` : `${r.issues.length} 個地方要注意`}</div>
          ${r.issues.map((i) => `<div class="netwarn">${ic("mdi:alert-circle-outline")}<span><b>${esc(i.label)}</b>：${esc(i.text)}</span></div>`).join("")}
          ${this._netEventsHtml()}
        </div>
        ${ok ? `<span class="gv ok">${ic("mdi:check-circle")}</span>` : ""}
      </div>`;
  }

  // 整個 Wi-Fi 的插座同時斷線（最近 7 天）
  _netEventsHtml() {
    const now = this._now();
    const evs = (this._s.net_events || []).filter((e) => !e.end || now - e.end < 7 * 86400).reverse();
    return evs
      .map((e) => {
        const t = new Date(e.start * 1000);
        const at = `${t.getMonth() + 1}/${t.getDate()} ${pad2(t.getHours())}:${pad2(t.getMinutes())}`;
        const text = e.end
          ? `${at} 斷了大約 ${Math.max(1, Math.round((e.end - e.start) / 60))} 分鐘，${e.devices} 台插座同時連不上，多半是路由器重開或當機`
          : `從 ${at} 開始，${e.devices} 台插座同時連不上，可能是路由器的問題`;
        return `<div class="netwarn ${e.end ? "past" : ""}">${ic(e.end ? "mdi:wifi" : "mdi:wifi-off")}<span><b>「${esc(e.ssid)}」</b>：${text}</span></div>`;
      })
      .join("");
  }

  _awayCard() {
    const a = this._s.settings.away || {};
    const n = (a.plugs || []).filter((id) => this._plug(id)).length;
    return `
      <section class="card">
        <div class="ch"><div class="ri">${ic("mdi:home-outline")}</div><div class="n">離家模式</div><div class="end">${a.enabled ? `<span class="badge ok">啟用中</span>` : ""}</div></div>
        <button class="set tapset" data-a="away-open">
          <div class="tx"><div class="l">${a.enabled ? `每天 ${esc(a.start)}–${esc(a.end)}，${n} 個插座隨機開關` : "不在家時讓燈隨機開關"}</div><div class="s">看起來像有人在家；由插座自己執行，樹莓派離線也照跑</div></div>
          ${ic("mdi:chevron-right")}
        </button>
        ${this._kasaAwayHtml()}
      </section>`;
  }

  // 用 Kasa App 設、存在插座裡的離家模式
  _kasaAwayHtml() {
    const rows = [];
    for (const p of this._plugs)
      for (const r of p.native?.kasa_away || []) {
        const key = esc([p.id, r.smin, r.emin, r.wday.join("")].join("|"));
        rows.push(`
          <div class="set">
            <div class="tx"><div class="l">${esc(p.name)}・${hhmm(r.smin)}–${hhmm(r.emin)}</div>
              <div class="s">${daysText(kasaDays(r.wday))}・插座內建・Kasa App 設的${r.enable ? "" : "・已停用"}</div></div>
            <button class="btn sm danger" data-a="kasa-away-delete" data-v="${key}" data-confirm="刪除這條離家模式？" data-confirm-text="插座裡這條 Kasa App 設的離家模式會被刪掉，不能復原。">刪除</button>
            <button class="sw ${r.enable ? "on" : ""}" data-a="kasa-away-toggle" data-v="${key}" role="switch" aria-checked="${!!r.enable}" aria-label="啟用"></button>
          </div>`);
      }
    return rows.join("");
  }

  _kasaAwayReq(v) {
    const [plug, smin, emin, wday] = v.split("|");
    return { plug, match: { smin: Number(smin), emin: Number(emin), wday: [...wday].map(Number) } };
  }

  _schedDesc(x) {
    if (x.action === "scene") {
      const sc = this._scenes.find((s) => s.id === x.scene);
      return sc ? `執行「${esc(sc.name)}」` : "情境已刪除，請重新選擇";
    }
    const names = x.plugs.map((id) => this._plug(id)?.name).filter(Boolean);
    const list = names.length > 3 ? `${names.slice(0, 3).join("、")} 等 ${names.length} 個` : names.join("、") || "沒有選插座";
    return `${x.action === "on" ? "打開" : "關閉"} ${esc(list)}`;
  }

  // 今天是國定假日／手動放假／下雨：排程清單上方一行說明
  _calendarLine() {
    const c = this._s.calendar || {};
    const scheds = this._s.schedules || [];
    const parts = [];
    if (c.holiday) parts.push(`今天是「${esc(c.holiday)}」`);
    if (c.day_off) parts.push("今天放假");
    if (c.rain && scheds.some((x) => x.skip_rain)) parts.push(`下雨：${esc(c.rain)}`);
    if (!parts.length) return "";
    return `<div class="callout">${ic("mdi:information-outline")}<div><b>${parts.join("・")}</b><span>打開「${c.rain && !c.holiday && !c.day_off ? "下雨不執行" : "國定假日不執行"}」的排程今天會跳過</span></div></div>`;
  }

  _dayOffBtn() {
    const c = this._s.calendar || {};
    if (!(this._s.schedules || []).some((x) => x.skip_holiday)) return "";
    return `<div class="end"><button class="btn sm ${c.day_off ? "primary" : ""}" data-a="day-off" aria-pressed="${!!c.day_off}">${c.day_off ? `${ic("mdi:check")}今天放假` : "今天放假"}</button></div>`;
  }

  _schedRow(x) {
    const extra =
      x.action === "off" && x.restore_at
        ? `，${x.restore_at < x.time ? "隔天" : ""} ${showT(x.restore_at)} 再打開`
        : x.action === "on" && x.duration_s
          ? `，${fmtSec(x.duration_s)}後關閉`
          : "";
    const sunMode = x.time_mode === "sunrise" || x.time_mode === "sunset";
    const [hh, mm, ss] = hms(sunMode ? x.today || "00:00:00" : x.time).split(":");
    const sunTag = sunMode ? `<span class="sun">${ic(sunIcon(x.time_mode === "sunrise" ? 1 : 2))}${sunLabel(x.time_mode === "sunrise" ? 1 : 2, x.offset_min)}</span>` : "";
    return `
      <div class="sched ${x.enabled ? "" : "off"}" data-a="sched-edit" data-v="${esc(x.id)}" role="button" tabindex="0">
        <div class="t">${sunMode && !x.today ? "—" : `${hh}:${mm}`}<small>${ss === "00" ? "" : `:${ss}`}</small></div>
        <div class="d"><div class="x">${sunTag}${daysText(x.days)}${x.enabled ? "" : "・已暫停"}</div><div class="y">${this._schedDesc(x)}${extra}</div>
          ${this._backupTag(x)}${x.skip_holiday ? `<div class="tag">${ic("mdi:calendar-clock")}假日跳過</div>` : ""}${x.skip_rain ? `<div class="tag">${ic("mdi:water")}下雨跳過</div>` : ""}
          ${x.enabled && x.days.includes((new Date().getDay() + 6) % 7) && (x.skipped || x.skip_today) ? `<div class="tag warn">${ic("mdi:information-outline")}今天不執行：${esc(x.skipped || x.skip_today)}</div>` : ""}</div>
        <button class="sw ${x.enabled ? "on" : ""}" data-a="sched-toggle" data-v="${esc(x.id)}" role="switch" aria-checked="${x.enabled}" aria-label="啟用排程"></button>
      </div>`;
  }

  // ── 用電 ──

  _wattOptions(p) {
    const preset = WATT_PRESETS.find(([, w]) => w === p.watts);
    const custom = p.watts && !preset;
    return [
      `<option value="" ${!p.watts ? "selected" : ""}>不估算</option>`,
      ...WATT_PRESETS.map(([label, w]) => `<option value="${w}" ${p.watts === w ? "selected" : ""}>${label} ${w} W</option>`),
      `<option value="custom" ${custom ? "selected" : ""}>${custom ? `自訂 ${fmt(p.watts)} W` : "自訂…"}</option>`,
    ].join("");
  }

  // 用電：插座自己記錄的開機時間 × 瓦數（/api/energy），打開這頁時讀、5 分鐘更新一次
  _loadEnergy(force = false) {
    if (this._energyLoading || (!force && this._energy && Date.now() - this._energyAt < 300000)) return;
    this._energyLoading = true;
    api("GET", "/api/energy")
      .then((e) => {
        this._energy = e;
        this._energyAt = Date.now();
        if (this._sheet?.type === "edev") this._renderSheet();
      })
      .catch(() => (this._energyErr = true))
      .finally(() => {
        this._energyLoading = false;
        this._render();
      });
  }

  // 用電 dashboard：KPI、趨勢、依房間、值得注意、每天開機熱力圖、裝置排行、電費設定
  _energyPage() {
    this._loadEnergy();
    const e = this._energy;
    const head = `<div class="ph"><div><h1>用電</h1><div class="sub">${
      e ? `估算：插座記錄的開機時間 × 瓦數・台電累進電價 ${fmt(e.price, 2)} 元/度（${esc(e.season)}）` : "讀取插座記錄的使用時間…"
    }</div></div></div>`;
    if (!e) return `${head}<div class="card"><div class="empty">${this._energyErr ? "讀不到插座的使用時間，稍後再試。" : "讀取中…"}</div></div>`;
    const useKwh = e.plugs.some((p) => p.watts);
    const money = (v) => `$${fmt(v)}`;

    // ── KPI ──
    const delta = e.same_period.kwh ? (e.month.kwh - e.same_period.kwh) / e.same_period.kwh : null;
    const deltaTile =
      delta == null
        ? `<div class="kv">—</div><div class="ks">沒有上個月的資料</div>`
        : `<div class="kv ${delta > 0.02 ? "up" : delta < -0.02 ? "down" : ""}">${ic(delta > 0.02 ? "mdi:chevron-up" : delta < -0.02 ? "mdi:chevron-down" : "mdi:minus")}${fmt(Math.abs(delta) * 100)}%</div>
           <div class="ks">${delta > 0.02 ? "比上月同期多" : delta < -0.02 ? "比上月同期少" : "和上月同期差不多"}・上月同期 ${money(e.same_period.cost)}</div>`;
    const kpis = `
      <div class="kpis">
        <div class="kpi"><div class="kl">本月至今</div><div class="kv">${money(e.month.cost)}</div><div class="ks">${fmt(e.month.kwh, 1)} 度・${e.day_of_month} 天</div></div>
        <div class="kpi"><div class="kl">預估本月</div><div class="kv">${money(e.projected.cost)}</div><div class="ks">${fmt(e.projected.kwh, 0)} 度・照目前每天的平均推算</div></div>
        <div class="kpi"><div class="kl">比上月同期</div>${deltaTile}</div>
        <div class="kpi"><div class="kl">今天</div><div class="kv">${fmt(e.today.kwh, 1)}<small> 度</small></div><div class="ks">約 ${money(e.today.kwh * e.price)}・到現在為止</div></div>
      </div>`;

    // ── 趨勢（單一數列：不需要圖例；平均線；滑過顯示讀數）──
    const range = this._energyRange || "days";
    const series = range === "days" ? e.days.slice(0, -1).concat(e.days.slice(-1)) : e.months;
    const val = (x) => (useKwh ? x.kwh : x.hours);
    const max = Math.max(0.001, ...series.map(val));
    const full = range === "days" ? series.slice(0, -1) : series.slice(0, -1); // 平均不算還沒過完的今天／本月
    const avg = full.length ? full.reduce((a, x) => a + val(x), 0) / full.length : 0;
    const unit = useKwh ? "度" : "小時";
    const tip = (x, last) => {
      const when = range === "days" ? `${Number(x.day.slice(5, 7))}/${Number(x.day.slice(8))}${last ? "（今天，還沒過完）" : ""}` : `${x.month.slice(0, 4)} 年 ${Number(x.month.slice(5))} 月${last ? "（本月至今）" : ""}`;
      return `${when}：${useKwh ? `${fmt(x.kwh, 1)} 度・約 $${fmt(x.cost != null ? x.cost : x.kwh * e.price)}・` : ""}開了 ${fmt(x.hours, 0)} 小時`;
    };
    // 每一欄：整欄都是滑過的範圍（比長條大），長條本身最寬 24px、頂端圓角
    const slots = series
      .map((x, i) => {
        const last = i === series.length - 1;
        return `<div class="slot ${last ? "now" : ""}" data-tip="${esc(tip(x, last))}"><i style="height:${Math.max(val(x) > 0 ? 1.5 : 0, (val(x) / max) * 100)}%"></i></div>`;
      })
      .join("");
    const xlabels = series
      .map((x, i) => {
        const last = i === series.length - 1;
        const show = range === "months" || last || i % 5 === 4;
        return `<span>${show ? (range === "days" ? (last ? "今" : Number(x.day.slice(8))) : `${Number(x.month.slice(5))}月`) : ""}</span>`;
      })
      .join("");
    const avgPct = (avg / max) * 100;
    const trendDefault = `平均每${range === "days" ? "天" : "月"} ${fmt(avg, 1)} ${unit}・滑過長條看每${range === "days" ? "天" : "月"}`;
    const trend = `
      <section class="card d-trend viz">
        <div class="ch"><div class="n">${useKwh ? "用電" : "開機時數"}（${unit}）</div>
          <div class="end"><div class="seg">${[["days", "近 30 天"], ["months", "近 12 個月"]]
            .map(([k, l]) => `<button class="${range === k ? "sel" : ""}" data-a="energy-range" data-v="${k}">${l}</button>`)
            .join("")}</div></div></div>
        <div class="readout-line" data-default="${esc(trendDefault)}">${esc(trendDefault)}</div>
        <div class="plot"><div class="cols">${slots}</div><div class="avgline" style="bottom:${avgPct}%"><span>平均 ${fmt(avg, 1)}</span></div></div>
        <div class="xl">${xlabels}</div>
      </section>`;

    // ── 依房間（排序的橫條，單一色）──
    const rmax = Math.max(0.001, ...e.rooms.map((r) => r.kwh));
    const rtotal = e.rooms.reduce((a, r) => a + r.kwh, 0) || 1;
    const rooms = `
      <section class="card d-rooms">
        <div class="ch"><div class="n">本月依房間</div></div>
        <div class="hbars">${e.rooms
          .map(
            (r) => `<div class="hb"><div class="hl"><span>${esc(r.name)}</span><b>${fmt(r.kwh, 1)} 度</b></div>
              <div class="ht"><i style="width:${Math.max(1, (r.kwh / rmax) * 100)}%"></i></div>
              <div class="hs">${fmt((r.kwh / rtotal) * 100)}%・約 ${money(r.kwh * e.price)}</div></div>`,
          )
          .join("")}</div>
      </section>`;

    // ── 值得注意 ──
    const iconFor = { always: "mdi:clock-outline", rise: "mdi:chevron-up", unset: "mdi:flash" };
    const insights = `
      <section class="card d-insights">
        <div class="ch"><div class="n">值得注意</div></div>
        ${
          e.insights.length
            ? e.insights
                .map(
                  (x) => `<div class="ins ${x.plug ? "tap" : ""}" ${x.plug ? `data-a="edev" data-v="${esc(x.plug)}" role="button" tabindex="0"` : ""}>
                    <span class="ii ${x.kind}">${ic(iconFor[x.kind] || "mdi:alert-circle-outline")}</span><span>${esc(x.text)}</span>${x.plug ? ic("mdi:chevron-right") : ""}</div>`,
                )
                .join("")
            : `<p class="desc">${ic("mdi:check-circle")} 沒有特別的狀況：沒有整天開著或最近突然開很久的裝置。</p>`
        }
      </section>`;

    // ── 每天開機熱力圖（裝置 × 30 天，單一色系由淺到深）──
    const known = e.plugs.filter((p) => p.known).sort((a, b) => (b.month_min || 0) - (a.month_min || 0));
    const dayHead = e.days.map((d, i) => `<span>${i === e.days.length - 1 ? "今" : i % 5 === 4 ? Number(d.day.slice(8)) : ""}</span>`).join("");
    const heatRows = known
      .map(
        (p) => `<div class="hname" title="${esc(p.name)}">${esc(p.name)}</div>${p.days
          .map((m, i) => {
            const d = e.days[i].day;
            const h = m / 60;
            const lvl = m <= 0 ? "" : `style="--a:${Math.max(0.12, Math.min(1, h / 24)).toFixed(2)}"`;
            return `<i class="${m > 0 ? "on" : ""}" ${lvl} data-tip="${esc(`${p.name}・${Number(d.slice(5, 7))}/${Number(d.slice(8))}：開了 ${fmtMin(m)}`)}"></i>`;
          })
          .join("")}`,
      )
      .join("");
    const heatDefault = "每一格是一天，顏色越深開越久・滑過看時數";
    const heat = `
      <section class="card d-heat viz">
        <div class="ch"><div class="n">每天開機時數</div><div class="end"><span class="legend">0${'<i style="--a:.15"></i><i style="--a:.4"></i><i style="--a:.7"></i><i style="--a:1"></i>'}24 小時</span></div></div>
        <div class="readout-line" data-default="${heatDefault}">${heatDefault}</div>
        <div class="heat"><div class="hname"></div>${dayHead}${heatRows}</div>
      </section>`;

    // ── 裝置排行（本月、比上月同期）──
    const totalKwh = known.reduce((a, p) => a + (p.month_kwh || 0), 0) || 1;
    const totalMin = known.reduce((a, p) => a + (p.month_min || 0), 0) || 1;
    const rows = [...e.plugs]
      .sort((a, b) => (b.month_kwh || 0) - (a.month_kwh || 0) || (b.month_min || 0) - (a.month_min || 0))
      .map((p) => {
        const share = p.watts ? (p.month_kwh || 0) / totalKwh : (p.month_min || 0) / totalMin;
        const ch = p.known && p.same_min > 30 ? (p.month_min - p.same_min) / p.same_min : null;
        const chTxt = ch == null ? "" : Math.abs(ch) < 0.05 ? `<span class="dl">持平</span>` : `<span class="dl ${ch > 0 ? "up" : "down"}">${ch > 0 ? "▲" : "▼"} ${fmt(Math.abs(ch) * 100)}%</span>`;
        const right = !p.known
          ? `<span class="muted">讀不到</span>`
          : p.watts
            ? `<b>${fmt(p.month_kwh, 1)} 度</b><small>$${fmt(p.month_cost)}</small>`
            : `<span class="pill quiet">設定瓦數</span>`;
        return `
          <div class="row tap erow" data-a="edev" data-v="${esc(p.id)}" role="button" tabindex="0" aria-label="${esc(p.name)}的用電明細">
            <div class="di">${ic(deviceIcon(p.name))}</div>
            <div class="nm"><div class="a"><span>${esc(p.name)}</span></div>
              <div class="b">${p.known ? `開了 ${fmtMin(p.month_min)}` : ""}${p.watts ? `・${fmt(p.watts)} W` : ""} ${chTxt}</div>
              <div class="share"><i style="width:${Math.max(1, share * 100)}%"></i></div></div>
            <div class="ev">${right}</div>
          </div>`;
      })
      .join("");
    const rank = `
      <section class="card d-rank">
        <div class="ch"><div class="n">本月各裝置</div><div class="c">比上月同期・點一下看明細</div></div>
        ${rows}
      </section>`;
    const tariffCard = `
      <section class="card d-tariff">
        <div class="ch"><div class="n">電費設定</div></div>
        ${this._numberRow("household_monthly_kwh", "家裡每月用電", "電費單上的度數（兩個月一期的話除以 2），用來決定電價級距", "度", 10)}
        <div class="set"><div class="tx"><div class="l">目前電價</div><div class="s">依每月用電和季節自動算出（夏月 6～9 月較貴）</div></div><div class="readout">${fmt(e.price, 2)} 元/度<small>${esc(e.season)}</small></div></div>
        <p class="desc">所有金額都是估算：開著的時間 × 設定的瓦數。時間是插座自己記錄的（樹莓派停機時也有記錄），實際用電會依電器狀態而不同。</p>
      </section>`;
    return `${head}<div class="dash">${kpis}${trend}${rooms}${insights}${heat}${rank}${tariffCard}</div>`;
  }

  // 單一裝置的用電明細：本月數字、每天／每月趨勢、接的電器（唯一和用電有關的設定）
  _edevSheet(s) {
    const e = this._energy;
    const p = this._plug(s.id);
    const ep = e?.plugs.find((x) => x.id === s.id);
    if (!p || !ep) return null;
    const kw = (p.watts || 0) / 1000;
    const range = s.range || "days";
    const useKwh = !!p.watts;
    const unit = useKwh ? "度" : "小時";
    let items = [];
    if (ep.known) {
      items =
        range === "days"
          ? ep.days.map((m, i) => {
              const d = e.days[i].day;
              const last = i === ep.days.length - 1;
              const kwh = (m / 60) * kw;
              return {
                v: useKwh ? kwh : m / 60,
                now: last,
                label: last ? "今" : i % 5 === 4 ? Number(d.slice(8)) : "",
                tip: `${Number(d.slice(5, 7))}/${Number(d.slice(8))}${last ? "（今天）" : ""}：開了 ${fmtMin(m)}${useKwh ? `・${fmt(kwh, 2)} 度・約 $${fmt(kwh * e.price, 1)}` : ""}`,
              };
            })
          : ep.months.map((m, i) => {
              const mm = e.months[i].month;
              const last = i === ep.months.length - 1;
              const kwh = (m / 60) * kw;
              return {
                v: useKwh ? kwh : m / 60,
                now: last,
                label: `${Number(mm.slice(5))}月`,
                tip: `${mm.slice(0, 4)} 年 ${Number(mm.slice(5))} 月${last ? "（本月至今）" : ""}：開了 ${fmtMin(m)}${useKwh ? `・${fmt(kwh, 1)} 度` : ""}`,
              };
            });
    }
    const chart = items.length ? barPlot(items, unit) : null;
    const ch = ep.known && ep.same_min > 30 ? (ep.month_min - ep.same_min) / ep.same_min : null;
    const chTxt = ch == null ? "—" : Math.abs(ch) < 0.05 ? "持平" : `${ch > 0 ? "▲" : "▼"} ${fmt(Math.abs(ch) * 100)}%`;
    const dflt = chart ? `平均每${range === "days" ? "天" : "月"} ${fmt(chart.avg, 1)} ${unit}・滑過長條看${range === "days" ? "每天" : "每月"}` : "";
    const room = this._room(p.room)?.name || "還沒分房間";
    return `
      ${this._sheetHead(deviceIcon(p.name), p.name, `${room}・用電明細`)}
      ${
        !ep.known
          ? `<div class="callout bad">${ic("mdi:alert-circle-outline")}<div><b>讀不到這個插座的使用時間</b><span>插座離線或還沒讀到，稍後再看</span></div></div>`
          : `<div class="kpis mini4">
              <div class="kpi"><div class="kl">本月用電</div><div class="kv">${useKwh ? `${fmt(ep.month_kwh, 1)}<small> 度</small>` : "—"}</div><div class="ks">${useKwh ? "" : "沒設瓦數"}</div></div>
              <div class="kpi"><div class="kl">本月電費</div><div class="kv">${useKwh ? `$${fmt(ep.month_cost)}` : "—"}</div><div class="ks">估算</div></div>
              <div class="kpi"><div class="kl">本月開機</div><div class="kv">${fmt(ep.month_min / 60, 0)}<small> 小時</small></div><div class="ks">平均每天 ${fmt(ep.month_min / 60 / Math.max(1, e.day_of_month), 1)} 小時</div></div>
              <div class="kpi"><div class="kl">比上月同期</div><div class="kv ${ch > 0.05 ? "up" : ch < -0.05 ? "down" : ""}">${chTxt}</div><div class="ks">開機時數</div></div>
            </div>
            <div class="card viz flat">
              <div class="ch"><div class="n">${useKwh ? "用電（度）" : "開機時數（小時）"}</div>
                <div class="end"><div class="seg">${[["days", "近 30 天"], ["months", "近 12 個月"]]
                  .map(([k, l]) => `<button class="${range === k ? "sel" : ""}" data-a="edev-range" data-v="${k}">${l}</button>`)
                  .join("")}</div></div></div>
              <div class="readout-line" data-default="${esc(dflt)}">${esc(dflt)}</div>
              ${chart.html}
            </div>`
      }
      <div class="q">接的電器 <small>決定這個裝置怎麼估算用電</small></div>
      <div class="group">
        <label class="gi"><span class="gl">瓦數<small>改了會馬上重算</small></span><select class="gsel" data-c="sheet-watts" aria-label="接的電器">${this._wattOptions(p)}</select></label>
      </div>
      <div class="err"></div>
      <button class="link sm" data-a="dev" data-v="${esc(p.id)}">裝置設定 ›</button>`;
  }

  // Wi-Fi 感測（實驗）：每台插座 × 最近 60 分鐘的擾動熱力圖
  _senseSheet(s) {
    const d = s.data;
    const head = this._sheetHead("mdi:wifi", "Wi-Fi 感測", "實驗：用插座的訊號擾動，猜哪裡有人在走動");
    if (!d) return `${head}<div class="empty">讀取中…</div>`;
    const CAP = 3; // 擾動 3 dB 以上算最深
    const cols = d.minutes;
    const t0 = d.start;
    const hhmmAt = (i) => {
      const t = new Date((t0 + i * 60) * 1000);
      return `${pad2(t.getHours())}:${pad2(t.getMinutes())}`;
    };
    const header = Array.from({ length: cols }, (_, i) => `<span>${i % 10 === 0 && i < cols - 5 ? hhmmAt(i) : ""}</span>`).join("");
    const rows = d.devices
      .map((dev) => {
        const cells = dev.cols
          .map((c, i) => {
            const m = c.motion;
            const cls = m == null ? "none" : m > 0.15 ? "on" : "";
            const a = m == null ? 0 : Math.max(0.12, Math.min(1, m / CAP));
            const tip = m == null ? `${dev.name}・${hhmmAt(i)}：沒有資料` : `${dev.name}・${hhmmAt(i)}：擾動 ${fmt(m, 1)}・訊號 ${fmt(c.rssi, 0)} dBm`;
            return `<i class="${cls}" style="--a:${a.toFixed(2)}" data-tip="${esc(tip)}"></i>`;
          })
          .join("");
        const now = dev.now == null ? "—" : fmt(dev.now, 1);
        return `<div class="hname" title="${esc(dev.name)}">${esc(dev.name)}</div>${cells}<div class="snow ${dev.now >= 1 ? "hot" : ""}">${now}</div>`;
      })
      .join("");
    const status = !d.enabled
      ? `<div class="callout">${ic("mdi:pause")}<div><b>記錄已暫停</b><span>打開下面的開關開始記錄</span></div></div>`
      : d.active.length
        ? `<div class="callout timer">${ic("mdi:wifi")}<div><b>最近 30 秒有動靜</b><span>${esc(d.active.join("、"))} 附近</span></div></div>`
        : `<div class="callout">${ic("mdi:wifi")}<div><b>目前沒有偵測到動靜</b><span>${d.samples ? `已記錄 ${fmt(d.samples)} 筆` : "剛開始記錄，等幾分鐘"}</span></div></div>`;
    const dflt = "每一格是一分鐘，顏色越深擾動越大・滑過看數字";
    return `
      ${head}
      ${status}
      <div class="card viz flat">
        <div class="ch"><div class="n">最近 ${cols} 分鐘</div><div class="end"><span class="legend warm">安靜<i style="--a:.15"></i><i style="--a:.4"></i><i style="--a:.7"></i><i style="--a:1"></i>擾動大</span></div></div>
        <div class="readout-line" data-default="${dflt}">${dflt}</div>
        <div class="heat sense" style="grid-template-columns:minmax(72px,140px) repeat(${cols},1fr) 40px"><div class="hname"></div>${header}<span>現在</span>${rows}</div>
      </div>
      <div class="group" style="margin-top:12px"><div class="gi"><div class="gt"><div class="gl">記錄訊號</div><div class="gs">每 2 秒讀一次每台插座的訊號強度，保留最近 1 小時（存在樹莓派上，重啟後接著用）；只讀取，不控制任何東西</div></div>
        <button class="sw ${d.enabled ? "on" : ""}" data-a="sense-toggle" role="switch" aria-checked="${d.enabled}" aria-label="記錄訊號"></button></div></div>
      <p class="note"><b>怎麼測試：</b>在某台插座附近走動 1～2 分鐘，再看那一列有沒有變深。<br>
        <b>限制：</b>插座只回報訊號強度（一個數字），只能偵測走動，偵測不到靜止的人；路由器、其他 Wi-Fi、微波爐也會造成擾動。要可靠地偵測有沒有人，建議用毫米波雷達感測器。</p>`;
  }

  // ───────────── 網路裝置（讀路由器）─────────────

  _routerLine() {
    const r = this._s.router || {};
    if (!r.configured) return "還沒連到路由器";
    if (!r.ok) return `連不上路由器${r.error ? `：${r.error}` : ""}`;
    const people = this._s.people || [];
    const home = people.filter((x) => x.home).length;
    return `${r.nodes.map((n) => n.model).join(" + ")}${people.length ? `・${home ? `${home} 人在家` : "大家都出門了"}` : "・看誰在家、陌生裝置通知"}`;
  }

  _netLoad() {
    if (this._netTimer) return;
    const load = () => {
      if (this._tab !== "net") {
        clearInterval(this._netTimer);
        this._netTimer = null;
        return;
      }
      this._netRefresh();
    };
    load();
    this._netTimer = setInterval(load, 10000);
  }

  _netRefresh() {
    return api("GET", "/api/net")
      .then((d) => {
        this._net = d;
        this._render();
        if (this._sheet?.type === "netdev" || this._sheet?.type === "person") this._renderSheet();
      })
      .catch(() => {});
  }

  _netClient(mac) {
    return (this._net?.clients || []).find((c) => c.mac === mac);
  }

  // 「5G・castle・-57 dBm」
  _netWhere(c) {
    const hidden = (x) => !x || /^[0-9A-F]{32}$/.test(x);
    const parts = [];
    if (c.wired) parts.push("有線");
    else if (c.band) parts.push(`${c.band}${hidden(c.ssid) ? "" : `・${c.ssid}`}`);
    if (!c.wired && c.rssi != null && c.online) parts.push(`${c.rssi} dBm`);
    return parts.join("・");
  }

  _netAgo(t) {
    if (!t) return "";
    const d = new Date(t * 1000);
    const now = new Date(this._now() * 1000);
    const same = d.toDateString() === now.toDateString();
    return `${same ? "" : `${d.getMonth() + 1}/${d.getDate()} `}${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }

  _netPage() {
    this._netLoad();
    const r = this._s.router || {};
    const n = this._net;
    const head = `
      <div class="ph"><div><button class="link back" data-a="net-back">${ic("mdi:chevron-left")}設定</button><h1>網路裝置</h1>
        <div class="sub">${esc(this._routerLine())}</div></div></div>`;
    if (!r.configured)
      return `${head}<div class="card"><div class="empty">還沒設定要讀哪一台路由器。</div></div>`;
    if (!n) return `${head}<div class="card"><div class="empty">讀取中…</div></div>`;
    const set = this._s.settings;
    const people = this._s.people || [];
    const pres = set.presence || {};
    const scenes = this._scenes;
    const sceneSel = (key) =>
      `<select class="gsel" data-c="pres" data-v="${key}" aria-label="情境"><option value="">不做事</option>${scenes.map((x) => `<option value="${esc(x.id)}" ${pres[key] === x.id ? "selected" : ""}>執行「${esc(x.name)}」</option>`).join("")}</select>`;
    const peopleRows = people
      .map((x) => {
        const devs = x.macs.map((m) => this._netClient(m)?.name || m).join("、");
        const when = x.since ? `${this._netAgo(x.since)} ${x.home ? "回來" : "出門"}・` : "";
        return `<button class="set tapset" data-a="person-edit" data-v="${esc(x.id)}">
            <div class="tx"><div class="l">${esc(x.name)}</div><div class="s">${esc(when)}${esc(devs || "還沒選手機")}</div></div>
            <span class="badge ${x.home ? "ok" : ""}">${x.home == null ? "—" : x.home ? "在家" : "出門"}</span>
          </button>`;
      })
      .join("");
    const peopleCard = `
      <section class="card">
        <div class="ch"><div class="ri">${ic("mdi:home-outline")}</div><div class="n">誰在家</div><div class="end"><button class="btn sm" data-a="person-new">${ic("mdi:plus")}新增</button></div></div>
        ${peopleRows || `<p class="desc">新增家人、選他的手機，就能看誰在家，最後一個人出門時自動執行「出門」。</p>`}
        ${
          people.length
            ? `<div class="set"><div class="tx"><div class="l">大家都出門時</div><div class="s">最後一個人的手機離開家裡的 Wi-Fi</div></div>${sceneSel("away_scene")}</div>
          <div class="set"><div class="tx"><div class="l">有人回家時</div><div class="s">大家都出門之後，第一個人回來</div></div>${sceneSel("home_scene")}</div>
          ${
            pres.home_scene
              ? `<div class="set"><div class="tx"><div class="l">只在天黑後</div><div class="s">日落前 30 分鐘到日出之間回家才執行（白天回家不開燈）</div></div>
            <button class="sw ${pres.home_dark_only ? "on" : ""}" data-a="pres-dark" role="switch" aria-checked="${!!pres.home_dark_only}" aria-label="只在天黑後"></button></div>`
              : ""
          }
          <div class="set"><div class="tx"><div class="l">沒人在家還有電器開著</div><div class="s">大家都出門 10 分鐘後檢查；設成「常開」的不算</div></div>
            <select class="gsel" data-c="pres" data-v="left_on" aria-label="怎麼處理">${[["notify", "通知我"], ["off", "自動關掉並通知"], ["none", "不用管"]].map(([k, l]) => `<option value="${k}" ${(pres.left_on || "notify") === k ? "selected" : ""}>${l}</option>`).join("")}</select></div>
          <div class="set"><div class="tx"><div class="l">離線多久才算出門</div><div class="s">手機睡著時偶爾會斷線一下，太短會誤判</div></div>
            <select class="gsel" data-c="pres" data-v="grace_min" aria-label="分鐘">${[5, 10, 15, 20, 30].map((m) => `<option value="${m}" ${+pres.grace_min === m ? "selected" : ""}>${m} 分鐘</option>`).join("")}</select></div>`
            : ""
        }
        <p class="desc foot">${ic("mdi:shield-check-outline")}只看手機有沒有連著家裡的 Wi-Fi，紀錄只留在樹莓派上；請先讓家人知道。手機如果對這個 Wi-Fi 用「隨機／私人 MAC 位址」而且會一直換，就認不出來，要改成固定。</p>
      </section>`;
    const alertCard = `
      <section class="card">
        <div class="group"><div class="gi"><div class="gt"><div class="gl">新裝置通知</div><div class="gs">沒看過的裝置連上家裡的網路就推播通知（要先在「提醒與通知」填 ntfy）</div></div>
          <button class="sw ${set.new_device_alert !== false ? "on" : ""}" data-a="newdev-toggle" role="switch" aria-checked="${set.new_device_alert !== false}" aria-label="新裝置通知"></button></div></div>
      </section>`;
    const day = 86400;
    const row = (c) => {
      const tags = [
        c.person ? `<span class="tag">${ic("mdi:account")}${esc(c.person)}</span>` : "",
        c.plug ? `<span class="tag">${ic("mdi:power-plug")}插座</span>` : "",
        c.map ? `<span class="tag">${ic("mdi:wifi")}在地圖上</span>` : "",
        c.first && n.now - c.first < day ? `<span class="tag new">新</span>` : "",
      ].join("");
      const sub = [c.vendor && c.vendor !== c.name ? c.vendor : "", this._netWhere(c), c.today_bytes ? `今天 ${fmtBytes(c.today_bytes)}` : "", c.online ? "" : c.seen ? `最後看到 ${this._netAgo(c.seen)}` : ""].filter(Boolean).join("・");
      return `<button class="set tapset netdev" data-a="netdev-open" data-v="${esc(c.mac)}">
          <div class="tx"><div class="l">${esc(c.name)}${tags}</div><div class="s">${esc(sub)}</div></div>${ic("mdi:chevron-right")}</button>`;
    };
    const online = n.clients.filter((c) => c.online);
    const groups = n.nodes
      .slice()
      .sort((a, b) => b.main - a.main)
      .map((node) => {
        const all = online.filter((c) => c.node === node.mac);
        const list = all.filter((c) => !c.plug);
        const plugs = all.length - list.length;
        return all.length
          ? `<section class="card"><div class="ch"><div class="ri">${ic("mdi:wifi")}</div><div class="n">${esc(node.model)}<small>${node.main ? "主路由器" : "節點"}</small></div><div class="end"><span class="badge">${all.length}</span></div></div>${list.map(row).join("")}
            ${plugs ? `<p class="desc foot">${ic("mdi:power-plug")}另外還有 ${plugs} 台插座連在這裡</p>` : ""}</section>`
          : "";
      })
      .join("");
    const offline = n.clients.filter((c) => !c.online && (c.person || c.map || c.label));
    const offCard = offline.length
      ? `<section class="card"><div class="ch"><div class="ri">${ic("mdi:wifi-off")}</div><div class="n">現在沒連線</div></div>${offline.map(row).join("")}</section>`
      : "";
    const heavy = n.clients.filter((c) => c.today_bytes > 0 && !c.plug).sort((a, b) => b.today_bytes - a.today_bytes).slice(0, 5);
    const maxB = heavy[0]?.today_bytes || 1;
    const usageCard = heavy.length
      ? `<section class="card">
        <div class="ch"><div class="ri">${ic("mdi:chart-bar")}</div><div class="n">今天用最多網路</div></div>
        <div class="pad usage">${heavy.map((c) => `<button class="urow" data-a="netdev-open" data-v="${esc(c.mac)}"><span class="un">${esc(c.name)}</span><span class="ubar"><i style="width:${Math.max(3, (c.today_bytes / maxB) * 100).toFixed(1)}%"></i></span><span class="uv">${fmtBytes(c.today_bytes)}</span></button>`).join("")}</div>
        <p class="desc foot">下載＋上傳；只算連在主路由器 Wi-Fi 上的裝置（節點和有線的讀不到）</p>
      </section>`
      : "";
    const err = !n.ok ? `<div class="netwarn">${ic("mdi:alert-circle-outline")}<span>連不上路由器${n.error ? `：${esc(n.error)}` : ""}。下面是最後讀到的資料。</span></div>` : "";
    return `${head}${err}
      <div class="grid">
        ${peopleCard}
        ${alertCard}
        ${usageCard}
        ${groups}
        ${offCard}
      </div>
      <p class="note">每 4～20 秒從路由器讀一次（SSH 金鑰登入，只讀，不改路由器的設定）。點裝置可以取名字、指定是誰的手機、放到訊號地圖。</p>`;
  }

  _netdevSheet(s) {
    const c = this._netClient(s.id);
    if (!c) return null;
    const d = (s.draft ||= { label: c.label || "", map: c.map });
    const people = this._s.people || [];
    const canMap = !c.plug && !c.wired;
    const node = (this._net.nodes || []).find((x) => x.mac === c.node);
    const info = [
      ["MAC", c.mac],
      ["廠商", c.vendor || "—"],
      ["路由器上的名字", c.router_name || "—"],
      ["連在", c.online ? `${node ? `${node.model}（${node.main ? "主路由器" : "節點"}）` : "—"}${this._netWhere(c) ? `・${this._netWhere(c)}` : ""}` : `沒連線${c.seen ? `・最後看到 ${this._netAgo(c.seen)}` : ""}`],
      ["第一次看到", c.first ? this._netAgo(c.first) : "—"],
    ];
    return `
      ${this._sheetHead(c.person ? "mdi:cellphone" : c.plug ? "mdi:power-plug" : "mdi:wifi", c.name, c.plug ? `插座：${c.plug}` : c.vendor || "")}
      <div class="q">名字</div>
      <input class="text" data-netdev-label data-enter="netdev-save" value="${esc(d.label)}" maxlength="30" placeholder="${esc(c.router_name || "例如：客廳電視、爸爸的手機")}" aria-label="名字">
      ${
        people.length && !c.plug
          ? `<div class="q">這是誰的手機 <small>用來判斷誰在家</small></div>
        <div class="chips">${people.map((x) => { const on = x.macs.includes(c.mac); return `<button class="chip ${on ? "sel" : ""}" data-a="netdev-person" data-v="${esc(x.id)}" aria-pressed="${on}">${on ? ic("mdi:check") : ""}${esc(x.name)}</button>`; }).join("")}</div>`
          : ""
      }
      ${
        canMap
          ? `<div class="group" style="margin-top:14px"><div class="gi"><div class="gt"><div class="gl">放到訊號地圖</div><div class="gs">用路由器量到的它的訊號偵測附近的動靜。適合不會移動的裝置：電視、電腦、智慧音箱；手機會被帶著走，不適合。</div></div>
        <button class="sw ${d.map ? "on" : ""}" data-a="netdev-map" role="switch" aria-checked="${d.map}" aria-label="放到訊號地圖"></button></div></div>`
          : ""
      }
      <div class="group" style="margin-top:14px">${info.map(([l, v]) => `<div class="gi"><span class="gl">${l}</span><span class="gv">${esc(v)}</span></div>`).join("")}</div>
      <div class="err"></div>
      <div class="actions"><button class="btn" data-a="close">取消</button><button class="btn primary" data-a="netdev-save">儲存</button></div>`;
  }

  _personSheet(s) {
    const isNew = !s.id;
    const person = isNew ? null : (this._s.people || []).find((x) => x.id === s.id);
    if (!isNew && !person) return null;
    const d = (s.draft ||= { name: person?.name || "", macs: [...(person?.macs || [])] });
    // 可以選的：現在連著 Wi-Fi、不是插座的裝置，加上已經選的
    const cands = (this._net?.clients || []).filter((c) => d.macs.includes(c.mac) || (c.online && !c.plug && !c.wired));
    const chips = cands
      .map((c) => {
        const on = d.macs.includes(c.mac);
        const other = !on && c.person && c.person !== person?.name ? `（${c.person}）` : "";
        return `<button class="chip ${on ? "sel" : ""}" data-a="person-mac" data-v="${esc(c.mac)}" aria-pressed="${on}">${on ? ic("mdi:check") : ""}${esc(c.name)}${esc(other)}</button>`;
      })
      .join("");
    return `
      ${this._sheetHead("mdi:account", isNew ? "新增家人" : person.name, isNew ? "" : person.home ? "在家" : "出門")}
      <div class="q">名字</div>
      <input class="text" data-person-name data-enter="person-save" ${isNew ? "data-autofocus" : ""} value="${esc(d.name)}" maxlength="20" placeholder="例如：爸爸" aria-label="名字">
      <div class="q">他的手機 <small>選一到兩支；不知道是哪一支，可以先把手機的 Wi-Fi 關掉再打開，看哪一個消失又出現</small></div>
      <div class="chips">${chips || `<p class="desc">${this._net ? "現在沒有連著 Wi-Fi 的裝置" : "讀取中…"}</p>`}</div>
      <div class="err"></div>
      <div class="actions">
        ${isNew ? `<button class="btn" data-a="close">取消</button>` : `<button class="btn danger" data-a="person-delete" data-confirm="刪除「${esc(person.name)}」？" data-confirm-text="只是不再判斷他在不在家，手機本身不受影響。">刪除</button>`}
        <button class="btn primary" data-a="person-save">${isNew ? "新增" : "儲存"}</button>
      </div>`;
  }

  // ───────────── 訊號地圖 ─────────────

  _mapLoad() {
    if (this._fp || this._fpLoading) return;
    this._fpLoading = true;
    api("GET", "/api/floorplan")
      .then((fp) => {
        this._fp = fp;
        if (!fp.rooms) {
          this._mapAutoLayout(false);
          this._mapSave();
        }
      })
      .catch(() => {})
      .finally(() => {
        this._fpLoading = false;
        this._render();
      });
    // 有開 Wi-Fi 感測就一起讀動靜
    const sense = () => {
      if (this._tab !== "map") return clearInterval(this._mapTimer);
      api("GET", "/api/sensing")
        .then((d) => {
          this._mapSense = d;
          this._mapAutoAps();
          this._render();
        })
        .catch(() => {});
    };
    sense();
    clearInterval(this._mapTimer);
    this._mapTimer = setInterval(sense, 10000);
  }

  // 從路由器讀到的每一台（主路由器、節點）自動放上地圖；放在連到它的裝置中間，之後可以拖到實際位置
  _mapAutoAps() {
    const fp = this._fp;
    const nodes = this._mapSense?.net?.nodes || [];
    if (!fp?.rooms || !nodes.length) return;
    const done = new Set([...(fp.auto_nodes || []), ...fp.aps.map((a) => a.node).filter(Boolean)]);
    const todo = nodes.filter((n) => !done.has(n.mac));
    if (!todo.length) return;
    const devs = this._mapDevices();
    // 已經自己擺了、還沒指定是哪一台的基地台：依序對上（主路由器先），不另外加
    const free = fp.aps.filter((a) => !a.node && fp.items[`ap:${a.id}`]);
    todo.sort((a, b) => b.main - a.main);
    todo.forEach((n, i) => {
      const own = free.shift();
      if (own) {
        own.node = n.mac;
        if (/^Wi-Fi 基地台 \d+$/.test(own.name)) own.name = n.model;
        return;
      }
      const near = devs.filter((d) => d.node === n.mac && fp.items[d.key]).map((d) => fp.items[d.key]);
      const x = near.length ? near.reduce((t, it) => t + it.x, 0) / near.length : fp.w * (0.3 + 0.4 * i);
      const y = near.length ? near.reduce((t, it) => t + it.y, 0) / near.length : fp.h * 0.15;
      const id = `n${n.mac.replace(/:/g, "").slice(-6).toLowerCase()}`;
      fp.aps.push({ id, name: n.model, node: n.mac, z: AP_Z });
      fp.items[`ap:${id}`] = { x, y };
    });
    fp.auto_nodes = [...done, ...todo.map((n) => n.mac)];
    this._mapSave();
  }

  // 每台插座一個標記（排插算一台）
  _mapDevices() {
    const devs = new Map();
    for (const p of this._plugs) {
      if (!devs.has(p.device)) devs.set(p.device, { key: p.device, plugs: [], rssi: p.rssi, online: p.online, room: p.room });
      const d = devs.get(p.device);
      d.plugs.push(p);
      d.online = d.online || p.online;
    }
    const net = this._mapSense?.net;
    const cl = Object.fromEntries((net?.clients || []).map((c) => [c.mac, c]));
    for (const d of devs.values()) {
      d.name = d.plugs.length > 1 ? `${d.plugs[0].name} +${d.plugs.length - 1}` : d.plugs[0].name;
      d.full = d.plugs.map((p) => p.name).join("、");
      d.ssid = d.plugs.find((p) => p.net?.ssid)?.net.ssid || null;
      d.node = cl[d.key]?.online ? cl[d.key].node : null;
    }
    // 從路由器加到地圖的裝置（電視、電腦…）：訊號強度是路由器量到的
    for (const c of net?.clients || []) {
      if (!c.map || c.plug || devs.has(c.mac)) continue;
      devs.set(c.mac, { key: c.mac, plugs: [], name: c.name, full: c.name, rssi: c.online ? c.rssi : null, online: c.online, room: null, ssid: c.ssid, node: c.online ? c.node : null, router: true });
    }
    return [...devs.values()];
  }

  // 第一次：用家庭中控的房間排出草圖，裝置放進各自的房間
  _mapAutoLayout(reset) {
    const fp = this._fp;
    const rooms = this._rooms.length ? this._rooms : [{ id: "all", name: "家" }];
    const cols = rooms.length > 4 ? 3 : 2;
    const rowsN = Math.ceil(rooms.length / cols);
    const pad = 16;
    const cw = (fp.w - pad * (cols + 1)) / cols;
    const ch = (fp.h - pad * (rowsN + 1)) / rowsN;
    fp.rooms = rooms.map((r, i) => ({
      id: r.id, name: r.name,
      x: pad + (i % cols) * (cw + pad), y: pad + Math.floor(i / cols) * (ch + pad), w: cw, h: ch,
    }));
    if (reset) fp.items = Object.fromEntries(Object.entries(fp.items).filter(([k]) => k.startsWith("ap:")));
    const devs = this._mapDevices();
    for (const room of fp.rooms) {
      const inRoom = devs.filter((d) => (d.room || "") === room.id || (room.id === "all"));
      inRoom.forEach((d, i) => {
        if (fp.items[d.key]) return;
        const n = inRoom.length;
        const c = Math.ceil(Math.sqrt(n));
        const r = Math.ceil(n / c);
        fp.items[d.key] = { x: room.x + ((i % c) + 0.5) * (room.w / c), y: room.y + 30 + (Math.floor(i / c) + 0.5) * ((room.h - 30) / r) };
      });
    }
  }

  _mapSave() {
    clearTimeout(this._fpSaveT);
    this._fpSaveT = setTimeout(() => {
      const { w, h, aps } = this._fp;
      const R = Math.round;
      const rooms = this._fp.rooms.map((r) => ({ ...r, x: R(r.x), y: R(r.y), w: R(r.w), h: R(r.h) }));
      const items = Object.fromEntries(Object.entries(this._fp.items).map(([k, v]) => [k, { x: R(v.x), y: R(v.y), z: v.z ?? null }]));
      api("PUT", "/api/floorplan", { w, h, meters: this._fp.meters || 12, rooms, items, aps, auto_nodes: this._fp.auto_nodes || [] }).catch((err) => this._showToast(`地圖沒有存到：${err.message}`));
    }, 400);
  }

  async _mapUpload(file) {
    try {
      // 縮到最長邊 1600px，再上傳
      const img = await new Promise((resolve, reject) => {
        const im = new Image();
        im.onload = () => resolve(im);
        im.onerror = reject;
        im.src = URL.createObjectURL(file);
      });
      const scale = Math.min(1, 1600 / Math.max(img.width, img.height));
      const c = document.createElement("canvas");
      c.width = Math.round(img.width * scale);
      c.height = Math.round(img.height * scale);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      const data = c.toDataURL("image/jpeg", 0.85);
      // 地圖的比例跟著平面圖
      const fp = this._fp;
      const nh = Math.round((1000 * c.height) / c.width);
      const sy = nh / fp.h;
      for (const r of fp.rooms) {
        r.y *= sy;
        r.h *= sy;
      }
      for (const it of Object.values(fp.items)) it.y *= sy;
      fp.w = 1000;
      fp.h = nh;
      await api("PUT", "/api/floorplan", { w: fp.w, h: fp.h, rooms: fp.rooms, items: fp.items, aps: fp.aps });
      this._fp = await api("POST", "/api/floorplan/image", { data });
      this._render();
    } catch (err) {
      this._showToast(`上傳沒有成功：${err.message || err}`);
    }
  }

  _mapPoint(e) {
    const svg = this._root.querySelector("svg.map");
    const pt = svg.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    return pt.matrixTransform(svg.getScreenCTM().inverse());
  }

  _mapDragStart(e, el) {
    e.preventDefault();
    const fp = this._fp;
    const { mdrag: kind, id } = el.dataset;
    const start = this._mapPoint(e);
    let orig;
    if (kind === "item") orig = { ...fp.items[id] };
    else orig = { ...fp.rooms.find((r) => r.id === id) };
    this._mapSel = kind === "item" ? (id.startsWith("ap:") ? { kind: "ap", id: id.slice(3) } : { kind: "dev", id }) : { kind: "room", id };
    let raf = 0;
    const move = (ev) => {
      const pt = this._mapPoint(ev);
      const dx = pt.x - start.x;
      const dy = pt.y - start.y;
      const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
      if (kind === "item") {
        fp.items[id] = { x: clamp(orig.x + dx, 0, fp.w), y: clamp(orig.y + dy, 0, fp.h) };
      } else {
        const r = fp.rooms.find((x) => x.id === id);
        if (kind === "room") {
          r.x = clamp(orig.x + dx, 0, fp.w - r.w);
          r.y = clamp(orig.y + dy, 0, fp.h - r.h);
        } else {
          r.w = clamp(orig.w + dx, 40, fp.w - r.x);
          r.h = clamp(orig.h + dy, 40, fp.h - r.y);
        }
      }
      if (!raf) raf = requestAnimationFrame(() => ((raf = 0), this._render()));
    };
    const end = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      this._mapSave();
      this._render();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    this._render();
  }

  // 每台插座到它連的 Wi-Fi 基地台的連線：路徑有多長經過人的腰到胸（0.8～1.6 公尺），越長越適合偵測走動
  _mapLinks(devs) {
    const fp = this._fp;
    const mpp = (fp.meters || 12) / fp.w; // 每單位幾公尺
    const aps = fp.aps.filter((a) => (a.ssid || a.node) && fp.items[`ap:${a.id}`]);
    const links = [];
    for (const d of devs) {
      const it = fp.items[d.key];
      if (!it || (!d.ssid && !d.node)) continue;
      // 路由器說它連在哪一台就用那一台；沒有的話用 Wi-Fi 名稱猜
      let cands = d.node ? aps.filter((a) => a.node === d.node) : [];
      if (!cands.length && d.ssid) cands = aps.filter((a) => !a.node && a.ssid === d.ssid);
      if (!cands.length) continue;
      const dist = (a) => Math.hypot(fp.items[`ap:${a.id}`].x - it.x, fp.items[`ap:${a.id}`].y - it.y);
      const ap = cands.reduce((b, a) => (dist(a) < dist(b) ? a : b));
      const at = fp.items[`ap:${ap.id}`];
      const L = dist(ap) * mpp;
      const zp = it.z ?? DEV_Z;
      const za = ap.z ?? AP_Z;
      let f;
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

  _mapPage() {
    this._mapLoad();
    const fp = this._fp;
    const edit = !!this._mapEdit;
    const head = `
      <div class="ph">
        <div><button class="link back" data-a="map-back">${ic("mdi:chevron-left")}設定</button><h1>訊號地圖</h1>
          <div class="sub">${edit ? "拖曳房間和裝置到實際的位置；拉右下角改大小" : "各裝置的 Wi-Fi 訊號：藍色好、橘色弱；點裝置看詳細、設定高度"}</div></div>
        <div class="right"><button class="btn ${edit ? "primary" : ""}" data-a="map-edit">${edit ? "完成" : `${ic("mdi:pencil")}編輯`}</button></div>
      </div>`;
    if (!fp || !fp.rooms) return `${head}<div class="card"><div class="empty">讀取中…</div></div>`;
    const W = fp.w;
    const H = fp.h;
    const devs = this._mapDevices();
    const sense = this._mapSense;
    const motion = Object.fromEntries((sense?.devices || []).map((d) => [d.key, d.now]));
    const layer = this._mapLayer || "signal";
    const placed = devs.filter((d) => fp.items[d.key]);

    // 訊號覆蓋：用擺好的裝置的訊號強度（反距離加權）推算每一格
    // 每個裝置周圍一圈柔和的光暈，顏色代表它的訊號；沒有裝置的地方不上色（不用猜的）
    const glowR = Math.max(60, Math.min(220, 2.2 / ((fp.meters || 12) / W)));
    const heat =
      layer === "signal"
        ? placed
            .filter((d) => d.online && d.rssi != null)
            .map((d) => `<circle cx="${fp.items[d.key].x}" cy="${fp.items[d.key].y}" r="${glowR.toFixed(0)}" fill="url(#g-${sigQ(d.rssi)})"/>`)
            .join("")
        : "";
    const grad = ["good", "mid", "weak"].map((q) => `<radialGradient id="g-${q}" class="g-${q}"><stop offset="0"/><stop offset="1"/></radialGradient>`).join("");
    // 標記大小跟著螢幕寬度：手機上地圖縮得很小，標記要放大才看得到
    const px = this._root.querySelector("svg.map")?.clientWidth || Math.min(innerWidth - 64, 900);
    const k = Math.max(1, Math.min(2.1, (W / px) * 0.85));
    const showNames = k < 1.9;
    const clip = `<clipPath id="rooms">${fp.rooms.map((r) => `<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" rx="10"/>`).join("")}</clipPath>`;
    const img = fp.image ? `<image href="/api/floorplan/image?v=${encodeURIComponent(fp.image)}" x="0" y="0" width="${W}" height="${H}" preserveAspectRatio="xMidYMid meet" class="bgimg"/>` : "";
    const rooms = fp.rooms
      .map((r) => {
        const sel = edit && this._mapSel?.kind === "room" && this._mapSel.id === r.id;
        return `<g class="room ${sel ? "sel" : ""}">
          <rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" rx="10" ${edit ? `data-mdrag="room" data-id="${esc(r.id)}"` : ""}/>
          <text x="${r.x + 12 * k}" y="${r.y + 24 * k}" class="rl" style="font-size:${15 * k}px">${esc(r.name)}</text>
          ${edit ? `<rect class="rh" x="${r.x + r.w - 20 * k}" y="${r.y + r.h - 20 * k}" width="${18 * k}" height="${18 * k}" rx="${4 * k}" data-mdrag="resize" data-id="${esc(r.id)}"/>` : ""}
        </g>`;
      })
      .join("");
    const sigText = (v) => (v == null ? "—" : `${v}`);
    const weak = (v) => v != null && v < -70;
    const links = this._mapLinks(devs);
    const showLinks = edit || layer === "motion";
    const linesSvg = showLinks
      ? links
          .map((l) => {
            const m = motion[l.dev.key];
            const hot = layer === "motion" && !edit && m != null && m > 0.15;
            return `<line class="link ${l.q} ${hot ? "hot" : ""}" x1="${l.x1}" y1="${l.y1}" x2="${l.x2}" y2="${l.y2}" style="stroke-width:${((hot ? 3 + Math.min(m, 3) * 1.5 : 2.5) * k).toFixed(1)}px${hot ? `;--a:${Math.min(1, 0.35 + m / 3).toFixed(2)}` : ""}"/>`;
          })
          .join("")
      : "";
    const qText = { good: "適合偵測走動", ok: "勉強可以偵測走動", poor: "不太適合偵測走動" };
    const markers = placed
      .map((d) => {
        const it = fp.items[d.key];
        const m = motion[d.key];
        const ring = layer === "motion" && m != null && m > 0.15 ? `<circle r="${20 + Math.min(m, 3) * 12}" class="halo" style="--a:${Math.min(1, m / 3).toFixed(2)}"/>` : "";
        const sel = this._mapSel?.kind === "dev" && this._mapSel.id === d.key;
        const tip = `${d.full}：${d.online ? `訊號 ${sigText(d.rssi)} dBm` : "離線"}${m != null ? `・擾動 ${fmt(m, 1)}` : ""}`;
        return `<g class="mk ${d.online && d.rssi != null ? sigQ(d.rssi) : ""} ${d.online ? "" : "off"} ${sel ? "sel" : ""}" transform="translate(${it.x} ${it.y}) scale(${k.toFixed(2)})" ${edit ? `data-mdrag="item" data-id="${esc(d.key)}"` : `data-a="map-pick" data-v="${esc(d.key)}"`} data-tip="${esc(tip)}">
          ${ring}<circle r="15" class="dot"/><text class="v" y="5">${layer === "motion" ? (m == null ? "·" : fmt(m, 1)) : sigText(d.rssi)}</text>
          ${showNames || sel ? `<text class="n" y="31">${esc(shortName(d.name, 6))}</text>` : ""}</g>`;
      })
      .join("");
    const aps = fp.aps
      .filter((a) => fp.items[`ap:${a.id}`])
      .map((a) => {
        const it = fp.items[`ap:${a.id}`];
        const sel = this._mapSel?.kind === "ap" && this._mapSel.id === a.id;
        return `<g class="ap ${sel ? "sel" : ""}" transform="translate(${it.x} ${it.y}) scale(${k.toFixed(2)})" ${edit ? `data-mdrag="item" data-id="ap:${esc(a.id)}"` : `data-a="map-pick" data-v="ap:${esc(a.id)}"`} data-tip="${esc(a.name)}">
          <circle r="18" class="bg"/><path d="M-9,-1 Q0,-10 9,-1 M-5,3 Q0,-2 5,3" class="w"/><circle cy="7" r="2.3" class="wd"/>
          ${showNames || sel ? `<text class="n apn" y="34">${esc(shortName(a.name, 9))}</text>` : ""}</g>`;
      })
      .join("");
    const svg = `
      <svg class="map ${edit ? "editing" : ""}" viewBox="0 0 ${W} ${H}" role="img" aria-label="訊號地圖">
        <defs>${clip}${grad}</defs>
        ${img}
        <g class="roomsbg">${fp.rooms.map((r) => `<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" rx="10"/>`).join("")}</g>
        ${heat ? `<g clip-path="url(#rooms)">${heat}</g>` : ""}
        ${rooms}<g class="links">${linesSvg}</g>${aps}${markers}
      </svg>`;
    const dflt = layer === "signal" ? "滑過裝置看訊號強度" : sense?.enabled === false ? "Wi-Fi 感測已暫停（設定 → Wi-Fi 感測）" : "橘色光圈越大，那附近越可能有人在走動・每 10 秒更新";
    const legend =
      layer === "signal"
        ? `<span class="legend sig"><b class="good"></b>強<b class="mid"></b>普通<b class="weak"></b>弱</span>`
        : `<span class="legend warm">安靜<i style="--a:.15"></i><i style="--a:.4"></i><i style="--a:.7"></i><i style="--a:1"></i>擾動大</span>${links.length ? `<span class="legend lk"><b class="good"></b>適合偵測的線<b class="poor"></b>不太適合</span>` : ""}`;
    const tools = edit
      ? `<div class="maptools">
          <button class="btn sm" data-a="map-room-add">${ic("mdi:plus")}房間</button>
          <button class="btn sm" data-a="map-ap-add">${ic("mdi:wifi")}Wi-Fi 基地台</button>
          <button class="btn sm" data-a="map-image">${ic("mdi:plus")}${fp.image ? "換" : "上傳"}平面圖</button>
          ${fp.image ? `<button class="btn sm" data-a="map-image-del" data-confirm="移除平面圖？" data-confirm-text="只移除底圖，房間和裝置的位置會保留。" data-confirm-ok="移除">移除平面圖</button>` : ""}
          <button class="btn sm" data-a="map-auto" data-confirm="重新自動排版？" data-confirm-text="房間會依家庭中控的房間重新排列，裝置放回各自的房間；Wi-Fi 基地台的位置保留。" data-confirm-ok="重新排版" data-confirm-safe="1">重新自動排版</button>
          <input type="file" accept="image/*" data-map-file data-c="map-file" hidden>
        </div>`
      : `<div class="maptools"><div class="seg">${[["signal", "訊號強度"], ["motion", "動靜"]]
          .map(([k, l]) => `<button class="${layer === k ? "sel" : ""}" data-a="map-layer" data-v="${k}">${l}</button>`)
          .join("")}</div><div class="end">${legend}</div></div>`;
    // 編輯：選到的房間／基地台可以改名、刪除；還沒擺上去的裝置
    let side = "";
    const sel = this._mapSel;
    let picked = "";
    {
      const zSel = (val, opts) =>
        `<select class="gsel" data-c="map-z" aria-label="高度">${opts.map(([v, l]) => `<option value="${v}" ${Math.abs(v - val) < 0.01 ? "selected" : ""}>${l}（${v} 公尺）</option>`).join("")}${opts.some(([v]) => Math.abs(v - val) < 0.01) ? "" : `<option selected value="${val}">${val} 公尺</option>`}</select>`;
      const ssids = [...new Set(devs.map((d) => d.ssid).filter(Boolean))];
      const nodes = this._mapSense?.net?.nodes || [];
      let selHtml = "";
      if (edit) selHtml = `<p class="desc">點房間、裝置或 Wi-Fi 基地台可以選取；拖曳移動，房間拉右下角的小方塊改大小。</p>
        <div class="q">地圖的實際寬度 <small>用來算距離</small></div>
        <div class="field"><input class="text num" type="number" min="2" max="100" step="0.5" inputmode="decimal" data-c="map-meters" value="${fp.meters || 12}" aria-label="實際寬度"><span class="unit">公尺</span></div>`;
      if (sel?.kind === "room" && edit) {
        const r = fp.rooms.find((x) => x.id === sel.id);
        if (r)
          selHtml = `<div class="q">房間名稱</div><div class="field"><input class="text" data-c="map-name" value="${esc(r.name)}" maxlength="20" aria-label="房間名稱"><button class="btn danger" data-a="map-room-del" data-v="${esc(r.id)}" data-confirm="從地圖移除這個房間？" data-confirm-text="只影響地圖，家庭中控的房間設定不變。" data-confirm-ok="移除">移除</button></div>`;
      } else if (sel?.kind === "ap") {
        const a = fp.aps.find((x) => x.id === sel.id);
        if (a)
          selHtml = `${edit ? `<div class="q">Wi-Fi 基地台名稱</div><div class="field"><input class="text" data-c="map-name" value="${esc(a.name)}" maxlength="30" aria-label="名稱"><button class="btn danger" data-a="map-ap-del" data-v="${esc(a.id)}" data-confirm="移除這個 Wi-Fi 基地台？" data-confirm-text="只從地圖移除。" data-confirm-ok="移除">移除</button></div>` : `<div class="q">${esc(a.name)}</div>`}
            ${
              nodes.length
                ? `<div class="q">這是哪一台 <small>從路由器讀到的；連在這台的裝置會自動畫線</small></div>
            <select class="gsel" data-c="map-ap-node" aria-label="哪一台"><option value="">還沒選</option>${nodes.map((n) => `<option value="${esc(n.mac)}" ${a.node === n.mac ? "selected" : ""}>${esc(n.model)}（${n.main ? "主路由器" : "節點"}）</option>`).join("")}</select>`
                : `<div class="q">它發出的 Wi-Fi <small>連這個 Wi-Fi 的插座會畫一條線連到它</small></div>
            <select class="gsel" data-c="map-ap-ssid" aria-label="Wi-Fi 名稱"><option value="">還沒選</option>${ssids.map((x) => `<option ${a.ssid === x ? "selected" : ""}>${esc(x)}</option>`).join("")}</select>`
            }
            <div class="q">放的高度 <small>放高一點，訊號線才會穿過人的身體</small></div>
            ${zSel(a.z ?? AP_Z, AP_HEIGHTS)}
            <p class="desc" style="margin-top:8px">${links.filter((l) => l.ap.id === a.id).length} 台插座連到這裡</p>`;
      } else if (sel?.kind === "dev") {
        const d = devs.find((x) => x.key === sel.id);
        const l = links.find((x) => x.dev.key === sel.id);
        const linkTxt = l
          ? `連到「${esc(l.ap.name)}」${l.guess ? "（同名的 Wi-Fi 有好幾台，先猜最近的）" : ""}，相距約 ${fmt(l.L, 1)} 公尺，其中約 ${fmt(l.band, 1)} 公尺經過人的腰到胸的高度：<b>${qText[l.q]}</b>`
          : d?.node
            ? `連在 ${esc((this._mapSense?.net?.nodes || []).find((n) => n.mac === d.node)?.model || "")}，在地圖上加一台 Wi-Fi 基地台、選這一台，就會畫出連線`
            : d?.ssid
              ? `連「${esc(d.ssid)}」，在地圖上加一台 Wi-Fi 基地台、選這個 Wi-Fi，就會畫出連線`
              : "";
        if (d)
          selHtml = `<div class="q">${esc(d.full)}</div><p class="desc">訊號 ${sigText(d.rssi)} dBm${linkTxt ? `・${linkTxt}` : ""}</p>
            <div class="q">${d.router ? "放在多高" : "插在多高"}</div>${zSel(fp.items[d.key].z ?? DEV_Z, DEV_HEIGHTS)}
            ${edit ? `<button class="btn sm" data-a="map-unplace" data-v="${esc(d.key)}" style="margin-top:12px">從地圖拿下來</button>` : ""}`;
      }
      picked = selHtml;
    }
    if (edit) {
      const selHtml = picked;
      const tray = devs.filter((d) => !fp.items[d.key]);
      side = `
        <section class="card mapside">
          <div class="ch"><div class="n">選取的項目</div></div><div class="pad">${selHtml}</div>
          ${tray.length ? `<div class="ch"><div class="n">還沒擺上去的裝置</div></div><div class="chips pad">${tray.map((d) => `<button class="chip" data-a="map-place" data-v="${esc(d.key)}">${ic("mdi:plus")}${esc(d.name)}</button>`).join("")}</div>` : ""}
        </section>`;
    } else {
      const weakDevs = devs.filter((d) => d.online && weak(d.rssi));
      const off = devs.filter((d) => !d.online);
      const pickCard = picked && (sel?.kind === "dev" || sel?.kind === "ap")
        ? `<section class="card mapside"><div class="ch"><div class="n">${sel.kind === "ap" ? "Wi-Fi 基地台" : "裝置"}</div><div class="end"><button class="x" data-a="map-unpick" aria-label="關閉">${ic("mdi:close")}</button></div></div><div class="pad">${picked}</div></section>`
        : "";
      side = `${pickCard}
        <section class="card mapside">
          <div class="ch"><div class="n">訊號狀況</div></div>
          <div class="pad">
            ${weakDevs.length ? weakDevs.map((d) => `<div class="netwarn">${ic("mdi:alert-circle-outline")}<span><b>${esc(d.full)}</b>：訊號 ${d.rssi} dBm，偏弱，容易斷線。可以考慮把 Wi-Fi 基地台移近一點。</span></div>`).join("") : `<p class="desc">${ic("mdi:check-circle")} 所有裝置的訊號都在 -70 dBm 以上。</p>`}
            ${off.length ? `<div class="netwarn">${ic("mdi:wifi-off")}<span>${off.length} 台離線：${esc(off.map((d) => d.name).join("、"))}</span></div>` : ""}
            ${
              layer === "motion"
                ? links.length
                  ? `<p class="desc" style="margin-top:10px"><b>${links.filter((l) => l.q === "good").length} 條線適合偵測走動</b>${links.some((l) => l.q === "good") ? `：${esc(links.filter((l) => l.q === "good").map((l) => l.dev.name).join("、"))}` : ""}。實線穿過人的腰到胸的高度，有人走過去訊號會明顯跳動；虛線大多貼著地面或太短。</p>`
                  : `<p class="desc" style="margin-top:10px">在「編輯」裡加上 Wi-Fi 基地台、選它是哪一台和放的高度，就會畫出每台裝置到基地台的訊號線，看得出哪幾條適合偵測走動。電視、電腦也能當感測器：到「設定 → 網路裝置」點它、打開「放到訊號地圖」。</p>`
                : fp.aps.length
                  ? ""
                  : `<p class="desc" style="margin-top:10px">按右上角「編輯」可以把你的 Wi-Fi 基地台也擺上去，比較容易看出哪裡離基地台太遠。</p>`
            }
            <p class="desc" style="margin-top:10px">點裝置或 Wi-Fi 基地台可以設定它放的高度。裝置周圍的顏色是它的訊號：藍色強（-55 dBm 以上）、淡藍普通、橘色弱（低於 -70，容易斷線）。</p>
          </div>
        </section>`;
    }
    return `${head}
      <div class="mapgrid">
        <section class="card mapcard viz">
          ${tools}
          <div class="readout-line" data-default="${esc(dflt)}">${esc(dflt)}</div>
          <div class="mapwrap">${svg}</div>
        </section>
        ${side}
      </div>`;
  }

  _numberRow(key, label, desc, unit, step) {
    const v = this._s.settings[key];
    return `
      <div class="set">
        <div class="tx"><div class="l">${label}</div><div class="s">${desc}</div></div>
        <div class="num">
          <button data-a="step" data-v="${key}" data-d="${-step}" aria-label="減少">−</button>
          <input type="number" inputmode="decimal" data-c="number" data-v="${key}" value="${esc(+v)}" step="${step}" aria-label="${label}">
          <button data-a="step" data-v="${key}" data-d="${step}" aria-label="增加">+</button>
          <span class="u">${unit}</span>
        </div>
      </div>`;
  }

  // ── 設定 ──

  _settingsPage() {
    const set = this._s.settings;
    const metered = this._plugs.some((p) => p.mode === "metered");
    return `
      <div class="ph"><div><h1>設定</h1></div></div>
      <div class="grid">
        <section class="card">
          <div class="ch"><div class="ri">${ic("mdi:bell-outline")}</div><div class="n">提醒與通知</div></div>
          ${this._numberRow("long_on_hours", "開太久提醒", "插座開超過這麼久，名稱下方會變橘色（常開的不算）", "小時", 1)}
          ${metered ? this._numberRow("overload_watts", "功率過高通知", "有計量的插座超過這個瓦數 1 分鐘就通知", "W", 50) : ""}
          ${metered ? this._numberRow("standby_watts", "待機門檻", "有計量的插座開著但低於這個瓦數，就當作待機", "W", 0.5) : ""}
          <div class="set">
            <div class="tx"><div class="l">手機通知</div>
            <div class="s">手機裝 ntfy App，訂閱一個只有你知道的名稱（例如 home-plugs-8f3k），再填到下面。定時關閉、插座斷線時會通知你。</div></div>
          </div>
          <div class="inline">
            <input class="text" data-c="ntfy" value="${esc(set.ntfy_topic)}" placeholder="ntfy 主題名稱" autocapitalize="off" autocomplete="off" spellcheck="false" aria-label="ntfy 主題名稱">
            <button class="btn" style="height:46px" data-a="test-notify">${ic("mdi:bell-outline")}測試</button>
          </div>
          <div class="set">
            <div class="tx"><div class="l">每週摘要</div><div class="s">每週日晚上 8 點推播：這週的電費、開最久的電器、新連上網路的裝置、Wi-Fi 斷線次數、用最多網路的裝置</div></div>
            <button class="btn sm" data-a="weekly-preview">預覽</button>
            <button class="sw ${set.weekly !== false ? "on" : ""}" data-a="weekly-toggle" role="switch" aria-checked="${set.weekly !== false}" aria-label="每週摘要"></button>
          </div>
        </section>
        ${this._googleHtml()}
        <section class="card">
          <div class="ch"><div class="ri">${ic("mdi:magnify")}</div><div class="n">裝置</div></div>
          ${this._netCheckHtml()}
          <button class="set tapset" data-a="map-open">
            <div class="tx"><div class="l">訊號地圖</div><div class="s">在平面圖上看每個裝置的 Wi-Fi 訊號、哪裡有動靜</div></div>
            ${ic("mdi:chevron-right")}
          </button>
          <button class="set tapset" data-a="net-open">
            <div class="tx"><div class="l">網路裝置與在家的人</div><div class="s">${esc(this._routerLine())}</div></div>
            ${ic("mdi:chevron-right")}
          </button>
          <button class="set tapset" data-a="sense-open">
            <div class="tx"><div class="l">Wi-Fi 感測 <span class="badge wait">實驗</span></div><div class="s">用插座的訊號擾動，猜哪裡有人在走動</div></div>
            ${ic("mdi:chevron-right")}
          </button>
          <button class="set tapset" data-a="cloud-open">
            <div class="tx"><div class="l">TP-Link 雲端</div><div class="s">${this._cloudBound().length ? `${this._cloudBound().length} 個插座綁著 TP-Link 帳號` : "已和 TP-Link 帳號解除綁定"}・家庭中控和 Google Home 都不需要它</div></div>
            ${ic("mdi:chevron-right")}
          </button>
          <div class="set">
            <div class="tx"><div class="l">找新插座</div><div class="s">每分鐘會自動找一次；剛插上的插座可以按這裡馬上找</div></div>
            <button class="btn" data-a="discover">現在找</button>
          </div>
          <div class="set">
            <div class="tx"><div class="l">連線</div><div class="s">${this._connected ? "和樹莓派連線正常" : "連不上樹莓派，重新連線中"}</div></div>
            <span class="led ${this._connected ? "" : "bad"}"></span>
          </div>
        </section>
      </div>`;
  }

  // Google Home（Matter）配對：狀態由 Matterbridge 外掛回報
  _googleHtml() {
    const m = this._s.matter;
    const head = (badge) => `<div class="ch"><div class="ri">${ic("mdi:microphone")}</div><div class="n">Google Home</div><div class="end">${badge}</div></div>`;
    const admin = `
      <div class="set">
        <div class="tx"><div class="l">Matterbridge 管理頁</div><div class="s">進階：看紀錄、重設配對。只能從這裡點進去</div></div>
        <a class="btn" href="/matterbridge" target="_blank" rel="noopener">打開</a>
      </div>`;
    if (!m || !m.running) {
      return `
        <section class="card">
          ${head('<span class="badge">沒有在執行</span>')}
          <p class="desc">用 Google Home 語音或 App 控制插座（Matter，不經過 TP-Link 雲端）。要先在樹莓派上啟動串接：<br><code>cd app &amp;&amp; docker compose up -d matterbridge</code></p>
        </section>`;
    }
    if (m.commissioned) {
      const names = [...new Set(m.fabrics.map((f) => f.vendor))];
      return `
        <section class="card">
          ${head('<span class="badge ok">已連上</span>')}
          <p class="desc">${m.plugs} 個插座已加入${esc(names.join("、") || "Google Home")}。可以說「Hey Google，關掉${esc(this._plugs[0]?.name || "立燈")}」。<br>
          名稱和房間在 Google Home App 裡設定。要再加到 Apple 家庭或 Alexa：在 Google Home 打開任一個插座 → 設定 →「連結的 Matter 應用程式與服務」。</p>
          <div class="set">
            <div class="tx"><div class="l">情境也放到 Google Home</div><div class="s">每個情境變成一個開關，說「Hey Google，打開${esc(this._scenes[0]?.name || "出門")}」就執行；執行完會自己變回關</div></div>
            <button class="sw ${this._s.settings.matter_scenes !== false ? "on" : ""}" data-a="matter-scenes" role="switch" aria-checked="${this._s.settings.matter_scenes !== false}" aria-label="情境也放到 Google Home"></button>
          </div>
          ${admin}
        </section>`;
    }
    const code = m.manual_code.replace(/^(\d{4})(\d{3})(\d{4})$/, "$1-$2-$3");
    return `
      <section class="card">
        ${head('<span class="badge wait">等待配對</span>')}
        <p class="desc">用 Google Home 語音或 App 控制插座，不經過 TP-Link 雲端。需要家裡有 Nest 音箱、Nest Hub 或 Google TV。</p>
        <div class="pair">
          <img src="/api/matter/qr.svg?c=${encodeURIComponent(m.manual_code)}" alt="配對 QR code">
          <div><div class="desc">或輸入配對碼</div><div class="pair-code">${esc(code)}</div></div>
        </div>
        <ol class="steps">
          <li>打開 <b>Google Home</b> App →「＋」→「裝置」→「新裝置」→ 選家庭</li>
          <li>選「<b>Matter 裝置</b>」，掃上面的 QR code（或輸入配對碼）</li>
          <li>出現「未經認證的裝置」時選「<b>仍要繼續</b>」</li>
          <li>${m.plugs} 個插座會一次加進來，再把它們分到房間</li>
        </ol>
        <p class="desc">配對的手機要和樹莓派在同一個 Wi-Fi。</p>
        ${admin}
      </section>`;
  }

  // ───────────── 事件（全部用事件委派，畫面重畫也不用重新綁） ─────────────

  _onClick(e) {
    if (this._noClick) return; // 剛拖完滾輪，不算點擊
    const t = e.target.closest("[data-a]");
    if (!t || t.disabled) return;
    const fn = this._actions[t.dataset.a];
    if (fn) fn(t.dataset.v, t, e);
  }

  _onKey(e) {
    if (e.key === "Escape" && this._sheet) return this._closeSheet();
    const t = e.target;
    if ((e.key === "ArrowUp" || e.key === "ArrowDown") && t.matches?.(".wcol")) {
      e.preventDefault();
      t.scrollBy({ top: e.key === "ArrowUp" ? -WHEEL_ROW : WHEEL_ROW, behavior: "smooth" });
      return;
    }
    if ((e.key === "ArrowUp" || e.key === "ArrowDown") && t.matches?.("[data-drag]")) {
      e.preventDefault();
      const { drag: kind, v } = t.dataset;
      this._move(kind, v, e.key === "ArrowUp" ? -1 : 1);
      this.shadowRoot.querySelector(`[data-drag="${kind}"][data-v="${CSS.escape(v)}"]`)?.focus();
      return;
    }
    if ((e.key === "Enter" || e.key === " ") && t.matches?.('.row[role="button"], .sched[role="button"]')) {
      e.preventDefault();
      t.click();
    }
    if (e.key === "Enter" && t.matches?.("input[data-c]")) t.blur();
    if (e.key === "Enter" && t.matches?.("[data-enter]")) this._actions[t.dataset.enter]?.();
  }

  _onChange(e) {
    const t = e.target.closest("[data-c]");
    if (!t) return;
    const fn = this._changes[t.dataset.c];
    if (fn) fn(t.dataset.v, t, e);
  }

  get _actions() {
    const sure = (t) => {
      // 會刪掉東西或有影響的動作：先跳確認對話框（按鈕本身不變），確定後再執行一次同一個動作
      if (t.dataset.sure) {
        delete t.dataset.sure;
        return true;
      }
      this._confirm({
        title: t.dataset.confirm || "確定要刪除？",
        text: t.dataset.confirmText || "這個動作不能復原。",
        ok: t.dataset.confirmOk || t.textContent.trim(),
        danger: !t.dataset.confirmSafe,
      }).then((yes) => {
        if (!yes || !t.isConnected) return;
        t.dataset.sure = "1";
        t.click();
      });
      return false;
    };
    const redraw = (fn) => () => {
      fn(this._sheet.draft);
      this._renderSheet();
    };
    return {
      tab: (v) => this._go(v),
      toggle: (v) => this._guardedToggle(v),
      "confirm-power": () => {
        const id = this._sheet.id;
        this._closeSheet();
        this._toggle(id);
      },
      offline: (v) => this._showToast(`${this._plug(v)?.name || "插座"}連不上：檢查插頭有沒有插好、Wi-Fi 有沒有訊號`),
      timer: (v) => this._openDevice(v),
      dev: (v) => this._openDevice(v),
      edev: (v) => this._openSheet({ type: "edev", id: v, wide: true, live: true }),
      "edev-range": (v) => {
        this._sheet.range = v;
        this._renderSheet();
      },
      "all-off": () => this._turnOff({}),
      "room-off": (v) => this._turnOff({ room: v }),
      "room-on": async (v) => {
        try {
          const res = await api("POST", "/api/on", { room: v });
          if (!res.count) this._showToast("沒有可以打開的插座");
        } catch (err) {
          this._showToast(`沒有成功：${err.message}`);
        }
      },
      scene: (v) => this._runScene(v),
      edit: () => {
        this._edit = true;
        this._render();
        window.scrollTo(0, 0);
      },
      "edit-done": () => {
        this._edit = false;
        this._render();
        window.scrollTo(0, 0);
      },
      "plug-edit": (v) => this._openDevice(v),
      "room-edit": (v) => this._openSheet({ type: "room", id: v, name: this._room(v)?.name || "" }),
      "room-new": () => this._openSheet({ type: "room", id: null, name: "" }),
      "scene-edit": (v) => this._openSceneEditor(v),
      "scene-new": () => this._openSceneEditor(null),
      "sched-new": () => this._openSchedEditor(null),
      "habit-yes": (v) => {
        const x = this._habitList().find((h) => h.key === v);
        if (x) this._openSchedEditor(null, null, x);
      },
      "habit-no": (v) =>
        this._safe(async () => {
          await api("POST", "/api/habits/dismiss", { key: v });
        }),
      "sched-edit": (v) => this._openSchedEditor(v),
      "sched-template": (v) => this._openSchedEditor(null, v),
      "sched-toggle": (v, t) => {
        const x = (this._s.schedules || []).find((s) => s.id === v);
        if (!x) return;
        t.classList.toggle("on", !x.enabled);
        this._safe(async () => {
          await api("PUT", `/api/schedules/${v}`, { enabled: !x.enabled });
        });
      },
      "timer-cancel": (v) =>
        this._safe(async () => {
          await api("DELETE", `/api/plugs/${v}/timer`);
        }),
      step: (v, t) => this._setSetting(v, +this._s.settings[v] + Number(t.dataset.d)),
      discover: (v, t) => {
        t.disabled = true;
        this._safe(async () => {
          await api("POST", "/api/discover");
          this._showToast("找好了");
        });
      },
      "test-notify": () =>
        this._safe(async () => {
          const input = this._root.querySelector('[data-c="ntfy"]');
          await api("PUT", "/api/settings", { ntfy_topic: input.value });
          await api("POST", "/api/test-notify");
          this._showToast("已送出測試通知");
        }),

      // ── 面板裡的動作 ──
      close: () => this._closeSheet(),
      "timer-set": (v) => this._setTimer(this._sheet.id, Number(v)),
      "timer-more": () => {
        this._sheet.customTimer = !this._sheet.customTimer;
        this._renderSheet();
      },
      "dev-power": (v) => this._guardedToggle(this._sheet.id),
      protect: (v) => this._safe(() => api("PATCH", `/api/plugs/${this._sheet.id}`, { protect: v })),
      "matter-toggle": (v, t) => {
        const next = !t.classList.contains("on");
        t.classList.toggle("on", next);
        this._safe(() => api("PATCH", `/api/plugs/${this._sheet.id}`, { matter: next }));
      },
      "led-toggle": (v, t) => {
        const next = !t.classList.contains("on");
        t.classList.toggle("on", next);
        this._safe(() => api("PATCH", `/api/plugs/${this._sheet.id}`, { led: next }));
      },
      reboot: (v, t) =>
        sure(t) &&
        this._safe(async () => {
          await api("POST", `/api/plugs/${this._sheet.id}/reboot`);
          this._showToast("插座重新啟動中，大約 30 秒後恢復");
        }),
      "away-open": () => this._openAway(),
      "map-open": () => {
        this._go("map", false);
        history.pushState(null, "", "#map");
      },
      "net-open": () => {
        this._go("net", false);
        history.pushState(null, "", "#net");
      },
      "net-back": () => {
        this._go("settings", false);
        history.pushState(null, "", "#settings");
      },
      "netdev-open": (v) => this._openSheet({ type: "netdev", id: v }),
      "netdev-map": () => {
        const d = this._sheet.draft;
        d.label = this._sheetHost.querySelector("[data-netdev-label]")?.value ?? d.label;
        d.map = !d.map;
        this._renderSheet();
      },
      "netdev-save": () => {
        const s = this._sheet;
        const label = this._sheetHost.querySelector("[data-netdev-label]").value.trim();
        const body = { label: label || null };
        const c = this._netClient(s.id);
        if (c && !c.plug && !c.wired) body.map = !!s.draft.map;
        this._safe(async () => {
          this._net = await api("PATCH", `/api/net/devices/${encodeURIComponent(s.id)}`, body);
          this._closeSheet();
          if (body.map && !c.map) this._showToast("已加到訊號地圖：到地圖的「編輯」把它擺到實際的位置");
        });
      },
      "netdev-person": (v) => {
        const x = (this._s.people || []).find((p) => p.id === v);
        const mac = this._sheet.id;
        if (!x) return;
        const macs = x.macs.includes(mac) ? x.macs.filter((m) => m !== mac) : [...x.macs, mac];
        this._safe(async () => {
          await api("PUT", `/api/people/${v}`, { name: x.name, macs });
          x.macs = macs;
          await this._netRefresh();
        });
      },
      "matter-scenes": () =>
        this._safe(async () => {
          await api("PUT", "/api/settings", { matter_scenes: this._s.settings.matter_scenes === false });
        }),
      "pres-dark": () =>
        this._safe(async () => {
          await api("PUT", "/api/settings", { presence: { home_dark_only: !this._s.settings.presence?.home_dark_only } });
        }),
      "weekly-toggle": () =>
        this._safe(async () => {
          await api("PUT", "/api/settings", { weekly: this._s.settings.weekly === false });
        }),
      "weekly-preview": () =>
        this._safe(async () => {
          const r = await api("GET", "/api/weekly");
          await this._confirm({ title: "這週的家（預覽）", text: r.text || "這週還沒有資料", ok: "好", danger: false });
        }),
      "day-off": () =>
        this._safe(async () => {
          const on = !this._s.calendar?.day_off;
          await api("POST", "/api/day-off", { on });
          this._showToast(on ? "今天放假：打開「國定假日不執行」的排程今天都跳過" : "取消放假，排程照常執行");
        }),
      "newdev-toggle": () =>
        this._safe(async () => {
          await api("PUT", "/api/settings", { new_device_alert: this._s.settings.new_device_alert === false });
        }),
      "person-new": () => this._openSheet({ type: "person", id: null }),
      "person-edit": (v) => this._openSheet({ type: "person", id: v }),
      "person-mac": (v) => {
        const d = this._sheet.draft;
        d.name = this._sheetHost.querySelector("[data-person-name]")?.value ?? d.name;
        d.macs = d.macs.includes(v) ? d.macs.filter((m) => m !== v) : [...d.macs, v];
        this._renderSheet();
      },
      "person-save": () => {
        const s = this._sheet;
        const name = this._sheetHost.querySelector("[data-person-name]").value.trim();
        if (!name) return this._sheetError("請輸入名字");
        this._safe(async () => {
          if (s.id) await api("PUT", `/api/people/${s.id}`, { name, macs: s.draft.macs });
          else await api("POST", "/api/people", { name, macs: s.draft.macs });
          this._closeSheet();
          this._netRefresh();
        });
      },
      "person-delete": (v, t) =>
        sure(t) &&
        this._safe(async () => {
          await api("DELETE", `/api/people/${this._sheet.id}`);
          this._closeSheet();
          this._netRefresh();
        }),
      "map-back": () => {
        this._mapEdit = false;
        this._go("settings", false);
        history.pushState(null, "", "#settings");
      },
      "map-edit": () => {
        this._mapEdit = !this._mapEdit;
        this._mapSel = null;
        this._render();
      },
      "map-layer": (v) => {
        this._mapLayer = v;
        this._render();
      },
      "map-pick": (v) => {
        this._mapSel = v.startsWith("ap:") ? { kind: "ap", id: v.slice(3) } : { kind: "dev", id: v };
        this._render();
        // 手機上面板在地圖下面，捲過去
        if (innerWidth < 900) requestAnimationFrame(() => this._root.querySelector(".mapside")?.scrollIntoView({ behavior: "smooth", block: "nearest" }));
      },
      "map-unpick": () => {
        this._mapSel = null;
        this._render();
      },
      "map-place": (v) => {
        const fp = this._fp;
        fp.items[v] = { x: fp.w / 2 + (Math.random() - 0.5) * 80, y: fp.h / 2 + (Math.random() - 0.5) * 80 };
        this._mapSave();
        this._render();
      },
      "map-unplace": (v) => {
        delete this._fp.items[v];
        this._mapSel = null;
        this._mapSave();
        this._render();
      },
      "map-room-add": () => {
        const fp = this._fp;
        const id = `r${Date.now().toString(36)}`;
        fp.rooms.push({ id, name: "新房間", x: fp.w / 2 - 120, y: fp.h / 2 - 90, w: 240, h: 180 });
        this._mapSel = { kind: "room", id };
        this._mapSave();
        this._render();
      },
      "map-room-del": (v, t) => {
        if (!sure(t)) return;
        this._fp.rooms = this._fp.rooms.filter((r) => r.id !== v);
        this._mapSel = null;
        this._mapSave();
        this._render();
      },
      "map-ap-add": () => {
        const fp = this._fp;
        const id = `a${Date.now().toString(36)}`;
        fp.aps.push({ id, name: `Wi-Fi 基地台 ${fp.aps.length + 1}` });
        fp.items[`ap:${id}`] = { x: fp.w / 2, y: fp.h / 2 };
        this._mapSel = { kind: "ap", id };
        this._mapSave();
        this._render();
      },
      "map-ap-del": (v, t) => {
        if (!sure(t)) return;
        this._fp.aps = this._fp.aps.filter((a) => a.id !== v);
        delete this._fp.items[`ap:${v}`];
        this._mapSel = null;
        this._mapSave();
        this._render();
      },
      "map-image": () => this._root.querySelector("[data-map-file]")?.click(),
      "map-image-del": (v, t) =>
        sure(t) &&
        this._safe(async () => {
          this._fp = await api("DELETE", "/api/floorplan/image");
          this._render();
        }),
      "map-auto": (v, t) => {
        if (!sure(t)) return;
        this._mapAutoLayout(true);
        this._mapSave();
        this._render();
      },
      "sense-open": () => {
        this._openSheet({ type: "sense", wide: true });
        const load = () =>
          api("GET", "/api/sensing")
            .then((d) => {
              if (this._sheet?.type !== "sense") return;
              this._sheet.data = d;
              this._renderSheet();
            })
            .catch(() => {});
        load();
        clearInterval(this._senseTimer);
        this._senseTimer = setInterval(load, 10000);
      },
      "sense-toggle": () =>
        this._safe(async () => {
          const on = !this._sheet.data?.enabled;
          await api("PUT", "/api/sensing", { enabled: on });
          if (this._sheet.data) this._sheet.data.enabled = on;
          this._renderSheet();
        }),
      "kasa-away-toggle": (v, t) => {
        const req = this._kasaAwayReq(v);
        this._safe(() => api("PUT", "/api/kasa-away", { ...req, enable: !t.classList.contains("on") }));
      },
      "kasa-away-delete": (v, t) => sure(t) && this._safe(() => api("DELETE", "/api/kasa-away", this._kasaAwayReq(v))),
      "kasa-adopt": (v, t) => {
        if (!sure(t)) return;
        const k = this._kasaRule(v);
        if (!k) return;
        this._safe(async () => {
          await api("POST", "/api/kasa-rules/adopt", { plug: k.p.id, match: this._ruleMatch(k.r), enabled: !!k.r.enable });
          if (this._sheet?.type === "kasa") this._closeSheet();
          this._showToast("已轉成家庭中控的排程");
        });
      },
      "kasa-toggle": (v) => {
        const k = this._kasaRule(v);
        if (!k) return;
        this._safe(() => api("PUT", "/api/kasa-rules", { plug: k.p.id, match: this._ruleMatch(k.r), set: { enable: !k.r.enable } }));
      },
      "kasa-edit": (v) => {
        const k = this._kasaRule(v);
        if (!k) return;
        const { p, r } = k;
        this._openSheet({ type: "kasa", key: v, wide: true,
          draft: { pid: p.id, sact: r.sact, mode: ["clock", "sunrise", "sunset"][r.opt], offset: r.opt ? r.val : 0, time: hhmm(r.opt ? this._ruleMin(r) : r.val),
            days: kasaDays(r.wday), enable: !!r.enable, match: this._ruleMatch(r) } });
      },
      "kasa-enable": () => redraw((d) => (d.enable = !d.enable))(),
      "kasa-mode": (v) => redraw((d) => (d.mode = v))(),
      "kasa-offset": (v) => redraw((d) => (d.offset = Math.max(-180, Math.min(180, v === "0" ? 0 : d.offset + Number(v)))))(),
      "sched-mode": (v) => redraw((d) => (d.time_mode = v))(),
      "sched-offset": (v) => redraw((d) => (d.offset_min = Math.max(-180, Math.min(180, v === "0" ? 0 : (d.offset_min || 0) + Number(v)))))(),
      "kasa-act": (v) => redraw((d) => (d.sact = Number(v)))(),
      "kasa-day": (v) => redraw((d) => (d.days = d.days.includes(Number(v)) ? d.days.filter((x) => x !== Number(v)) : [...d.days, Number(v)].sort()))(),
      "kasa-save": () => {
        const d = this._sheet.draft;
        if (!d.days.length) return this._sheetError("請至少選一天");
        const [h, m] = d.time.split(":").map(Number);
        const opt = { clock: 0, sunrise: 1, sunset: 2 }[d.mode];
        this._safe(async () => {
          await api("PUT", "/api/kasa-rules", { plug: d.pid, match: d.match, set: { enable: d.enable, sact: d.sact, opt, val: opt ? d.offset : h * 60 + m, wday: toKasaWday(d.days) } });
          this._closeSheet();
        });
      },
      "kasa-delete": (v, t) => {
        if (!sure(t)) return;
        const d = this._sheet.draft;
        this._safe(async () => {
          await api("DELETE", "/api/kasa-rules", { plug: d.pid, match: d.match });
          this._closeSheet();
        });
      },
      "away-toggle": () => {
        this._sheet.draft.enabled = !this._sheet.draft.enabled;
        this._renderSheet();
      },
      "away-plug": (v) => {
        const d = this._sheet.draft;
        d.plugs = d.plugs.includes(v) ? d.plugs.filter((x) => x !== v) : [...d.plugs, v];
        this._renderSheet();
      },
      "away-save": () =>
        this._safe(async () => {
          const d = this._sheet.draft;
          if (d.enabled && !d.plugs.length) return this._sheetError("請至少選一個插座");
          await api("PUT", "/api/away", d);
          this._closeSheet();
        }),
      "cloud-open": () => this._openSheet({ type: "cloud" }),
      "cloud-unbind": (v, t) =>
        sure(t) &&
        this._safe(async () => {
          this._showToast("斷開中…");
          const res = await api("POST", "/api/cloud/unbind", { confirm: "斷開" });
          this._closeSheet();
          this._showToast(res.failed ? `斷開 ${res.ok} 台，${res.failed} 台沒有回應` : `已斷開 ${res.ok} 台插座的 TP-Link 雲端`);
        }),
      "energy-range": (v) => {
        this._energyRange = v;
        this._render();
      },
      "timer-custom": () => {
        const n = this._sheet.timerDraft;
        const max = this._plug(this._sheet.id)?.max_on_s || 86400;
        if (!(n >= 1 && n <= max)) return this._sheetError(`請選 1 秒～${fmtSec(max)}`);
        this._setTimer(this._sheet.id, n);
      },
      // 滾輪：點數字就捲到那一格
      wi: (v, t) => t.closest(".wcol")?.scrollTo({ top: Number(v) * WHEEL_ROW, behavior: "smooth" }),
      // 最長開啟時間
      "max-toggle": () => {
        const p = this._plug(this._sheet.id);
        this._sheet.maxDraft = null;
        this._setMaxOn(p?.max_on_s ? null : 600);
      },
      "max-quick": (v) => {
        this._sheet.maxDraft = null;
        this._setMaxOn(Number(v));
      },
      "max-save": () => {
        const n = this._sheet.maxDraft;
        if (!(n >= 1 && n <= 86400)) return this._sheetError("請選 1 秒～24 小時");
        this._setMaxOn(n).then(() => {
          this._sheet && (this._sheet.maxDraft = null);
          this._renderSheet();
        });
      },
      "timer-stop": () =>
        this._safe(async () => {
          await api("DELETE", `/api/plugs/${this._sheet.id}/timer`);
        }),
      "keep-on": (v, t) => {
        const next = !t.classList.contains("on");
        t.classList.toggle("on", next);
        this._safe(() => api("PATCH", `/api/plugs/${this._sheet.id}`, { keep_on: next }));
      },
      "plug-save": () => this._savePlugName(),
      "watts-save": () => {
        const n = Number(this._sheetHost.querySelector("[data-watts-input]")?.value);
        if (!(n > 0 && n <= 5000)) return this._sheetError("請輸入 1～5000 W");
        this._safe(async () => {
          await api("PATCH", `/api/plugs/${this._sheet.id}`, { watts: n });
          this._closeSheet();
          this._loadEnergy(true);
        });
      },
      "room-save": () => this._saveRoom(),
      "room-delete": (v, t) =>
        sure(t) &&
        this._safe(async () => {
          await api("DELETE", `/api/rooms/${this._sheet.id}`);
          this._closeSheet();
          this._showToast("已刪除房間，裡面的插座移到「還沒分房間」");
        }),
      "scene-act": (v, t) => redraw((d) => (d.actions[v] = t.dataset.d))(),
      "scene-all": (v) => redraw((d) => this._plugs.forEach((p) => !(v === "off" && p.keep_on) && (d.actions[p.id] = v)))(),
      "scene-others": (v) => redraw((d) => (d.others = v))(),
      "scene-icon": (v) => redraw((d) => (d.icon = v))(),
      "scene-save": () => this._saveScene(),
      "scene-delete": (v, t) =>
        sure(t) &&
        this._safe(async () => {
          await api("DELETE", `/api/scenes/${this._sheet.id}`);
          this._closeSheet();
        }),
      "sched-day": (v) =>
        redraw((d) => {
          const n = Number(v);
          d.days = d.days.includes(n) ? d.days.filter((x) => x !== n) : [...d.days, n].sort();
        })(),
      "sched-days": (v) => redraw((d) => (d.days = { all: [0, 1, 2, 3, 4, 5, 6], week: [0, 1, 2, 3, 4], end: [5, 6] }[v]))(),
      "sched-action": (v) => redraw((d) => (d.action = v))(),
      "sched-plug": (v) => redraw((d) => (d.plugs = d.plugs.includes(v) ? d.plugs.filter((x) => x !== v) : [...d.plugs, v]))(),
      "sched-room": (v) =>
        redraw((d) => {
          const ids = this._plugs.filter((p) => this._roomOf(p) === v && !(d.action === "off" && p.keep_on)).map((p) => p.id);
          const all = ids.every((id) => d.plugs.includes(id));
          d.plugs = all ? d.plugs.filter((id) => !ids.includes(id)) : [...new Set([...d.plugs, ...ids])];
        })(),
      "sched-scene": (v) => redraw((d) => (d.scene = v))(),
      "sched-restore": () => redraw((d) => (d.restore_at = d.restore_at ? null : "07:00:00"))(),
      "sched-backup": () => redraw((d) => (d.backup = !d.backup))(),
      "sched-skip": (v) => redraw((d) => (d[v] = !d[v]))(),
      "sched-duration": () => redraw((d) => (d.duration_s = d.duration_s ? null : 60))(),
      "sched-save": () => this._saveSched(),
      "sched-delete": (v, t) =>
        sure(t) &&
        this._safe(async () => {
          await api("DELETE", `/api/schedules/${this._sheet.id}`);
          this._closeSheet();
        }),
    };
  }

  get _changes() {
    return {
      "plug-room": (v, t) => this._safe(() => api("PATCH", `/api/plugs/${v}`, { room: t.value || null })),
      watts: (v, t) => {
        if (t.value === "custom") return this._openSheet({ type: "watts", id: v });
        this._safe(() => api("PATCH", `/api/plugs/${v}`, { watts: t.value ? Number(t.value) : null }));
      },
      number: (v, t) => this._setSetting(v, parseFloat(t.value)),
      ntfy: (v, t) => this._safe(() => api("PUT", "/api/settings", { ntfy_topic: t.value })),
      "sheet-room": (v, t) => this._safe(() => api("PATCH", `/api/plugs/${this._sheet.id}`, { room: t.value || null })),
      "sheet-watts": (v, t) => {
        if (t.value === "custom") return this._openSheet({ type: "watts", id: this._sheet.id });
        this._safe(async () => {
          await api("PATCH", `/api/plugs/${this._sheet.id}`, { watts: t.value ? Number(t.value) : null });
          this._loadEnergy(true);
        });
      },
      "scene-name": (v, t) => (this._sheet.draft.name = t.value),
      "map-name": (v, t) => {
        const sel = this._mapSel;
        if (!sel) return;
        const list = sel.kind === "room" ? this._fp.rooms : this._fp.aps;
        const x = list.find((r) => r.id === sel.id);
        if (x) x.name = t.value.trim().slice(0, 20) || x.name;
        this._mapSave();
        this._render();
      },
      "map-meters": (v, t) => {
        const n = Number(t.value);
        if (!(n >= 2 && n <= 100)) return;
        this._fp.meters = n;
        this._mapSave();
        this._render();
      },
      pres: (v, t) =>
        this._safe(async () => {
          const val = v === "grace_min" ? +t.value : v === "left_on" ? t.value : t.value || null;
          await api("PUT", "/api/settings", { presence: { [v]: val } });
        }),
      "map-ap-node": (v, t) => {
        const a = this._fp.aps.find((x) => x.id === this._mapSel?.id);
        if (!a) return;
        a.node = t.value || null;
        const n = (this._mapSense?.net?.nodes || []).find((x) => x.mac === a.node);
        if (n && /^Wi-Fi 基地台 \d+$/.test(a.name)) a.name = n.model;
        this._mapSave();
        this._render();
      },
      "map-ap-ssid": (v, t) => {
        const a = this._fp.aps.find((x) => x.id === this._mapSel?.id);
        if (!a) return;
        a.ssid = t.value || null;
        this._mapSave();
        this._render();
      },
      "map-z": (v, t) => {
        const sel = this._mapSel;
        const z = Number(t.value);
        if (!sel) return;
        if (sel.kind === "ap") {
          const a = this._fp.aps.find((x) => x.id === sel.id);
          if (a) a.z = z;
        } else if (sel.kind === "dev" && this._fp.items[sel.id]) this._fp.items[sel.id].z = z;
        this._mapSave();
        this._render();
      },
      "map-file": (v, t) => {
        const file = t.files?.[0];
        if (!file) return;
        this._mapUpload(file);
        t.value = "";
      },
    };
  }

  // ───────────── 動作 ─────────────

  // 有防呆設定的先確認；鎖定的打開裝置詳細說明
  _guardedToggle(id) {
    const p = this._plug(id);
    if (!p || !p.online) return;
    const on = this._isOn(p);
    if (p.protect === "lock") return this._openDevice(id);
    if (p.protect === "confirm" || (p.protect === "confirm_off" && on)) return this._openSheet({ type: "confirm", id });
    this._toggle(id);
  }

  _openDevice(id) {
    this._openSheet({ type: "device", id, live: true });
    // 插座自己記錄的使用時間（另外讀，不擋住面板）
    api("GET", `/api/plugs/${id}/usage`)
      .then((u) => {
        if (this._sheet?.id === id) {
          this._sheet.usage = u;
          this._renderSheet();
        }
      })
      .catch(() => {
        if (this._sheet?.id === id) {
          this._sheet.usage = false;
          this._renderSheet();
        }
      });
  }

  _confirmSheet(s) {
    const p = this._plug(s.id);
    if (!p) return null;
    const on = this._isOn(p);
    return `
      ${this._sheetHead(deviceIcon(p.name), on ? `關閉「${p.name}」？` : `打開「${p.name}」？`, this._room(p.room)?.name || "")}
      <p class="lead">這個裝置設定了「${PROTECT.find(([k]) => k === p.protect)?.[1] || "確認"}」，避免誤按。</p>
      <div class="actions">
        <button class="btn" data-a="close">取消</button>
        <button class="btn ${on ? "danger solid" : "primary"}" data-a="confirm-power">${on ? "關閉" : "打開"}</button>
      </div>`;
  }

  _awaySheet(s) {
    const d = s.draft;
    const chips = this._groups()
      .map((g) => {
        const list = g.plugs.filter((p) => !p.keep_on && !p.max_on_s && p.protect !== "lock");
        if (!list.length) return "";
        return `<div class="group-title">${esc(g.name)}</div><div class="chips">${list
          .map((p) => `<button class="chip ${d.plugs.includes(p.id) ? "sel" : ""}" data-a="away-plug" data-v="${esc(p.id)}">${d.plugs.includes(p.id) ? ic("mdi:check") : ""}${esc(p.name)}</button>`)
          .join("")}</div>`;
      })
      .join("");
    return `
      ${this._sheetHead("mdi:home-outline", "離家模式", "不在家時，讓燈隨機開關，看起來像有人在")}
      <div class="group power"><div class="gi"><div class="gt"><div class="gl">啟用離家模式</div><div class="gs">由插座自己執行，樹莓派離線也照跑</div></div>
        <button class="sw ${d.enabled ? "on" : ""}" data-a="away-toggle" role="switch" aria-checked="${d.enabled}" aria-label="啟用離家模式"></button></div></div>
      <div class="cols"><div class="col">
      <div class="q">每天這段時間</div>
      <div class="range"><div><div class="rl">開始</div>${hmPicker("away_start", d.start)}</div><div><div class="rl">結束</div>${hmPicker("away_end", d.end)}</div></div>
      </div><div class="col">
      <div class="q">要隨機開關的插座 <small>常開、鎖定、有最長開啟時間的不會出現</small></div>
      ${chips || `<p class="note">沒有可以用的插座。</p>`}
      </div></div>
      <div class="err"></div>
      <div class="actions"><button class="btn" data-a="close">取消</button><button class="btn primary" data-a="away-save">儲存</button></div>`;
  }

  _openAway() {
    const a = this._s.settings.away || {};
    const lights = this._plugs.filter((p) => deviceIcon(p.name) === "mdi:lightbulb" && !p.keep_on && !p.max_on_s && p.protect !== "lock").map((p) => p.id);
    this._openSheet({
      type: "away",
      wide: true,
      draft: { enabled: !!a.enabled, start: a.start || "18:00", end: a.end || "23:00", plugs: a.plugs?.length ? [...a.plugs] : lights },
    });
  }

  // 還綁著 TP-Link 帳號的插座（排插算一台）；還沒讀到的當作綁著
  _cloudBound() {
    const devs = new Map();
    for (const p of this._plugs) if (p.online) devs.set(p.device, p);
    return [...devs.values()].filter((p) => p.net?.cloud_bound !== false);
  }

  _cloudSheet() {
    const devs = new Set(this._plugs.filter((p) => p.online).map((p) => p.device)).size;
    const on = this._cloudBound().length;
    if (!on)
      return `
      ${this._sheetHead("mdi:cloud-off-outline", "TP-Link 雲端", `${devs} 台插座都已解除綁定`)}
      <p class="lead">所有插座都已經和你的 TP-Link 帳號<b>解除綁定</b>。</p>
      <ul class="bul">
        <li>家庭中控、Google Home、排程、插座內建的排程照常運作</li>
        <li>Kasa App 只能在家裡同一個 Wi-Fi 下控制，在外面不行</li>
        <li>插座還是會連到 TP-Link 的伺服器（主要是查韌體更新），但已經不屬於任何帳號</li>
        <li>想恢復的話，要用 Kasa App 重新設定插座</li>
      </ul>
      <div class="actions"><button class="btn primary" data-a="close">好</button></div>`;
    return `
      ${this._sheetHead("mdi:cloud-outline", "TP-Link 雲端", `${on}／${devs} 台插座綁著 TP-Link 帳號`)}
      <p class="lead">家庭中控和 Google Home（Matter）都在家裡直接控制插座，<b>不需要</b> TP-Link 雲端。斷開後：</p>
      <ul class="bul">
        <li>插座不再和 TP-Link 的伺服器連線，隱私比較好</li>
        <li>Kasa App 在外面不能控制，家裡同一個 Wi-Fi 還可以</li>
        <li>家庭中控、Google Home、排程、插座內建的排程都不受影響</li>
        <li>想恢復的話，要用 Kasa App 重新設定插座</li>
      </ul>
      <div class="actions"><button class="btn" data-a="close">先不要</button><button class="btn danger solid" data-a="cloud-unbind" data-confirm="斷開所有插座的 TP-Link 雲端？" data-confirm-text="之後 Kasa App 只能在家裡的 Wi-Fi 使用；要恢復得用 Kasa App 重新設定插座。家庭中控和 Google Home 不受影響。" data-confirm-ok="斷開">斷開所有插座</button></div>`;
  }

  // 確認對話框：回傳 Promise<boolean>
  _confirm({ title, text, ok, danger = true }) {
    return new Promise((resolve) => {
      const host = this._confirmHost;
      const done = (v) => {
        host.innerHTML = "";
        document.removeEventListener("keydown", onKey, true);
        resolve(v);
      };
      const onKey = (e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          done(false);
        }
      };
      host.innerHTML = `
        <div class="cwrap" data-cback>
          <div class="cbox" role="alertdialog" aria-modal="true" aria-labelledby="ct" aria-describedby="cd">
            <div class="ct" id="ct">${esc(title)}</div>
            <div class="cd" id="cd">${esc(text)}</div>
            <div class="cact"><button class="btn" data-c-no>取消</button><button class="btn ${danger ? "danger solid" : "primary"}" data-c-yes>${esc(ok)}</button></div>
          </div>
        </div>`;
      host.querySelector("[data-c-no]").addEventListener("click", () => done(false));
      host.querySelector("[data-c-yes]").addEventListener("click", () => done(true));
      host.querySelector("[data-cback]").addEventListener("click", (e) => e.target.matches("[data-cback]") && done(false));
      document.addEventListener("keydown", onKey, true);
      // 用鍵盤／滑鼠的裝置才把焦點放到「取消」（手機上不顯示焦點框）
      if (matchMedia("(hover: hover) and (pointer: fine)").matches) host.querySelector("[data-c-no]").focus({ focusVisible: false });
    });
  }

  _toggle(id) {
    const p = this._plug(id);
    if (!p || !p.online) return;
    const target = !this._isOn(p);
    this._pending.set(id, target);
    this._render();
    api("POST", `/api/plugs/${id}/power`, { on: target })
      .catch((err) => {
        this._pending.delete(id);
        this._showToast(`${p.name} 沒有回應：${err.message}`);
      })
      .finally(() => {
        // 伺服器推新狀態時會清掉；萬一沒推，5 秒後也清掉
        setTimeout(() => {
          if (this._pending.get(id) === target) {
            this._pending.delete(id);
            this._update();
          }
        }, 5000);
        this._update();
      });
  }

  async _turnOff(body) {
    try {
      const res = await api("POST", "/api/off", body);
      // 整間關閉：結果就在眼前，不提示；全部關閉會動到畫面外的插座，提示並可以復原
      if (!res.count) this._showToast("沒有開著的插座");
      else if (!body.room) this._showToast(`已關閉 ${res.count} 個插座`, true);
    } catch (err) {
      this._showToast(`沒有成功：${err.message}`);
    }
  }

  async _runScene(id) {
    const sc = this._scenes.find((s) => s.id === id);
    try {
      const res = await api("POST", `/api/scenes/${id}/run`);
      this._showToast(res.count ? `「${sc?.name}」：改了 ${res.count} 個插座` : `「${sc?.name}」：插座本來就是這樣`, res.count > 0);
    } catch (err) {
      this._showToast(`沒有成功：${err.message}`);
    }
  }

  // 滾輪捲到目前的值（剛打開、或值被別的地方改了；使用者正在滑的不動）
  _syncWheels() {
    for (const col of this._sheetHost.querySelectorAll(".wcol")) {
      const want = Number(col.dataset.val) * WHEEL_ROW;
      if (col._busy) continue;
      if (!col._init || Math.abs(col.scrollTop - want) > 2) {
        col._init = true;
        col._sync = true;
        col.scrollTop = want;
      }
    }
  }

  _wheelDrag(e, col) {
    e.preventDefault();
    const y0 = e.clientY;
    const top0 = col.scrollTop;
    let moved = false;
    col._drag = true;
    const move = (ev) => {
      const dy = ev.clientY - y0;
      if (!moved && Math.abs(dy) < 4) return;
      if (!moved) {
        moved = true;
        col.style.scrollSnapType = "none";
        col.style.cursor = "grabbing";
      }
      col.scrollTop = top0 - dy;
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      col._drag = false;
      col.style.cursor = "";
      if (!moved) return; // 沒拖：當作點擊（點上下的數字會跳過去）
      this._noClick = true;
      setTimeout(() => (this._noClick = false), 0);
      const i = Math.max(0, Math.min(col.children.length - 1, Math.round(col.scrollTop / WHEEL_ROW)));
      col.style.scrollSnapType = "";
      col.scrollTo({ top: i * WHEEL_ROW, behavior: "smooth" });
      this._wheelScroll(col);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  }

  _wheelScroll(col) {
    if (col._drag) {
      col._busy = true; // 拖的時候不要讀值、也不要被重畫拉回去
      clearTimeout(col._t);
      return;
    }
    if (col._sync) {
      col._sync = false; // 程式自己捲的，不算
      return;
    }
    col._busy = true;
    clearTimeout(col._t);
    col._t = setTimeout(() => {
      col._busy = false;
      const i = Math.max(0, Math.min(col.children.length - 1, Math.round(col.scrollTop / WHEEL_ROW)));
      if (i === Number(col.dataset.val)) return;
      const [key, unit] = col.dataset.wheel.split(":");
      this._tpSet(key, unit, i);
      col.dataset.val = i;
      col.setAttribute("aria-valuenow", i);
      navigator.vibrate?.(5);
      this._renderSheet();
    }, 130);
  }

  // 時間選擇器改值：幾點（"HH:MM:SS"）或多久（秒）
  _tpSet(key, unit, n) {
    const s = this._sheet;
    if (key === "kasa_time") {
      const parts = (s.draft.time || "00:00").split(":");
      parts[unit === "h" ? 0 : 1] = pad2(n);
      s.draft.time = parts.join(":");
      return;
    }
    if (key === "away_start" || key === "away_end") {
      const k = key === "away_start" ? "start" : "end";
      const parts = (s.draft[k] || "00:00").split(":");
      parts[unit === "h" ? 0 : 1] = pad2(n);
      s.draft[k] = parts.join(":");
      return;
    }
    if (key === "time" || key === "restore_at") {
      const parts = hms(s.draft[key]).split(":");
      parts["hms".indexOf(unit)] = pad2(n);
      s.draft[key] = parts.join(":");
      return;
    }
    const cur = { duration_s: s.draft?.duration_s, max_on: s.maxDraft ?? this._plug(s.id)?.max_on_s, timer: s.timerDraft }[key] || 0;
    const v = { ...splitSec(cur), [unit]: n };
    const sec = v.h * 3600 + v.m * 60 + v.s;
    if (key === "duration_s") s.draft.duration_s = sec || null;
    else if (key === "max_on") s.maxDraft = sec;
    else s.timerDraft = sec;
  }

  async _setMaxOn(seconds) {
    try {
      await api("PATCH", `/api/plugs/${this._sheet.id}`, { max_on_s: seconds });
    } catch (err) {
      this._sheetError(`沒有成功：${err.message}`);
    }
  }

  async _setTimer(id, seconds) {
    const p = this._plug(id);
    try {
      await api("POST", `/api/plugs/${id}/timer`, { seconds });
      if (this._sheet) this._sheet.customTimer = false;
    } catch (err) {
      this._sheetError(`沒有成功：${err.message}`);
    }
  }

  _move(kind, id, dir) {
    const swap = (ids) => {
      const i = ids.indexOf(id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= ids.length) return null;
      [ids[i], ids[j]] = [ids[j], ids[i]];
      return ids;
    };
    if (kind === "room") {
      const ids = swap(this._rooms.map((r) => r.id));
      if (!ids) return;
      this._roomOrder = ids;
      this._render();
      this._safe(() => api("POST", "/api/order", { rooms: ids }));
    } else if (kind === "scene") {
      const ids = swap(this._scenes.map((s) => s.id));
      if (!ids) return;
      this._s.scenes = ids.map((x) => this._scenes.find((s) => s.id === x));
      this._render();
      this._safe(() => api("POST", "/api/order", { scenes: ids }));
    } else {
      // 只在同一個房間裡交換位置，其他插座的順序不動
      const all = this._plugs;
      const room = this._roomOf(this._plug(id));
      const same = swap(all.filter((x) => this._roomOf(x) === room).map((x) => x.id));
      if (!same) return;
      let k = 0;
      const order = all.map((x) => (this._roomOf(x) === room ? same[k++] : x.id));
      this._order = order;
      this._render();
      this._safe(() => api("POST", "/api/order", { plugs: order }));
    }
  }

  _setSetting(key, value) {
    if (!Number.isFinite(value)) return this._render();
    this._safe(() => api("PUT", "/api/settings", { [key]: Math.round(value * 10) / 10 }));
  }

  _showToast(text, undo = false) {
    clearTimeout(this._toastTimer);
    this._toastHost.innerHTML = `<div class="toast" role="status"><span>${esc(text)}</span>${undo ? `<button data-undo>${ic("mdi:undo")}復原</button>` : ""}</div>`;
    this._toastHost.querySelector("[data-undo]")?.addEventListener("click", async () => {
      try {
        const res = await api("POST", "/api/restore");
        this._toastHost.innerHTML = "";
        if (!res.count) this._showToast("已經是原本的樣子了");
      } catch (err) {
        this._showToast(`沒有成功：${err.message}`);
      }
    });
    this._toastTimer = setTimeout(() => (this._toastHost.innerHTML = ""), undo ? TOAST_UNDO_MS : TOAST_MS);
  }

  async _safe(fn) {
    try {
      await fn();
    } catch (err) {
      this._showToast(`沒有成功：${err?.message || err}`);
      this._render();
    }
  }

  // ───────────── 面板 ─────────────

  _openSheet(sheet) {
    this._sheet = sheet;
    this._renderSheet();
    // 電腦上直接把游標放進輸入框；手機上不要自動跳出鍵盤
    const first = this._sheetHost.querySelector("[data-autofocus]");
    if (first && matchMedia("(hover: hover) and (pointer: fine)").matches) first.focus();
  }

  _closeSheet() {
    clearInterval(this._senseTimer);
    this._sheet = null;
    this._sheetKey = null;
    this._sheetHost.innerHTML = "";
    this._render();
  }

  _sheetError(msg) {
    const el = this._sheetHost.querySelector(".err");
    if (el) el.textContent = msg;
  }

  _renderSheet() {
    const s = this._sheet;
    if (!s) return;
    const builders = { sense: this._senseSheet, edev: this._edevSheet, kasa: this._kasaSheet, confirm: this._confirmSheet, away: this._awaySheet, cloud: this._cloudSheet, netdev: this._netdevSheet, person: this._personSheet, device: this._deviceSheet, timer: this._deviceSheet, plug: this._deviceSheet, room: this._roomSheet, scene: this._sceneSheet, sched: this._schedSheet, watts: this._wattsSheet };
    const html = builders[s.type]?.call(this, s);
    if (html === null || html === undefined) return this._closeSheet();
    const key = `${s.type}|${s.id}|${s.wide ? 1 : 0}`;
    const sheet = this._sheetHost.querySelector(".sheet");
    const cls = `sheet ${/class="cols[ "]/.test(html) ? "wide xwide" : s.wide ? "wide" : ""}`;
    if (sheet && this._sheetKey === key) {
      // 同一個面板：只更新有變的地方
      if (sheet.className !== cls) sheet.className = cls;
      morph(sheet, `<div class="grab"></div>${html}`);
      this._syncWheels();
      return;
    }
    this._sheetKey = key;
    this._sheetHost.innerHTML = `<div class="wrap" data-backdrop><div class="${cls}" role="dialog" aria-modal="true"><div class="grab"></div>${html}</div></div>`;
    this._sheetHost.querySelector("[data-backdrop]").addEventListener("click", (e) => {
      if (e.target.matches("[data-backdrop]")) this._closeSheet();
    });
    this._syncWheels();
  }

  _sheetHead(icon, title, sub, iconStyle = "", meta = "") {
    return `<div class="sh"><div class="di" style="${iconStyle}">${ic(icon)}</div><div style="min-width:0"><div class="t">${esc(title)}</div>${sub ? `<div class="s">${esc(sub)}</div>` : ""}${meta ? `<div class="m">${esc(meta)}</div>` : ""}</div>
      <button class="x" data-a="close" aria-label="關閉">${ic("mdi:close")}</button></div>`;
  }

  // 裝置詳細：開關、定時關閉、名稱與設定，全部在同一個面板
  _deviceSheet(s) {
    const p = this._plug(s.id);
    if (!p) return null;
    const on = this._isOn(p);
    const room = this._room(p.room)?.name || "還沒分房間";
    const now = this._now();
    const max = p.max_on_s || 86400;
    if (s.timerDraft == null) s.timerDraft = Math.min(600, max);
    const status = !p.online ? "連不上" : on ? "開著" : "關著";
    // 裝置詳細只看資訊、調整設定；開關在列表上
    const callouts = [
      !p.online && `<div class="callout bad">${ic("mdi:wifi-off")}<div><b>連不上這個插座</b><span>檢查插頭有沒有插好、Wi-Fi 有沒有訊號</span></div></div>`,
      p.online && p.protect === "lock" && `<div class="callout">${ic("mdi:lock")}<div><b>已鎖定</b><span>App、Google Home、情境、排程都不能開關它；要開關請先把「防呆」改掉</span></div></div>`,
      p.online && on && p.timer && `<div class="callout timer">${ic("mdi:timer-outline")}<div><b>${fmtLeft(p.timer - now)}後自動關閉</b><span>${clockSec(p.timer)} 關閉</span></div>${p.max_on_s ? "" : `<button class="btn sm" data-a="timer-stop">取消</button>`}</div>`,
    ].filter(Boolean).join("");
    // 定時：有最長時間（澆水）就給短的選項
    const choices = p.max_on_s ? [...new Set([...SHORT_OPTIONS.filter((x) => x < max), max])].slice(-4) : TIMER_OPTIONS.slice(0, 4);
    const opts = choices.map((x) => `<button class="opt" data-a="timer-set" data-v="${x}">${fmtSec(x)}</button>`).join("");
    const timer = p.online && on && p.protect !== "lock"
      ? `<div class="q">${on ? "定時關閉" : "打開，並在多久後關閉"}</div>
         <div class="opts four">${opts}</div>
         <button class="link sm" data-a="timer-more">${s.customTimer ? "收起" : "自訂時間…"}</button>
         ${s.customTimer ? `${durPicker("timer", s.timerDraft)}<button class="btn primary big" style="margin-top:10px" data-a="timer-custom">${on ? "" : "打開，"}${fmtSec(s.timerDraft)}後關閉</button>` : ""}`
      : "";
    // 防呆放左欄（左：定時、名稱、設定、防呆；右：Google Home、插座本身，兩邊差不多高）
    const protect = `
      <div class="q">防呆</div>
      <div class="protect">${PROTECT.map(([k, label, desc]) => `<button class="pr ${p.protect === k ? "sel" : ""}" data-a="protect" data-v="${k}" aria-pressed="${p.protect === k}"><b>${k === "lock" ? ic("mdi:lock") : ""}${label}</b><span>${desc}</span></button>`).join("")}</div>`;
    const roomOpts = [`<option value="">還沒分房間</option>`, ...this._rooms.map((r) => `<option value="${esc(r.id)}" ${p.room === r.id ? "selected" : ""}>${esc(r.name)}</option>`)].join("");
    return `
      ${this._sheetHead(deviceIcon(p.name), p.name, `${room}・${status}`, on ? "background:var(--on-soft);color:var(--on)" : "", `${p.model}・${p.host}`)}
      ${callouts}
      <div class="cols"><div class="col">
      ${timer}
      <div class="q">名稱</div>
      <div class="field"><input class="text" data-plug-name data-enter="plug-save" value="${esc(p.name)}" maxlength="30" aria-label="名稱"><button class="btn" data-a="plug-save">改名</button></div>
      ${p.kasa_name !== p.name ? `<p class="note">插座本身的名稱：${esc(p.kasa_name)}（清空後改名就改回這個）</p>` : ""}
      <div class="q">設定</div>
      <div class="group">
        <label class="gi"><span class="gl">房間</span><select class="gsel" data-c="sheet-room" aria-label="房間">${roomOpts}</select></label>
        ${p.mode === "metered" ? "" : `<label class="gi"><span class="gl">接的電器<small>估算用電</small></span><select class="gsel" data-c="sheet-watts" aria-label="接的電器">${this._wattOptions(p)}</select></label>`}
        <div class="gi">
          <div class="gt"><div class="gl">常開</div><div class="gs">全部關閉、情境、排程都不會關它（路由器、冰箱）</div></div>
          <button class="sw ${p.keep_on ? "on" : ""}" data-a="keep-on" role="switch" aria-checked="${p.keep_on}" aria-label="常開"></button>
        </div>
        <div class="gi">
          <div class="gt"><div class="gl">最長開啟時間</div><div class="gs">${p.max_on_s ? `開了 ${fmtSec(p.max_on_s)}一定關，不能取消` : "澆水、電暖器這類開太久會出事的"}</div></div>
          <button class="sw ${p.max_on_s ? "on" : ""}" data-a="max-toggle" role="switch" aria-checked="${!!p.max_on_s}" aria-label="最長開啟時間"></button>
        </div>
        ${p.max_on_s ? this._maxOnEditor(s, p) : ""}
      </div>
      ${p.max_on_s ? `<p class="note">App、Google Home、排程、情境、插座按鈕打開都算；插座本身也會倒數，樹莓派停掉照樣會關。</p>` : ""}
      ${protect}
      </div><div class="col">
      <div class="q">Google Home</div>
      <div class="group">
        <div class="gi">
          <div class="gt"><div class="gl">讓 Google Home 控制</div><div class="gs">關掉後，語音說「全部關掉」也不會動到它</div></div>
          <button class="sw ${p.matter !== false ? "on" : ""}" data-a="matter-toggle" role="switch" aria-checked="${p.matter !== false}" aria-label="讓 Google Home 控制"></button>
        </div>
      </div>
      ${this._hardwareHtml(s, p)}
      </div></div>
      <div class="err"></div>`;
  }

  _netRowsHtml(p) {
    const n = p.net;
    if (!n) return "";
    const r = this._netReport();
    const other = r.main && n.ssid && n.ssid !== r.main && ![r.main, n.ssid].every((x) => (this._s.router?.ssids || []).includes(x));
    const onRouter = (this._s.router?.ssids || []).includes(n.ssid);
    const weak = n.key_type != null && n.key_type < 3 && !onRouter;
    const ups = n.fw_updates || [];
    const fw = n.fw_check === "unavailable" ? "無法檢查（已斷開雲端）" : ups.length ? `有新版 ${esc(ups[0].version || "")}` : n.fw_check === "ok" ? "已是最新" : "檢查中…";
    return `
      <div class="gi"><span class="gl">Wi-Fi 網路${other ? `<small class="warn">和其他裝置不同（大多數在「${esc(r.main)}」）</small>` : ""}</span>
        <span class="gv ${other ? "warn" : ""}">${esc(n.ssid || "—")}</span></div>
      <div class="gi"><span class="gl">加密方式${weak ? `<small class="warn">比較容易被破解，建議改用 WPA2 以上</small>` : ""}</span>
        <span class="gv ${weak ? "warn" : ""}">${onRouter ? "WPA2 以上（路由器設定）" : keyName(n.key_type)}</span></div>
      <div class="gi"><span class="gl">韌體<small>${esc(n.model || "")} 硬體 ${esc(n.hw || "")}</small></span>
        <span class="gv ${ups.length ? "warn" : ""}">${esc(n.fw || "")}・${fw}</span></div>`;
  }

  // 插座本身：指示燈、訊號、使用時間、內建排程、雲端、重新啟動
  _hardwareHtml(s, p) {
    if (!p.online) return "";
    const sig = signal(p.rssi);
    const shared = this._plugs.filter((x) => x.host === p.host).length > 1;
    const u = s.usage;
    const usage =
      u === undefined
        ? `<span class="gv muted">讀取中…</span>`
        : u === false
          ? `<span class="gv muted">讀不到</span>`
          : `<span class="gv">今天 ${fmtMin(u.today)}・本月 ${fmtMin(u.month)}</span>`;
    const maxDay = u && u.days ? Math.max(1, ...u.days.map((d) => d.minutes)) : 1;
    const chart = u && u.days ? `<div class="gi col"><div class="mini">${u.days.map((d, i) => `<div title="${d.day}：${fmtMin(d.minutes)}" class="${i === u.days.length - 1 ? "today" : ""}"><i style="height:${(d.minutes / maxDay) * 100}%"></i></div>`).join("")}</div></div>` : "";
    const n = p.native;
    const nativeText = !n ? "等待同步…" : !n.ok ? n.msg || "同步失敗，稍後再試" : n.schedule ? `已寫入 ${n.schedule} 條，樹莓派離線時照樣執行` : "目前沒有排程要寫入";
    return `
      <div class="q">插座本身</div>
      <div class="group">
        <div class="gi"><div class="gt"><div class="gl">指示燈</div>${shared ? `<div class="gs">整條排插共用一個燈</div>` : ""}</div>
          <button class="sw ${p.led ? "on" : ""}" data-a="led-toggle" role="switch" aria-checked="${!!p.led}" aria-label="指示燈"></button></div>
        ${this._netRowsHtml(p)}
        <div class="gi"><span class="gl">Wi-Fi 訊號</span>${sig ? `<span class="gv">${bars(sig.level)}${sig.text}・${p.rssi} dBm</span>` : `<span class="gv muted">—</span>`}</div>
        <div class="gi"><span class="gl">使用時間<small>插座自己記錄的</small></span>${usage}</div>
        ${chart}
        <div class="gi"><span class="gl">內建排程<small>${esc(nativeText)}</small></span>${n && !n.ok ? `<span class="gv warn">${ic("mdi:alert-circle-outline")}</span>` : n ? `<span class="gv ok">${ic("mdi:check-circle")}</span>` : ""}</div>
        ${(n?.kasa || []).length ? `<div class="gi"><span class="gl">Kasa App 設的排程<small>插座自己會執行；在「排程」頁可以修改</small></span><span class="gv kasa">${n.kasa.map((r) => `${r.sact ? "開" : "關"} ${this._ruleText(r)}${r.wday.every(Boolean) ? "" : ` ${r.wday.map((v, i) => (v ? "日一二三四五六"[i] : "")).join("")}`}${r.enable ? "" : "（停用）"}`).join("<br>")}</span></div>` : ""}
        <div class="gi"><span class="gl">TP-Link 雲端</span><span class="gv">${p.net?.cloud_bound === false ? "已解除綁定" : p.net?.cloud_bound ? "綁著帳號" : p.cloud ? "連線中" : p.cloud === false ? "未連線" : "—"}</span></div>
        <div class="gi"><span class="gl">重新啟動插座<small>插座卡住時用；${shared ? "整條排插都會重開，" : ""}可能短暫斷電</small></span><button class="btn sm" data-a="reboot" data-confirm="重新啟動插座？" data-confirm-text="插座大約 30 秒後恢復，期間可能短暫斷電${shared ? "；整條排插的每個孔都會一起重開" : ""}。" data-confirm-ok="重新啟動">重新啟動</button></div>
      </div>`;
  }

  _maxOnEditor(s, p) {
    const v = s.maxDraft ?? p.max_on_s;
    const quick = [30, 60, 300, 600, 1800]
      .map((x) => `<button class="chip ${v === x ? "sel" : ""}" data-a="max-quick" data-v="${x}">${fmtSec(x)}</button>`)
      .join("");
    const dirty = s.maxDraft != null && s.maxDraft !== p.max_on_s;
    return `<div class="gi col">
        ${durPicker("max_on", v)}
        <div class="chips">${quick}</div>
        ${dirty ? `<button class="btn primary" data-a="max-save">儲存：最長 ${fmtSec(s.maxDraft)}</button>` : ""}
      </div>`;
  }

  _savePlugName() {
    const input = this._sheetHost.querySelector("[data-plug-name]");
    this._safe(async () => {
      await api("PATCH", `/api/plugs/${this._sheet.id}`, { name: input.value });
      input.blur();
    });
  }

  _wattsSheet(s) {
    const p = this._plug(s.id);
    if (!p) return null;
    return `
      ${this._sheetHead(deviceIcon(p.name), p.name, "自訂瓦數")}
      <div class="q">這個電器大約幾瓦？ <small>看電器背面的標示</small></div>
      <div class="field"><input class="text" data-watts-input data-enter="watts-save" data-autofocus type="number" inputmode="decimal" min="1" max="5000" value="${esc(p.watts || "")}" aria-label="瓦數"><span>W</span></div>
      <div class="err"></div>
      <div class="actions"><button class="btn" data-a="close">取消</button><button class="btn primary" data-a="watts-save">儲存</button></div>`;
  }

  _roomSheet(s) {
    const isNew = !s.id;
    const room = isNew ? null : this._room(s.id);
    if (!isNew && !room) return null;
    const count = isNew ? 0 : this._plugs.filter((p) => p.room === s.id).length;
    return `
      ${this._sheetHead(room?.icon || "mdi:home-plus-outline", isNew ? "新增房間" : room.name, isNew ? "" : `${count} 個插座`)}
      <div class="q">房間名稱</div>
      <input class="text" data-room-name data-enter="room-save" data-autofocus value="${esc(s.name)}" maxlength="20" placeholder="例如：客廳、書房" aria-label="房間名稱">
      <p class="note">圖示會依名稱自動選，例如「客廳」是沙發、「廚房」是爐子。</p>
      <div class="err"></div>
      <div class="actions">
        ${isNew ? `<button class="btn" data-a="close">取消</button>` : `<button class="btn danger" data-a="room-delete" data-confirm="刪除這個房間？" data-confirm-text="房間裡的裝置會移到「還沒分房間」，裝置本身不受影響。">刪除房間</button>`}
        <button class="btn primary" data-a="room-save">${isNew ? "建立" : "儲存"}</button>
      </div>`;
  }

  _saveRoom() {
    const name = this._sheetHost.querySelector("[data-room-name]").value.trim();
    if (!name) return this._sheetError("請輸入房間名稱");
    const id = this._sheet.id;
    this._safe(async () => {
      if (id) await api("PATCH", `/api/rooms/${id}`, { name });
      else await api("POST", "/api/rooms", { name });
      this._closeSheet();
      if (!id) this._showToast(`已建立「${name}」，按住插座右邊的 ⠿ 拖進來`);
    });
  }

  // ── 情境編輯 ──

  _openSceneEditor(id) {
    const sc = id ? this._scenes.find((s) => s.id === id) : null;
    const draft = sc
      ? { name: sc.name, icon: sc.icon, actions: { ...sc.actions }, others: sc.others || "keep" }
      : { name: "", icon: "mdi:star-outline", actions: {}, others: "keep" };
    this._openSheet({ type: "scene", id, draft, wide: true });
  }

  _sceneSheet(s) {
    const d = s.draft;
    const icons = SCENE_ICONS.map((x) => `<button class="chip ${d.icon === x ? "sel" : ""}" data-a="scene-icon" data-v="${x}" aria-label="選這個圖示">${ic(x)}</button>`).join("");
    const row = (p) => {
      const act = d.actions[p.id] || "keep";
      const seg = [
        ["on", "打開"],
        ["off", "關閉"],
        ["keep", "不動"],
      ]
        .map(([k, label]) => {
          const dis = k === "off" && p.keep_on;
          return `<button class="${act === k ? `sel ${k}` : ""}" data-a="scene-act" data-v="${esc(p.id)}" data-d="${k}" ${dis ? 'disabled title="常開的插座不會被關"' : ""}>${label}</button>`;
        })
        .join("");
      return `<div class="srow ${act === "on" ? "on" : ""}"><div class="di">${ic(deviceIcon(p.name))}</div><div class="nm"><div class="a"><span>${esc(p.name)}</span></div>${p.keep_on ? '<div class="b">常開</div>' : ""}</div><div class="seg">${seg}</div></div>`;
    };
    // 插座清單分成兩半（寬螢幕左右兩欄）：在中間切開；切在房間中間時，右欄開頭補「房間（續）」
    const items = [];
    for (const g of this._groups()) {
      items.push({ title: g.name, h: 0.7 });
      for (const p of g.plugs) items.push({ p, g: g.name, h: 1 });
    }
    const total = items.reduce((a, x) => a + x.h, 0);
    let acc = 0;
    let cut = items.length;
    for (let k = 0; k < items.length; k++) {
      if (acc + items[k].h / 2 > total / 2) {
        cut = items[k - 1]?.title ? k - 1 : k; // 不要讓房間標題留在左欄最底下
        break;
      }
      acc += items[k].h;
    }
    const html = (list) => list.map((x) => (x.title ? `<div class="group-title">${esc(x.title)}</div>` : row(x.p))).join("");
    const right = items.slice(cut);
    const cont = right[0] && !right[0].title ? `<div class="group-title cont">${esc(right[0].g)}（續）</div>` : "";
    const rows = `<div class="scol">${html(items.slice(0, cut))}</div><div class="scol">${cont}${html(right)}</div>`;
    return `
      ${this._sheetHead(d.icon, s.id ? "編輯情境" : "新增情境", "按一下情境按鈕，一次設定好多個插座")}
      <div class="cols"><div class="col">
        <div class="q">名稱</div>
        <input class="text" data-c="scene-name" data-autofocus value="${esc(d.name)}" maxlength="20" placeholder="例如：看電影、回家" aria-label="情境名稱">
        <div class="q">圖示</div>
        <div class="chips">${icons}</div>
      </div><div class="col">
        <div class="q">按下時，每個插座要：</div>
        <div class="chips">
          <button class="chip" data-a="scene-all" data-v="off">全部設成關閉</button>
          <button class="chip" data-a="scene-all" data-v="keep">全部設成不動</button>
        </div>
        <div class="q">之後新找到的插座：</div>
        <div class="seg full">
          <button class="${d.others === "keep" ? "sel" : ""}" data-a="scene-others" data-v="keep">不動</button>
          <button class="${d.others === "off" ? "sel off" : ""}" data-a="scene-others" data-v="off">關閉</button>
        </div>
      </div></div>
      <div class="q">每個插座</div>
      <div class="srooms">${rows}</div>
      <div class="err"></div>
      <div class="actions">
        ${s.id ? `<button class="btn danger" data-a="scene-delete" data-confirm="刪除這個情境？" data-confirm-text="用到這個情境的排程會先暫停，不能復原。">刪除情境</button>` : `<button class="btn" data-a="close">取消</button>`}
        <button class="btn primary" data-a="scene-save">儲存</button>
      </div>`;
  }

  _saveScene() {
    const d = this._sheet.draft;
    const name = (this._sheetHost.querySelector('[data-c="scene-name"]')?.value ?? d.name).trim();
    if (!name) return this._sheetError("請輸入情境名稱");
    const id = this._sheet.id;
    const body = { name, icon: d.icon, actions: d.actions, others: d.others };
    this._safe(async () => {
      if (id) await api("PUT", `/api/scenes/${id}`, body);
      else await api("POST", "/api/scenes", body);
      this._closeSheet();
    });
  }

  // ── 排程編輯 ──

  _openSchedEditor(id, template, sugg) {
    const x = id ? (this._s.schedules || []).find((s) => s.id === id) : null;
    let draft;
    if (x) {
      draft = { ...x, days: [...x.days], plugs: [...x.plugs] };
    } else {
      draft = { enabled: true, time: "23:00:00", days: [0, 1, 2, 3, 4, 5, 6], action: "off", scene: null, plugs: [], restore_at: null, duration_s: null, backup: true };
      const plugs = this._plugs;
      if (template === "night") {
        draft.plugs = plugs.filter((p) => deviceIcon(p.name) === "mdi:lightbulb" && !p.keep_on).map((p) => p.id);
        draft.restore_at = "07:00:00";
      } else if (template === "leave") {
        const sc = this._scenes.find((s) => s.name === "出門") || this._scenes[0];
        Object.assign(draft, { time: "08:30:00", days: [0, 1, 2, 3, 4], action: "scene", scene: sc?.id || null, skip_holiday: true });
      } else if (template === "water") {
        Object.assign(draft, { time: "06:30:00", action: "on", duration_s: 60, skip_rain: true, plugs: plugs.filter((p) => /澆水|water/i.test(p.name)).map((p) => p.id) });
      }
      if (sugg) {
        Object.assign(draft, {
          time: `${sugg.time}:00`, days: [...sugg.days], action: sugg.action, plugs: [sugg.plug],
          time_mode: sugg.mode, offset_min: sugg.offset_min,
        });
      }
    }
    this._openSheet({ type: "sched", id, draft, wide: true });
  }

  _schedSheet(s) {
    const d = s.draft;
    const days = DAYS.map((label, i) => `<button class="chip day ${d.days.includes(i) ? "sel" : ""}" data-a="sched-day" data-v="${i}" aria-pressed="${d.days.includes(i)}">${label}</button>`).join("");
    const action = [
      ["off", "關閉插座"],
      ["on", "打開插座"],
      ["scene", "執行情境"],
    ]
      .map(([k, label]) => `<button class="${d.action === k ? "sel" : ""}" data-a="sched-action" data-v="${k}">${label}</button>`)
      .join("");
    let what;
    if (d.action === "scene") {
      what = this._scenes.length
        ? `<div class="chips">${this._scenes.map((sc) => `<button class="chip ${d.scene === sc.id ? "sel" : ""}" data-a="sched-scene" data-v="${esc(sc.id)}">${ic(sc.icon)}${esc(sc.name)}</button>`).join("")}</div>`
        : `<p class="note">還沒有情境，先到「插座 → 編輯」新增一個。</p>`;
    } else {
      what = this._groups()
        .map((g) => {
          const chips = g.plugs
            .map((p) => {
              const dis = d.action === "off" && p.keep_on;
              const sel = d.plugs.includes(p.id) && !dis;
              return `<button class="chip ${sel ? "sel" : ""}" data-a="sched-plug" data-v="${esc(p.id)}" ${dis ? 'disabled title="常開的插座不會被關"' : ""} aria-pressed="${sel}">${sel ? ic("mdi:check") : ""}${esc(p.name)}</button>`;
            })
            .join("");
          return `<div class="group-title">${esc(g.name)}<button class="link" data-a="sched-room" data-v="${esc(g.id)}">全選／取消</button></div><div class="chips">${chips}</div>`;
        })
        .join("");
    }
    const restore =
      d.action === "off"
        ? `<div class="set" style="padding:18px 0 0">
            <div class="tx"><div class="l">之後再打開</div><div class="s">只打開被這個排程關掉的；本來就關著的不會被打開</div></div>
            <button class="sw ${d.restore_at ? "on" : ""}" data-a="sched-restore" role="switch" aria-checked="${!!d.restore_at}" aria-label="之後再打開"></button>
          </div>
          ${d.restore_at ? `<div style="margin-top:10px">${clockPicker("restore_at", d.restore_at, 3)}<p class="note">${d.restore_at <= d.time ? "隔天" : "當天"}這個時間打開</p></div>` : ""}`
        : d.action === "on"
          ? `<div class="set" style="padding:18px 0 0">
            <div class="tx"><div class="l">開多久後自動關閉</div><div class="s">例如澆水開 50 秒；插座有設「最長開啟時間」的話，以比較短的為準</div></div>
            <button class="sw ${d.duration_s ? "on" : ""}" data-a="sched-duration" role="switch" aria-checked="${!!d.duration_s}" aria-label="開多久後自動關閉"></button>
          </div>
          ${d.duration_s ? `<div style="margin-top:10px">${durPicker("duration_s", d.duration_s)}</div>` : ""}`
          : "";
    return `
      ${this._sheetHead("mdi:calendar-clock", s.id ? "編輯排程" : "新增排程", "")}
      <div class="cols"><div class="col">
      <div class="q">什麼時候</div>
      ${this._timeModeHtml(d.time_mode || "clock", "sched-mode")}
      ${(d.time_mode || "clock") === "clock" ? clockPicker("time", d.time) : this._offsetHtml(d.time_mode, d.offset_min || 0, "sched-offset")}
      <div class="q">哪幾天 <small>${daysText(d.days)}</small></div>
      <div class="chips">${days}</div>
      <div class="chips" style="margin-top:8px">
        <button class="chip" data-a="sched-days" data-v="all">每天</button>
        <button class="chip" data-a="sched-days" data-v="week">平日</button>
        <button class="chip" data-a="sched-days" data-v="end">週末</button>
      </div>
      ${this._backupHtml(s)}
      </div><div class="col">
      <div class="q">要做什麼</div>
      <div class="seg full">${action}</div>
      ${restore}
      <div class="q">${d.action === "scene" ? "哪個情境" : d.action === "on" ? "打開哪些插座" : "關閉哪些插座"}</div>
      ${what}
      </div></div>
      <div class="err"></div>
      <div class="actions">
        ${s.id ? `<button class="btn danger" data-a="sched-delete" data-confirm="刪除這條排程？" data-confirm-text="寫進插座的備援也會一起清掉，不能復原。">刪除排程</button>` : `<button class="btn" data-a="close">取消</button>`}
        <button class="btn primary" data-a="sched-save">儲存</button>
      </div>`;
  }

  _backupHtml(s) {
    const d = s.draft;
    const saved = s.id ? (this._s.schedules || []).find((x) => x.id === s.id) : null;
    const b = saved?.backup_status;
    const status =
      d.backup && saved && saved.backup !== false && b && b.total
        ? b.ok === b.total
          ? `<div class="bstat ok">${ic("mdi:check-circle")}${b.total} 個插座都寫好了</div>`
          : b.issues.map((i) => `<div class="bstat ${i.pending ? "" : "bad"}">${ic(i.pending ? "mdi:clock-outline" : "mdi:alert-circle-outline")}${esc(i.plug)}：${esc(i.reason)}</div>`).join("")
        : "";
    // 實際寫進插座的內容（插座只到分鐘；「X 秒後關閉」會變成下一分鐘的關閉）
    const rules = d.backup && saved && saved.backup !== false && b?.rules?.length
      ? `<div class="bstat">${ic("mdi:power-plug-outline")}插座裡：${Object.entries(
          b.rules
            .map(([act, opt, val, wday]) => ({ act, opt, val, wday }))
            .sort((x, y) => this._ruleMin(x) - this._ruleMin(y))
            .reduce((g, r) => {
              const k = daysText(kasaDays(r.wday));
              (g[k] ||= []).push(`${r.opt ? sunLabel(r.opt, r.val) : hhmm(r.val)} ${r.act ? "開" : "關"}`);
              return g;
            }, {}),
        )
          .map(([days, list]) => `${days} ${list.join("、")}`)
          .join("；")}</div>`
      : "";
    const extraNote =
      d.action === "on" && d.duration_s && d.duration_s % 60
        ? `<div class="bstat">${ic("mdi:alert-circle-outline")}插座只到分鐘：樹莓派離線時會在下一個整分鐘才關，最多多開 ${60 - (d.duration_s % 60)} 秒</div>`
        : "";
    return `
      <div class="q">什麼時候不執行</div>
      <div class="group">
        <div class="gi"><div class="gt"><div class="gl">國定假日不執行</div>
          <div class="gs">平日遇到國定假日、補假就跳過（假日表來自政府公告）；颱風假可以在排程頁按「今天放假」</div></div>
          <button class="sw ${d.skip_holiday ? "on" : ""}" data-a="sched-skip" data-v="skip_holiday" role="switch" aria-checked="${!!d.skip_holiday}" aria-label="國定假日不執行"></button></div>
        <div class="gi"><div class="gt"><div class="gl">下雨不執行</div>
          <div class="gs">前一天下過雨、或預報當天會下雨（超過 3 mm）就跳過，適合澆水。會用大概的位置（約 10 公里）查天氣</div></div>
          <button class="sw ${d.skip_rain ? "on" : ""}" data-a="sched-skip" data-v="skip_rain" role="switch" aria-checked="${!!d.skip_rain}" aria-label="下雨不執行"></button></div>
      </div>
      <div class="q">備援</div>
      <div class="group">
        <div class="gi"><div class="gt"><div class="gl">樹莓派離線時由插座接手</div>
          <div class="gs">寫一份到插座裡；平常由樹莓派執行，樹莓派離線時插座照樣會做（只到分鐘${d.action === "off" && d.restore_at ? "；「之後再打開」不會寫進插座" : ""}）</div></div>
          <button class="sw ${d.backup ? "on" : ""}" data-a="sched-backup" role="switch" aria-checked="${!!d.backup}" aria-label="樹莓派離線時由插座接手"></button></div>
        ${status || rules || extraNote ? `<div class="gi col">${status}${rules}${d.backup ? extraNote : ""}</div>` : ""}
      </div>`;
  }

  _timeModeHtml(mode, action) {
    return `<div class="seg full" style="margin-bottom:10px">${[["clock", "固定時間"], ["sunrise", "日出"], ["sunset", "日落"]]
      .map(([k, label]) => `<button class="${mode === k ? "sel" : ""}" data-a="${action}" data-v="${k}">${label}</button>`)
      .join("")}</div>`;
  }

  // 日出日落：提早／延後幾分鐘，顯示今天大約幾點
  _offsetHtml(mode, offset, action) {
    const opt = mode === "sunrise" ? 1 : 2;
    const base = opt === 1 ? this._s.sun?.sunrise : this._s.sun?.sunset;
    const today = base != null ? `今天約 ${hhmm(Math.min(1439, Math.max(0, base + offset)))}` : "還不知道家裡的位置，算不出今天幾點";
    return `
      <div class="offset">
        <button class="btn" data-a="${action}" data-v="-5" aria-label="提早 5 分鐘">−5</button>
        <div class="ov"><b>${ic(sunIcon(opt))}${sunLabel(opt, offset) || (opt === 1 ? "日出" : "日落")}</b><span>${today}</span></div>
        <button class="btn" data-a="${action}" data-v="5" aria-label="延後 5 分鐘">+5</button>
      </div>
      <div class="chips" style="margin-top:8px">${[-30, -15, 0, 15, 30]
        .map((m) => `<button class="chip ${offset === m ? "sel" : ""}" data-a="${action}" data-v="${m === 0 ? "0" : m - offset}">${m === 0 ? "準時" : `${m < 0 ? "提早" : "延後"} ${Math.abs(m)} 分`}</button>`)
        .join("")}</div>
      <p class="note">每天跟著日出日落自動調整；寫進插座的備援也用插座內建的日出日落，離線好幾天也準。</p>`;
  }

  _saveSched() {
    const d = this._sheet.draft;
    if (!d.days.length) return this._sheetError("請至少選一天");
    if (d.action === "scene" && !d.scene) return this._sheetError("請選一個情境");
    if (d.action !== "scene" && !d.plugs.length) return this._sheetError("請至少選一個插座");
    const id = this._sheet.id;
    const body = {
      enabled: id ? d.enabled : true,
      time: d.time,
      days: d.days,
      action: d.action,
      scene: d.scene,
      plugs: d.plugs,
      restore_at: d.action === "off" ? d.restore_at : null,
      duration_s: d.action === "on" ? d.duration_s || null : null,
      backup: d.backup !== false,
      time_mode: d.time_mode || "clock",
      offset_min: d.offset_min || 0,
      skip_holiday: !!d.skip_holiday,
      skip_rain: !!d.skip_rain,
    };
    this._safe(async () => {
      if (id) await api("PUT", `/api/schedules/${id}`, body);
      else await api("POST", "/api/schedules", body);
      this._closeSheet();
    });
  }
}

customElements.define("plug-app", PlugApp);

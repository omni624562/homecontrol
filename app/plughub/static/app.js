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
  .group.power { margin-top: 2px; }
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
    padding: calc((var(--rows) - 1) / 2 * var(--row)) 0; scrollbar-width: none; outline: none; cursor: ns-resize;
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
    this.shadowRoot.innerHTML = `<style>${STYLE}</style><div class="root"></div><div class="sheet-host"></div><div class="toast-host"></div>`;
    this._root = this.shadowRoot.querySelector(".root");
    this._sheetHost = this.shadowRoot.querySelector(".sheet-host");
    this._toastHost = this.shadowRoot.querySelector(".toast-host");
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
    root.addEventListener("pointerdown", (e) => {
      const grip = e.target.closest?.("[data-drag]");
      if (grip) this._dragStart(e, grip);
    });
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
    return TABS.some(([k]) => k === h) ? h : null;
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
        `<button class="tab ${this._tab === key ? "sel" : ""}" data-a="tab" data-v="${key}" ${this._tab === key ? 'aria-current="page"' : ""}>${ic(icon)}<span>${label}</span></button>`,
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
        <section class="card">
          <div class="ch"><div class="ri">${ic("mdi:calendar-clock")}</div><div class="n">排程</div></div>
          ${rows || empty}
          ${rows ? `<p class="desc foot">${ic("mdi:shield-check-outline")}家庭中控的排程也會寫進插座，樹莓派離線時照樣執行。標「插座內建」的是用 Kasa App 設的，存在插座裡，在這裡一樣可以開關、修改、刪除。</p>` : ""}
        </section>
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

  // 家庭中控排程的標籤：順便顯示有沒有寫進插座當備援
  _backupTag(x) {
    const home = (text) => `<div class="tag home">${ic("mdi:home-automation")}家庭中控${text ? `・${text}` : ""}</div>`;
    const b = x.backup_status || { total: 0, ok: 0, issues: [] };
    if (!x.enabled || !b.total) return home(x.backup === false ? "不寫進插座" : "");
    if (x.backup === false) return home("不寫進插座");
    if (b.ok === b.total) return home(`插座備援 ${ic("mdi:check")}`);
    if (b.issues.every((i) => i.pending)) return home("備援同步中…");
    return `${home("")}<div class="tag warn">${ic("mdi:alert-circle-outline")}插座備援 ${b.ok}／${b.total}</div>`;
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
      <div class="q">什麼時候 <small>插座的排程只到分鐘</small></div>
      ${this._timeModeHtml(d.mode, "kasa-mode")}
      ${d.mode === "clock" ? hmPicker("kasa_time", d.time) : this._offsetHtml(d.mode, d.offset, "kasa-offset")}
      <div class="q">哪幾天 <small>${daysText(d.days)}</small></div>
      <div class="chips">${days}</div>
      <div class="q">要做什麼</div>
      <div class="seg full">${act}</div>
      <p class="note">改的是插座裡的設定，Kasa App 也會看到一樣的內容。插座自己執行，不需要樹莓派，但也<b>不會</b>遵守鎖定、常開這些防呆設定。</p>
      <div class="group" style="margin-top:14px"><div class="gi"><div class="gt"><div class="gl">改由家庭中控管理</div><div class="gs">轉成家庭中控的排程：可以設到秒、套用防呆和最長開啟時間，樹莓派離線時一樣由插座接手</div></div>
        <button class="btn sm" data-a="kasa-adopt" data-v="${esc(s.key)}" data-confirm="再按一次轉換">轉換</button></div></div>
      <div class="err"></div>
      <div class="actions"><button class="btn danger" data-a="kasa-delete" data-confirm="確定刪除？再按一次">刪除</button><button class="btn primary" data-a="kasa-save">儲存</button></div>`;
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
      </section>`;
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
          ${this._backupTag(x)}</div>
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
      })
      .catch(() => (this._energyErr = true))
      .finally(() => {
        this._energyLoading = false;
        this._render();
      });
  }

  _energyPage() {
    this._loadEnergy();
    const e = this._energy;
    const head = `<div class="ph"><div><h1>用電</h1><div class="sub">${
      e ? `插座記錄的開機時間 × 瓦數・台電累進電價 ${fmt(e.price, 2)} 元/度（${esc(e.season)}）` : "讀取插座記錄的使用時間…"
    }</div></div></div>`;
    if (!e) return `${head}<div class="card"><div class="empty">${this._energyErr ? "讀不到插座的使用時間，稍後再試。" : "讀取中…"}</div></div>`;
    const range = this._energyRange || "days";
    const series = range === "days" ? e.days : e.months;
    const useKwh = e.plugs.some((p) => p.watts);
    const val = (x) => (useKwh ? x.kwh : x.hours);
    const max = Math.max(0.001, ...series.map(val));
    const bars = series
      .map((x, i) => {
        const last = i === series.length - 1;
        const label = range === "days" ? (last ? "今" : Number(x.day.slice(8))) : `${Number(x.month.slice(5))}月`;
        const show = range === "months" || last || i % 5 === 4;
        const tip = range === "days" ? x.day : x.month;
        return `<div class="bar ${last ? "today" : ""}" title="${tip}：${useKwh ? `${fmt(x.kwh, 1)} 度，` : ""}開了 ${fmt(x.hours, 0)} 小時${x.cost != null ? `・約 $${fmt(x.cost)}` : ""}"><div style="height:${(val(x) / max) * 100}%"></div><span>${show ? label : ""}</span></div>`;
      })
      .join("");
    const known = e.plugs.filter((p) => p.known);
    const totalKwh = known.reduce((a, p) => a + (p.month_kwh || 0), 0) || 1;
    const totalMin = known.reduce((a, p) => a + (p.month_min || 0), 0) || 1;
    const rows = [...e.plugs]
      .sort((a, b) => (b.month_kwh || 0) - (a.month_kwh || 0) || (b.month_min || 0) - (a.month_min || 0))
      .map((p) => {
        const share = p.watts ? (p.month_kwh || 0) / totalKwh : (p.month_min || 0) / totalMin;
        const right = !p.known
          ? `<span class="muted">讀不到</span>`
          : p.watts
            ? `<b>${fmt(p.month_kwh, 1)} 度</b><small>$${fmt(p.month_cost)}</small>`
            : `<span class="pill quiet">設定瓦數</span>`;
        return `
          <div class="row tap erow" data-a="dev" data-v="${esc(p.id)}" role="button" tabindex="0">
            <div class="di">${ic(deviceIcon(p.name))}</div>
            <div class="nm"><div class="a"><span>${esc(p.name)}</span></div>
              <div class="b">${p.known ? `開了 ${fmtMin(p.month_min)}` : ""}${p.watts ? `・${fmt(p.watts)} W` : ""}</div>
              <div class="share"><i style="width:${Math.max(1, share * 100)}%"></i></div></div>
            <div class="ev">${right}</div>
          </div>`;
      })
      .join("");
    const hasLast = !!e.last_month.kwh;
    return `
      ${head}
      <div class="grid">
        <section class="card">
          <div class="hero">
            <div><div class="l">本月約</div><div class="big">$${fmt(e.month.cost)}</div><div class="s">${fmt(e.month.kwh, 1)} 度</div></div>
            <div class="hside">
              <div><span>今天</span><b>${fmt(e.today.kwh, 1)} 度</b></div>
              <div><span>上個月</span><b>${hasLast ? `${fmt(e.last_month.kwh, 0)} 度` : "—"}</b></div>
              <div><span>上月電費</span><b>${hasLast ? `$${fmt(e.last_month.cost)}` : "—"}</b></div>
            </div>
          </div>
          ${e.unset ? `<div class="hint" style="margin:0 16px 14px">有 ${e.unset} 個裝置沒設定瓦數，沒算進電費。點下面的裝置設定「接的電器」。</div>` : ""}
          <div class="ch" style="padding-top:4px"><div class="n" style="font-size:15px">${useKwh ? "用電（度）" : "開機時數"}</div>
            <div class="end"><div class="seg">${[["days", "近 30 天"], ["months", "近 12 個月"]]
              .map(([k, l]) => `<button class="${range === k ? "sel" : ""}" data-a="energy-range" data-v="${k}">${l}</button>`)
              .join("")}</div></div></div>
          <div class="chart ${range}">${bars}</div>
          <p class="desc">估算：開著的時間 × 設定的瓦數。時間是插座自己記錄的，樹莓派停機時也有記錄；實際用電會依電器狀態而不同。</p>
        </section>
        <section class="card">
          <div class="ch"><div class="ri" style="background:var(--on-soft);color:var(--on-text)">${ic("mdi:chart-bar")}</div><div class="n">本月各裝置</div><div class="c">點一下可以改瓦數</div></div>
          ${rows}
        </section>
        <section class="card">
          <div class="ch"><div class="ri">${ic("mdi:cash")}</div><div class="n">電費</div></div>
          ${this._numberRow("household_monthly_kwh", "家裡每月用電", "電費單上的度數（兩個月一期的話除以 2），用來決定電價級距", "度", 10)}
          <div class="set"><div class="tx"><div class="l">目前電價</div><div class="s">依每月用電和季節自動算出（夏月 6～9 月較貴）</div></div><div class="readout">${fmt(e.price, 2)} 元/度<small>${esc(e.season)}</small></div></div>
        </section>
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
        </section>
        ${this._googleHtml()}
        <section class="card">
          <div class="ch"><div class="ri">${ic("mdi:magnify")}</div><div class="n">裝置</div></div>
          <button class="set tapset" data-a="cloud-open">
            <div class="tx"><div class="l">TP-Link 雲端</div><div class="s">${this._plugs.filter((p) => p.cloud).length} 個插座連著雲端・家庭中控和 Google Home 都不需要它</div></div>
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
      // 刪除要按兩次
      if (t.dataset.sure) return true;
      t.dataset.sure = "1";
      t.textContent = t.dataset.confirm || "確定要刪除？再按一次";
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
        this._safe(() => api("PATCH", `/api/plugs/${this._sheet.id}`, { watts: t.value ? Number(t.value) : null }));
      },
      "scene-name": (v, t) => (this._sheet.draft.name = t.value),
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
      <div class="q">每天這段時間</div>
      <div class="range"><div><div class="rl">開始</div>${hmPicker("away_start", d.start)}</div><div><div class="rl">結束</div>${hmPicker("away_end", d.end)}</div></div>
      <div class="q">要隨機開關的插座 <small>常開、鎖定、有最長開啟時間的不會出現</small></div>
      ${chips || `<p class="note">沒有可以用的插座。</p>`}
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

  _cloudSheet() {
    const plugs = this._plugs.filter((p) => p.online);
    const on = plugs.filter((p) => p.cloud).length;
    return `
      ${this._sheetHead("mdi:cloud-outline", "TP-Link 雲端", `${on}／${plugs.length} 個插座連著雲端`)}
      <p class="lead">家庭中控和 Google Home（Matter）都在家裡直接控制插座，<b>不需要</b> TP-Link 雲端。斷開後：</p>
      <ul class="bul">
        <li>插座不再和 TP-Link 的伺服器連線，隱私比較好</li>
        <li>Kasa App 在外面不能控制，家裡同一個 Wi-Fi 還可以</li>
        <li>家庭中控、Google Home、排程、插座內建的排程都不受影響</li>
        <li>想恢復的話，要用 Kasa App 重新設定插座</li>
      </ul>
      <div class="actions"><button class="btn" data-a="close">先不要</button><button class="btn danger solid" data-a="cloud-unbind" data-confirm="確定斷開？再按一次">斷開所有插座</button></div>`;
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

  _wheelScroll(col) {
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
    const builders = { kasa: this._kasaSheet, confirm: this._confirmSheet, away: this._awaySheet, cloud: this._cloudSheet, device: this._deviceSheet, timer: this._deviceSheet, plug: this._deviceSheet, room: this._roomSheet, scene: this._sceneSheet, sched: this._schedSheet, watts: this._wattsSheet };
    const html = builders[s.type]?.call(this, s);
    if (html === null || html === undefined) return this._closeSheet();
    const key = `${s.type}|${s.id}|${s.wide ? 1 : 0}`;
    const sheet = this._sheetHost.querySelector(".sheet");
    if (sheet && this._sheetKey === key) {
      // 同一個面板：只更新有變的地方
      morph(sheet, `<div class="grab"></div>${html}`);
      this._syncWheels();
      return;
    }
    this._sheetKey = key;
    this._sheetHost.innerHTML = `<div class="wrap" data-backdrop><div class="sheet ${s.wide ? "wide" : ""}" role="dialog" aria-modal="true"><div class="grab"></div>${html}</div></div>`;
    this._sheetHost.querySelector("[data-backdrop]").addEventListener("click", (e) => {
      if (e.target.matches("[data-backdrop]")) this._closeSheet();
    });
    this._syncWheels();
  }

  _sheetHead(icon, title, sub, iconStyle = "") {
    return `<div class="sh"><div class="di" style="${iconStyle}">${ic(icon)}</div><div style="min-width:0"><div class="t">${esc(title)}</div>${sub ? `<div class="s">${esc(sub)}</div>` : ""}</div>
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
    const callouts = [
      !p.online && `<div class="callout bad">${ic("mdi:wifi-off")}<div><b>連不上這個插座</b><span>檢查插頭有沒有插好、Wi-Fi 有沒有訊號</span></div></div>`,
      p.online && on && p.timer && `<div class="callout timer">${ic("mdi:timer-outline")}<div><b>${fmtLeft(p.timer - now)}後自動關閉</b><span>${clockSec(p.timer)} 關閉</span></div>${p.max_on_s ? "" : `<button class="btn sm" data-a="timer-stop">取消</button>`}</div>`,
    ].filter(Boolean).join("");
    // 定時：有最長時間（澆水）就給短的選項
    const choices = p.max_on_s ? [...new Set([...SHORT_OPTIONS.filter((x) => x < max), max])].slice(-4) : TIMER_OPTIONS.slice(0, 4);
    const opts = choices.map((x) => `<button class="opt" data-a="timer-set" data-v="${x}">${fmtSec(x)}</button>`).join("");
    const timer = p.online && p.protect !== "lock"
      ? `<div class="q">${on ? "定時關閉" : "打開，並在多久後關閉"}</div>
         <div class="opts four">${opts}</div>
         <button class="link sm" data-a="timer-more">${s.customTimer ? "收起" : "自訂時間…"}</button>
         ${s.customTimer ? `${durPicker("timer", s.timerDraft)}<button class="btn primary big" style="margin-top:10px" data-a="timer-custom">${on ? "" : "打開，"}${fmtSec(s.timerDraft)}後關閉</button>` : ""}`
      : "";
    const roomOpts = [`<option value="">還沒分房間</option>`, ...this._rooms.map((r) => `<option value="${esc(r.id)}" ${p.room === r.id ? "selected" : ""}>${esc(r.name)}</option>`)].join("");
    return `
      ${this._sheetHead(deviceIcon(p.name), p.name, `${room}・${status}`, on ? "background:var(--on-soft);color:var(--on)" : "")}
      ${
        !p.online
          ? ""
          : p.protect === "lock"
            ? `<div class="group power"><div class="gi"><div class="gt"><div class="gl">電源・${on ? "開著" : "關著"}</div><div class="gs">已鎖定，要開關請先把下面的「防呆」改掉</div></div><span class="lockmark">${ic("mdi:lock")}</span></div></div>`
            : `<div class="group power"><div class="gi"><div class="gt"><div class="gl">電源</div></div><button class="sw ${on ? "on" : ""}" data-a="dev-power" role="switch" aria-checked="${on}" aria-label="電源"></button></div></div>`
      }
      ${callouts}
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
      ${p.max_on_s ? `<p class="note">不管從 App、Google Home、排程、情境或插座上的按鈕打開都算；「整間打開」不會打開它；關不掉時手機會收到緊急通知。插座本身也會倒數，樹莓派停掉照樣會關。</p>` : ""}
      <div class="q">防呆</div>
      <div class="protect">${PROTECT.map(([k, label, desc]) => `<button class="pr ${p.protect === k ? "sel" : ""}" data-a="protect" data-v="${k}" aria-pressed="${p.protect === k}"><b>${k === "lock" ? ic("mdi:lock") : ""}${label}</b><span>${desc}</span></button>`).join("")}</div>
      <div class="group" style="margin-top:10px">
        <div class="gi">
          <div class="gt"><div class="gl">讓 Google Home 控制</div><div class="gs">關掉後，語音說「全部關掉」也不會動到它</div></div>
          <button class="sw ${p.matter !== false ? "on" : ""}" data-a="matter-toggle" role="switch" aria-checked="${p.matter !== false}" aria-label="讓 Google Home 控制"></button>
        </div>
      </div>
      ${this._hardwareHtml(s, p)}
      <div class="err"></div>
      <p class="meta">${esc(p.model)}・${esc(p.host)}</p>`;
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
        <div class="gi"><span class="gl">Wi-Fi 訊號</span>${sig ? `<span class="gv">${bars(sig.level)}${sig.text}・${p.rssi} dBm</span>` : `<span class="gv muted">—</span>`}</div>
        <div class="gi"><span class="gl">使用時間<small>插座自己記錄的</small></span>${usage}</div>
        ${chart}
        <div class="gi"><span class="gl">內建排程<small>${esc(nativeText)}</small></span>${n && !n.ok ? `<span class="gv warn">${ic("mdi:alert-circle-outline")}</span>` : n ? `<span class="gv ok">${ic("mdi:check-circle")}</span>` : ""}</div>
        ${(n?.kasa || []).length ? `<div class="gi"><span class="gl">Kasa App 設的排程<small>插座自己會執行；在「排程」頁可以修改</small></span><span class="gv kasa">${n.kasa.map((r) => `${r.sact ? "開" : "關"} ${this._ruleText(r)}${r.wday.every(Boolean) ? "" : ` ${r.wday.map((v, i) => (v ? "日一二三四五六"[i] : "")).join("")}`}${r.enable ? "" : "（停用）"}`).join("<br>")}</span></div>` : ""}
        <div class="gi"><span class="gl">TP-Link 雲端</span><span class="gv">${p.cloud ? "連線中" : p.cloud === false ? "未連線" : "—"}</span></div>
        <div class="gi"><span class="gl">重新啟動插座<small>插座卡住時用；${shared ? "整條排插都會重開，" : ""}可能短暫斷電</small></span><button class="btn sm" data-a="reboot" data-confirm="再按一次重新啟動">重新啟動</button></div>
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
        ${isNew ? `<button class="btn" data-a="close">取消</button>` : `<button class="btn danger" data-a="room-delete">刪除房間</button>`}
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
    const rows = this._groups()
      .map((g) => {
        const list = g.plugs
          .map((p) => {
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
          })
          .join("");
        return `<div class="group-title">${esc(g.name)}</div>${list}`;
      })
      .join("");
    return `
      ${this._sheetHead(d.icon, s.id ? "編輯情境" : "新增情境", "按一下情境按鈕，一次設定好多個插座")}
      <div class="q">名稱</div>
      <input class="text" data-c="scene-name" data-autofocus value="${esc(d.name)}" maxlength="20" placeholder="例如：看電影、回家" aria-label="情境名稱">
      <div class="q">圖示</div>
      <div class="chips">${icons}</div>
      <div class="q">按下時，每個插座要：</div>
      <div class="chips" style="margin-bottom:6px">
        <button class="chip" data-a="scene-all" data-v="off">全部設成關閉</button>
        <button class="chip" data-a="scene-all" data-v="keep">全部設成不動</button>
      </div>
      ${rows}
      <div class="q">之後新找到的插座：</div>
      <div class="seg full">
        <button class="${d.others === "keep" ? "sel" : ""}" data-a="scene-others" data-v="keep">不動</button>
        <button class="${d.others === "off" ? "sel off" : ""}" data-a="scene-others" data-v="off">關閉</button>
      </div>
      <div class="err"></div>
      <div class="actions">
        ${s.id ? `<button class="btn danger" data-a="scene-delete">刪除情境</button>` : `<button class="btn" data-a="close">取消</button>`}
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

  _openSchedEditor(id, template) {
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
        Object.assign(draft, { time: "08:30:00", days: [0, 1, 2, 3, 4], action: "scene", scene: sc?.id || null });
      } else if (template === "water") {
        Object.assign(draft, { time: "06:30:00", action: "on", duration_s: 60, plugs: plugs.filter((p) => /澆水|water/i.test(p.name)).map((p) => p.id) });
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
      <div class="q">要做什麼</div>
      <div class="seg full">${action}</div>
      ${restore}
      <div class="q">${d.action === "scene" ? "哪個情境" : d.action === "on" ? "打開哪些插座" : "關閉哪些插座"}</div>
      ${what}
      ${this._backupHtml(s)}
      <div class="err"></div>
      <div class="actions">
        ${s.id ? `<button class="btn danger" data-a="sched-delete">刪除排程</button>` : `<button class="btn" data-a="close">取消</button>`}
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
    };
    this._safe(async () => {
      if (id) await api("PUT", `/api/schedules/${id}`, body);
      else await api("POST", "/api/schedules", body);
      this._closeSheet();
    });
  }
}

customElements.define("plug-app", PlugApp);

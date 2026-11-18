// 插座 App：手機、平板、電腦共用的網頁介面。
//
// 設計原則：看得到的就是全部 —— 開關就是開關、按一次就執行（按錯可以「復原」），
// 沒有要按住、拖拉這類看不到的操作。改名、換房間、調順序都在「編輯」裡用按鈕完成。
//
// 版面：手機一欄 + 下方分頁列；平板兩欄 + 下方分頁列；電腦左側選單 + 兩到三欄。
// 狀態：先拿 /api/state，之後伺服器有變動就從 /api/events 推過來。

import { ICONS } from "./icons.js";

const TOAST_MS = 6000;
const DAYS = ["一", "二", "三", "四", "五", "六", "日"]; // 0 = 星期一（跟伺服器一樣）
const TIMER_OPTIONS = [5, 10, 30, 60, 120];
const WATT_PRESETS = [
  ["燈", 10],
  ["風扇", 40],
  ["電腦", 60],
  ["電視", 100],
  ["電暖器", 1000],
];
const SCENE_ICONS = ["mdi:logout", "mdi:home", "mdi:weather-night", "mdi:white-balance-sunny", "mdi:television", "mdi:lightbulb", "mdi:star-outline"];
const TABS = [
  ["plugs", "插座", "mdi:power-plug"],
  ["schedule", "排程", "mdi:clock-outline"],
  ["energy", "用電", "mdi:chart-bar"],
  ["settings", "設定", "mdi:cog-outline"],
];
const NO_ROOM = "";

// ───────────── 小工具 ─────────────

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const ic = (name) => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="${ICONS[name] || ICONS["mdi:power-plug"]}"/></svg>`;

const fmt = (v, digits = 0) =>
  v === null || v === undefined ? "—" : Number(v).toLocaleString("zh-TW", { minimumFractionDigits: digits, maximumFractionDigits: digits });

const fmtWatts = (w) => (w === null || w === undefined ? "—" : w >= 1000 ? `${fmt(w / 1000, 2)} kW` : `${fmt(w, w < 10 ? 1 : 0)} W`);

// 秒數 → 「2 小時 10 分」
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
  :host {
    --bg: #f3f4f6; --card: #ffffff; --text: #111827; --muted: #6b7280; --faint: #9ca3af;
    --line: #eef0f3; --soft: #f3f4f6; --soft2: #e5e7eb;
    --on: #f59e0b; --on-soft: #fef3c7; --on-text: #b45309;
    --accent: #2563eb; --accent-soft: #dbeafe;
    --danger: #dc2626; --danger-soft: #fef2f2;
    --timer: #7c3aed; --timer-soft: #ede9fe;
    --warn: #ea580c;
    --ok: #16a34a; --ok-soft: #dcfce7;
    --shadow: 0 1px 3px rgba(0,0,0,.06), 0 1px 2px rgba(0,0,0,.04);
    --tabbar: 64px;
    display: block; color: var(--text); background: var(--bg); min-height: 100vh;
    font-family: -apple-system, BlinkMacSystemFont, "Noto Sans TC", "PingFang TC", "Microsoft JhengHei", Roboto, sans-serif;
    -webkit-tap-highlight-color: transparent;
  }
  @media (prefers-color-scheme: dark) {
    :host {
      --bg: #0f1115; --card: #1a1d23; --text: #f3f4f6; --muted: #9ca3af; --faint: #6b7280;
      --line: #262a31; --soft: #252932; --soft2: #3a3f4b;
      --on-soft: rgba(245,158,11,.18); --on-text: #fbbf24;
      --accent: #60a5fa; --accent-soft: rgba(96,165,250,.16);
      --danger: #f87171; --danger-soft: rgba(248,113,113,.12);
      --timer: #a78bfa; --timer-soft: rgba(167,139,250,.18);
      --warn: #fb923c; --ok: #4ade80; --ok-soft: rgba(74,222,128,.15);
      --shadow: none;
    }
  }
  * { box-sizing: border-box; }
  button, select, input { font: inherit; color: inherit; }
  button { background: none; border: 0; padding: 0; cursor: pointer; }
  button:disabled { cursor: default; opacity: .4; }
  :focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
  .i { width: 22px; height: 22px; fill: currentColor; flex: none; display: block; }

  /* ── 外框：手機、平板 ── */
  .content { padding: 0 16px calc(var(--tabbar) + 32px + env(safe-area-inset-bottom)); }
  .page { max-width: 1240px; margin: 0 auto; padding-top: max(14px, env(safe-area-inset-top)); }
  .side { display: none; }
  .tabbar {
    position: fixed; left: 0; right: 0; bottom: 0; z-index: 20;
    display: flex; justify-content: space-around; align-items: stretch;
    height: calc(var(--tabbar) + env(safe-area-inset-bottom)); padding-bottom: env(safe-area-inset-bottom);
    background: var(--card); border-top: 1px solid var(--line);
  }
  .tab { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 3px; font-size: 12px; font-weight: 700; color: var(--faint); }
  .tab .i { width: 26px; height: 26px; }
  .tab.sel { color: var(--text); }
  @media (min-width: 720px) {
    .content { padding-left: 24px; padding-right: 24px; }
    .tab { flex-direction: row; gap: 8px; font-size: 15px; }
  }

  /* ── 電腦：左側選單 ── */
  @media (min-width: 1100px) {
    .tabbar { display: none; }
    .side {
      display: flex; flex-direction: column; gap: 4px; position: fixed; left: 0; top: 0; bottom: 0; width: 228px;
      padding: 22px 14px; background: var(--card); border-right: 1px solid var(--line); z-index: 20;
    }
    .side .logo { display: flex; align-items: center; gap: 10px; font-size: 20px; font-weight: 800; padding: 4px 10px 20px; }
    .side .logo .i { width: 30px; height: 30px; color: var(--on); }
    .side .tab { flex: none; flex-direction: row; justify-content: flex-start; gap: 12px; padding: 12px 14px; border-radius: 12px; font-size: 16px; }
    .side .tab .i { width: 22px; height: 22px; }
    .side .tab.sel { background: var(--soft); }
    .side .conn { margin-top: auto; padding: 10px 14px; font-size: 13px; color: var(--muted); display: flex; gap: 8px; align-items: center; }
    .content { margin-left: 228px; padding: 0 32px 48px; }
    .page { padding-top: 28px; }
  }
  @media (hover: hover) {
    .side .tab:hover:not(.sel) { background: var(--soft); color: var(--text); }
    .row.tap:hover, .sched:hover { background: color-mix(in srgb, var(--soft) 60%, transparent); }
    .scene:hover { transform: translateY(-1px); box-shadow: 0 4px 12px rgba(0,0,0,.08); }
    .btn:hover, .chip:hover:not(.sel), .opt:hover:not(.sel) { filter: brightness(.96); }
  }
  .led { width: 8px; height: 8px; border-radius: 50%; background: var(--ok); flex: none; display: inline-block; }
  .led.bad { background: var(--danger); }

  /* ── 頁首 ── */
  .ph { display: flex; align-items: flex-end; gap: 12px; margin: 4px 2px 14px; }
  .ph h1 { font-size: 30px; line-height: 1.15; font-weight: 800; letter-spacing: -.5px; margin: 0; }
  .ph .sub { font-size: 14px; color: var(--muted); font-weight: 600; margin-top: 3px; }
  .ph .sub b { color: var(--on-text); }
  .ph .right { margin-left: auto; display: flex; gap: 8px; align-items: center; }
  .link { color: var(--accent); font-size: 16px; font-weight: 700; padding: 8px 6px; }
  .btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; height: 40px; padding: 0 16px; border-radius: 999px; font-size: 15px; font-weight: 700; background: var(--soft); white-space: nowrap; text-decoration: none; color: inherit; }
  .btn.primary { background: var(--accent); color: #fff; }
  .btn.danger { background: var(--danger-soft); color: var(--danger); }
  .btn.big { height: 50px; border-radius: 16px; font-size: 16px; width: 100%; }
  .btn .i { width: 20px; height: 20px; }
  .banner { margin: 0 0 12px; padding: 12px 14px; border-radius: 14px; background: var(--danger-soft); color: var(--danger); font-weight: 700; font-size: 14px; display: flex; gap: 8px; align-items: center; }
  .hint { margin: 0 0 12px; padding: 12px 14px; border-radius: 14px; background: var(--accent-soft); color: var(--accent); font-weight: 600; font-size: 14px; line-height: 1.55; }

  /* ── 情境按鈕 ── */
  .scenes { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin-bottom: 14px; }
  .scene {
    background: var(--card); border-radius: 16px; min-height: 78px; padding: 8px 4px; box-shadow: var(--shadow);
    display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px;
    font-size: 14px; font-weight: 800; transition: transform .12s, box-shadow .12s; text-align: center; min-width: 0;
  }
  .scene .si { width: 36px; height: 36px; border-radius: 12px; display: flex; align-items: center; justify-content: center; background: var(--accent-soft); color: var(--accent); }
  .scene .si .i { width: 20px; height: 20px; }
  .scene.danger { color: var(--danger); }
  .scene.danger .si { background: var(--danger-soft); color: var(--danger); }
  .scene:active { transform: scale(.97); }
  .scene span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; padding: 0 4px; }
  @media (min-width: 720px) {
    .scenes { grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); }
    .scene { flex-direction: row; justify-content: flex-start; padding: 12px 14px; min-height: 64px; font-size: 15px; gap: 10px; }
  }

  /* ── 卡片與列（平板兩欄、大螢幕三欄） ── */
  .grid { columns: 1; column-gap: 14px; }
  @media (min-width: 720px) { .grid { columns: 2; } }
  @media (min-width: 1500px) { .grid.wide { columns: 3; } }
  .card { background: var(--card); border-radius: 20px; box-shadow: var(--shadow); overflow: hidden; margin: 0 0 14px; break-inside: avoid; }
  .ch { display: flex; align-items: center; gap: 10px; padding: 12px 14px 8px; min-height: 56px; }
  .ch .ri { width: 34px; height: 34px; border-radius: 11px; background: var(--accent-soft); color: var(--accent); display: flex; align-items: center; justify-content: center; flex: none; }
  .ch .ri .i { width: 20px; height: 20px; }
  .ch .n { font-size: 18px; font-weight: 800; white-space: nowrap; }
  .ch .c { font-size: 13px; color: var(--muted); font-weight: 600; white-space: nowrap; }
  .ch .end { margin-left: auto; display: flex; gap: 6px; align-items: center; }
  .pill { font-size: 14px; font-weight: 700; border-radius: 999px; padding: 8px 12px; background: var(--soft); white-space: nowrap; }
  .pill.danger { color: var(--danger); background: var(--danger-soft); }
  .pill.accent { color: var(--accent); background: var(--accent-soft); }
  .desc { font-size: 14px; color: var(--muted); line-height: 1.55; margin: 0; }
  .card > .desc { padding: 0 16px 14px; }

  .row { display: flex; align-items: center; gap: 12px; min-height: 64px; padding: 6px 12px 6px 14px; position: relative; width: 100%; text-align: left; }
  .row + .row::before { content: ""; position: absolute; left: 64px; right: 0; top: 0; border-top: 1px solid var(--line); }
  .row.tap { cursor: pointer; user-select: none; -webkit-user-select: none; }
  .di { width: 40px; height: 40px; border-radius: 50%; background: var(--soft); color: var(--faint); display: flex; align-items: center; justify-content: center; flex: none; transition: background .15s, color .15s; }
  .di .i { width: 21px; height: 21px; }
  .on > .di { background: var(--on-soft); color: var(--on-text); }
  .nm { flex: 1; min-width: 0; text-align: left; }
  .nm .a { font-size: 17px; font-weight: 700; display: flex; align-items: center; gap: 6px; min-width: 0; }
  .nm .a > span:first-child { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .nm .b { font-size: 13px; color: var(--faint); font-weight: 600; margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .on .nm .b { color: var(--on-text); }
  .nm .b.warn { color: var(--warn); }
  .nm .b.timer { color: var(--timer); }
  .nm .b.bad { color: var(--danger); }
  .row.offline .nm .a { color: var(--muted); }
  .tm { width: 42px; height: 42px; border-radius: 50%; display: flex; align-items: center; justify-content: center; color: var(--faint); flex: none; }
  .tm .i { width: 22px; height: 22px; }
  .tm.act { background: var(--timer-soft); color: var(--timer); }
  .sw { width: 56px; height: 34px; border-radius: 17px; background: var(--soft2); position: relative; flex: none; transition: background .18s; }
  .sw::after { content: ""; position: absolute; width: 28px; height: 28px; border-radius: 50%; background: #fff; top: 3px; left: 3px; box-shadow: 0 2px 4px rgba(0,0,0,.25); transition: left .18s; }
  .on > .sw, .sw.on { background: var(--on); }
  .on > .sw::after, .sw.on::after { left: 25px; }
  .row.pending .sw { opacity: .55; }
  .empty { padding: 28px 18px; text-align: center; color: var(--muted); font-size: 15px; line-height: 1.6; }

  /* 編輯模式 */
  .mv { display: flex; gap: 4px; flex: none; }
  .mv button { width: 38px; height: 38px; border-radius: 10px; background: var(--soft); display: flex; align-items: center; justify-content: center; }
  .mv button .i { width: 20px; height: 20px; }
  select.pick { height: 38px; border-radius: 999px; border: 0; background: var(--soft); padding: 0 10px; font-size: 14px; font-weight: 700; max-width: 120px; flex: none; }
  .pen { color: var(--faint); display: inline-flex; }
  .nm > button.a { max-width: 100%; }
  .nm select.pick { margin-top: 6px; height: 34px; max-width: 100%; }
  .pen .i { width: 16px; height: 16px; }
  .add { display: flex; align-items: center; justify-content: center; gap: 6px; width: 100%; height: 52px; border-radius: 16px; border: 2px dashed var(--soft2); color: var(--muted); font-size: 16px; font-weight: 700; margin: 0 0 14px; break-inside: avoid; }
  .card .add { border: 0; border-top: 1px solid var(--line); border-radius: 0; margin: 0; height: 52px; color: var(--accent); }

  /* ── 排程 ── */
  .sched { display: flex; align-items: center; gap: 14px; padding: 12px 12px 12px 16px; width: 100%; text-align: left; position: relative; cursor: pointer; }
  .sched + .sched::before { content: ""; position: absolute; left: 16px; right: 0; top: 0; border-top: 1px solid var(--line); }
  .sched .t { font-size: 30px; font-weight: 800; font-variant-numeric: tabular-nums; letter-spacing: -.5px; min-width: 86px; }
  .sched .d { flex: 1; min-width: 0; }
  .sched .d .x { font-size: 15px; font-weight: 800; }
  .sched .d .y { font-size: 13px; color: var(--muted); font-weight: 600; margin-top: 2px; line-height: 1.45; }
  .sched.off .t, .sched.off .d { opacity: .45; }
  .templates { display: flex; flex-wrap: wrap; gap: 8px; padding: 0 16px 16px; }

  /* ── 用電 ── */
  .stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; padding: 6px 16px 16px; }
  .stat .l { font-size: 13px; color: var(--muted); font-weight: 600; }
  .stat .v { font-size: 22px; font-weight: 800; margin-top: 2px; font-variant-numeric: tabular-nums; }
  .stat .v small { font-size: 13px; color: var(--muted); font-weight: 600; margin-left: 2px; }
  .chart { display: flex; align-items: flex-end; gap: 5px; height: 140px; padding: 0 16px 14px; }
  .bar { flex: 1; height: 100%; display: flex; flex-direction: column; justify-content: flex-end; align-items: center; gap: 4px; }
  .bar div { width: 100%; background: color-mix(in srgb, var(--on) 45%, transparent); border-radius: 4px 4px 2px 2px; min-height: 2px; }
  .bar.today div { background: var(--on); }
  .bar span { font-size: 10px; color: var(--faint); }

  /* ── 設定 ── */
  .set { display: flex; align-items: center; gap: 12px; padding: 12px 16px; position: relative; }
  .set + .set::before { content: ""; position: absolute; left: 16px; right: 0; top: 0; border-top: 1px solid var(--line); }
  .set .tx { flex: 1; min-width: 0; }
  .set .l { font-size: 16px; font-weight: 700; }
  .set .s { font-size: 13px; color: var(--muted); margin-top: 2px; line-height: 1.45; }
  .num { display: flex; align-items: center; gap: 4px; flex: none; }
  .num button { width: 36px; height: 36px; border-radius: 10px; background: var(--soft); font-size: 20px; font-weight: 600; }
  .num input { width: 66px; height: 36px; border: 0; border-radius: 10px; background: var(--soft); text-align: center; font-size: 16px; font-weight: 700; }
  .num .u { font-size: 13px; color: var(--muted); min-width: 26px; }
  .text { height: 46px; border: 0; border-radius: 12px; background: var(--soft); padding: 0 12px; font-size: 16px; width: 100%; min-width: 0; }
  .inline { display: flex; gap: 8px; padding: 0 16px 14px; }
  .readout { font-size: 15px; font-weight: 700; text-align: right; }
  .readout small { display: block; font-size: 12px; color: var(--muted); font-weight: 500; }
  .badge { font-size: 12px; font-weight: 700; padding: 4px 10px; border-radius: 999px; background: var(--soft); color: var(--muted); white-space: nowrap; }
  .badge.ok { background: var(--ok-soft); color: var(--ok); }
  .badge.wait { background: var(--accent-soft); color: var(--accent); }
  .pair { display: flex; gap: 16px; align-items: center; flex-wrap: wrap; padding: 4px 16px 6px; }
  .pair img { width: 168px; height: 168px; border-radius: 12px; background: #fff; flex: none; }
  .pair-code { font-size: 22px; font-weight: 800; letter-spacing: 1px; font-variant-numeric: tabular-nums; user-select: all; }
  .steps { margin: 6px 16px 10px; padding-left: 20px; font-size: 14px; line-height: 1.65; color: var(--muted); }
  .steps b { color: var(--text); }
  code { font-size: 13px; background: var(--soft); padding: 2px 6px; border-radius: 6px; }

  /* ── 面板：手機從下面滑上來；平板、電腦是置中的對話框 ── */
  .wrap { position: fixed; inset: 0; z-index: 40; background: rgba(17,24,39,.45); display: flex; align-items: flex-end; justify-content: center; animation: fade .15s; }
  .sheet {
    width: 100%; max-height: 92vh; overflow: auto; background: var(--card); border-radius: 24px 24px 0 0;
    padding: 10px 18px calc(22px + env(safe-area-inset-bottom)); animation: up .2s ease-out; overscroll-behavior: contain;
  }
  .grab { width: 40px; height: 5px; border-radius: 3px; background: var(--soft2); margin: 0 auto 12px; }
  @media (min-width: 720px) {
    .wrap { align-items: center; }
    .sheet { width: min(520px, 92vw); max-height: 88vh; border-radius: 24px; padding: 22px 24px 24px; animation: pop .16s ease-out; }
    .sheet.wide { width: min(680px, 94vw); }
    .grab { display: none; }
  }
  @keyframes fade { from { opacity: 0; } }
  @keyframes up { from { transform: translateY(40px); opacity: .6; } }
  @keyframes pop { from { transform: scale(.97); opacity: 0; } }
  .sh { display: flex; align-items: center; gap: 12px; margin-bottom: 4px; }
  .sh .di { width: 46px; height: 46px; }
  .sh .di .i { width: 24px; height: 24px; }
  .sh .t { font-size: 21px; font-weight: 800; }
  .sh .s { font-size: 14px; color: var(--muted); font-weight: 600; }
  .sh .x { margin-left: auto; width: 40px; height: 40px; border-radius: 50%; background: var(--soft); display: flex; align-items: center; justify-content: center; flex: none; }
  .q { font-size: 15px; font-weight: 800; margin: 20px 0 10px; }
  .q small { font-weight: 600; color: var(--muted); }
  .opts { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
  .opt { min-height: 56px; border-radius: 16px; background: var(--soft); display: flex; align-items: center; justify-content: center; gap: 6px; font-size: 16px; font-weight: 800; padding: 6px; text-align: center; }
  .opt.timer:active { background: var(--timer); color: #fff; }
  .chips { display: flex; flex-wrap: wrap; gap: 8px; }
  .chip { min-height: 40px; padding: 8px 14px; border-radius: 999px; background: var(--soft); font-size: 15px; font-weight: 700; display: inline-flex; gap: 4px; align-items: center; }
  .chip.sel { background: var(--accent); color: #fff; }
  .chip.day { width: 44px; justify-content: center; padding: 0; }
  .chip .i { width: 18px; height: 18px; }
  .seg { display: flex; background: var(--soft); border-radius: 12px; padding: 3px; gap: 2px; flex: none; }
  .seg button { font-size: 14px; font-weight: 800; padding: 8px 10px; border-radius: 9px; color: var(--muted); }
  .seg button.sel { background: var(--card); color: var(--text); box-shadow: 0 1px 2px rgba(0,0,0,.12); }
  .seg button.sel.on { background: var(--on); color: #fff; }
  .seg button.sel.off { background: #374151; color: #fff; }
  .seg.full { width: 100%; }
  .seg.full button { flex: 1; padding: 11px 6px; }
  .group-title { display: flex; align-items: center; font-size: 13px; font-weight: 800; color: var(--muted); margin: 16px 2px 6px; }
  .group-title .link { margin-left: auto; font-size: 13px; padding: 2px 4px; }
  .actions { display: flex; gap: 10px; margin-top: 22px; }
  .actions .btn { flex: 1; height: 50px; border-radius: 16px; font-size: 16px; }
  .field { display: flex; align-items: center; gap: 10px; }
  input[type="time"] { height: 56px; border: 0; border-radius: 14px; background: var(--soft); padding: 0 14px; font-size: 26px; font-weight: 800; color-scheme: light dark; }
  input[type="time"].small { height: 46px; font-size: 18px; }
  select.text { appearance: auto; }
  .note { font-size: 14px; color: var(--muted); line-height: 1.55; margin: 12px 0 0; }
  .err { color: var(--danger); font-weight: 700; font-size: 14px; margin-top: 12px; }
  .err:empty { display: none; }
  .srow { display: flex; align-items: center; gap: 10px; padding: 8px 0; border-top: 1px solid var(--line); }
  .srow .nm .a { font-size: 16px; }
  .srow .di { width: 34px; height: 34px; }

  /* ── 提示條 ── */
  .toast {
    position: fixed; left: 16px; right: 16px; bottom: calc(var(--tabbar) + 14px + env(safe-area-inset-bottom)); z-index: 50;
    background: #111827; color: #fff; border-radius: 16px; padding: 14px 16px; display: flex; align-items: center; gap: 12px;
    font-size: 15px; font-weight: 600; box-shadow: 0 10px 24px rgba(0,0,0,.25); animation: up .2s ease-out;
  }
  .toast button { margin-left: auto; color: #fbbf24; font-weight: 800; display: flex; gap: 4px; align-items: center; white-space: nowrap; padding: 4px; }
  .toast button .i { width: 18px; height: 18px; }
  @media (min-width: 720px) { .toast { left: 50%; right: auto; transform: translateX(-50%); width: max-content; min-width: 360px; max-width: 560px; animation: fade .2s; } }
  @media (min-width: 1100px) { .toast { bottom: 28px; margin-left: 114px; } }
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
    window.addEventListener("hashchange", () => {
      const tab = this._tabFromHash();
      if (tab && tab !== this._tab) this._go(tab, false);
    });
    // 「開了多久」「還有幾分鐘」每 30 秒更新一次
    setInterval(() => this._update(), 30000);
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
      page = `<div class="ph"><div><h1>插座</h1></div></div><div class="card"><div class="empty">${this._connected ? "載入中…" : "連不上插座伺服器。<br>確認這台裝置和樹莓派在同一個網路。"}</div></div>`;
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
    this._root.innerHTML = `
      <nav class="side" aria-label="選單"><div class="logo">${ic("mdi:power-plug")}插座</div>${nav}${conn}</nav>
      <main class="content"><div class="page">${banner}${page}</div></main>
      <nav class="tabbar" aria-label="選單">${nav}</nav>`;
  }

  // ── 插座 ──

  _plugsPage() {
    const plugs = this._plugs;
    const onCount = plugs.filter((p) => p.online && this._isOn(p)).length;
    const head = `
      <div class="ph">
        <div><h1>插座</h1><div class="sub"><b>${onCount} 個開著</b>・共 ${plugs.length} 個</div></div>
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
    const off = g.id !== NO_ROOM && canOff ? `<button class="pill danger" data-a="room-off" data-v="${esc(g.id)}">整間關閉</button>` : "";
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
    if (!p.online) {
      return `
        <div class="row offline tap" data-a="offline" data-v="${esc(p.id)}">
          <div class="di">${ic("mdi:wifi-off")}</div>
          <div class="nm"><div class="a"><span>${esc(p.name)}</span></div><div class="b bad">連不上</div></div>
        </div>`;
    }
    const on = this._isOn(p);
    const now = this._now();
    let sub = "關著";
    let cls = "";
    if (on && p.timer) {
      sub = `開著・${fmtDur(p.timer - now)}後自動關閉`;
      cls = "timer";
    } else if (on) {
      const since = p.on_since ? now - p.on_since : null;
      const long = since && !p.keep_on && since > (this._s.settings.long_on_hours || 6) * 3600;
      const watts = p.power !== null && p.power !== undefined ? `・${fmtWatts(p.power)}` : "";
      sub = (since === null ? "開著" : since < 60 ? "剛打開" : `開了 ${fmtDur(since)}${long ? "・很久沒關了" : ""}`) + watts + (p.keep_on ? "・常開" : "");
      if (long) cls = "warn";
    }
    return `
      <div class="row tap ${on ? "on" : ""} ${this._pending.has(p.id) ? "pending" : ""}" data-a="toggle" data-v="${esc(p.id)}"
        role="switch" aria-checked="${on}" tabindex="0" aria-label="${esc(p.name)}">
        <div class="di">${ic(deviceIcon(p.name))}</div>
        <div class="nm"><div class="a"><span>${esc(p.name)}</span></div><div class="b ${cls}">${esc(sub)}</div></div>
        <button class="tm ${on && p.timer ? "act" : ""}" data-a="timer" data-v="${esc(p.id)}" aria-label="定時關閉 ${esc(p.name)}">${ic("mdi:timer-outline")}</button>
        <span class="sw" aria-hidden="true"></span>
      </div>`;
  }

  // ── 編輯 ──

  _editPage() {
    const scenes = this._scenes;
    const sceneRows = scenes
      .map(
        (sc, i) => `
        <div class="row">
          <div class="di">${ic(sc.icon)}</div>
          <button class="nm" data-a="scene-edit" data-v="${esc(sc.id)}"><div class="a"><span>${esc(sc.name)}</span><span class="pen">${ic("mdi:pencil")}</span></div><div class="b">設定要開關哪些插座</div></button>
          ${this._moveBtns("scene", sc.id, i, scenes.length)}
        </div>`,
      )
      .join("");
    const rooms = this._rooms;
    const cards = this._groups(true)
      .map((g) => {
        const ri = rooms.findIndex((r) => r.id === g.id);
        const roomBtns =
          g.id === NO_ROOM ? "" : `<button class="pill accent" data-a="room-edit" data-v="${esc(g.id)}">改名</button>${this._moveBtns("room", g.id, ri, rooms.length)}`;
        const rows = g.plugs.length
          ? g.plugs
              .map((p, i) => {
                const opts = [`<option value="">還沒分房間</option>`, ...rooms.map((r) => `<option value="${esc(r.id)}" ${p.room === r.id ? "selected" : ""}>${esc(r.name)}</option>`)].join("");
                return `
                <div class="row">
                  <div class="di">${ic(deviceIcon(p.name))}</div>
                  <div class="nm">
                    <button class="a" data-a="plug-edit" data-v="${esc(p.id)}"><span>${esc(p.name)}</span><span class="pen">${ic("mdi:pencil")}</span>${p.keep_on ? '<span class="badge">常開</span>' : ""}</button>
                    <select class="pick" data-c="plug-room" data-v="${esc(p.id)}" aria-label="${esc(p.name)} 的房間">${opts}</select>
                  </div>
                  ${this._moveBtns("plug", p.id, i, g.plugs.length)}
                </div>`;
              })
              .join("")
          : `<p class="desc">還沒有插座。用其他插座旁的選單把它換到這個房間。</p>`;
        return `
          <section class="card">
            <div class="ch"><div class="ri">${ic(g.icon || "mdi:home-outline")}</div><div class="n">${esc(g.name)}</div><div class="end">${roomBtns}</div></div>
            ${rows}
          </section>`;
      })
      .join("");
    return `
      <div class="ph">
        <div><h1>編輯</h1><div class="sub">改名稱、換房間、調順序</div></div>
        <div class="right"><button class="btn primary" data-a="edit-done">完成</button></div>
      </div>
      <div class="hint">點名稱可以改名、設定「常開」；用名稱下面的選單換房間；用 ⌃ ⌄ 調整順序。</div>
      <div class="grid wide">
        <section class="card">
          <div class="ch"><div class="ri">${ic("mdi:star-outline")}</div><div class="n">情境</div></div>
          ${sceneRows}
          <button class="add" data-a="scene-new">${ic("mdi:plus")}新增情境</button>
        </section>
        ${cards}
        <button class="add" data-a="room-new">${ic("mdi:plus")}新增房間</button>
      </div>`;
  }

  _moveBtns(kind, id, i, n) {
    return `<div class="mv">
      <button data-a="move" data-k="${kind}" data-v="${esc(id)}" data-d="-1" ${i <= 0 ? "disabled" : ""} aria-label="往上">${ic("mdi:chevron-up")}</button>
      <button data-a="move" data-k="${kind}" data-v="${esc(id)}" data-d="1" ${i >= n - 1 ? "disabled" : ""} aria-label="往下">${ic("mdi:chevron-down")}</button>
    </div>`;
  }

  // ── 排程 ──

  _schedulePage() {
    const scheds = this._s.schedules || [];
    const rows = scheds.map((x) => this._schedRow(x)).join("");
    const timers = this._plugs.filter((p) => p.timer && p.online && this._isOn(p));
    const now = this._now();
    const timerRows = timers.length
      ? timers
          .map(
            (p) => `
          <div class="row on">
            <div class="di">${ic(deviceIcon(p.name))}</div>
            <div class="nm"><div class="a"><span>${esc(p.name)}</span></div><div class="b timer">還有 ${fmtDur(p.timer - now)}・${clock(p.timer)} 關閉</div></div>
            <button class="pill" data-a="timer-cancel" data-v="${esc(p.id)}">取消</button>
          </div>`,
          )
          .join("")
      : `<p class="desc">在「插座」頁按插座旁的 ⏱，可以設定幾分鐘後自動關閉。</p>`;
    const empty = `
      <p class="desc" style="padding:0 16px 12px">還沒有排程。可以從這些開始：</p>
      <div class="templates">
        <button class="chip" data-a="sched-template" data-v="night">每晚 23:00 關燈、早上再開</button>
        <button class="chip" data-a="sched-template" data-v="leave">平日 08:30 執行「出門」</button>
        <button class="chip" data-a="sched-template" data-v="water">每天 06:30 打開澆水</button>
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
        </section>
        <section class="card">
          <div class="ch"><div class="ri" style="background:var(--timer-soft);color:var(--timer)">${ic("mdi:timer-outline")}</div><div class="n">定時關閉中</div></div>
          ${timerRows}
        </section>
      </div>`;
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
    const extra = x.action === "off" && x.restore_at ? `，${x.restore_at < x.time ? "隔天" : ""} ${x.restore_at} 再打開` : "";
    return `
      <div class="sched ${x.enabled ? "" : "off"}" data-a="sched-edit" data-v="${esc(x.id)}" role="button" tabindex="0">
        <div class="t">${esc(x.time)}</div>
        <div class="d"><div class="x">${daysText(x.days)}${x.enabled ? "" : "・已暫停"}</div><div class="y">${this._schedDesc(x)}${extra}</div></div>
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

  _energyPage() {
    const s = this._s;
    const sum = s.summary;
    const hist = sum.history || [];
    const max = Math.max(0.001, ...hist.map((d) => d.kwh));
    const bars = hist
      .map((d, i) => {
        const today = i === hist.length - 1;
        return `<div class="bar ${today ? "today" : ""}" title="${d.day}：${fmt(d.kwh, 2)} 度"><div style="height:${(d.kwh / max) * 100}%"></div><span>${today ? "今" : Number(d.day.slice(8))}</span></div>`;
      })
      .join("");
    const plugs = this._plugs;
    const rows = plugs
      .map((p) => {
        if (p.mode === "metered") {
          return `<div class="row"><div class="di">${ic(deviceIcon(p.name))}</div><div class="nm"><div class="a"><span>${esc(p.name)}</span></div><div class="b">有計量・現在 ${fmtWatts(p.power)}</div></div></div>`;
        }
        return `<div class="row"><div class="di">${ic(deviceIcon(p.name))}</div><div class="nm"><div class="a"><span>${esc(p.name)}</span></div></div>
          <select class="pick" style="max-width:150px" data-c="watts" data-v="${esc(p.id)}" aria-label="${esc(p.name)} 接的電器">${this._wattOptions(p)}</select></div>`;
      })
      .join("");
    const noMeter = plugs.every((p) => p.mode !== "metered");
    return `
      <div class="ph"><div><h1>用電</h1><div class="sub">台電累進電價・${esc(sum.season)} ${fmt(sum.price, 2)} 元/度</div></div></div>
      <div class="grid">
        <section class="card">
          <div class="ch"><div class="ri" style="background:var(--on-soft);color:var(--on-text)">${ic("mdi:chart-bar")}</div><div class="n">用了多少電</div></div>
          <div class="stats">
            <div class="stat"><div class="l">現在</div><div class="v">${sum.power === null ? "—" : fmtWatts(sum.power)}</div></div>
            <div class="stat"><div class="l">今天</div><div class="v">${fmt(sum.energy_today, 2)}<small>度</small></div><div class="l">約 $${fmt(sum.cost_today, 1)}</div></div>
            <div class="stat"><div class="l">本月</div><div class="v">${fmt(sum.energy_month, 1)}<small>度</small></div><div class="l">約 $${fmt(sum.cost_month)}</div></div>
          </div>
          <div class="chart">${bars}</div>
          ${noMeter ? `<p class="desc">你的插座量不到用電。在「估算用電」幫插座選接的是什麼電器，就會用「開著的時間 × 瓦數」估算。</p>` : ""}
        </section>
        <section class="card">
          <div class="ch"><div class="ri">${ic("mdi:flash")}</div><div class="n">估算用電</div></div>
          <p class="desc">沒有計量的插座，選接的是什麼電器：</p>
          ${rows}
        </section>
        <section class="card">
          <div class="ch"><div class="ri">${ic("mdi:cash")}</div><div class="n">電費</div></div>
          ${this._numberRow("household_monthly_kwh", "家裡每月用電", "電費單上的度數（兩個月一期的話除以 2），用來決定電價級距", "度", 10)}
          <div class="set"><div class="tx"><div class="l">目前電價</div><div class="s">依每月用電和季節自動算出</div></div><div class="readout">${fmt(sum.price, 2)} 元/度<small>${esc(sum.season)}</small></div></div>
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
          <div class="ch"><div class="ri">${ic("mdi:magnify")}</div><div class="n">插座</div></div>
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
    if ((e.key === "Enter" || e.key === " ") && t.matches?.('.row[role="switch"], .sched[role="button"]')) {
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
      t.textContent = "確定要刪除？再按一次";
      return false;
    };
    const redraw = (fn) => () => {
      fn(this._sheet.draft);
      this._renderSheet();
    };
    return {
      tab: (v) => this._go(v),
      toggle: (v) => this._toggle(v),
      offline: (v) => this._showToast(`${this._plug(v)?.name || "插座"}連不上：檢查插頭有沒有插好、Wi-Fi 有沒有訊號`),
      timer: (v) => this._openSheet({ type: "timer", id: v, live: true }),
      "all-off": () => this._turnOff({}),
      "room-off": (v) => this._turnOff({ room: v }),
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
      move: (v, t) => this._move(t.dataset.k, v, Number(t.dataset.d)),
      "plug-edit": (v) => this._openSheet({ type: "plug", id: v }),
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
          this._showToast(x.enabled ? "排程已暫停" : "排程已啟用");
        });
      },
      "timer-cancel": (v) =>
        this._safe(async () => {
          await api("DELETE", `/api/plugs/${v}/timer`);
          this._showToast("已取消定時，插座保持開著");
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
      "timer-custom": () => {
        const n = Number(this._sheetHost.querySelector("[data-timer-min]")?.value);
        if (!(n >= 1 && n <= 1440)) return this._sheetError("請輸入 1～1440 分鐘");
        this._setTimer(this._sheet.id, n);
      },
      "timer-stop": () =>
        this._safe(async () => {
          await api("DELETE", `/api/plugs/${this._sheet.id}/timer`);
          this._closeSheet();
          this._showToast("已取消定時，插座保持開著");
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
          this._showToast("已儲存瓦數");
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
          this._showToast("已刪除情境");
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
      "sched-restore": () => redraw((d) => (d.restore_at = d.restore_at ? null : "07:00"))(),
      "sched-save": () => this._saveSched(),
      "sched-delete": (v, t) =>
        sure(t) &&
        this._safe(async () => {
          await api("DELETE", `/api/schedules/${this._sheet.id}`);
          this._closeSheet();
          this._showToast("已刪除排程");
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
      "sched-time": (v, t) => {
        if (t.value) {
          this._sheet.draft[v] = t.value;
          if (v === "time" || v === "restore_at") this._renderSheet();
        }
      },
      "scene-name": (v, t) => (this._sheet.draft.name = t.value),
    };
  }

  // ───────────── 動作 ─────────────

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
      const where = body.room ? this._room(body.room)?.name || "" : "";
      this._showToast(res.count ? `已關閉${where} ${res.count} 個插座` : "沒有開著的插座", res.count > 0);
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

  async _setTimer(id, minutes) {
    const p = this._plug(id);
    try {
      await api("POST", `/api/plugs/${id}/timer`, { minutes });
      this._closeSheet();
      this._showToast(`${p?.name} 會在 ${fmtDur(minutes * 60)}後自動關閉`);
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
        this._showToast(res.count ? `已復原 ${res.count} 個插座` : "已經是原本的樣子了");
      } catch (err) {
        this._showToast(`沒有成功：${err.message}`);
      }
    });
    this._toastTimer = setTimeout(() => (this._toastHost.innerHTML = ""), TOAST_MS);
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
    const builders = { timer: this._timerSheet, plug: this._plugSheet, room: this._roomSheet, scene: this._sceneSheet, sched: this._schedSheet, watts: this._wattsSheet };
    const html = builders[s.type]?.call(this, s);
    if (html === null || html === undefined) return this._closeSheet();
    const scroll = this._sheetHost.querySelector(".sheet")?.scrollTop || 0;
    this._sheetHost.innerHTML = `<div class="wrap" data-backdrop><div class="sheet ${s.wide ? "wide" : ""}" role="dialog" aria-modal="true"><div class="grab"></div>${html}</div></div>`;
    this._sheetHost.querySelector(".sheet").scrollTop = scroll;
    this._sheetHost.querySelector("[data-backdrop]").addEventListener("click", (e) => {
      if (e.target.matches("[data-backdrop]")) this._closeSheet();
    });
  }

  _sheetHead(icon, title, sub, iconStyle = "") {
    return `<div class="sh"><div class="di" style="${iconStyle}">${ic(icon)}</div><div style="min-width:0"><div class="t">${esc(title)}</div>${sub ? `<div class="s">${esc(sub)}</div>` : ""}</div>
      <button class="x" data-a="close" aria-label="關閉">${ic("mdi:close")}</button></div>`;
  }

  _timerSheet(s) {
    const p = this._plug(s.id);
    if (!p) return null;
    const on = this._isOn(p);
    const room = this._room(p.room)?.name || "還沒分房間";
    const now = this._now();
    const active =
      p.timer && on
        ? `<div class="hint" style="margin:14px 0 10px;background:var(--timer-soft);color:var(--timer)">還有 ${fmtDur(p.timer - now)}，${clock(p.timer)} 自動關閉。</div>
           <button class="btn big" data-a="timer-stop">取消定時（保持開著）</button>`
        : "";
    const opts = TIMER_OPTIONS.map((m) => `<button class="opt timer" data-a="timer-set" data-v="${m}">${m < 60 ? `${m} 分鐘` : `${m / 60} 小時`}</button>`).join("");
    return `
      ${this._sheetHead(deviceIcon(p.name), p.name, `${room}・現在${on ? "開著" : "關著"}`, "background:var(--timer-soft);color:var(--timer)")}
      ${active}
      <div class="q">${on ? (p.timer ? "改成多久後關閉？" : "多久後自動關閉？") : "打開，多久後自動關閉？"}</div>
      <div class="opts">${opts}
        <div class="opt" style="padding:6px"><input class="text" data-timer-min data-enter="timer-custom" type="number" inputmode="numeric" min="1" max="1440" placeholder="自訂分鐘" style="height:44px;text-align:center;background:var(--card)" aria-label="自訂分鐘"></div>
      </div>
      <button class="btn big" style="margin-top:10px" data-a="timer-custom">用自訂的分鐘數</button>
      <div class="err"></div>
      <p class="note">時間到會自動關閉${this._s.settings.ntfy_topic ? "，手機也會收到通知" : ""}。中途想停，直接按開關關掉就好。</p>`;
  }

  _plugSheet(s) {
    const p = this._plug(s.id);
    if (!p) return null;
    const opts = [`<option value="">還沒分房間</option>`, ...this._rooms.map((r) => `<option value="${esc(r.id)}" ${p.room === r.id ? "selected" : ""}>${esc(r.name)}</option>`)].join("");
    return `
      ${this._sheetHead(deviceIcon(p.name), p.name, `${p.model}・${p.host}`)}
      <div class="q">名稱</div>
      <div class="field"><input class="text" data-plug-name data-enter="plug-save" data-autofocus value="${esc(p.name)}" maxlength="30" aria-label="名稱"><button class="btn primary" style="height:46px" data-a="plug-save">儲存</button></div>
      ${p.kasa_name !== p.name ? `<p class="note">插座本身的名稱：${esc(p.kasa_name)}（清空後儲存就改回這個）</p>` : ""}
      <div class="q">房間</div>
      <select class="text" data-c="sheet-room" aria-label="房間">${opts}</select>
      ${p.mode === "metered" ? "" : `<div class="q">接的電器 <small>用來估算用電</small></div><select class="text" data-c="sheet-watts" aria-label="接的電器">${this._wattOptions(p)}</select>`}
      <div class="set" style="padding:18px 0 0">
        <div class="tx"><div class="l">常開</div><div class="s">全部關閉、整間關閉、情境、排程都不會關它（例如路由器、冰箱）</div></div>
        <button class="sw ${p.keep_on ? "on" : ""}" data-a="keep-on" role="switch" aria-checked="${p.keep_on}" aria-label="常開"></button>
      </div>
      <div class="err"></div>`;
  }

  _savePlugName() {
    const input = this._sheetHost.querySelector("[data-plug-name]");
    this._safe(async () => {
      await api("PATCH", `/api/plugs/${this._sheet.id}`, { name: input.value });
      this._closeSheet();
      this._showToast("已改名");
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
      this._showToast(id ? "已改名" : `已建立「${name}」，用插座旁的選單把插座換進來`);
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
      this._showToast(id ? "已儲存情境" : `已新增「${name}」，在插座頁最上面`);
    });
  }

  // ── 排程編輯 ──

  _openSchedEditor(id, template) {
    const x = id ? (this._s.schedules || []).find((s) => s.id === id) : null;
    let draft;
    if (x) {
      draft = { ...x, days: [...x.days], plugs: [...x.plugs] };
    } else {
      draft = { enabled: true, time: "23:00", days: [0, 1, 2, 3, 4, 5, 6], action: "off", scene: null, plugs: [], restore_at: null };
      const plugs = this._plugs;
      if (template === "night") {
        draft.plugs = plugs.filter((p) => deviceIcon(p.name) === "mdi:lightbulb" && !p.keep_on).map((p) => p.id);
        draft.restore_at = "07:00";
      } else if (template === "leave") {
        const sc = this._scenes.find((s) => s.name === "出門") || this._scenes[0];
        Object.assign(draft, { time: "08:30", days: [0, 1, 2, 3, 4], action: "scene", scene: sc?.id || null });
      } else if (template === "water") {
        Object.assign(draft, { time: "06:30", action: "on", plugs: plugs.filter((p) => /澆水|water/i.test(p.name)).map((p) => p.id) });
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
          ${d.restore_at ? `<div class="field" style="margin-top:10px"><input type="time" class="small" data-c="sched-time" data-v="restore_at" value="${esc(d.restore_at)}" aria-label="再打開的時間"><span class="desc">${d.restore_at <= d.time ? "隔天" : "當天"}這個時間打開</span></div>` : ""}`
        : "";
    return `
      ${this._sheetHead("mdi:calendar-clock", s.id ? "編輯排程" : "新增排程", "")}
      <div class="q">幾點</div>
      <input type="time" data-c="sched-time" data-v="time" value="${esc(d.time)}" aria-label="時間">
      <div class="q">哪幾天 <small>${daysText(d.days)}</small></div>
      <div class="chips">${days}</div>
      <div class="chips" style="margin-top:8px">
        <button class="chip" data-a="sched-days" data-v="all">每天</button>
        <button class="chip" data-a="sched-days" data-v="week">平日</button>
        <button class="chip" data-a="sched-days" data-v="end">週末</button>
      </div>
      <div class="q">要做什麼</div>
      <div class="seg full">${action}</div>
      <div class="q">${d.action === "scene" ? "哪個情境" : d.action === "on" ? "打開哪些插座" : "關閉哪些插座"}</div>
      ${what}
      ${restore}
      <div class="err"></div>
      <div class="actions">
        ${s.id ? `<button class="btn danger" data-a="sched-delete">刪除排程</button>` : `<button class="btn" data-a="close">取消</button>`}
        <button class="btn primary" data-a="sched-save">儲存</button>
      </div>`;
  }

  _saveSched() {
    const d = this._sheet.draft;
    // 時間欄位可能還沒觸發 change
    for (const input of this._sheetHost.querySelectorAll('[data-c="sched-time"]')) if (input.value) d[input.dataset.v] = input.value;
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
    };
    this._safe(async () => {
      if (id) await api("PUT", `/api/schedules/${id}`, body);
      else await api("POST", "/api/schedules", body);
      this._closeSheet();
      this._showToast(id ? "已儲存排程" : `已新增排程：${daysText(d.days)} ${d.time}`);
    });
  }
}

customElements.define("plug-app", PlugApp);

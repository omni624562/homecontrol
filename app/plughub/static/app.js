// 插座：手機上的網頁 App
//
// 從伺服器拿狀態（/api/state），之後狀態一有變動伺服器就推過來（/api/events），
// 畫面跟著更新。所有操作都是呼叫 /api/...，改完伺服器會再推新狀態過來。

import { ICONS } from "./icons.js";

const UNASSIGNED = "__unassigned__";
const NEW_ROOM = "__new_room__";
const TOAST_MS = 6000;
const HOLD_MS = 350; // 手機上按住多久開始拖拉
const DRAG_PX = 6; // 滑鼠移動多少開始拖拉

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const ic = (name) => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="${ICONS[name] || ICONS["mdi:home-outline"]}"/></svg>`;

const fmt = (v, digits = 0) =>
  v === null || v === undefined ? "—" : Number(v).toLocaleString("zh-TW", { minimumFractionDigits: digits, maximumFractionDigits: digits });

const fmtWatts = (w) => (w === null || w === undefined ? "—" : w >= 1000 ? `${fmt(w / 1000, 2)} kW` : `${fmt(w, w < 10 ? 1 : 0)} W`);

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

const STYLE = `
  :host {
    --on: #f59e0b;
    --accent: #2f80ed;
    --danger: #d93a3a;
    --bg: #f2f3f5;
    --card: #ffffff;
    --text: #1c1c1e;
    --muted: #6b7280;
    --line: rgba(0, 0, 0, 0.08);
    --soft: rgba(28, 28, 30, 0.06);
    --soft2: rgba(28, 28, 30, 0.04);
    display: block; color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, "Noto Sans TC", "PingFang TC", "Microsoft JhengHei", Roboto, sans-serif;
    -webkit-tap-highlight-color: transparent;
  }
  @media (prefers-color-scheme: dark) {
    :host {
      --accent: #3b8eea;
      --bg: #111214;
      --card: #1f2125;
      --text: #e8e9eb;
      --muted: #9ca3af;
      --line: rgba(255, 255, 255, 0.09);
      --soft: rgba(232, 233, 235, 0.07);
      --soft2: rgba(232, 233, 235, 0.045);
    }
  }
  * { box-sizing: border-box; }
  button, input { font: inherit; color: inherit; }
  button { border: 0; background: none; cursor: pointer; padding: 0; -webkit-tap-highlight-color: transparent; }
  button:disabled { opacity: 0.4; cursor: default; }
  .i { width: var(--s, 24px); height: var(--s, 24px); fill: currentColor; flex: none; display: block; }

  .page { max-width: 1100px; margin: 0 auto; padding: calc(12px + env(safe-area-inset-top)) 12px calc(32px + env(safe-area-inset-bottom)); }
  .topbar { display: flex; align-items: center; gap: 10px; padding: 8px 6px 14px; }
  .topbar h1 { font-size: 26px; font-weight: 700; margin: 0; flex: 1; letter-spacing: -0.01em; }
  .conn { font-size: 12px; color: var(--muted); display: flex; align-items: center; gap: 6px; }
  .conn .led { width: 8px; height: 8px; border-radius: 50%; background: #22c55e; }
  .conn.bad .led { background: var(--danger); }

  .wrap { display: grid; gap: 12px; }
  .block { background: var(--card); border-radius: 18px; border: 1px solid var(--line); }
  .cols { display: grid; gap: 12px; grid-template-columns: repeat(auto-fill, minmax(min(100%, 340px), 1fr)); align-items: start; }

  /* 總覽 */
  .hero {
    padding: 20px 20px 16px; overflow: hidden;
    background: radial-gradient(120% 140% at 100% 0%, color-mix(in srgb, var(--on) 22%, transparent) 0%, transparent 60%), var(--card);
  }
  .hero-top { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
  .eyebrow { font-size: 13px; color: var(--muted); display: flex; align-items: center; gap: 6px; }
  .eyebrow .i { --s: 16px; color: var(--on); }
  .big { font-size: 44px; line-height: 1.1; font-weight: 650; letter-spacing: -0.02em; margin-top: 6px; font-variant-numeric: tabular-nums; }
  .big small { font-size: 20px; font-weight: 500; color: var(--muted); margin-left: 4px; letter-spacing: 0; }
  .note { font-size: 13px; color: var(--muted); margin-top: 4px; line-height: 1.5; }
  .pill { flex: none; font-size: 13px; font-weight: 500; padding: 6px 10px; border-radius: 999px; background: color-mix(in srgb, var(--on) 16%, transparent); display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--on); }
  .stats { display: grid; grid-template-columns: repeat(3, 1fr); margin-top: 18px; border-top: 1px solid var(--line); padding-top: 14px; }
  .stat + .stat { border-left: 1px solid var(--line); padding-left: 12px; }
  .stat-label { font-size: 12px; color: var(--muted); }
  .stat-value { font-size: 18px; font-weight: 600; margin-top: 2px; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .stat-value small { font-size: 12px; font-weight: 500; color: var(--muted); margin-left: 2px; }

  .actions { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 8px; margin-top: 16px; }
  .btn { display: flex; align-items: center; justify-content: center; gap: 8px; min-height: 44px; padding: 0 14px; border-radius: 12px; font-size: 15px; font-weight: 500; background: var(--soft); transition: transform 0.1s; }
  .btn .i { --s: 20px; }
  .btn:active:not(:disabled) { transform: scale(0.98); }
  .btn.primary { background: var(--accent); color: #fff; }
  .btn.danger { color: var(--danger); }

  .alert { display: flex; gap: 10px; align-items: flex-start; padding: 12px 14px; border-radius: 12px; font-size: 14px; line-height: 1.45; margin-top: 14px; }
  .alert .i { --s: 20px; margin-top: 1px; }
  .alert.warn { background: color-mix(in srgb, #ffa600 16%, transparent); }
  .alert.warn .i { color: #e69500; }

  /* 房間 */
  .room { padding: 14px; }
  .room.unassigned { border-style: dashed; }
  .room-head { display: flex; align-items: center; gap: 10px; padding: 2px 2px 12px; }
  .room-icon { width: 34px; height: 34px; border-radius: 10px; display: grid; place-items: center; flex: none; background: var(--soft); color: var(--muted); }
  .room-icon .i { --s: 18px; }
  .room-title { flex: 1; min-width: 0; text-align: left; }
  .room-name { font-size: 16px; font-weight: 600; display: flex; align-items: center; gap: 2px; }
  .room-name .i { --s: 16px; color: var(--muted); }
  .room-sub { font-size: 12px; color: var(--muted); margin-top: 1px; }
  .small-btn { font-size: 13px; font-weight: 500; padding: 7px 12px; border-radius: 999px; white-space: nowrap; background: var(--soft); display: inline-flex; align-items: center; gap: 4px; }
  .small-btn .i { --s: 16px; }
  .small-btn.primary { background: var(--accent); color: #fff; }
  .hint { font-size: 13px; color: var(--muted); margin: -4px 2px 12px; line-height: 1.5; }

  /* 插座 */
  .plugs { display: grid; gap: 8px; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); }
  .plug {
    position: relative; padding: 12px; border-radius: 14px; min-height: 96px; cursor: pointer;
    display: flex; flex-direction: column; justify-content: space-between; gap: 10px;
    background: var(--soft2); transition: background 0.2s, transform 0.1s, opacity 0.2s;
    user-select: none; -webkit-user-select: none; -webkit-touch-callout: none; touch-action: manipulation; outline: none;
  }
  .plug:focus-visible { box-shadow: 0 0 0 2px var(--accent); }
  .plug:active { transform: scale(0.97); }
  .plug.on { background: color-mix(in srgb, var(--on) 16%, transparent); }
  .plug.off-line { opacity: 0.55; }
  .plug.pending { opacity: 0.65; }
  .plug-top { display: flex; align-items: flex-start; justify-content: space-between; }
  .knob { width: 36px; height: 36px; border-radius: 50%; display: grid; place-items: center; flex: none; background: var(--soft); color: var(--muted); transition: background 0.2s, color 0.2s, box-shadow 0.2s; }
  .knob .i { --s: 20px; }
  .plug.on .knob { background: var(--on); color: #fff; box-shadow: 0 4px 14px color-mix(in srgb, var(--on) 45%, transparent); }
  .edit, .grip { width: 36px; height: 36px; margin: -6px -6px 0 0; border-radius: 50%; display: grid; place-items: center; color: var(--muted); }
  .edit:hover { background: var(--soft); }
  .edit .i, .grip .i { --s: 20px; }
  .plug-name { font-size: 15px; font-weight: 600; line-height: 1.3; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; word-break: break-all; }
  .plug-state { font-size: 13px; color: var(--muted); margin-top: 2px; font-variant-numeric: tabular-nums; }
  .plug.on .plug-state { color: var(--text); }
  .empty { padding: 28px 20px; color: var(--muted); font-size: 14px; text-align: center; line-height: 1.6; }

  /* 拖拉 */
  .toolbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 4px 4px 0; }
  .toolbar-title { font-size: 15px; font-weight: 600; color: var(--muted); }
  .toolbar.arranging { position: sticky; top: calc(8px + env(safe-area-inset-top)); z-index: 3; padding: 10px 10px 10px 16px; border-radius: 14px; background: var(--accent); color: #fff; box-shadow: 0 6px 20px rgba(0, 0, 0, 0.18); }
  .toolbar.arranging .toolbar-title { color: #fff; font-weight: 600; }
  .toolbar.arranging .small-btn { background: #fff; color: var(--accent); }
  .toolbar-sub { font-size: 12px; font-weight: 400; opacity: 0.92; margin-top: 2px; line-height: 1.4; }
  .toolbar-sub .i { --s: 14px; display: inline-block; vertical-align: -2px; }
  .arrange .plug { touch-action: none; cursor: grab; min-height: 72px; }
  .arrange .plug:active { transform: none; }
  .plug.dragging, .room.dragging { opacity: 0.25; }
  .room-grip { width: 40px; height: 40px; margin: -4px -6px -4px 0; border-radius: 10px; display: grid; place-items: center; color: var(--muted); cursor: grab; touch-action: none; background: var(--soft); }
  .room-grip .i { --s: 22px; }
  .ghost { position: fixed; z-index: 20; pointer-events: none; margin: 0; transform: rotate(2deg) scale(1.05); box-shadow: 0 14px 34px rgba(0, 0, 0, 0.28); background: var(--card) !important; opacity: 0.96; }
  .ghost.on { background: color-mix(in srgb, var(--on) 22%, var(--card)) !important; }
  [data-drop] { transition: background 0.15s, box-shadow 0.15s; }
  [data-drop].over { box-shadow: 0 0 0 2px var(--accent); background: color-mix(in srgb, var(--accent) 7%, var(--card)); }
  .plug.ins-before { box-shadow: -5px 0 0 -1px var(--accent); }
  .plug.ins-after { box-shadow: 5px 0 0 -1px var(--accent); }
  .room.ins-before { box-shadow: 0 -5px 0 -1px var(--accent); }
  .room.ins-after { box-shadow: 0 5px 0 -1px var(--accent); }
  .drop-empty { border: 2px dashed var(--line); border-radius: 14px; padding: 18px; text-align: center; font-size: 13px; color: var(--muted); }
  .new-zone { padding: 22px 14px; text-align: center; border-style: dashed; color: var(--muted); font-size: 14px; display: grid; justify-items: center; gap: 6px; }

  /* 圖表 */
  .chart { display: flex; align-items: flex-end; gap: 4px; height: 120px; margin-top: 12px; }
  .bar { flex: 1; display: flex; flex-direction: column; justify-content: flex-end; align-items: center; height: 100%; gap: 4px; }
  .bar div { width: 100%; max-width: 22px; border-radius: 4px 4px 2px 2px; background: color-mix(in srgb, var(--on) 75%, transparent); min-height: 2px; }
  .bar.today div { background: var(--on); }
  .bar span { font-size: 10px; color: var(--muted); font-variant-numeric: tabular-nums; }

  /* 設定 */
  .panel { padding: 16px; }
  .panel-head { display: flex; align-items: center; gap: 10px; margin-bottom: 4px; }
  .panel-head .room-icon { color: var(--on); background: color-mix(in srgb, var(--on) 14%, transparent); }
  .panel-title { flex: 1; font-size: 16px; font-weight: 600; }
  .row { display: flex; align-items: center; gap: 12px; padding: 12px 0; border-top: 1px solid var(--line); }
  .row.first { border-top: 0; }
  .row-text { flex: 1; min-width: 0; }
  .row-label { font-size: 15px; }
  .row-desc { font-size: 12px; color: var(--muted); margin-top: 2px; line-height: 1.45; font-weight: 400; }
  .desc { font-size: 13px; color: var(--muted); line-height: 1.5; margin: 4px 0; }
  .muted { opacity: 0.45; pointer-events: none; }
  input[type="time"], .num input, .text { background: var(--soft); border: 0; border-radius: 10px; height: 40px; padding: 0 10px; font-size: 16px; font-variant-numeric: tabular-nums; outline: none; color-scheme: light dark; }
  input:focus { box-shadow: 0 0 0 2px var(--accent); }
  .num { display: flex; align-items: center; gap: 4px; }
  .num input { width: 72px; text-align: center; -moz-appearance: textfield; }
  .num input::-webkit-inner-spin-button, .num input::-webkit-outer-spin-button { -webkit-appearance: none; margin: 0; }
  .num .unit { font-size: 13px; color: var(--muted); min-width: 22px; }
  .step { width: 36px; height: 40px; border-radius: 10px; background: var(--soft); display: grid; place-items: center; font-size: 18px; }
  .readout { font-size: 15px; font-weight: 600; font-variant-numeric: tabular-nums; text-align: right; }
  .readout small { display: block; font-size: 12px; font-weight: 400; color: var(--muted); }
  .switch { position: relative; width: 50px; height: 30px; flex: none; }
  .switch input { position: absolute; opacity: 0; inset: 0; margin: 0; cursor: pointer; z-index: 1; }
  .switch span { position: absolute; inset: 0; border-radius: 999px; background: color-mix(in srgb, var(--text) 18%, transparent); transition: background 0.2s; }
  .switch span::after { content: ""; position: absolute; top: 3px; left: 3px; width: 24px; height: 24px; border-radius: 50%; background: #fff; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.25); transition: transform 0.2s; }
  .switch input:checked + span { background: var(--accent); }
  .switch input:checked + span::after { transform: translateX(20px); }
  .switch input:focus-visible + span { box-shadow: 0 0 0 2px var(--accent); }
  .chips { display: flex; flex-wrap: wrap; gap: 8px; }
  .chip-btn { min-height: 38px; padding: 0 14px; border-radius: 999px; font-size: 14px; border: 1px solid var(--line); display: inline-flex; align-items: center; gap: 6px; transition: background 0.15s, border-color 0.15s, color 0.15s; }
  .chip-btn .i { --s: 18px; }
  .chip-btn.sel { background: var(--accent); border-color: var(--accent); color: #fff; }
  .chip-btn.add { border-style: dashed; color: var(--muted); }

  /* 底部面板 */
  .backdrop { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.45); z-index: 10; display: flex; align-items: flex-end; justify-content: center; animation: fade 0.15s ease-out; }
  .sheet { width: 100%; max-width: 560px; max-height: 88vh; overflow: auto; background: var(--card); color: var(--text); border-radius: 22px 22px 0 0; padding: 8px 20px calc(20px + env(safe-area-inset-bottom)); animation: up 0.2s ease-out; }
  @media (min-width: 600px) { .backdrop { align-items: center; } .sheet { border-radius: 22px; padding-bottom: 20px; } }
  @keyframes fade { from { opacity: 0; } }
  @keyframes up { from { transform: translateY(40px); opacity: 0; } }
  .grabber { width: 40px; height: 5px; border-radius: 3px; background: var(--line); margin: 4px auto 12px; }
  .sheet-head { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; }
  .sheet-title { flex: 1; font-size: 19px; font-weight: 600; }
  .close { width: 36px; height: 36px; border-radius: 50%; background: var(--soft); display: grid; place-items: center; }
  .close .i { --s: 20px; }
  .field { margin-bottom: 20px; }
  .field-label { font-size: 13px; font-weight: 600; color: var(--muted); margin-bottom: 8px; }
  .text { width: 100%; height: 46px; border-radius: 12px; padding: 0 14px; }
  .new-room { display: flex; gap: 8px; margin-top: 10px; }
  .new-room .text { flex: 1; }
  .opt { display: flex; align-items: center; gap: 12px; padding: 12px 0; border-top: 1px solid var(--line); }
  .opt:first-of-type { border-top: 0; }
  .sheet-actions { display: grid; gap: 8px; margin-top: 8px; }
  .progress { height: 4px; border-radius: 2px; background: var(--soft); overflow: hidden; margin-bottom: 18px; }
  .progress div { height: 100%; background: var(--accent); transition: width 0.2s; }
  .wizard-name { font-size: 26px; font-weight: 600; margin: 4px 0; }
  .wizard-q { font-size: 15px; color: var(--muted); margin-bottom: 16px; }
  .chips.big .chip-btn { min-height: 48px; font-size: 16px; padding: 0 18px; }
  .err { color: var(--danger); font-size: 13px; margin-top: 8px; }
  .info { font-size: 13px; color: var(--muted); line-height: 1.7; }
  .info b { color: var(--text); font-weight: 500; }

  .toast { position: fixed; left: 50%; bottom: calc(24px + env(safe-area-inset-bottom)); transform: translateX(-50%); z-index: 11; display: flex; align-items: center; gap: 16px; padding: 10px 10px 10px 18px; border-radius: 14px; background: #2b2d31; color: #fff; font-size: 15px; box-shadow: 0 8px 28px rgba(0, 0, 0, 0.3); white-space: nowrap; max-width: calc(100vw - 32px); animation: fade 0.2s ease-out; }
  .toast span { padding: 6px 0; overflow: hidden; text-overflow: ellipsis; }
  .toast button { color: #ffd27a; font-weight: 600; padding: 8px 10px; border-radius: 8px; }
`;

class PlugApp extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this.shadowRoot.innerHTML = `<style>${STYLE}</style><div class="main"></div><div class="sheet-host"></div><div class="toast-host"></div>`;
    this._main = this.shadowRoot.querySelector(".main");
    this._sheetHost = this.shadowRoot.querySelector(".sheet-host");
    this._toastHost = this.shadowRoot.querySelector(".toast-host");
    this._s = null; // 伺服器給的狀態
    this._connected = false;
    this._pending = new Set();
    this._sheet = null;
    this._arrange = false;
    this._moved = {}; // 剛拖到別的房間、伺服器還沒確認的插座
    this._order = null; // 剛排好、伺服器還沒確認的插座順序
    this._roomOrder = null;
    this._drag = null;
  }

  connectedCallback() {
    this._load();
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
    es.onmessage = (ev) => {
      this._connected = true;
      this._setState(JSON.parse(ev.data));
    };
    es.onopen = () => {
      this._connected = true;
      this._update();
    };
    es.onerror = () => {
      this._connected = false;
      this._update();
    };
    // 手機從背景回來時重新連線，馬上拿最新狀態
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && es.readyState === EventSource.CLOSED) this._listen();
    }, { once: true });
  }

  _setState(s) {
    this._s = s;
    this._connected = true;
    // 伺服器已經跟上的本機暫存就清掉
    for (const p of s.plugs) {
      if (p.id in this._moved && (p.room || null) === this._moved[p.id]) delete this._moved[p.id];
    }
    if (this._order && s.plugs.map((p) => p.id).join() === this._order.filter((id) => this._plug(id)).join()) this._order = null;
    if (this._roomOrder && s.rooms.map((r) => r.id).join() === this._roomOrder.join()) this._roomOrder = null;
    this._update();
  }

  _update() {
    if (this._drag) return; // 拖拉中不重畫，放開後再畫
    const active = this.shadowRoot.activeElement;
    if (active && active.tagName === "INPUT" && this._main.contains(active)) return; // 正在輸入
    this._render();
  }

  _refresh() {
    this._update();
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

  _room(id) {
    return (this._s?.rooms || []).find((r) => r.id === id);
  }

  _plug(id) {
    return (this._s?.plugs || []).find((p) => p.id === id);
  }

  _roomOf(p) {
    const r = p.id in this._moved ? this._moved[p.id] : p.room;
    return r && this._room(r) ? r : null;
  }

  // ───────────── 畫面 ─────────────

  _render() {
    const top = `
      <div class="topbar">
        <h1>插座</h1>
        <div class="conn ${this._connected ? "" : "bad"}"><span class="led"></span>${this._connected ? "已連線" : "連不上伺服器，重新連線中…"}</div>
      </div>`;
    if (!this._s) {
      this._main.innerHTML = `<div class="page">${top}<div class="block empty">${this._connected ? "載入中…" : "連不上插座伺服器。確認手機和樹莓派在同一個網路。"}</div></div>`;
      return;
    }
    this._main.innerHTML = `<div class="page">${top}<div class="wrap">${this._plugsHtml()}${this._chartHtml()}${this._settingsHtml()}</div></div>`;
    this._bindMain();
    if (this._sheet) this._renderSheet();
  }

  _plugsHtml() {
    const s = this._s;
    const plugs = this._plugs;
    const sum = s.summary;
    const onCount = plugs.filter((p) => p.is_on && p.online).length;
    const measured = plugs.some((p) => p.mode !== "switch");
    const metered = plugs.some((p) => p.mode === "metered");

    let hero;
    if (measured) {
      const [value, unit] = fmtWatts(sum.power).split(" ");
      hero = `
        <div class="hero-top">
          <div>
            <div class="eyebrow">${ic("mdi:flash")}目前總功率</div>
            <div class="big">${value}<small>${unit || ""}</small></div>
          </div>
          <span class="pill"><span class="dot"></span>${onCount} / ${plugs.length} 開著</span>
        </div>
        <div class="stats">
          <div class="stat"><div class="stat-label">今日用電</div><div class="stat-value">${fmt(sum.energy_today, 2)}<small>度</small></div></div>
          <div class="stat"><div class="stat-label">今日電費</div><div class="stat-value"><small>$</small>${fmt(sum.cost_today, 1)}</div></div>
          <div class="stat"><div class="stat-label">本月電費</div><div class="stat-value"><small>$</small>${fmt(sum.cost_month)}</div></div>
        </div>`;
    } else {
      hero = `
        <div class="eyebrow">${ic("mdi:power-plug")}插座</div>
        <div class="big">${onCount}<small>/ ${plugs.length} 開著</small></div>
        <div class="note">這些插座沒有用電計量。點插座右上角的 ⋯，填上大約幾瓦，就能估算用電和電費。</div>`;
    }

    const offline = plugs.filter((p) => !p.online).map((p) => p.name);
    const alerts = offline.length
      ? `<div class="alert warn">${ic("mdi:wifi-off")}<div>連不上：${esc(offline.join("、"))}</div></div>`
      : "";

    const closable = plugs.filter((p) => p.is_on && p.online && !p.keep_on).length;
    const standby = plugs.filter((p) => p.standby).length;
    const actions = `
      <div class="actions">
        <button class="btn" data-off="all" ${closable ? "" : "disabled"}>${ic("mdi:power")}全部關閉</button>
        ${metered ? `<button class="btn" data-off="standby" ${standby ? "" : "disabled"}>${ic("mdi:power-sleep")}關閉待機${standby ? ` ${standby} 個` : ""}</button>` : ""}
      </div>`;

    // 分房間
    const byRoom = new Map();
    if (this._arrange) {
      byRoom.set(UNASSIGNED, []);
      for (const r of this._rooms) byRoom.set(r.id, []);
    }
    for (const p of plugs) {
      const key = this._roomOf(p) || UNASSIGNED;
      if (!byRoom.has(key)) byRoom.set(key, []);
      byRoom.get(key).push(p);
    }
    const order = this._rooms.map((r) => r.id).filter((id) => byRoom.has(id));
    if (byRoom.has(UNASSIGNED)) order.unshift(UNASSIGNED); // 還沒分房間的放最前面

    const rooms = order.map((id) => this._roomHtml(id, this._room(id), byRoom.get(id)));
    if (this._arrange) rooms.push(`<section class="block room new-zone" data-drop="${NEW_ROOM}">${ic("mdi:plus")}拖到這裡，建立新房間</section>`);

    const toolbar = this._arrange
      ? `<div class="toolbar arranging"><div class="toolbar-title">整理房間<div class="toolbar-sub">拖插座換房間、排順序；拉房間右上角的 ${ic("mdi:drag-horizontal-variant")} 調整房間順序</div></div><button class="small-btn" data-arrange>完成</button></div>`
      : `<div class="toolbar"><div class="toolbar-title">房間</div><button class="small-btn" data-arrange>${ic("mdi:drag-variant")}整理房間</button></div>`;

    const body = plugs.length
      ? `${toolbar}<div class="cols ${this._arrange ? "arrange" : ""}">${rooms.join("")}</div>`
      : `<div class="block empty">還沒找到插座。<br>確認插座和樹莓派連在同一個網路，等一下會自動出現。<br><br><button class="small-btn" data-discover>${ic("mdi:magnify")}現在找一次</button></div>`;

    return `<section class="block hero">${hero}${alerts}${actions}</section>${body}`;
  }

  _roomHtml(id, room, list) {
    const roomOn = list.filter((p) => p.is_on && p.online).length;
    const arrange = this._arrange;
    const body = list.length
      ? `<div class="plugs">${list.map((p) => this._plugHtml(p)).join("")}</div>`
      : `<div class="drop-empty">把插座拖到這裡</div>`;
    if (id === UNASSIGNED) {
      return `
        <section class="block room unassigned" data-drop="${UNASSIGNED}">
          <div class="room-head">
            <div class="room-icon">${ic("mdi:help-circle-outline")}</div>
            <div class="room-title"><div class="room-name">還沒分房間</div><div class="room-sub">${list.length} 個插座</div></div>
            ${arrange || !list.length ? "" : `<button class="small-btn primary" data-assign>${ic("mdi:home-plus-outline")}分配房間</button>`}
          </div>
          ${arrange || !list.length ? "" : `<div class="hint">把插座拖到下面的房間，或按「分配房間」一個一個點選。手機上按住插座一下再拖。</div>`}
          ${body}
        </section>`;
    }
    const canOff = !arrange && list.some((p) => p.is_on && p.online && !p.keep_on);
    return `
      <section class="block room" data-drop="${esc(id)}" data-room-sec="${esc(id)}">
        <div class="room-head">
          <div class="room-icon">${ic(room.icon)}</div>
          <button class="room-title" data-room="${esc(id)}" title="改房間名稱">
            <div class="room-name">${esc(room.name)}${ic("mdi:chevron-right")}</div>
            <div class="room-sub">${roomOn ? `${roomOn} 個開著` : "全部關閉"} · 共 ${list.length} 個</div>
          </button>
          ${canOff ? `<button class="small-btn" data-off="room:${esc(id)}">${ic("mdi:power")}全關</button>` : ""}
          ${arrange ? `<span class="room-grip" data-room-grip="${esc(id)}" title="拖拉調整房間順序">${ic("mdi:drag-horizontal-variant")}</span>` : ""}
        </div>
        ${body}
      </section>`;
  }

  _plugHtml(p) {
    const on = p.is_on && p.online;
    const off = !p.online;
    const bits = [off ? "離線" : on ? "開啟" : "關閉"];
    if (on && p.mode === "metered") bits.push(fmtWatts(p.power));
    if (on && p.mode === "estimated") bits.push(`約 ${fmtWatts(p.watts)}`);
    if (p.keep_on) bits.push("常開");
    else if (p.night) bits.push("夜間關");
    const cls = ["plug", on ? "on" : "", off ? "off-line" : "", this._pending.has(p.id) ? "pending" : ""].join(" ");
    const icon = off ? "mdi:power-plug-off-outline" : on ? "mdi:power-plug" : "mdi:power-plug-outline";
    return `
      <div class="${cls}" role="switch" tabindex="0" aria-checked="${on}" data-plug="${esc(p.id)}">
        <div class="plug-top">
          <div class="knob">${ic(icon)}</div>
          ${this._arrange
            ? `<span class="grip" aria-hidden="true">${ic("mdi:drag")}</span>`
            : `<button class="edit" data-edit="${esc(p.id)}" aria-label="設定 ${esc(p.name)}">${ic("mdi:dots-horizontal")}</button>`}
        </div>
        <div>
          <div class="plug-name">${esc(p.name)}</div>
          <div class="plug-state">${bits.join(" · ")}</div>
        </div>
      </div>`;
  }

  _chartHtml() {
    const hist = this._s.summary.history || [];
    if (!hist.some((d) => d.kwh > 0)) return "";
    const max = Math.max(...hist.map((d) => d.kwh), 0.001);
    const bars = hist
      .map((d, i) => {
        const day = Number(d.day.slice(8));
        const today = i === hist.length - 1;
        return `<div class="bar ${today ? "today" : ""}" title="${d.day}：${fmt(d.kwh, 2)} 度"><div style="height:${(d.kwh / max) * 100}%"></div><span>${today ? "今" : day}</span></div>`;
      })
      .join("");
    return `
      <section class="block panel">
        <div class="panel-head"><div class="room-icon">${ic("mdi:chart-bar")}</div><div class="panel-title">每日用電（近 14 天）</div></div>
        <div class="desc">本月 ${fmt(this._s.summary.energy_month, 1)} 度，約 $${fmt(this._s.summary.cost_month)}；只算有計量或填了瓦數的插座。</div>
        <div class="chart">${bars}</div>
      </section>`;
  }

  _settingsHtml() {
    const s = this._s;
    const sched = s.schedule;
    const set = s.settings;
    const plugs = this._plugs;
    const nightCount = plugs.filter((p) => p.night && !p.keep_on).length;
    const nightChips = plugs
      .map((p) =>
        p.keep_on
          ? `<button class="chip-btn" disabled title="常開的插座不會被關">${esc(p.name)}・常開</button>`
          : `<button class="chip-btn ${p.night ? "sel" : ""}" data-night="${esc(p.id)}">${p.night ? ic("mdi:check") : ""}${esc(p.name)}</button>`,
      )
      .join("");

    const numberRow = (key, label, desc, unit, step, first = false) => `
      <div class="row ${first ? "first" : ""}">
        <div class="row-text"><div class="row-label">${label}</div><div class="row-desc">${desc}</div></div>
        <div class="num">
          <button class="step" data-step="${key}" data-by="${-step}" aria-label="減少">−</button>
          <input type="number" inputmode="decimal" data-number="${key}" value="${esc(+set[key])}" step="${step}">
          <button class="step" data-step="${key}" data-by="${step}" aria-label="增加">+</button>
          <span class="unit">${unit}</span>
        </div>
      </div>`;

    return `
      <div class="cols">
        <section class="block panel">
          <div class="panel-head">
            <div class="room-icon">${ic("mdi:weather-night")}</div>
            <div class="panel-title">夜間排程</div>
            <label class="switch"><input type="checkbox" data-sched-enabled ${sched.enabled ? "checked" : ""} aria-label="夜間排程"><span></span></label>
          </div>
          <div class="desc">${sched.enabled ? "每天晚上自動關掉選好的插座，早上再打開；晚上本來就關著的不會被打開。" : "打開右邊的開關，每天晚上自動關掉選好的插座，早上再打開。"}</div>
          <div class="${sched.enabled ? "" : "muted"}">
            <div class="row"><div class="row-text"><div class="row-label">晚上關閉</div></div><input type="time" data-time="night_off" value="${esc(sched.night_off)}"></div>
            <div class="row"><div class="row-text"><div class="row-label">早上打開</div></div><input type="time" data-time="morning_on" value="${esc(sched.morning_on)}"></div>
            <div class="row" style="display:block">
              <div class="row-label" style="margin-bottom:10px">要關閉的插座 <span class="row-desc">已選 ${nightCount} 個，點一下選取或取消</span></div>
              <div class="chips">${nightChips || '<span class="row-desc">還沒有插座</span>'}</div>
            </div>
          </div>
        </section>

        <section class="block panel">
          <div class="panel-head"><div class="room-icon">${ic("mdi:cash")}</div><div class="panel-title">電費與提醒</div></div>
          ${numberRow("household_monthly_kwh", "家裡每月用電", "電費單上的度數；兩個月一期的話除以 2", "度", 10, true)}
          <div class="row">
            <div class="row-text"><div class="row-label">目前電價</div><div class="row-desc">台電累進電價，依每月用電和季節自動算出</div></div>
            <div class="readout">${fmt(s.summary.price, 2)} 元/度<small>${esc(s.summary.season)}</small></div>
          </div>
          ${numberRow("standby_watts", "待機門檻", "有計量的插座開著但低於這個瓦數，就當作在待機", "W", 0.5)}
          ${numberRow("overload_watts", "功率過高提醒", "超過這個瓦數持續 1 分鐘就通知", "W", 50)}
          <div class="row" style="display:block">
            <div class="row-label">手機通知</div>
            <div class="row-desc" style="margin-bottom:8px">手機裝 ntfy App，訂閱一個只有你知道的名稱（例如 home-plugs-8f3k），再填到這裡。插座斷線、功率過高時會通知你。</div>
            <div class="new-room" style="margin-top:0">
              <input class="text" data-ntfy value="${esc(set.ntfy_topic)}" placeholder="ntfy 主題名稱" autocapitalize="off" autocomplete="off" spellcheck="false">
              <button class="btn" data-test-notify>${ic("mdi:bell-outline")}測試</button>
            </div>
          </div>
          <div class="row">
            <div class="row-text"><div class="row-label">找新插座</div><div class="row-desc">每分鐘會自動找一次；剛插上的插座可以按這裡馬上找</div></div>
            <button class="small-btn" data-discover>${ic("mdi:magnify")}現在找</button>
          </div>
        </section>
      </div>`;
  }

  // ───────────── 事件 ─────────────

  _bindMain() {
    const root = this._main;
    const on = (sel, ev, fn) => root.querySelectorAll(sel).forEach((el) => el.addEventListener(ev, (e) => fn(el, e)));

    on("[data-plug]", "click", (el, e) => {
      if (this._justDragged || this._arrange) return; // 剛拖完放開也會觸發 click
      if (!e.target.closest("[data-edit]")) this._toggle(el.dataset.plug);
    });
    on("[data-plug]", "keydown", (el, e) => {
      if (this._arrange) return;
      if ((e.key === "Enter" || e.key === " ") && e.target === el) {
        e.preventDefault();
        this._toggle(el.dataset.plug);
      }
    });
    on("[data-plug]", "pointerdown", (el, e) => this._dragDown(el, e));
    on("[data-plug]", "contextmenu", (el, e) => e.preventDefault());
    on("[data-room-grip]", "pointerdown", (el, e) => this._dragDown(el, e, "room"));
    on("[data-edit]", "click", (el, e) => {
      e.stopPropagation();
      this._openSheet({ type: "plug", id: el.dataset.edit });
    });
    on("[data-arrange]", "click", () => {
      this._arrange = !this._arrange;
      this._refresh();
    });
    on("[data-off]", "click", (el) => this._turnOff(el.dataset.off));
    on("[data-assign]", "click", () => this._startAssign());
    on("[data-room]", "click", (el) => this._openSheet({ type: "room", id: el.dataset.room }));
    on("[data-discover]", "click", (el) => {
      el.disabled = true;
      this._safe(async () => {
        await api("POST", "/api/discover");
        this._showToast("找好了");
      });
    });

    // 排程與設定
    on("[data-sched-enabled]", "change", (el) => this._safe(() => api("PUT", "/api/schedule", { enabled: el.checked })));
    on("[data-time]", "change", (el) => el.value && this._safe(() => api("PUT", "/api/schedule", { [el.dataset.time]: el.value })));
    on("[data-time]", "blur", () => this._refresh());
    on("[data-number]", "change", (el) => this._setSetting(el.dataset.number, parseFloat(el.value)));
    on("[data-number]", "keydown", (el, e) => e.key === "Enter" && el.blur());
    on("[data-number]", "blur", () => this._refresh());
    on("[data-step]", "click", (el) => {
      const key = el.dataset.step;
      this._setSetting(key, +this._s.settings[key] + Number(el.dataset.by));
    });
    on("[data-ntfy]", "change", (el) => this._safe(() => api("PUT", "/api/settings", { ntfy_topic: el.value })));
    on("[data-ntfy]", "keydown", (el, e) => e.key === "Enter" && el.blur());
    on("[data-ntfy]", "blur", () => this._refresh());
    on("[data-test-notify]", "click", () =>
      this._safe(async () => {
        const input = root.querySelector("[data-ntfy]");
        await api("PUT", "/api/settings", { ntfy_topic: input.value });
        await api("POST", "/api/test-notify");
        this._showToast("已送出測試通知");
      }),
    );
    on("[data-night]", "click", (el) => {
      const p = this._plug(el.dataset.night);
      if (!p) return;
      el.disabled = true;
      this._safe(() => api("PATCH", `/api/plugs/${p.id}`, { night: !p.night }));
    });
  }

  _setSetting(key, value) {
    if (!Number.isFinite(value)) return this._refresh();
    this._safe(() => api("PUT", "/api/settings", { [key]: Math.round(value * 10) / 10 }));
  }

  _toggle(id) {
    const p = this._plug(id);
    if (!p) return;
    if (!p.online) {
      this._openSheet({ type: "plug", id });
      return;
    }
    this._pending.add(id);
    this._refresh();
    api("POST", `/api/plugs/${id}/power`, { on: !p.is_on })
      .catch((err) => this._showToast(`${p.name} 沒有回應：${err.message}`))
      .finally(() => {
        this._pending.delete(id);
        this._refresh();
      });
  }

  // 按一次就關，下面出現「復原」可以反悔
  async _turnOff(key) {
    const body = key === "standby" ? { standby_only: true } : key.startsWith("room:") ? { room: key.slice(5) } : {};
    try {
      const res = await api("POST", "/api/off", body);
      const where = body.room ? this._room(body.room)?.name || "" : body.standby_only ? "待機中的" : "";
      this._showToast(res.count ? `已關閉${where} ${res.count} 個插座` : "沒有要關的插座", res.count > 0);
    } catch (err) {
      this._showToast(`沒有成功：${err.message}`);
    }
  }

  _showToast(text, undo = false) {
    clearTimeout(this._toastTimer);
    this._toastHost.innerHTML = `<div class="toast" role="status"><span>${esc(text)}</span>${undo ? "<button data-undo>復原</button>" : ""}</div>`;
    this._toastHost.querySelector("[data-undo]")?.addEventListener("click", async () => {
      try {
        const res = await api("POST", "/api/restore");
        this._showToast(`已打開 ${res.count} 個插座`);
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
      this._refresh();
    }
  }

  async _setRoom(plug, roomId) {
    await api("PATCH", `/api/plugs/${plug.id}`, { room: roomId });
  }

  async _createRoom(name) {
    const room = await api("POST", "/api/rooms", { name: name.trim() });
    // 伺服器推新狀態前，先把新房間放進本機狀態，畫面才找得到它
    if (!this._room(room.id)) this._s.rooms = [...this._s.rooms, room];
    return room.id;
  }

  // ───────────── 拖拉：換房間、自訂排序 ─────────────
  //
  // 插座：拖到別的房間就換房間；拖到某個插座的左半邊／右半邊就排在它前面／後面。
  // 房間：整理模式下拉房間右上角的把手，調整房間順序。
  // 滑鼠：按下移動一點點就開始拖。手機：整理模式下直接拖；平常要先按住一下。

  _dragDown(el, e, kind = "plug") {
    if (e.button > 0 || e.target.closest("[data-edit]")) return;
    const touch = e.pointerType !== "mouse";
    const d = {
      kind,
      el: kind === "room" ? el.closest("[data-room-sec]") : el,
      id: kind === "room" ? el.dataset.roomGrip : el.dataset.plug,
      pointerId: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      started: false,
      ready: !touch || this._arrange,
    };
    if (kind === "room") e.preventDefault();
    if (!d.ready) {
      d.timer = setTimeout(() => {
        d.ready = true;
        navigator.vibrate?.(15);
        this._dragBegin(d, d.x, d.y);
      }, HOLD_MS);
    }
    const move = (ev) => {
      if (ev.pointerId !== d.pointerId) return;
      if (!d.started) {
        if (Math.hypot(ev.clientX - d.x, ev.clientY - d.y) <= DRAG_PX) return;
        if (!d.ready) return cleanup(); // 還沒按夠久就移動 = 想捲動畫面
        this._dragBegin(d, ev.clientX, ev.clientY);
      }
      ev.preventDefault();
      this._dragMove(ev.clientX, ev.clientY);
    };
    const touchmove = (ev) => d.started && ev.cancelable && ev.preventDefault(); // 拖拉中擋掉捲動
    const up = (ev) => {
      if (ev.pointerId !== d.pointerId) return;
      const dropped = d.started;
      cleanup();
      if (dropped) this._dragEnd(ev.type === "pointerup");
    };
    const cleanup = () => {
      clearTimeout(d.timer);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      window.removeEventListener("touchmove", touchmove);
    };
    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    window.addEventListener("touchmove", touchmove, { passive: false });
  }

  _dragBegin(d, x, y) {
    if (d.started || !d.el?.isConnected) return;
    d.started = true;
    const rect = d.el.getBoundingClientRect();
    const ghost = d.el.cloneNode(true);
    ghost.classList.add("ghost");
    ghost.classList.remove("pending", "over");
    const height = d.kind === "room" ? Math.min(rect.height, 64) : rect.height;
    Object.assign(ghost.style, { width: `${rect.width}px`, height: `${height}px`, left: `${rect.left}px`, top: `${rect.top}px`, overflow: "hidden" });
    this.shadowRoot.appendChild(ghost);
    d.ghost = ghost;
    d.dx = x - rect.left;
    d.dy = Math.min(y - rect.top, height - 10);
    if (d.kind === "plug") d.from = this._roomOf(this._plug(d.id)) || UNASSIGNED;
    this._drag = d;
    // 平常模式下開始拖：暫時切到整理模式，空房間和「新房間」才會出現
    if (!this._arrange) {
      this._arrange = true;
      d.autoArrange = true;
      this._render();
    }
    this._markDragging();
    this._dragMove(x, y);
  }

  _markDragging() {
    const d = this._drag;
    this._main.querySelectorAll("[data-plug]").forEach((el) => el.classList.toggle("dragging", !!d && d.kind === "plug" && el.dataset.plug === d.id));
    this._main.querySelectorAll("[data-room-sec]").forEach((el) => el.classList.toggle("dragging", !!d && d.kind === "room" && el.dataset.roomSec === d.id));
  }

  _clearMarks() {
    this._main.querySelectorAll(".over, .ins-before, .ins-after").forEach((el) => el.classList.remove("over", "ins-before", "ins-after"));
  }

  _dragMove(x, y) {
    const d = this._drag;
    if (!d) return;
    d.cx = x;
    d.cy = y;
    d.ghost.style.left = `${x - d.dx}px`;
    d.ghost.style.top = `${y - d.dy}px`;
    const under = this.shadowRoot.elementFromPoint(x, y);
    this._clearMarks();
    d.over = d.tile = null;
    if (d.kind === "plug") {
      const zone = under?.closest("[data-drop]");
      const tile = under?.closest("[data-plug]");
      if (tile && tile.dataset.plug !== d.id && zone?.contains(tile)) {
        const r = tile.getBoundingClientRect();
        d.tile = tile.dataset.plug;
        d.before = x < r.left + r.width / 2;
        tile.classList.add(d.before ? "ins-before" : "ins-after");
        d.over = zone;
      } else if (zone && zone.dataset.drop !== d.from) {
        d.over = zone;
      }
      d.over?.classList.add("over");
    } else {
      const sec = under?.closest("[data-room-sec]");
      if (sec && sec.dataset.roomSec !== d.id) {
        const r = sec.getBoundingClientRect();
        d.over = sec;
        d.before = y < r.top + r.height / 2;
        sec.classList.add(d.before ? "ins-before" : "ins-after");
      }
    }
    // 拖到畫面上下邊緣時自動捲動
    const edge = 70;
    d.scroll = y < edge ? -1 : y > window.innerHeight - edge ? 1 : 0;
    if (d.scroll && !d.raf) {
      const step = () => {
        if (!this._drag || !d.scroll) {
          d.raf = null;
          return;
        }
        window.scrollBy(0, d.scroll * 12);
        this._dragMove(d.cx, d.cy);
        d.raf = requestAnimationFrame(step);
      };
      d.raf = requestAnimationFrame(step);
    }
  }

  _dragEnd(drop) {
    const d = this._drag;
    if (!d) return;
    this._drag = null;
    cancelAnimationFrame(d.raf);
    d.ghost.remove();
    this._markDragging();
    this._clearMarks();
    if (d.autoArrange) this._arrange = false;
    this._justDragged = true;
    setTimeout(() => (this._justDragged = false), 50);
    if (!drop || !d.over) return this._refresh();

    if (d.kind === "room") {
      const ids = this._rooms.map((r) => r.id).filter((id) => id !== d.id);
      ids.splice(ids.indexOf(d.over.dataset.roomSec) + (d.before ? 0 : 1), 0, d.id);
      this._roomOrder = ids;
      this._refresh();
      this._safe(() => api("POST", "/api/order", { rooms: ids }));
      return;
    }
    const plug = this._plug(d.id);
    const target = d.over.dataset.drop;
    if (!plug) return this._refresh();
    if (target === NEW_ROOM) {
      this._refresh();
      this._openSheet({ type: "newroom", id: d.id });
      return;
    }
    if (d.tile) {
      const ids = this._plugs.map((p) => p.id).filter((id) => id !== d.id);
      ids.splice(ids.indexOf(d.tile) + (d.before ? 0 : 1), 0, d.id);
      this._order = ids;
      this._safe(() => api("POST", "/api/order", { plugs: ids }));
    }
    if (target !== d.from) this._moveTo(plug, target === UNASSIGNED ? null : target);
    else this._refresh();
  }

  async _moveTo(plug, roomId) {
    this._moved[plug.id] = roomId;
    this._refresh();
    try {
      await this._setRoom(plug, roomId);
      this._showToast(`${plug.name} → ${roomId ? this._room(roomId)?.name : "還沒分房間"}`);
    } catch (err) {
      delete this._moved[plug.id];
      this._showToast(`沒有成功：${err.message}`);
      this._refresh();
    }
  }

  // ───────────── 底部面板 ─────────────

  _openSheet(sheet) {
    this._sheet = sheet;
    this._renderSheet();
    if (sheet.type === "newroom") this._sheetHost.querySelector("[data-new-room-name]")?.focus();
  }

  _closeSheet() {
    this._sheet = null;
    this._sheetHost.innerHTML = "";
  }

  _startAssign() {
    const queue = this._plugs.filter((p) => !this._roomOf(p)).map((p) => p.id);
    if (queue.length) this._openSheet({ type: "assign", queue, index: 0 });
  }

  _roomChips(selected, attr) {
    return this._rooms
      .map((r) => `<button class="chip-btn ${r.id === selected ? "sel" : ""}" ${attr}="${esc(r.id)}">${ic(r.icon)}${esc(r.name)}</button>`)
      .join("");
  }

  _newRoomHtml(s) {
    return `<button class="chip-btn add" data-new-room>${ic("mdi:plus")}新房間</button>
      </div>
      ${s.newRoom ? `<div class="new-room"><input class="text" data-new-room-name placeholder="例如：書房" maxlength="30" enterkeyhint="done"><button class="btn primary" data-new-room-ok>加入</button></div>` : ""}`;
  }

  _sheetHead(title) {
    return `<div class="sheet-head"><div class="sheet-title">${title}</div><button class="close" data-close aria-label="關閉">${ic("mdi:close")}</button></div>`;
  }

  _renderSheet() {
    const s = this._sheet;
    if (!s) return;
    const active = this.shadowRoot.activeElement;
    if (s.rendered && active && active.tagName === "INPUT" && this._sheetHost.contains(active)) return; // 正在打字

    let body = null;
    if (s.type === "plug") body = this._plugSheet(s);
    else if (s.type === "assign") body = this._assignSheet(s);
    else if (s.type === "room") body = this._roomSheet(s);
    else if (s.type === "newroom") body = this._newRoomSheet(s);
    if (body === null) return this._closeSheet();
    s.rendered = true;

    const scroll = this._sheetHost.querySelector(".sheet")?.scrollTop || 0;
    this._sheetHost.innerHTML = `
      <div class="backdrop" data-backdrop>
        <div class="sheet" role="dialog" aria-modal="true">
          <div class="grabber"></div>
          ${body}
          ${s.error ? `<div class="err">${esc(s.error)}</div>` : ""}
        </div>
      </div>`;
    this._sheetHost.querySelector(".sheet").scrollTop = scroll;
    this._bindSheet();
  }

  _plugSheet(s) {
    const p = this._plug(s.id);
    if (!p) return null;
    const room = s.room !== undefined ? s.room : this._roomOf(p);
    return `
      ${this._sheetHead("插座設定")}
      <div class="field">
        <div class="field-label">名稱</div>
        <input class="text" data-name value="${esc(s.name ?? p.name)}" maxlength="40" enterkeyhint="done">
      </div>
      <div class="field">
        <div class="field-label">房間</div>
        <div class="chips">
          ${this._roomChips(room, "data-set-room")}
          ${this._newRoomHtml(s)}
      </div>
      <div class="field">
        <div class="field-label">選項</div>
        <div class="opt">
          <div class="row-text"><div class="row-label">常開</div><div class="row-desc">冰箱、網路設備：「全部關閉」和排程都不會關它</div></div>
          <label class="switch"><input type="checkbox" data-opt="keep_on" ${p.keep_on ? "checked" : ""} aria-label="常開"><span></span></label>
        </div>
        <div class="opt">
          <div class="row-text"><div class="row-label">夜間關閉</div><div class="row-desc">夜間排程的時間到了自動關掉</div></div>
          <label class="switch"><input type="checkbox" data-opt="night" ${p.night ? "checked" : ""} aria-label="夜間關閉"><span></span></label>
        </div>
        ${p.mode === "metered" ? "" : `
        <div class="opt">
          <div class="row-text"><div class="row-label">大約耗電</div><div class="row-desc">這個插座沒有計量；填上電器的瓦數就能估算電費，不知道就留空</div></div>
          <div class="num"><input type="number" inputmode="decimal" data-watts value="${esc(p.watts ?? "")}" placeholder="—" min="0" step="1"><span class="unit">W</span></div>
        </div>`}
      </div>
      <div class="field">
        <div class="field-label">插座資訊</div>
        <div class="info">型號 <b>${esc(p.model)}</b>　IP <b>${esc(p.host)}</b><br>插座裡的名稱 <b>${esc(p.kasa_name)}</b>　${p.online ? "連線正常" : "目前連不上"}</div>
      </div>
      <div class="sheet-actions"><button class="btn primary" data-done>完成</button></div>`;
  }

  _assignSheet(s) {
    const p = this._plug(s.queue[s.index]);
    if (!p) return null;
    const total = s.queue.length;
    return `
      ${this._sheetHead(`分配房間 <span class="row-desc">${s.index + 1} / ${total}</span>`)}
      <div class="progress"><div style="width:${(s.index / total) * 100}%"></div></div>
      <div class="wizard-name">${esc(p.name)}</div>
      <div class="wizard-q">這個插座在哪個房間？${this._rooms.length ? "" : "先建立一個房間吧。"}</div>
      <div class="chips big">
        ${this._roomChips(null, "data-pick-room")}
        ${this._newRoomHtml(s)}
      <div class="sheet-actions" style="margin-top:20px"><button class="btn" data-skip>先跳過</button></div>`;
  }

  _newRoomSheet(s) {
    const p = this._plug(s.id);
    if (!p) return null;
    return `
      ${this._sheetHead("新房間")}
      <div class="field">
        <div class="field-label">房間名稱</div>
        <input class="text" data-new-room-name placeholder="例如：書房" maxlength="30" enterkeyhint="done">
      </div>
      <div class="desc" style="margin-bottom:16px">建立之後，「${esc(p.name)}」會放進這個房間。</div>
      <div class="sheet-actions"><button class="btn primary" data-new-room-ok>建立</button></div>`;
  }

  _roomSheet(s) {
    const room = this._room(s.id);
    if (!room) return null;
    const count = this._plugs.filter((p) => this._roomOf(p) === s.id).length;
    return `
      ${this._sheetHead("房間設定")}
      <div class="field">
        <div class="field-label">名稱</div>
        <input class="text" data-room-name value="${esc(room.name)}" maxlength="30" enterkeyhint="done">
      </div>
      <div class="sheet-actions">
        <button class="btn primary" data-room-save>完成</button>
        <button class="btn danger" data-room-delete>${ic("mdi:delete-outline")}${s.confirmDelete ? `確定刪除？裡面 ${count} 個插座會回到「還沒分房間」` : "刪除這個房間"}</button>
      </div>`;
  }

  _bindSheet() {
    const host = this._sheetHost;
    const s = this._sheet;
    const on = (sel, ev, fn) => host.querySelectorAll(sel).forEach((el) => el.addEventListener(ev, (e) => fn(el, e)));
    const run = async (fn) => {
      s.error = null;
      try {
        await fn();
      } catch (err) {
        s.error = `沒有成功：${err?.message || err}`;
        this._renderSheet();
      }
    };
    const patch = (body) => api("PATCH", `/api/plugs/${s.id}`, body);

    on("[data-backdrop]", "click", (el, e) => e.target === el && this._finishSheet());
    on("[data-close]", "click", () => this._finishSheet());
    on("[data-done]", "click", () => this._finishSheet());

    // 插座設定：改什麼就立刻存
    on("[data-name]", "input", (el) => (s.name = el.value));
    on("[data-name]", "keydown", (el, e) => e.key === "Enter" && el.blur());
    on("[data-name]", "change", (el) => run(() => patch({ name: el.value })));
    on("[data-set-room]", "click", (el) =>
      run(async () => {
        const p = this._plug(s.id);
        const current = s.room !== undefined ? s.room : this._roomOf(p);
        const roomId = el.dataset.setRoom === current ? null : el.dataset.setRoom; // 再點一次 = 取消
        s.room = roomId;
        this._moved[p.id] = roomId;
        this._renderSheet();
        this._refresh();
        await this._setRoom(p, roomId);
      }),
    );
    on("[data-opt]", "change", (el) => run(() => patch({ [el.dataset.opt]: el.checked })));
    on("[data-watts]", "keydown", (el, e) => e.key === "Enter" && el.blur());
    on("[data-watts]", "change", (el) => run(() => patch({ watts: parseFloat(el.value) || null })));

    // 新房間
    on("[data-new-room]", "click", () => {
      s.newRoom = true;
      s.rendered = false;
      this._renderSheet();
      host.querySelector("[data-new-room-name]")?.focus();
    });
    const addRoom = () =>
      run(async () => {
        const input = host.querySelector("[data-new-room-name]");
        const name = input?.value.trim();
        if (!name) return;
        input.blur();
        const roomId = await this._createRoom(name);
        s.newRoom = false;
        if (s.type === "assign") {
          await this._pickRoom(roomId);
        } else if (s.type === "newroom") {
          const p = this._plug(s.id);
          this._closeSheet();
          if (p) await this._moveTo(p, roomId);
        } else {
          s.room = roomId;
          this._moved[s.id] = roomId;
          this._renderSheet();
          await this._setRoom(this._plug(s.id), roomId);
        }
      });
    on("[data-new-room-ok]", "click", addRoom);
    on("[data-new-room-name]", "keydown", (el, e) => e.key === "Enter" && addRoom());

    // 分配房間
    on("[data-pick-room]", "click", (el) => run(() => this._pickRoom(el.dataset.pickRoom)));
    on("[data-skip]", "click", () => this._nextAssign());

    // 房間設定
    on("[data-room-name]", "keydown", (el, e) => e.key === "Enter" && host.querySelector("[data-room-save]").click());
    on("[data-room-save]", "click", () =>
      run(async () => {
        const name = host.querySelector("[data-room-name]").value.trim();
        const room = this._room(s.id);
        if (name && room && name !== room.name) await api("PATCH", `/api/rooms/${s.id}`, { name });
        this._closeSheet();
      }),
    );
    on("[data-room-delete]", "click", () =>
      run(async () => {
        if (!s.confirmDelete) {
          s.confirmDelete = true;
          this._renderSheet();
          return;
        }
        await api("DELETE", `/api/rooms/${s.id}`);
        this._closeSheet();
        this._showToast("已刪除房間");
      }),
    );
  }

  async _pickRoom(roomId) {
    const s = this._sheet;
    const p = this._plug(s.queue[s.index]);
    if (p) this._moved[p.id] = roomId;
    this._nextAssign();
    this._refresh();
    if (p) await this._setRoom(p, roomId);
  }

  _nextAssign() {
    const s = this._sheet;
    s.index += 1;
    s.newRoom = false;
    s.rendered = false;
    if (s.index >= s.queue.length) {
      this._closeSheet();
      this._showToast("房間都分好了");
      return;
    }
    this._renderSheet();
  }

  // 關掉面板前，把還在輸入框裡的名稱、瓦數存起來
  _finishSheet() {
    const s = this._sheet;
    if (s?.type === "plug") {
      const p = this._plug(s.id);
      const name = this._sheetHost.querySelector("[data-name]")?.value;
      if (p && name !== undefined && name.trim() && name.trim() !== p.name) this._safe(() => api("PATCH", `/api/plugs/${p.id}`, { name }));
      const w = this._sheetHost.querySelector("[data-watts]");
      if (p && w && w === this.shadowRoot.activeElement) this._safe(() => api("PATCH", `/api/plugs/${p.id}`, { watts: parseFloat(w.value) || null }));
    }
    this._closeSheet();
  }
}

customElements.define("plug-app", PlugApp);

// 離線也能打開（顯示上次的畫面框架），並且可以「加入主畫面」
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});

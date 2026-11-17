// 自動產生的用電儀表板
//
// 讀取 power_hub 偵測到的插座（sensor.plugs_managed 的 plugs 屬性），依 Home Assistant 的
// 「區域」分區排版。新插座加入、換房間、改設定之後畫面會自己更新，不用改這個檔案。
//
// 用法：configuration.yaml 的 frontend: extra_module_url 載入這個檔案，
// 再新增一個儀表板，原始設定只寫：
//   strategy:
//     type: custom:power-dashboard
//
// 這個檔案定義兩個東西：
//   power-hub-card：自己畫的卡片。view: plugs（預設）是總覽和各房間的插座；
//                   view: settings 是夜間排程和電費設定
//   power-dashboard：儀表板策略，把卡片和圖表排在一起
//
// 插座的名稱、房間、常開／夜間關閉／估算瓦數，都直接在卡片上改：
// 卡片會幫你寫進 Home Assistant 的實體名稱、區域和標籤，power_hub 再自動重新偵測。

const MANAGED = "sensor.plugs_managed";
const UNASSIGNED = "__unassigned__";
const LABEL_KEEP_ON = "常開";
const LABEL_NIGHT = "夜間關閉";
const WATTS_LABEL = /^\s*(\d+(?:\.\d+)?)\s*[wW]\s*$/;
const UNDO_KEY = "dashboard_undo";
const TOAST_MS = 6000;
const HOLD_MS = 350; // 手機上按住多久開始拖拉
const DRAG_PX = 6; // 滑鼠移動多少開始拖拉
const NEW_ROOM = "__new_room__";

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const num = (hass, id) => {
  const v = parseFloat(hass.states[id]?.state);
  return Number.isFinite(v) ? v : null;
};

const fmt = (v, digits = 0) =>
  v === null ? "—" : v.toLocaleString("zh-TW", { minimumFractionDigits: digits, maximumFractionDigits: digits });

const fmtWatts = (w) => (w === null ? "—" : w >= 1000 ? `${fmt(w / 1000, 2)} kW` : `${fmt(w, w < 10 ? 1 : 0)} W`);

const byName = (a, b) => a.name.localeCompare(b.name, "zh-Hant");

const STYLE = `
  :host {
    --ph-on: var(--power-hub-on-color, #f59e0b);
    --ph-accent: var(--primary-color, #2f80ed);
    --ph-danger: var(--error-color, #db4437);
    --ph-card: var(--ha-card-background, var(--card-background-color, #fff));
    --ph-text: var(--primary-text-color, #1c1c1e);
    --ph-muted: var(--secondary-text-color, #6b7280);
    --ph-line: var(--divider-color, rgba(0, 0, 0, 0.08));
    --ph-soft: color-mix(in srgb, var(--ph-text) 6%, transparent);
    --ph-radius: var(--ha-card-border-radius, 16px);
    display: block;
    color: var(--ph-text);
    -webkit-tap-highlight-color: transparent;
  }
  * { box-sizing: border-box; }
  button, input { font: inherit; color: inherit; }
  button { border: 0; background: none; cursor: pointer; padding: 0; -webkit-tap-highlight-color: transparent; }
  button:disabled { opacity: 0.4; cursor: default; }
  ha-icon { display: inline-flex; }
  .wrap { display: grid; gap: 12px; }
  .block {
    background: var(--ph-card);
    border-radius: var(--ph-radius);
    border: var(--ha-card-border-width, 1px) solid var(--ha-card-border-color, var(--ph-line));
    box-shadow: var(--ha-card-box-shadow, none);
  }
  .cols { display: grid; gap: 12px; grid-template-columns: repeat(auto-fill, minmax(min(100%, 340px), 1fr)); align-items: start; }

  /* 總覽 */
  .hero {
    padding: 20px 20px 16px;
    background:
      radial-gradient(120% 140% at 100% 0%, color-mix(in srgb, var(--ph-on) 22%, transparent) 0%, transparent 60%),
      var(--ph-card);
    overflow: hidden;
  }
  .hero-top { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
  .eyebrow { font-size: 13px; color: var(--ph-muted); display: flex; align-items: center; gap: 6px; }
  .eyebrow ha-icon { --mdc-icon-size: 16px; color: var(--ph-on); }
  .big { font-size: 44px; line-height: 1.1; font-weight: 600; letter-spacing: -0.02em; margin-top: 6px; font-variant-numeric: tabular-nums; }
  .big small { font-size: 20px; font-weight: 500; color: var(--ph-muted); margin-left: 4px; letter-spacing: 0; }
  .note { font-size: 13px; color: var(--ph-muted); margin-top: 4px; line-height: 1.5; }
  .pill {
    flex: none; font-size: 13px; font-weight: 500; padding: 6px 10px; border-radius: 999px;
    background: color-mix(in srgb, var(--ph-on) 16%, transparent);
    display: inline-flex; align-items: center; gap: 6px; white-space: nowrap;
  }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--ph-on); }
  .stats { display: grid; grid-template-columns: repeat(3, 1fr); margin-top: 18px; border-top: 1px solid var(--ph-line); padding-top: 14px; }
  .stat + .stat { border-left: 1px solid var(--ph-line); padding-left: 12px; }
  .stat-label { font-size: 12px; color: var(--ph-muted); }
  .stat-value { font-size: 18px; font-weight: 600; margin-top: 2px; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .stat-value small { font-size: 12px; font-weight: 500; color: var(--ph-muted); margin-left: 2px; }

  .actions { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 8px; margin-top: 16px; }
  .btn {
    display: flex; align-items: center; justify-content: center; gap: 8px;
    min-height: 44px; padding: 0 14px; border-radius: 12px; font-size: 15px; font-weight: 500;
    background: var(--ph-soft); transition: background 0.15s, transform 0.1s;
  }
  .btn ha-icon { --mdc-icon-size: 20px; }
  .btn:active:not(:disabled) { transform: scale(0.98); }
  .btn.primary { background: var(--ph-accent); color: #fff; }
  .btn.danger { color: var(--ph-danger); }

  .alert {
    display: flex; gap: 10px; align-items: flex-start; padding: 12px 14px; border-radius: 12px;
    font-size: 14px; line-height: 1.45; margin-top: 14px;
  }
  .alert ha-icon { --mdc-icon-size: 20px; flex: none; margin-top: 1px; }
  .alert.info { background: color-mix(in srgb, var(--info-color, #039be5) 12%, transparent); }
  .alert.info ha-icon { color: var(--info-color, #039be5); }
  .alert.warn { background: color-mix(in srgb, var(--warning-color, #ffa600) 16%, transparent); }
  .alert.warn ha-icon { color: var(--warning-color, #ffa600); }
  .alert a { color: inherit; font-weight: 600; }

  /* 房間 */
  .room { padding: 14px; }
  .room.unassigned { border-style: dashed; }
  .room-head { display: flex; align-items: center; gap: 10px; padding: 2px 2px 12px; }
  .room-icon {
    width: 34px; height: 34px; border-radius: 10px; display: grid; place-items: center; flex: none;
    background: var(--ph-soft); color: var(--ph-muted);
  }
  .room-icon ha-icon { --mdc-icon-size: 18px; }
  .room-title { flex: 1; min-width: 0; text-align: left; }
  .room-name { font-size: 16px; font-weight: 600; display: flex; align-items: center; gap: 4px; }
  .room-name ha-icon { --mdc-icon-size: 16px; color: var(--ph-muted); }
  .room-sub { font-size: 12px; color: var(--ph-muted); margin-top: 1px; }
  .small-btn {
    font-size: 13px; font-weight: 500; padding: 7px 12px; border-radius: 999px; white-space: nowrap;
    background: var(--ph-soft); display: inline-flex; align-items: center; gap: 4px;
  }
  .small-btn ha-icon { --mdc-icon-size: 16px; }
  .small-btn.primary { background: var(--ph-accent); color: #fff; }
  .hint { font-size: 13px; color: var(--ph-muted); margin: -4px 2px 12px; line-height: 1.5; }

  /* 插座 */
  .plugs { display: grid; gap: 8px; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); }
  .plug {
    position: relative; padding: 12px; border-radius: 14px; min-height: 96px; cursor: pointer;
    display: flex; flex-direction: column; justify-content: space-between; gap: 10px;
    background: color-mix(in srgb, var(--ph-text) 4%, transparent);
    transition: background 0.2s, transform 0.1s, opacity 0.2s;
    user-select: none; -webkit-user-select: none; touch-action: manipulation; outline: none;
  }
  .plug:focus-visible { box-shadow: 0 0 0 2px var(--ph-accent); }
  .plug:active { transform: scale(0.97); }
  .plug.on { background: color-mix(in srgb, var(--ph-on) 16%, transparent); }
  .plug.off-line { opacity: 0.55; }
  .plug.pending { opacity: 0.7; }
  .plug-top { display: flex; align-items: flex-start; justify-content: space-between; }
  .knob {
    width: 36px; height: 36px; border-radius: 50%; display: grid; place-items: center; flex: none;
    background: color-mix(in srgb, var(--ph-text) 8%, transparent); color: var(--ph-muted);
    transition: background 0.2s, color 0.2s, box-shadow 0.2s;
  }
  .knob ha-icon { --mdc-icon-size: 20px; }
  .plug.on .knob { background: var(--ph-on); color: #fff; box-shadow: 0 4px 14px color-mix(in srgb, var(--ph-on) 45%, transparent); }
  .edit {
    width: 36px; height: 36px; margin: -6px -6px 0 0; border-radius: 50%; display: grid; place-items: center;
    color: var(--ph-muted);
  }
  .edit:hover { background: var(--ph-soft); }
  .edit ha-icon { --mdc-icon-size: 20px; }
  .plug-name {
    font-size: 15px; font-weight: 600; line-height: 1.3;
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; word-break: break-all;
  }
  .plug-state { font-size: 13px; color: var(--ph-muted); margin-top: 2px; font-variant-numeric: tabular-nums; }
  .plug.on .plug-state { color: var(--ph-text); }

  .empty { padding: 20px; color: var(--ph-muted); font-size: 14px; text-align: center; }

  /* 拖拉 */
  .plug { -webkit-touch-callout: none; }
  .toolbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 4px 4px 0; }
  .toolbar-title { font-size: 15px; font-weight: 600; color: var(--ph-muted); }
  .toolbar.arranging {
    position: sticky; top: calc(var(--header-height, 56px) + 8px); z-index: 3;
    padding: 10px 10px 10px 16px; border-radius: 14px;
    background: var(--ph-accent); color: #fff; box-shadow: 0 6px 20px rgba(0, 0, 0, 0.18);
  }
  .toolbar.arranging .toolbar-title { color: #fff; font-weight: 500; }
  .toolbar.arranging .small-btn { background: #fff; color: var(--ph-accent); }
  .arrange .plug { touch-action: none; cursor: grab; min-height: 72px; }
  .arrange .plug:active { transform: none; }
  .grip { width: 36px; height: 36px; margin: -6px -6px 0 0; display: grid; place-items: center; color: var(--ph-muted); }
  .grip ha-icon { --mdc-icon-size: 20px; }
  .plug.dragging { opacity: 0.25; }
  .ghost {
    position: fixed; z-index: 20; pointer-events: none; margin: 0;
    transform: rotate(2deg) scale(1.05); box-shadow: 0 14px 34px rgba(0, 0, 0, 0.28);
    background: var(--ph-card) !important; opacity: 0.96;
  }
  .ghost.on { background: color-mix(in srgb, var(--ph-on) 22%, var(--ph-card)) !important; }
  [data-drop] { transition: background 0.15s, box-shadow 0.15s; }
  [data-drop].over { box-shadow: 0 0 0 2px var(--ph-accent); background: color-mix(in srgb, var(--ph-accent) 7%, var(--ph-card)); }
  .drop-empty {
    border: 2px dashed var(--ph-line); border-radius: 14px; padding: 18px; text-align: center;
    font-size: 13px; color: var(--ph-muted);
  }
  .new-zone { padding: 22px 14px; text-align: center; border-style: dashed; color: var(--ph-muted); font-size: 14px; }
  .new-zone ha-icon { --mdc-icon-size: 22px; display: block; margin: 0 auto 6px; }

  /* 設定 */
  .panel { padding: 16px; }
  .panel-head { display: flex; align-items: center; gap: 10px; margin-bottom: 4px; }
  .panel-head .room-icon { color: var(--ph-on); background: color-mix(in srgb, var(--ph-on) 14%, transparent); }
  .panel-title { flex: 1; font-size: 16px; font-weight: 600; }
  .row { display: flex; align-items: center; gap: 12px; padding: 12px 0; border-top: 1px solid var(--ph-line); }
  .row.first { border-top: 0; }
  .row-text { flex: 1; min-width: 0; }
  .row-label { font-size: 15px; }
  .row-desc { font-size: 12px; color: var(--ph-muted); margin-top: 2px; line-height: 1.45; font-weight: 400; }
  .desc { font-size: 13px; color: var(--ph-muted); line-height: 1.5; margin: 4px 0 4px; }
  .muted { opacity: 0.45; pointer-events: none; }
  input[type="time"], .num input {
    background: var(--ph-soft); border: 0; border-radius: 10px; height: 40px; padding: 0 10px;
    font-size: 16px; font-variant-numeric: tabular-nums; outline: none; color-scheme: light dark;
  }
  input:focus { box-shadow: 0 0 0 2px var(--ph-accent); }
  .num { display: flex; align-items: center; gap: 4px; }
  .num input { width: 72px; text-align: center; -moz-appearance: textfield; }
  .num input::-webkit-inner-spin-button, .num input::-webkit-outer-spin-button { -webkit-appearance: none; margin: 0; }
  .num .unit { font-size: 13px; color: var(--ph-muted); min-width: 22px; }
  .step { width: 36px; height: 40px; border-radius: 10px; background: var(--ph-soft); display: grid; place-items: center; font-size: 18px; }
  .readout { font-size: 15px; font-weight: 600; font-variant-numeric: tabular-nums; text-align: right; }
  .readout small { display: block; font-size: 12px; font-weight: 400; color: var(--ph-muted); }

  .switch { position: relative; width: 50px; height: 30px; flex: none; }
  .switch input { position: absolute; opacity: 0; inset: 0; margin: 0; cursor: pointer; z-index: 1; }
  .switch span {
    position: absolute; inset: 0; border-radius: 999px; background: color-mix(in srgb, var(--ph-text) 18%, transparent);
    transition: background 0.2s;
  }
  .switch span::after {
    content: ""; position: absolute; top: 3px; left: 3px; width: 24px; height: 24px; border-radius: 50%;
    background: #fff; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.25); transition: transform 0.2s;
  }
  .switch input:checked + span { background: var(--ph-accent); }
  .switch input:checked + span::after { transform: translateX(20px); }
  .switch input:focus-visible + span { box-shadow: 0 0 0 2px var(--ph-accent); }

  .chips { display: flex; flex-wrap: wrap; gap: 8px; }
  .chip-btn {
    min-height: 38px; padding: 0 14px; border-radius: 999px; font-size: 14px;
    border: 1px solid var(--ph-line); display: inline-flex; align-items: center; gap: 6px;
    transition: background 0.15s, border-color 0.15s, color 0.15s;
  }
  .chip-btn ha-icon { --mdc-icon-size: 18px; }
  .chip-btn.sel { background: var(--ph-accent); border-color: var(--ph-accent); color: #fff; }
  .chip-btn.add { border-style: dashed; color: var(--ph-muted); }

  /* 底部面板 */
  .backdrop {
    position: fixed; inset: 0; background: rgba(0, 0, 0, 0.45); z-index: 10;
    display: flex; align-items: flex-end; justify-content: center; animation: fade 0.15s ease-out;
  }
  .sheet {
    width: 100%; max-width: 560px; max-height: 88vh; overflow: auto;
    background: var(--ph-card); color: var(--ph-text);
    border-radius: 22px 22px 0 0; padding: 8px 20px calc(20px + env(safe-area-inset-bottom));
    animation: up 0.2s ease-out;
  }
  @media (min-width: 600px) {
    .backdrop { align-items: center; }
    .sheet { border-radius: 22px; padding-bottom: 20px; }
  }
  @keyframes fade { from { opacity: 0; } }
  @keyframes up { from { transform: translateY(40px); opacity: 0; } }
  .grabber { width: 40px; height: 5px; border-radius: 3px; background: var(--ph-line); margin: 4px auto 12px; }
  .sheet-head { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; }
  .sheet-title { flex: 1; font-size: 19px; font-weight: 600; }
  .close { width: 36px; height: 36px; border-radius: 50%; background: var(--ph-soft); display: grid; place-items: center; }
  .close ha-icon { --mdc-icon-size: 20px; }
  .field { margin-bottom: 20px; }
  .field-label { font-size: 13px; font-weight: 600; color: var(--ph-muted); margin-bottom: 8px; }
  .text {
    width: 100%; height: 46px; border-radius: 12px; border: 0; background: var(--ph-soft);
    padding: 0 14px; font-size: 16px; outline: none;
  }
  .new-room { display: flex; gap: 8px; margin-top: 10px; }
  .new-room .text { flex: 1; }
  .opt { display: flex; align-items: center; gap: 12px; padding: 12px 0; border-top: 1px solid var(--ph-line); }
  .opt:first-of-type { border-top: 0; }
  .sheet-actions { display: grid; gap: 8px; margin-top: 8px; }
  .progress { height: 4px; border-radius: 2px; background: var(--ph-soft); overflow: hidden; margin-bottom: 18px; }
  .progress div { height: 100%; background: var(--ph-accent); transition: width 0.2s; }
  .wizard-name { font-size: 26px; font-weight: 600; margin: 4px 0 4px; }
  .wizard-q { font-size: 15px; color: var(--ph-muted); margin-bottom: 16px; }
  .chips.big .chip-btn { min-height: 48px; font-size: 16px; padding: 0 18px; }
  .err { color: var(--ph-danger); font-size: 13px; margin-top: 8px; }

  /* 提示條 */
  .toast {
    position: fixed; left: 50%; bottom: calc(24px + env(safe-area-inset-bottom)); transform: translateX(-50%);
    z-index: 11; display: flex; align-items: center; gap: 16px; padding: 10px 10px 10px 18px;
    border-radius: 14px; background: #2b2d31; color: #fff; font-size: 15px;
    box-shadow: 0 8px 28px rgba(0, 0, 0, 0.3); white-space: nowrap; animation: fade 0.2s ease-out;
  }
  .toast span { padding: 6px 0; }
  .toast button { color: #ffd27a; font-weight: 600; padding: 8px 10px; border-radius: 8px; }
`;

class PowerHubCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this.shadowRoot.innerHTML = `<style>${STYLE}</style><div class="main"></div><div class="sheet-host"></div><div class="toast-host"></div>`;
    this._main = this.shadowRoot.querySelector(".main");
    this._sheetHost = this.shadowRoot.querySelector(".sheet-host");
    this._toastHost = this.shadowRoot.querySelector(".toast-host");
    this._pending = new Set(); // 剛按下、還沒收到新狀態的插座
    this._sheet = null; // 開著的底部面板
    this._arrange = false; // 整理房間模式
    this._moved = {}; // 剛拖到別的房間、Home Assistant 還沒更新的插座
    this._drag = null; // 正在拖拉的插座
  }

  setConfig(config) {
    this._config = { view: "plugs", ...(config || {}) };
  }

  getCardSize() {
    return 10;
  }

  getGridOptions() {
    return { columns: "full" };
  }

  set hass(hass) {
    this._hass = hass;
    // 拖拉中不重畫，放開後再畫
    if (this._drag) return;
    // 正在輸入時不重畫，免得打到一半被清掉；離開輸入框後會再畫
    const active = this.shadowRoot.activeElement;
    if (active && active.tagName === "INPUT" && this._main.contains(active)) return;
    const sig = this._signature();
    if (sig !== this._sig) {
      this._sig = sig;
      this._render();
    }
  }

  get _plugs() {
    return this._hass.states[MANAGED]?.attributes.plugs || [];
  }

  get _areas() {
    return Object.values(this._hass.areas || {}).sort(byName);
  }

  _plug(entityId) {
    return this._plugs.find((p) => p.entity_id === entityId);
  }

  // 只有相關的狀態變了才重畫
  _signature() {
    const h = this._hass;
    const ids = [
      MANAGED, "sensor.plugs_power", "sensor.plugs_energy_daily", "sensor.plugs_cost_daily",
      "sensor.plugs_cost_monthly", "sensor.plugs_discovered", "sensor.plugs_offline", "sensor.plugs_standby",
      "input_boolean.power_schedule", "input_datetime.power_night_off", "input_datetime.power_morning_on",
      "input_number.household_monthly_kwh", "input_number.standby_threshold", "input_number.overload_threshold",
      "sensor.power_price",
    ];
    const parts = ids.map((id) => {
      const s = h.states[id];
      return s ? `${s.state}|${JSON.stringify(s.attributes.names || s.attributes.plugs || s.attributes.season || "")}` : "";
    });
    for (const p of this._plugs) {
      parts.push(h.states[p.entity_id]?.state, p.power_entity && h.states[p.power_entity]?.state);
    }
    parts.push(this._areas.map((a) => `${a.area_id}:${a.name}:${a.icon}`).join(","));
    // Home Assistant 已經更新的，就不用再記著
    for (const p of this._plugs) {
      if (p.entity_id in this._moved && (p.area_id || null) === this._moved[p.entity_id]) delete this._moved[p.entity_id];
    }
    parts.push([...this._pending].join(","), JSON.stringify(this._moved), this._arrange);
    return parts.join("~");
  }

  _refresh() {
    this._sig = null;
    if (this._hass) this.hass = this._hass;
  }

  _render() {
    const h = this._hass;
    if (!h) return;
    if (!h.states[MANAGED]) {
      this._main.innerHTML = `<div class="block empty">找不到 power_hub：確認 configuration.yaml 有 <code>power_hub:</code> 並重新啟動。</div>`;
      return;
    }
    this._main.innerHTML = this._config.view === "settings" ? this._settingsHtml() : this._plugsHtml();
    this._bindMain();
    if (this._sheet) this._renderSheet();
  }

  // ───────────── 插座 ─────────────

  _isOn(p) {
    return this._hass.states[p.entity_id]?.state === "on";
  }

  _isOffline(p) {
    const s = this._hass.states[p.entity_id]?.state;
    return s === undefined || s === "unavailable" || s === "unknown";
  }

  _plugsHtml() {
    const h = this._hass;
    const plugs = this._plugs;
    const onCount = plugs.filter((p) => this._isOn(p)).length;
    const measured = plugs.some((p) => p.mode === "metered" || p.mode === "estimated");
    const metered = plugs.some((p) => p.mode === "metered");

    let hero;
    if (measured) {
      const [value, unit] = fmtWatts(num(h, "sensor.plugs_power")).split(" ");
      hero = `
        <div class="hero-top">
          <div>
            <div class="eyebrow"><ha-icon icon="mdi:flash"></ha-icon>目前總功率</div>
            <div class="big">${value}<small>${unit || ""}</small></div>
          </div>
          <span class="pill"><span class="dot"></span>${onCount} / ${plugs.length} 開著</span>
        </div>
        <div class="stats">
          <div class="stat"><div class="stat-label">今日用電</div><div class="stat-value">${fmt(num(h, "sensor.plugs_energy_daily"), 2)}<small>度</small></div></div>
          <div class="stat"><div class="stat-label">今日電費</div><div class="stat-value"><small>$</small>${fmt(num(h, "sensor.plugs_cost_daily"), 1)}</div></div>
          <div class="stat"><div class="stat-label">本月電費</div><div class="stat-value"><small>$</small>${fmt(num(h, "sensor.plugs_cost_monthly"))}</div></div>
        </div>`;
    } else {
      hero = `
        <div class="eyebrow"><ha-icon icon="mdi:power-plug"></ha-icon>插座</div>
        <div class="big">${onCount}<small>/ ${plugs.length} 開著</small></div>
        <div class="note">這些插座沒有用電計量。點插座右上角的 ⋯，填上大約幾瓦，就能估算用電和電費。</div>`;
    }

    const alerts = [];
    const discovered = h.states["sensor.plugs_discovered"]?.attributes.names || [];
    if (discovered.length) {
      alerts.push(`<div class="alert info"><ha-icon icon="mdi:access-point-plus"></ha-icon><div>區網發現新裝置：${esc(discovered.join("、"))}。<a href="/config/integrations/dashboard" data-nav>到裝置與服務新增</a></div></div>`);
    }
    const offline = h.states["sensor.plugs_offline"]?.attributes.names || [];
    if (offline.length) {
      alerts.push(`<div class="alert warn"><ha-icon icon="mdi:wifi-off"></ha-icon><div>連不上：${esc(offline.join("、"))}</div></div>`);
    }

    const closable = plugs.filter((p) => this._isOn(p) && !p.keep_on).length;
    const standbyCount = num(h, "sensor.plugs_standby") || 0;
    const actions = `
      <div class="actions">
        <button class="btn" data-off="all" ${closable ? "" : "disabled"}>
          <ha-icon icon="mdi:power"></ha-icon>全部關閉
        </button>
        ${metered ? `
        <button class="btn" data-off="standby" ${standbyCount ? "" : "disabled"}>
          <ha-icon icon="mdi:power-sleep"></ha-icon>關閉待機${standbyCount ? ` ${standbyCount} 個` : ""}
        </button>` : ""}
      </div>`;

    const areas = h.areas || {};
    const byArea = new Map();
    // 整理模式：所有房間都列出來（空房間也可以拖進去）
    if (this._arrange) {
      byArea.set(UNASSIGNED, []);
      for (const a of this._areas) byArea.set(a.area_id, []);
    }
    for (const p of plugs) {
      const area = this._areaOf(p);
      const key = area && areas[area] ? area : UNASSIGNED;
      if (!byArea.has(key)) byArea.set(key, []);
      byArea.get(key).push(p);
    }
    // 還沒分房間的放最前面，最需要處理
    const order = [...byArea.keys()].filter((id) => id !== UNASSIGNED).sort((a, b) => byName(areas[a], areas[b]));
    if (byArea.has(UNASSIGNED)) order.unshift(UNASSIGNED);

    const rooms = order.map((id) => this._roomHtml(id, areas[id], byArea.get(id).slice().sort(byName)));
    if (this._arrange) {
      rooms.push(`<section class="block room new-zone" data-drop="${NEW_ROOM}"><ha-icon icon="mdi:plus"></ha-icon>拖到這裡，建立新房間</section>`);
    }

    const toolbar = this._arrange
      ? `<div class="toolbar arranging"><div class="toolbar-title">把插座拖到其他房間</div><button class="small-btn" data-arrange>完成</button></div>`
      : `<div class="toolbar"><div class="toolbar-title">房間</div><button class="small-btn" data-arrange><ha-icon icon="mdi:drag-variant"></ha-icon>整理房間</button></div>`;

    return `
      <div class="wrap ${this._arrange ? "arrange" : ""}">
        <section class="block hero">${hero}${alerts.join("")}${actions}</section>
        ${plugs.length ? `${toolbar}<div class="cols">${rooms.join("")}</div>` : `<div class="block empty">還沒有插座。到「設定 → 裝置與服務」加入插座後會自動出現在這裡。</div>`}
      </div>`;
  }

  // 剛拖過去、Home Assistant 還沒更新的，先顯示在新房間
  _areaOf(p) {
    return p.entity_id in this._moved ? this._moved[p.entity_id] : p.area_id;
  }

  _roomHtml(id, area, list) {
    const roomOn = list.filter((p) => this._isOn(p)).length;
    const arrange = this._arrange;
    const body = list.length
      ? `<div class="plugs">${list.map((p) => this._plugHtml(p)).join("")}</div>`
      : `<div class="drop-empty">把插座拖到這裡</div>`;
    if (id === UNASSIGNED) {
      return `
        <section class="block room unassigned" data-drop="${UNASSIGNED}">
          <div class="room-head">
            <div class="room-icon"><ha-icon icon="mdi:help-circle-outline"></ha-icon></div>
            <div class="room-title">
              <div class="room-name">還沒分房間</div>
              <div class="room-sub">${list.length} 個插座</div>
            </div>
            ${arrange || !list.length ? "" : `<button class="small-btn primary" data-assign><ha-icon icon="mdi:home-plus-outline"></ha-icon>分配房間</button>`}
          </div>
          ${arrange || !list.length ? "" : `<div class="hint">把插座拖到下面的房間，或按「分配房間」一個一個點選。手機上按住插座一下再拖。</div>`}
          ${body}
        </section>`;
    }
    const canOff = !arrange && list.some((p) => this._isOn(p) && !p.keep_on);
    return `
      <section class="block room" data-drop="${esc(id)}">
        <div class="room-head">
          <div class="room-icon"><ha-icon icon="${esc(area.icon || "mdi:home-outline")}"></ha-icon></div>
          <button class="room-title" data-room="${esc(id)}" title="改房間名稱">
            <div class="room-name">${esc(area.name)}<ha-icon icon="mdi:chevron-right"></ha-icon></div>
            <div class="room-sub">${roomOn ? `${roomOn} 個開著` : "全部關閉"} · 共 ${list.length} 個</div>
          </button>
          ${canOff ? `<button class="small-btn" data-off="area:${esc(id)}"><ha-icon icon="mdi:power"></ha-icon>全關</button>` : ""}
        </div>
        ${body}
      </section>`;
  }

  _plugHtml(p) {
    const h = this._hass;
    const on = this._isOn(p);
    const off = this._isOffline(p);
    const bits = [off ? "離線" : on ? "開啟" : "關閉"];
    if (on && p.mode === "metered") bits.push(fmtWatts(num(h, p.power_entity)));
    if (on && p.mode === "estimated") bits.push(`約 ${fmtWatts(p.watts)}`);
    if (p.keep_on) bits.push("常開");
    else if (p.night) bits.push("夜間關");
    const cls = ["plug", on ? "on" : "", off ? "off-line" : "", this._pending.has(p.entity_id) ? "pending" : ""].join(" ");
    const icon = off ? "mdi:power-plug-off-outline" : on ? "mdi:power-plug" : "mdi:power-plug-outline";
    return `
      <div class="${cls}" role="switch" tabindex="0" aria-checked="${on}" data-plug="${esc(p.entity_id)}">
        <div class="plug-top">
          <div class="knob"><ha-icon icon="${icon}"></ha-icon></div>
          ${this._arrange
            ? `<span class="grip" aria-hidden="true"><ha-icon icon="mdi:drag"></ha-icon></span>`
            : `<button class="edit" data-edit="${esc(p.entity_id)}" aria-label="設定 ${esc(p.name)}"><ha-icon icon="mdi:dots-horizontal"></ha-icon></button>`}
        </div>
        <div>
          <div class="plug-name">${esc(p.name)}</div>
          <div class="plug-state">${bits.join(" · ")}</div>
        </div>
      </div>`;
  }

  // ───────────── 排程與設定 ─────────────

  _settingsHtml() {
    const h = this._hass;
    const schedOn = h.states["input_boolean.power_schedule"]?.state === "on";
    const time = (id) => (h.states[id]?.state || "").slice(0, 5);
    const plugs = this._plugs.slice().sort(byName);
    const nightCount = plugs.filter((p) => p.night && !p.keep_on).length;

    const nightChips = plugs
      .map((p) =>
        p.keep_on
          ? `<button class="chip-btn" disabled title="常開的插座不會被關">${esc(p.name)}・常開</button>`
          : `<button class="chip-btn ${p.night ? "sel" : ""}" data-night="${esc(p.entity_id)}">${p.night ? '<ha-icon icon="mdi:check"></ha-icon>' : ""}${esc(p.name)}</button>`,
      )
      .join("");

    const numberRow = (id, label, desc, unit, first = false) => {
      const s = h.states[id];
      if (!s) return "";
      const step = s.attributes.step || 1;
      return `
        <div class="row ${first ? "first" : ""}">
          <div class="row-text"><div class="row-label">${label}</div><div class="row-desc">${desc}</div></div>
          <div class="num">
            <button class="step" data-step="${id}" data-dir="-1" aria-label="減少">−</button>
            <input type="number" inputmode="decimal" data-number="${id}" value="${esc(parseFloat(s.state))}" step="${step}" min="${s.attributes.min ?? ""}" max="${s.attributes.max ?? ""}">
            <button class="step" data-step="${id}" data-dir="1" aria-label="增加">+</button>
            <span class="unit">${unit}</span>
          </div>
        </div>`;
    };

    const price = h.states["sensor.power_price"];
    return `
      <div class="cols">
        <section class="block panel">
          <div class="panel-head">
            <div class="room-icon"><ha-icon icon="mdi:weather-night"></ha-icon></div>
            <div class="panel-title">夜間排程</div>
            <label class="switch"><input type="checkbox" data-toggle="input_boolean.power_schedule" ${schedOn ? "checked" : ""} aria-label="夜間排程"><span></span></label>
          </div>
          <div class="desc">${schedOn ? "每天晚上自動關掉選好的插座，早上再打開；晚上本來就關著的不會被打開。" : "打開右邊的開關，每天晚上自動關掉選好的插座，早上再打開。"}</div>
          <div class="${schedOn ? "" : "muted"}">
            <div class="row">
              <div class="row-text"><div class="row-label">晚上關閉</div></div>
              <input type="time" data-time="input_datetime.power_night_off" value="${time("input_datetime.power_night_off")}">
            </div>
            <div class="row">
              <div class="row-text"><div class="row-label">早上打開</div></div>
              <input type="time" data-time="input_datetime.power_morning_on" value="${time("input_datetime.power_morning_on")}">
            </div>
            <div class="row" style="display:block">
              <div class="row-label" style="margin-bottom:10px">要關閉的插座 <span class="row-desc">已選 ${nightCount} 個，點一下選取或取消</span></div>
              <div class="chips">${nightChips || '<span class="row-desc">還沒有插座</span>'}</div>
            </div>
          </div>
        </section>

        <section class="block panel">
          <div class="panel-head">
            <div class="room-icon"><ha-icon icon="mdi:cash"></ha-icon></div>
            <div class="panel-title">電費與提醒</div>
          </div>
          ${numberRow("input_number.household_monthly_kwh", "家裡每月用電", "電費單上的度數；兩個月一期的話除以 2", "度", true)}
          <div class="row">
            <div class="row-text"><div class="row-label">目前電價</div><div class="row-desc">依每月用電和季節自動算出</div></div>
            <div class="readout">${price ? `${esc(price.state)} 元/度` : "—"}<small>${esc(price?.attributes.season || "")}</small></div>
          </div>
          ${numberRow("input_number.standby_threshold", "待機門檻", "插座開著但低於這個瓦數，就當作在待機", "W")}
          ${numberRow("input_number.overload_threshold", "功率過高提醒", "超過這個瓦數持續 1 分鐘就通知", "W")}
        </section>
      </div>`;
  }

  // ───────────── 事件 ─────────────

  _bindMain() {
    const root = this._main;
    const on = (sel, ev, fn) => root.querySelectorAll(sel).forEach((el) => el.addEventListener(ev, (e) => fn(el, e)));

    on("[data-plug]", "click", (el, e) => {
      // 剛拖完放開也會觸發 click，不要當成開關
      if (this._justDragged || this._arrange) return;
      if (!e.target.closest("[data-edit]")) this._toggle(el.dataset.plug);
    });
    on("[data-plug]", "pointerdown", (el, e) => this._dragDown(el, e));
    on("[data-plug]", "contextmenu", (el, e) => e.preventDefault());
    on("[data-arrange]", "click", () => {
      this._arrange = !this._arrange;
      this._refresh();
    });
    on("[data-plug]", "keydown", (el, e) => {
      if (this._arrange) return;
      if ((e.key === "Enter" || e.key === " ") && e.target === el) {
        e.preventDefault();
        this._toggle(el.dataset.plug);
      }
    });
    on("[data-edit]", "click", (el, e) => {
      e.stopPropagation();
      this._openSheet({ type: "plug", entityId: el.dataset.edit });
    });
    on("[data-off]", "click", (el) => this._turnOff(el.dataset.off));
    on("[data-assign]", "click", () => this._startAssign());
    on("[data-room]", "click", (el) => this._openSheet({ type: "room", areaId: el.dataset.room }));
    on("a[data-nav]", "click", (el, e) => {
      e.preventDefault();
      history.pushState(null, "", el.getAttribute("href"));
      window.dispatchEvent(new CustomEvent("location-changed"));
    });

    // 排程與設定
    on("[data-toggle]", "change", (el) =>
      this._hass.callService("input_boolean", el.checked ? "turn_on" : "turn_off", { entity_id: el.dataset.toggle }),
    );
    on("[data-time]", "change", (el) => {
      if (el.value) this._hass.callService("input_datetime", "set_datetime", { entity_id: el.dataset.time, time: `${el.value}:00` });
    });
    on("[data-time]", "blur", () => this._refresh());
    on("[data-number]", "change", (el) => this._setNumber(el.dataset.number, parseFloat(el.value)));
    on("[data-number]", "keydown", (el, e) => e.key === "Enter" && el.blur());
    on("[data-number]", "blur", () => this._refresh());
    on("[data-step]", "click", (el) => {
      const s = this._hass.states[el.dataset.step];
      const step = s.attributes.step || 1;
      this._setNumber(el.dataset.step, parseFloat(s.state) + step * Number(el.dataset.dir));
    });
    on("[data-night]", "click", (el) => {
      const p = this._plug(el.dataset.night);
      if (!p) return;
      el.disabled = true;
      this._safe(() => this._setLabel(p, LABEL_NIGHT, !p.night));
    });
  }

  // ───────────── 拖拉換房間 ─────────────
  //
  // 滑鼠：按下移動一點點就開始拖。
  // 手機：整理模式下直接拖；平常要先按住一下（不然會跟捲動畫面衝突）。

  _dragDown(el, e) {
    if (e.button > 0 || e.target.closest("[data-edit]")) return;
    const touch = e.pointerType !== "mouse";
    const d = {
      el,
      entityId: el.dataset.plug,
      pointerId: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      started: false,
      ready: !touch || this._arrange,
    };
    this._pre = d;
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
        const far = Math.hypot(ev.clientX - d.x, ev.clientY - d.y) > DRAG_PX;
        if (!far) return;
        // 還沒按夠久就移動 = 想捲動畫面，不拖
        if (!d.ready) return cleanup();
        this._dragBegin(d, ev.clientX, ev.clientY);
      }
      ev.preventDefault();
      this._dragMove(ev.clientX, ev.clientY);
    };
    // 拖拉中擋掉手機的捲動
    const touchmove = (ev) => d.started && ev.cancelable && ev.preventDefault();
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
      if (this._pre === d) this._pre = null;
    };
    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    window.addEventListener("touchmove", touchmove, { passive: false });
  }

  _dragBegin(d, x, y) {
    if (d.started || !d.el.isConnected) return;
    d.started = true;
    const rect = d.el.getBoundingClientRect();
    const ghost = d.el.cloneNode(true);
    ghost.classList.add("ghost");
    ghost.classList.remove("pending");
    Object.assign(ghost.style, { width: `${rect.width}px`, height: `${rect.height}px`, left: `${rect.left}px`, top: `${rect.top}px` });
    this.shadowRoot.appendChild(ghost);
    d.ghost = ghost;
    d.dx = x - rect.left;
    d.dy = y - rect.top;
    d.from = this._areaOf(this._plug(d.entityId)) || UNASSIGNED;
    this._drag = d;
    // 平常模式下開始拖：暫時切到整理模式，空房間和「新房間」才會出現
    if (!this._arrange) {
      this._arrange = true;
      d.autoArrange = true;
      this._sig = this._signature();
      this._render();
    }
    this._markDragging();
    this._scroller = this._findScroller();
    this._dragMove(x, y);
  }

  _markDragging() {
    const d = this._drag;
    this._main.querySelectorAll("[data-plug]").forEach((el) => el.classList.toggle("dragging", !!d && el.dataset.plug === d.entityId));
  }

  _dragMove(x, y) {
    const d = this._drag;
    if (!d) return;
    d.cx = x;
    d.cy = y;
    d.ghost.style.left = `${x - d.dx}px`;
    d.ghost.style.top = `${y - d.dy}px`;
    const hit = this.shadowRoot.elementFromPoint(x, y)?.closest("[data-drop]");
    if (hit !== d.over) {
      d.over?.classList.remove("over");
      d.over = hit && hit.dataset.drop !== d.from ? hit : null;
      d.over?.classList.add("over");
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
        this._scroller.scrollBy(0, d.scroll * 12);
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
    d.over?.classList.remove("over");
    if (d.autoArrange) this._arrange = false;
    this._justDragged = true;
    setTimeout(() => (this._justDragged = false), 50);

    const target = drop && d.over ? d.over.dataset.drop : null;
    const plug = this._plug(d.entityId);
    if (!target || !plug) return this._refresh();
    if (target === NEW_ROOM) {
      this._refresh();
      this._openSheet({ type: "newroom", entityId: d.entityId });
      return;
    }
    const areaId = target === UNASSIGNED ? null : target;
    this._moveTo(plug, areaId);
  }

  async _moveTo(plug, areaId) {
    const before = plug.area_id || null;
    this._moved[plug.entity_id] = areaId;
    this._refresh();
    const name = areaId ? this._hass.areas?.[areaId]?.name : "還沒分房間";
    try {
      await this._setRoom(plug, areaId);
      this._showToast(`${plug.name} → ${name}`);
    } catch (err) {
      this._moved[plug.entity_id] = before;
      this._showToast(`沒有成功：${err?.message || err}`);
      this._refresh();
    }
  }

  // Home Assistant 的頁面不一定是整個視窗在捲，找到真正在捲的那一層
  _findScroller() {
    let node = this;
    while (node) {
      node = node.parentNode || node.host;
      if (!node || node === document) break;
      if (node instanceof Element) {
        const style = getComputedStyle(node);
        if (/(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight) return node;
      }
    }
    return window;
  }

  _setNumber(entityId, value) {
    const s = this._hass.states[entityId];
    if (!s || !Number.isFinite(value)) return this._refresh();
    const { min, max } = s.attributes;
    const v = Math.min(max ?? Infinity, Math.max(min ?? -Infinity, value));
    this._hass.callService("input_number", "set_value", { entity_id: entityId, value: v });
  }

  _toggle(entityId) {
    const s = this._hass.states[entityId]?.state;
    if (s !== "on" && s !== "off") {
      this._openSheet({ type: "plug", entityId });
      return;
    }
    this._pending.add(entityId);
    this._refresh();
    this._hass
      .callService("switch", s === "on" ? "turn_off" : "turn_on", { entity_id: entityId })
      .finally(() => {
        this._pending.delete(entityId);
        this._refresh();
      });
  }

  // 按一次就關，下面出現「復原」可以反悔
  async _turnOff(key) {
    if (key === "standby") {
      await this._hass.callService("power_hub", "turn_off", { standby_only: true, remember: UNDO_KEY });
      this._showToast("已關閉待機中的插座", true);
      return;
    }
    const area = key.startsWith("area:") ? key.slice(5) : null;
    const targets = this._plugs.filter((p) => this._isOn(p) && !p.keep_on && (!area || p.area_id === area));
    if (!targets.length) return;
    const data = { remember: UNDO_KEY };
    if (area) data.area = area;
    await this._hass.callService("power_hub", "turn_off", data);
    const where = area ? this._hass.areas?.[area]?.name || "" : "";
    this._showToast(`已關閉${where} ${targets.length} 個插座`, true);
  }

  _showToast(text, undo = false) {
    clearTimeout(this._toastTimer);
    this._toastHost.innerHTML = `<div class="toast" role="status"><span>${esc(text)}</span>${undo ? "<button data-undo>復原</button>" : ""}</div>`;
    this._toastHost.querySelector("[data-undo]")?.addEventListener("click", () => {
      this._hass.callService("power_hub", "restore", { remember: UNDO_KEY });
      this._showToast("已復原");
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

  // ───────────── 寫入 Home Assistant ─────────────

  _ws(msg) {
    return this._hass.callWS(msg);
  }

  async _labels() {
    if (!this._labelCache) this._labelCache = await this._ws({ type: "config/label_registry/list" });
    return this._labelCache;
  }

  async _labelId(name, create) {
    const labels = await this._labels();
    let label = labels.find((l) => l.name === name);
    if (!label && create) {
      label = await this._ws({ type: "config/label_registry/create", name });
      labels.push(label);
    }
    return label?.label_id;
  }

  // 標籤可能貼在插座上，也可能貼在整個裝置上；拿掉時兩邊都拿
  async _editLabels(plug, { add = [], remove = [] }) {
    const ent = await this._ws({ type: "config/entity_registry/get", entity_id: plug.entity_id });
    const labels = new Set(ent.labels || []);
    remove.forEach((id) => labels.delete(id));
    add.forEach((id) => labels.add(id));
    await this._ws({ type: "config/entity_registry/update", entity_id: plug.entity_id, labels: [...labels] });
    const dev = plug.device_id ? this._hass.devices?.[plug.device_id] : null;
    const devLabels = dev?.labels || [];
    if (dev && devLabels.some((id) => remove.includes(id))) {
      await this._ws({
        type: "config/device_registry/update",
        device_id: dev.id,
        labels: devLabels.filter((id) => !remove.includes(id)),
      });
    }
  }

  async _setLabel(plug, name, on) {
    const id = await this._labelId(name, on);
    if (id) await this._editLabels(plug, on ? { add: [id] } : { remove: [id] });
  }

  async _setWatts(plug, watts) {
    const labels = await this._labels();
    const existing = labels.filter((l) => WATTS_LABEL.test(l.name)).map((l) => l.label_id);
    const add = watts > 0 ? [await this._labelId(`${+watts.toFixed(1)}W`, true)] : [];
    await this._editLabels(plug, { add, remove: existing.filter((id) => !add.includes(id)) });
  }

  async _setName(plug, name) {
    name = (name || "").trim();
    if (!plug || !name || name === plug.name) return;
    await this._ws({ type: "config/entity_registry/update", entity_id: plug.entity_id, name });
  }

  // 一台裝置只有一個插座：房間設在裝置上（Home Assistant 其他畫面也會跟著分好）；
  // 多孔排插：每一孔各自設定
  async _setRoom(plug, areaId) {
    const single = plug.device_id && this._plugs.filter((p) => p.device_id === plug.device_id).length === 1;
    if (single) {
      await this._ws({ type: "config/device_registry/update", device_id: plug.device_id, area_id: areaId });
      const ent = await this._ws({ type: "config/entity_registry/get", entity_id: plug.entity_id });
      if (ent.area_id && ent.area_id !== areaId) {
        await this._ws({ type: "config/entity_registry/update", entity_id: plug.entity_id, area_id: null });
      }
    } else {
      await this._ws({ type: "config/entity_registry/update", entity_id: plug.entity_id, area_id: areaId });
    }
  }

  async _createRoom(name) {
    const area = await this._ws({ type: "config/area_registry/create", name: name.trim() });
    return area.area_id;
  }

  // ───────────── 底部面板 ─────────────

  _openSheet(sheet) {
    this._labelCache = null;
    this._sheet = sheet;
    this._renderSheet();
    if (sheet.type === "newroom") this._sheetHost.querySelector("[data-new-room-name]")?.focus();
  }

  _closeSheet() {
    this._sheet = null;
    this._sheetHost.innerHTML = "";
  }

  _startAssign() {
    const areas = this._hass.areas || {};
    const queue = this._plugs.filter((p) => !(p.area_id && areas[p.area_id])).sort(byName).map((p) => p.entity_id);
    if (queue.length) this._openSheet({ type: "assign", queue, index: 0 });
  }

  _roomChips(selected, attr) {
    return this._areas
      .map(
        (a) => `<button class="chip-btn ${a.area_id === selected ? "sel" : ""}" ${attr}="${esc(a.area_id)}">
          <ha-icon icon="${esc(a.icon || "mdi:home-outline")}"></ha-icon>${esc(a.name)}</button>`,
      )
      .join("");
  }

  _newRoomHtml(s) {
    return `<button class="chip-btn add" data-new-room><ha-icon icon="mdi:plus"></ha-icon>新房間</button>
      </div>
      ${s.newRoom ? `<div class="new-room"><input class="text" data-new-room-name placeholder="例如：書房" maxlength="30" enterkeyhint="done"><button class="btn primary" data-new-room-ok>加入</button></div>` : ""}`;
  }

  _renderSheet() {
    const s = this._sheet;
    if (!s) return;
    // 面板裡正在打字就不要重畫
    const active = this.shadowRoot.activeElement;
    if (s.rendered && active && active.tagName === "INPUT" && this._sheetHost.contains(active)) return;

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

  _sheetHead(title) {
    return `
      <div class="sheet-head">
        <div class="sheet-title">${title}</div>
        <button class="close" data-close aria-label="關閉"><ha-icon icon="mdi:close"></ha-icon></button>
      </div>`;
  }

  _plugSheet(s) {
    const p = this._plug(s.entityId);
    if (!p) return null;
    const area = s.area !== undefined ? s.area : p.area_id;
    return `
      ${this._sheetHead("插座設定")}
      <div class="field">
        <div class="field-label">名稱</div>
        <input class="text" data-name value="${esc(s.name ?? p.name)}" maxlength="40" enterkeyhint="done">
      </div>
      <div class="field">
        <div class="field-label">房間</div>
        <div class="chips">
          ${this._roomChips(area, "data-set-room")}
          ${this._newRoomHtml(s)}
      </div>
      <div class="field">
        <div class="field-label">選項</div>
        <div class="opt">
          <div class="row-text"><div class="row-label">常開</div><div class="row-desc">冰箱、網路設備：「全部關閉」和排程都不會關它</div></div>
          <label class="switch"><input type="checkbox" data-opt="${LABEL_KEEP_ON}" ${p.keep_on ? "checked" : ""} aria-label="常開"><span></span></label>
        </div>
        <div class="opt">
          <div class="row-text"><div class="row-label">夜間關閉</div><div class="row-desc">夜間排程的時間到了自動關掉</div></div>
          <label class="switch"><input type="checkbox" data-opt="${LABEL_NIGHT}" ${p.night ? "checked" : ""} aria-label="夜間關閉"><span></span></label>
        </div>
        ${p.mode === "metered" ? "" : `
        <div class="opt">
          <div class="row-text"><div class="row-label">大約耗電</div><div class="row-desc">這個插座沒有計量；填上電器的瓦數就能估算電費，不知道就留空</div></div>
          <div class="num"><input type="number" inputmode="decimal" data-watts value="${esc(p.watts ?? "")}" placeholder="—" min="0" step="1"><span class="unit">W</span></div>
        </div>`}
      </div>
      <div class="sheet-actions">
        <button class="btn primary" data-done>完成</button>
        <button class="btn" data-more><ha-icon icon="mdi:cog-outline"></ha-icon>Home Assistant 進階設定</button>
      </div>`;
  }

  _assignSheet(s) {
    const p = this._plug(s.queue[s.index]);
    if (!p) return null;
    const total = s.queue.length;
    return `
      ${this._sheetHead(`分配房間 <span class="row-desc">${s.index + 1} / ${total}</span>`)}
      <div class="progress"><div style="width:${(s.index / total) * 100}%"></div></div>
      <div class="wizard-name">${esc(p.name)}</div>
      <div class="wizard-q">這個插座在哪個房間？</div>
      <div class="chips big">
        ${this._roomChips(null, "data-pick-room")}
        ${this._newRoomHtml(s)}
      <div class="sheet-actions" style="margin-top:20px">
        <button class="btn" data-skip>先跳過</button>
      </div>`;
  }

  _newRoomSheet(s) {
    const p = this._plug(s.entityId);
    if (!p) return null;
    return `
      ${this._sheetHead("新房間")}
      <div class="field">
        <div class="field-label">房間名稱</div>
        <input class="text" data-new-room-name placeholder="例如：書房" maxlength="30" enterkeyhint="done">
      </div>
      <div class="desc" style="margin-bottom:16px">建立之後，「${esc(p.name)}」會放進這個房間。</div>
      <div class="sheet-actions">
        <button class="btn primary" data-new-room-ok>建立</button>
      </div>`;
  }

  _roomSheet(s) {
    const area = this._hass.areas?.[s.areaId];
    if (!area) return null;
    const count = this._plugs.filter((p) => p.area_id === s.areaId).length;
    return `
      ${this._sheetHead("房間設定")}
      <div class="field">
        <div class="field-label">名稱</div>
        <input class="text" data-room-name value="${esc(area.name)}" maxlength="30" enterkeyhint="done">
      </div>
      <div class="sheet-actions">
        <button class="btn primary" data-room-save>完成</button>
        <button class="btn danger" data-room-delete><ha-icon icon="mdi:delete-outline"></ha-icon>${s.confirmDelete ? `確定刪除？裡面 ${count} 個插座會回到「還沒分房間」` : "刪除這個房間"}</button>
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

    on("[data-backdrop]", "click", (el, e) => e.target === el && this._finishSheet());
    on("[data-close]", "click", () => this._finishSheet());
    on("[data-done]", "click", () => this._finishSheet());
    on("[data-more]", "click", () => {
      const entityId = s.entityId;
      this._finishSheet();
      this.dispatchEvent(new CustomEvent("hass-more-info", { detail: { entityId }, bubbles: true, composed: true }));
    });

    // 插座設定：改什麼就立刻存
    on("[data-name]", "input", (el) => (s.name = el.value));
    on("[data-name]", "keydown", (el, e) => e.key === "Enter" && el.blur());
    on("[data-name]", "change", (el) => run(() => this._setName(this._plug(s.entityId), el.value)));
    on("[data-set-room]", "click", (el) =>
      run(async () => {
        const p = this._plug(s.entityId);
        // 再點一次已選的房間 = 取消
        const areaId = el.dataset.setRoom === (s.area !== undefined ? s.area : p.area_id) ? null : el.dataset.setRoom;
        s.area = areaId;
        this._renderSheet();
        await this._setRoom(p, areaId);
      }),
    );
    on("[data-opt]", "change", (el) => run(() => this._setLabel(this._plug(s.entityId), el.dataset.opt, el.checked)));
    on("[data-watts]", "keydown", (el, e) => e.key === "Enter" && el.blur());
    on("[data-watts]", "change", (el) => run(() => this._setWatts(this._plug(s.entityId), parseFloat(el.value) || 0)));

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
        const areaId = await this._createRoom(name);
        s.newRoom = false;
        if (s.type === "assign") {
          await this._pickRoom(areaId);
        } else if (s.type === "newroom") {
          const p = this._plug(s.entityId);
          this._closeSheet();
          if (p) await this._moveTo(p, areaId);
        } else {
          s.area = areaId;
          this._renderSheet();
          await this._setRoom(this._plug(s.entityId), areaId);
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
        const area = this._hass.areas?.[s.areaId];
        if (name && area && name !== area.name) {
          await this._ws({ type: "config/area_registry/update", area_id: s.areaId, name });
        }
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
        await this._ws({ type: "config/area_registry/delete", area_id: s.areaId });
        this._closeSheet();
        this._showToast("已刪除房間");
      }),
    );
  }

  async _pickRoom(areaId) {
    const s = this._sheet;
    const p = this._plug(s.queue[s.index]);
    this._nextAssign();
    if (p) await this._setRoom(p, areaId);
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
      const p = this._plug(s.entityId);
      const nameInput = this._sheetHost.querySelector("[data-name]");
      if (p && nameInput) this._safe(() => this._setName(p, nameInput.value));
      const w = this._sheetHost.querySelector("[data-watts]");
      if (p && w && w === this.shadowRoot.activeElement) this._safe(() => this._setWatts(p, parseFloat(w.value) || 0));
    }
    this._closeSheet();
  }
}

customElements.define("power-hub-card", PowerHubCard);
window.customCards = window.customCards || [];
window.customCards.push({ type: "power-hub-card", name: "用電總覽", description: "power_hub 的總覽、各房間插座、排程與設定" });

// ── 儀表板：卡片加上圖表 ──

const chartSections = (plugs) => {
  const metered = plugs.filter((p) => p.mode === "metered");
  const sections = [];
  const energy = metered.filter((p) => p.energy_entity);
  if (energy.length) {
    sections.push({
      type: "grid",
      cards: [
        { type: "heading", heading: "每日用電（近 14 天）", icon: "mdi:chart-bar" },
        {
          type: "statistics-graph",
          chart_type: "bar",
          period: "day",
          days_to_show: 14,
          stat_types: ["change"],
          entities: energy.map((p) => ({ entity: p.energy_entity, name: p.name })),
          grid_options: { columns: "full" },
        },
      ],
    });
  }
  if (metered.length) {
    sections.push({
      type: "grid",
      cards: [
        { type: "heading", heading: "功率（近 24 小時）", icon: "mdi:chart-line" },
        {
          type: "history-graph",
          hours_to_show: 24,
          entities: metered.map((p) => ({ entity: p.power_entity, name: p.name })),
          grid_options: { columns: "full" },
        },
      ],
    });
  }
  return sections;
};

class PowerDashboardStrategy extends HTMLElement {
  static async generate(config, hass) {
    const plugs = hass.states[MANAGED]?.attributes.plugs || [];
    const card = (view) => ({
      type: "grid",
      column_span: 2,
      cards: [{ type: "custom:power-hub-card", view, grid_options: { columns: "full" } }],
    });
    return {
      title: "用電",
      views: [
        {
          title: "用電",
          path: "power",
          icon: "mdi:flash",
          type: "sections",
          max_columns: 2,
          sections: [card("plugs"), ...chartSections(plugs), card("settings")],
        },
      ],
    };
  }
}

customElements.define("ll-strategy-dashboard-power-dashboard", PowerDashboardStrategy);

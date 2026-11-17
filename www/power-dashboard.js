// 自動產生的用電儀表板
//
// 讀取 power_hub 偵測到的插座（sensor.plugs_managed 的 plugs 屬性），依 Home Assistant 的
// 「區域」分區排版。新插座加入、換區域、貼標籤之後畫面會自己更新，不用改這個檔案。
//
// 用法：configuration.yaml 的 frontend: extra_module_url 載入這個檔案，
// 再新增一個儀表板，原始設定只寫：
//   strategy:
//     type: custom:power-dashboard
//
// 這個檔案定義兩個東西：
//   power-hub-card：總覽和各區域插座的卡片（自己畫，不用內建磚塊）
//   power-dashboard：儀表板策略，把 power-hub-card 和圖表、排程、設定排在一起

const MANAGED = "sensor.plugs_managed";
const UNASSIGNED = "__unassigned__";
const CONFIRM_MS = 4000;
const HOLD_MS = 500;

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const num = (hass, id) => {
  const v = parseFloat(hass.states[id]?.state);
  return Number.isFinite(v) ? v : null;
};

const fmt = (v, digits = 0) =>
  v === null ? "—" : v.toLocaleString("zh-TW", { minimumFractionDigits: digits, maximumFractionDigits: digits });

const fmtWatts = (w) => (w === null ? "—" : w >= 1000 ? `${fmt(w / 1000, 2)} kW` : `${fmt(w, w < 10 ? 1 : 0)} W`);

const STYLE = `
  :host {
    --ph-on: var(--power-hub-on-color, #f59e0b);
    --ph-danger: var(--error-color, #db4437);
    --ph-card: var(--ha-card-background, var(--card-background-color, #fff));
    --ph-text: var(--primary-text-color, #1c1c1e);
    --ph-muted: var(--secondary-text-color, #6b7280);
    --ph-line: var(--divider-color, rgba(0, 0, 0, 0.08));
    --ph-radius: var(--ha-card-border-radius, 16px);
    display: block;
    color: var(--ph-text);
    -webkit-tap-highlight-color: transparent;
  }
  * { box-sizing: border-box; }
  .wrap { display: grid; gap: 12px; }
  .block {
    background: var(--ph-card);
    border-radius: var(--ph-radius);
    border: var(--ha-card-border-width, 1px) solid var(--ha-card-border-color, var(--ph-line));
    box-shadow: var(--ha-card-box-shadow, none);
  }

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
  .note { font-size: 13px; color: var(--ph-muted); margin-top: 4px; }
  .pill {
    flex: none; font-size: 13px; font-weight: 500; padding: 6px 10px; border-radius: 999px;
    background: color-mix(in srgb, var(--ph-on) 16%, transparent); color: var(--ph-text);
    display: inline-flex; align-items: center; gap: 6px; white-space: nowrap;
  }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--ph-on); }
  .stats { display: grid; grid-template-columns: repeat(3, 1fr); margin-top: 18px; border-top: 1px solid var(--ph-line); padding-top: 14px; }
  .stat { padding: 0 4px; }
  .stat + .stat { border-left: 1px solid var(--ph-line); padding-left: 12px; }
  .stat-label { font-size: 12px; color: var(--ph-muted); }
  .stat-value { font-size: 18px; font-weight: 600; margin-top: 2px; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .stat-value small { font-size: 12px; font-weight: 500; color: var(--ph-muted); margin-left: 2px; }

  /* 按鈕 */
  .actions { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 8px; margin-top: 16px; }
  button {
    font: inherit; color: inherit; border: 0; cursor: pointer; -webkit-tap-highlight-color: transparent;
  }
  .btn {
    display: flex; align-items: center; justify-content: center; gap: 8px;
    height: 44px; border-radius: 12px; font-size: 15px; font-weight: 500;
    background: color-mix(in srgb, var(--ph-text) 6%, transparent);
    transition: background 0.15s, color 0.15s, transform 0.1s;
  }
  .btn ha-icon { --mdc-icon-size: 20px; }
  .btn:active { transform: scale(0.98); }
  .btn.confirm { background: var(--ph-danger); color: #fff; }
  .btn:disabled { opacity: 0.4; cursor: default; }

  /* 提示 */
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

  /* 區域 */
  .rooms { display: grid; gap: 12px; grid-template-columns: repeat(auto-fill, minmax(min(100%, 340px), 1fr)); align-items: start; }
  .room { padding: 14px 14px 14px; }
  .room-head { display: flex; align-items: center; gap: 10px; padding: 2px 2px 12px; }
  .room-icon {
    width: 32px; height: 32px; border-radius: 10px; display: grid; place-items: center; flex: none;
    background: color-mix(in srgb, var(--ph-text) 6%, transparent); color: var(--ph-muted);
  }
  .room-icon ha-icon { --mdc-icon-size: 18px; }
  .room-title { flex: 1; min-width: 0; }
  .room-name { font-size: 16px; font-weight: 600; }
  .room-sub { font-size: 12px; color: var(--ph-muted); margin-top: 1px; }
  .room-off {
    font-size: 13px; font-weight: 500; padding: 6px 12px; border-radius: 999px;
    background: color-mix(in srgb, var(--ph-text) 6%, transparent); white-space: nowrap;
  }
  .room-off.confirm { background: var(--ph-danger); color: #fff; }
  .hint { font-size: 13px; color: var(--ph-muted); margin: -4px 2px 12px; line-height: 1.45; }

  /* 插座 */
  .plugs { display: grid; gap: 8px; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); }
  .plug {
    position: relative; text-align: left; padding: 12px; border-radius: 14px; min-height: 96px;
    display: flex; flex-direction: column; justify-content: space-between; gap: 10px;
    background: color-mix(in srgb, var(--ph-text) 4%, transparent);
    transition: background 0.2s, transform 0.1s, opacity 0.2s;
    user-select: none; -webkit-user-select: none; touch-action: manipulation;
  }
  .plug:active { transform: scale(0.97); }
  .plug.on { background: color-mix(in srgb, var(--ph-on) 16%, transparent); }
  .plug.off-line { opacity: 0.55; }
  .plug.pending { opacity: 0.7; }
  .plug-top { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
  .knob {
    width: 36px; height: 36px; border-radius: 50%; display: grid; place-items: center; flex: none;
    background: color-mix(in srgb, var(--ph-text) 8%, transparent); color: var(--ph-muted);
    transition: background 0.2s, color 0.2s, box-shadow 0.2s;
  }
  .knob ha-icon { --mdc-icon-size: 20px; }
  .plug.on .knob { background: var(--ph-on); color: #fff; box-shadow: 0 4px 14px color-mix(in srgb, var(--ph-on) 45%, transparent); }
  .chip {
    font-size: 11px; font-weight: 500; padding: 2px 7px; border-radius: 999px;
    background: color-mix(in srgb, var(--ph-text) 8%, transparent); color: var(--ph-muted); white-space: nowrap;
  }
  .plug-name {
    font-size: 15px; font-weight: 600; line-height: 1.3;
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; word-break: break-all;
  }
  .plug-state { font-size: 13px; color: var(--ph-muted); margin-top: 2px; font-variant-numeric: tabular-nums; }
  .plug.on .plug-state { color: var(--ph-text); }

  .empty { padding: 20px; color: var(--ph-muted); font-size: 14px; text-align: center; }
`;

class PowerHubCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._confirm = null; // 正在等第二次確認的按鈕
    this._pending = new Set(); // 剛按下、還沒收到新狀態的插座
  }

  setConfig(config) {
    this._config = config || {};
  }

  getCardSize() {
    return 10;
  }

  getGridOptions() {
    return { columns: "full" };
  }

  set hass(hass) {
    this._hass = hass;
    const sig = this._signature();
    if (sig !== this._sig) {
      this._sig = sig;
      this._render();
    }
  }

  _plugs() {
    return this._hass.states[MANAGED]?.attributes.plugs || [];
  }

  // 只有相關的狀態變了才重畫，避免整個家裡任何感測器一動就重畫
  _signature() {
    const h = this._hass;
    const ids = [
      MANAGED, "sensor.plugs_power", "sensor.plugs_energy_daily", "sensor.plugs_cost_daily",
      "sensor.plugs_cost_monthly", "sensor.plugs_discovered", "sensor.plugs_offline", "sensor.plugs_standby",
    ];
    const parts = ids.map((id) => {
      const s = h.states[id];
      return s ? `${s.state}|${JSON.stringify(s.attributes.names || s.attributes.plugs || "")}` : "";
    });
    for (const p of this._plugs()) {
      parts.push(h.states[p.entity_id]?.state, p.power_entity && h.states[p.power_entity]?.state);
    }
    const areas = h.areas || {};
    parts.push(Object.values(areas).map((a) => `${a.area_id}:${a.name}:${a.icon}`).join(","));
    parts.push(this._confirm, [...this._pending].join(","));
    return parts.join("~");
  }

  _render() {
    const h = this._hass;
    if (!h) return;
    const plugs = this._plugs();
    const root = this.shadowRoot;

    if (!h.states[MANAGED]) {
      root.innerHTML = `<style>${STYLE}</style><div class="block empty">找不到 power_hub：確認 configuration.yaml 有 <code>power_hub:</code> 並重新啟動。</div>`;
      return;
    }

    const isOn = (p) => h.states[p.entity_id]?.state === "on";
    const isOffline = (p) => {
      const s = h.states[p.entity_id]?.state;
      return s === undefined || s === "unavailable" || s === "unknown";
    };
    const onCount = plugs.filter(isOn).length;
    const measured = plugs.some((p) => p.mode === "metered" || p.mode === "estimated");
    const metered = plugs.some((p) => p.mode === "metered");

    // ── 總覽 ──
    let hero;
    if (measured) {
      const w = num(h, "sensor.plugs_power");
      const [value, unit] = fmtWatts(w).split(" ");
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
        <div class="note">這些插座沒有用電計量。幫插座貼上「9W」這類瓦數標籤，就能估算用電和電費。</div>`;
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

    const offKey = "all";
    const standbyKey = "standby";
    const anyOn = onCount > 0;
    const standbyCount = num(h, "sensor.plugs_standby") || 0;
    const actions = `
      <div class="actions">
        <button class="btn ${this._confirm === offKey ? "confirm" : ""}" data-off="${offKey}" ${anyOn ? "" : "disabled"}>
          <ha-icon icon="mdi:power"></ha-icon>${this._confirm === offKey ? "再按一次，全部關閉" : "全部關閉"}
        </button>
        ${metered ? `
        <button class="btn" data-off="${standbyKey}" ${standbyCount ? "" : "disabled"}>
          <ha-icon icon="mdi:power-sleep"></ha-icon>關閉待機${standbyCount ? ` ${standbyCount} 個` : ""}
        </button>` : ""}
      </div>`;

    // ── 區域 ──
    const areas = h.areas || {};
    const byArea = new Map();
    for (const p of plugs) {
      const key = p.area_id && areas[p.area_id] ? p.area_id : UNASSIGNED;
      if (!byArea.has(key)) byArea.set(key, []);
      byArea.get(key).push(p);
    }
    const order = [...byArea.keys()]
      .filter((id) => id !== UNASSIGNED)
      .sort((a, b) => areas[a].name.localeCompare(areas[b].name, "zh-Hant"));
    if (byArea.has(UNASSIGNED)) order.push(UNASSIGNED);

    const plugTile = (p) => {
      const on = isOn(p);
      const off = isOffline(p);
      let state = off ? "離線" : on ? "開啟" : "關閉";
      if (on && p.mode === "metered") state += ` · ${fmtWatts(num(h, p.power_entity))}`;
      if (on && p.mode === "estimated") state += ` · 約 ${fmtWatts(p.watts)}`;
      const chip = p.keep_on ? "常開" : p.night ? "夜間關" : "";
      const cls = ["plug", on ? "on" : "", off ? "off-line" : "", this._pending.has(p.entity_id) ? "pending" : ""].join(" ");
      return `
        <button class="${cls}" data-plug="${esc(p.entity_id)}" aria-pressed="${on}" title="點一下開關，按住看詳細資料">
          <div class="plug-top">
            <div class="knob"><ha-icon icon="${off ? "mdi:power-plug-off-outline" : on ? "mdi:power-plug" : "mdi:power-plug-outline"}"></ha-icon></div>
            ${chip ? `<span class="chip">${chip}</span>` : ""}
          </div>
          <div>
            <div class="plug-name">${esc(p.name)}</div>
            <div class="plug-state">${state}</div>
          </div>
        </button>`;
    };

    const rooms = order.map((id) => {
      const list = byArea.get(id).slice().sort((a, b) => a.name.localeCompare(b.name, "zh-Hant"));
      const area = areas[id];
      const name = area ? area.name : "未分區";
      const icon = (area && area.icon) || (area ? "mdi:home-outline" : "mdi:tag-outline");
      const roomOn = list.filter(isOn).length;
      const canOff = list.some((p) => isOn(p) && !p.keep_on);
      const key = `area:${id}`;
      const offBtn = id !== UNASSIGNED && canOff
        ? `<button class="room-off ${this._confirm === key ? "confirm" : ""}" data-off="${esc(key)}">${this._confirm === key ? "確定關閉？" : "全關"}</button>`
        : "";
      return `
        <section class="block room">
          <div class="room-head">
            <div class="room-icon"><ha-icon icon="${esc(icon)}"></ha-icon></div>
            <div class="room-title">
              <div class="room-name">${esc(name)}</div>
              <div class="room-sub">${roomOn ? `${roomOn} 個開著` : "全部關閉"} · 共 ${list.length} 個</div>
            </div>
            ${offBtn}
          </div>
          ${id === UNASSIGNED ? `<div class="hint">按住插座 → 右上角齒輪 → 區域，就會分到該房間。</div>` : ""}
          <div class="plugs">${list.map(plugTile).join("")}</div>
        </section>`;
    });

    root.innerHTML = `
      <style>${STYLE}</style>
      <div class="wrap">
        <section class="block hero">${hero}${alerts.join("")}${actions}</section>
        ${plugs.length ? `<div class="rooms">${rooms.join("")}</div>` : `<div class="block empty">還沒有插座。到「設定 → 裝置與服務」加入插座後會自動出現在這裡。</div>`}
      </div>`;
    this._bind();
  }

  _bind() {
    const root = this.shadowRoot;
    root.querySelectorAll("[data-plug]").forEach((el) => this._bindPlug(el, el.dataset.plug));
    root.querySelectorAll("[data-off]").forEach((el) =>
      el.addEventListener("click", () => this._turnOff(el.dataset.off)),
    );
    root.querySelectorAll("a[data-nav]").forEach((a) =>
      a.addEventListener("click", (ev) => {
        ev.preventDefault();
        history.pushState(null, "", a.getAttribute("href"));
        window.dispatchEvent(new CustomEvent("location-changed"));
      }),
    );
  }

  // 點一下開關，按住開詳細資料（可以在那裡改名稱、區域、標籤）
  _bindPlug(el, entityId) {
    let timer = null;
    let held = false;
    const start = () => {
      held = false;
      timer = setTimeout(() => {
        held = true;
        this._moreInfo(entityId);
      }, HOLD_MS);
    };
    const cancel = () => clearTimeout(timer);
    el.addEventListener("pointerdown", start);
    el.addEventListener("pointerup", cancel);
    el.addEventListener("pointerleave", cancel);
    el.addEventListener("pointercancel", cancel);
    el.addEventListener("contextmenu", (ev) => ev.preventDefault());
    el.addEventListener("click", () => {
      if (held) return;
      this._toggle(entityId);
    });
  }

  _toggle(entityId) {
    const s = this._hass.states[entityId]?.state;
    if (s !== "on" && s !== "off") {
      this._moreInfo(entityId);
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

  // 關閉類的按鈕按第一次變紅色，幾秒內再按一次才真的關
  _turnOff(key) {
    if (key === "standby") {
      this._hass.callService("power_hub", "turn_off", { standby_only: true });
      return;
    }
    if (this._confirm !== key) {
      this._confirm = key;
      clearTimeout(this._confirmTimer);
      this._confirmTimer = setTimeout(() => {
        this._confirm = null;
        this._refresh();
      }, CONFIRM_MS);
      this._refresh();
      return;
    }
    this._confirm = null;
    clearTimeout(this._confirmTimer);
    const data = key.startsWith("area:") ? { area: key.slice(5) } : {};
    this._hass.callService("power_hub", "turn_off", data);
    this._refresh();
  }

  _moreInfo(entityId) {
    this.dispatchEvent(new CustomEvent("hass-more-info", { detail: { entityId }, bubbles: true, composed: true }));
  }

  _refresh() {
    this._sig = null;
    if (this._hass) this.hass = this._hass;
  }
}

customElements.define("power-hub-card", PowerHubCard);
window.customCards = window.customCards || [];
window.customCards.push({ type: "power-hub-card", name: "用電總覽", description: "power_hub 的總覽和各區域插座" });

// ── 儀表板其他區塊：用 Home Assistant 內建卡片 ──

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

const scheduleSection = (plugs) => {
  const night = plugs.filter((p) => p.night && !p.keep_on).map((p) => p.name);
  return {
    type: "grid",
    cards: [
      { type: "heading", heading: "夜間排程", icon: "mdi:weather-night" },
      {
        type: "entities",
        entities: [
          { entity: "input_boolean.power_schedule", name: "啟用" },
          { entity: "input_datetime.power_night_off", name: "晚上關閉" },
          { entity: "input_datetime.power_morning_on", name: "早上打開" },
        ],
        grid_options: { columns: "full" },
      },
      {
        type: "markdown",
        content: night.length
          ? `會關閉：${night.join("、")}`
          : "還沒有插座要夜間關閉：按住插座 → 齒輪 → 標籤，貼上「夜間關閉」。",
        grid_options: { columns: "full" },
      },
    ],
  };
};

const settingsSection = (plugs) => {
  const count = (mode) => plugs.filter((p) => p.mode === mode).length;
  return {
    type: "grid",
    cards: [
      { type: "heading", heading: "設定", icon: "mdi:cog-outline" },
      {
        type: "entities",
        entities: [
          { entity: "input_number.household_monthly_kwh" },
          { entity: "sensor.power_price" },
          { type: "attribute", entity: "sensor.power_price", attribute: "season", name: "目前季節", icon: "mdi:sun-thermometer" },
          { entity: "input_number.standby_threshold" },
          { entity: "input_number.overload_threshold" },
        ],
        grid_options: { columns: "full" },
      },
      {
        type: "markdown",
        content:
          `偵測到 ${plugs.length} 個插座：有計量 ${count("metered")}、估算 ${count("estimated")}、只有開關 ${count("switch")}。\n\n` +
          "標籤：「常開」不會被關、「夜間關閉」夜間排程、「9W」這種瓦數估算用電、「不管理」不納入。",
        grid_options: { columns: "full" },
      },
    ],
  };
};

class PowerDashboardStrategy extends HTMLElement {
  static async generate(config, hass) {
    const plugs = hass.states[MANAGED]?.attributes.plugs || [];
    const sections = [
      { type: "grid", column_span: 2, cards: [{ type: "custom:power-hub-card", grid_options: { columns: "full" } }] },
      ...chartSections(plugs),
      scheduleSection(plugs),
      settingsSection(plugs),
    ];
    return {
      title: "用電",
      views: [{ title: "用電", path: "power", icon: "mdi:flash", type: "sections", max_columns: 2, sections }],
    };
  }
}

customElements.define("ll-strategy-dashboard-power-dashboard", PowerDashboardStrategy);

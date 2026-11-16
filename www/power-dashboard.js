// 自動產生的用電儀表板
//
// 讀取 power_hub 偵測到的插座（sensor.plugs_managed 的 plugs 屬性），依 Home Assistant 的
// 「區域」分區排版。新插座加入、換區域、貼標籤之後，重新整理頁面就會更新，不用改這個檔案。
//
// 用法：configuration.yaml 的 frontend: extra_module_url 載入這個檔案，
// 再新增一個儀表板，原始設定只寫：
//   strategy:
//     type: custom:power-dashboard

const MANAGED = "sensor.plugs_managed";
const UNASSIGNED = "__unassigned__";

const toggleTile = (plug) => {
  let name = plug.name;
  if (plug.mode === "estimated") name += `（估算 ${plug.watts} W）`;
  if (plug.keep_on) name += "・常開";
  return {
    type: "tile",
    entity: plug.entity_id,
    name,
    // 點圖示開關，點其他地方看詳細資料
    icon_tap_action: { action: "toggle" },
  };
};

const actionTile = (name, icon, data, confirmation) => {
  const action = {
    action: "perform-action",
    perform_action: "power_hub.turn_off",
    data,
  };
  if (confirmation) action.confirmation = { text: confirmation };
  return {
    type: "tile",
    entity: MANAGED,
    name,
    icon,
    hide_state: true,
    tap_action: action,
    icon_tap_action: action,
  };
};

const alert = (entity, type, template) => ({
  type: "markdown",
  content: `<ha-alert alert-type="${type}">${template}</ha-alert>`,
  visibility: [{ condition: "numeric_state", entity, above: 0 }],
  grid_options: { columns: "full" },
});

const overviewSection = () => ({
  type: "grid",
  cards: [
    { type: "heading", heading: "總覽" },
    alert(
      "sensor.plugs_discovered",
      "info",
      "區網發現新裝置：{{ state_attr('sensor.plugs_discovered', 'names') | join('、') }}。" +
        "到<a href=\"/config/integrations/dashboard\">設定 → 裝置與服務</a>按「新增」",
    ),
    alert(
      "sensor.plugs_offline",
      "warning",
      "連不上：{{ state_attr('sensor.plugs_offline', 'names') | join('、') }}",
    ),
    { type: "tile", entity: "sensor.plugs_power", name: "目前總功率" },
    { type: "tile", entity: "sensor.plugs_energy_daily", name: "今日用電" },
    { type: "tile", entity: "sensor.plugs_cost_daily", name: "今日電費" },
    { type: "tile", entity: "sensor.plugs_cost_monthly", name: "本月電費" },
    actionTile("全部關閉", "mdi:power-plug-off", {}, "要關閉所有插座嗎？（常開插座不會關）"),
    actionTile("關閉待機中的", "mdi:power-sleep", { standby_only: true }),
  ],
});

const areaSection = (areaId, title, icon, plugs) => {
  const cards = [{ type: "heading", heading: title, icon }];
  if (areaId === UNASSIGNED) {
    cards.push({
      type: "markdown",
      content: "這些插座還沒設定區域：點插座 → 右上角齒輪 → 區域。",
      grid_options: { columns: "full" },
    });
  } else {
    cards.push({
      ...actionTile(`關閉${title}`, "mdi:power-plug-off", { area: areaId }, `要關閉${title}的插座嗎？（常開插座不會關）`),
      grid_options: { columns: "full" },
    });
  }
  // 有計量的插座：開關和功率排一列；其他的兩個開關排一列
  for (const plug of plugs.filter((p) => p.mode === "metered")) {
    cards.push(toggleTile(plug));
    cards.push({ type: "tile", entity: plug.power_entity, name: `${plug.name} 功率` });
  }
  for (const plug of plugs.filter((p) => p.mode !== "metered")) {
    cards.push(toggleTile(plug));
  }
  return { type: "grid", cards };
};

const chartSections = (plugs) => {
  const metered = plugs.filter((p) => p.mode === "metered");
  const sections = [];
  const energy = metered.filter((p) => p.energy_entity);
  if (energy.length) {
    sections.push({
      type: "grid",
      cards: [
        { type: "heading", heading: "每日用電（近 14 天）" },
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
        { type: "heading", heading: "功率（近 24 小時）" },
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
      { type: "heading", heading: "夜間排程" },
      {
        type: "entities",
        entities: [
          { entity: "input_boolean.power_schedule" },
          { entity: "input_datetime.power_night_off" },
          { entity: "input_datetime.power_morning_on" },
        ],
        grid_options: { columns: "full" },
      },
      {
        type: "markdown",
        content: night.length
          ? `會關閉：${night.join("、")}`
          : "還沒有插座要夜間關閉：幫插座貼「夜間關閉」標籤。",
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
      { type: "heading", heading: "設定" },
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
          `偵測到 ${plugs.length} 個插座：有計量 ${count("metered")}、估算 ${count("estimated")}、只有開關 ${count("switch")}。` +
          "標籤：「常開」不會被關、「夜間關閉」夜間排程、「9W」這種瓦數估算用電、「不管理」不納入。",
        grid_options: { columns: "full" },
      },
    ],
  };
};

class PowerDashboardStrategy extends HTMLElement {
  static async generate(config, hass) {
    const managed = hass.states[MANAGED];
    if (!managed) {
      return {
        title: "用電",
        views: [
          {
            title: "用電",
            cards: [
              {
                type: "markdown",
                content: "找不到 power_hub：確認 `custom_components/power_hub` 已複製，configuration.yaml 有 `power_hub:`，並重新啟動。",
              },
            ],
          },
        ],
      };
    }
    const plugs = managed.attributes.plugs || [];
    const areas = hass.areas || {};

    const byArea = new Map();
    for (const plug of plugs) {
      const key = plug.area_id && areas[plug.area_id] ? plug.area_id : UNASSIGNED;
      if (!byArea.has(key)) byArea.set(key, []);
      byArea.get(key).push(plug);
    }
    const areaIds = [...byArea.keys()]
      .filter((id) => id !== UNASSIGNED)
      .sort((a, b) => areas[a].name.localeCompare(areas[b].name, "zh-Hant"));
    if (byArea.has(UNASSIGNED)) areaIds.push(UNASSIGNED);

    const sections = [overviewSection()];
    for (const id of areaIds) {
      const area = areas[id];
      sections.push(
        areaSection(id, area ? area.name : "未分區", (area && area.icon) || (area ? "mdi:home" : "mdi:help-circle-outline"), byArea.get(id)),
      );
    }
    sections.push(...chartSections(plugs), scheduleSection(plugs), settingsSection(plugs));

    return {
      title: "用電",
      views: [{ title: "用電", path: "power", icon: "mdi:flash", type: "sections", max_columns: 2, sections }],
    };
  }
}

customElements.define("ll-strategy-dashboard-power-dashboard", PowerDashboardStrategy);

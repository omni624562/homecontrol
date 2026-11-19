// 伺服器 /api/state 的資料（只列畫面用到的欄位）

export type Protect = "" | "confirm_off" | "confirm" | "lock";

export interface Plug {
  id: string;
  name: string;
  room: string | null;
  is_on: boolean;
  online: boolean;
  power: number | null;
  watts: number | null;
  keep_on: boolean;
  protect: Protect;
  max_on_s: number | null;
  on_since: number | null;
  timer: number | null;
  standby: boolean;
  model?: string;
  kasa_name?: string;
  host?: string;
  device?: string;
  mode?: "metered" | "estimated";
  matter?: boolean;
  led?: boolean;
  rssi?: number | null;
  cloud?: boolean | null;
  native?: {
    ok: boolean;
    msg: string;
    schedule: number;
    kasa: KasaRule[];
    kasa_away?: KasaAway[];
  } | null;
  net?: {
    fw?: string;
    hw?: string;
    model?: string;
    ssid?: string;
    key_type?: number | null;
    cloud_bound?: boolean | null;
    fw_updates?: { version?: string }[];
    fw_check?: string;
  } | null;
}

export interface KasaRule {
  sact: number;
  opt: number;
  val: number;
  wday: number[];
  enable: number;
  repeat?: number;
  smin?: number;
}

export interface KasaAway {
  smin: number;
  emin: number;
  wday: number[];
  enable: number;
}

export type TimeMode = "clock" | "sunrise" | "sunset";

export interface Schedule {
  id: string;
  enabled: boolean;
  time: string;
  days: number[];
  action: "on" | "off" | "scene";
  scene: string | null;
  plugs: string[];
  restore_at: string | null;
  duration_s: number | null;
  backup: boolean;
  time_mode?: TimeMode;
  offset_min?: number;
  skip_holiday?: boolean;
  skip_rain?: boolean;
  today?: string | null;
  backup_status?: {
    total: number;
    ok: number;
    issues: { plug: string; reason: string; pending?: boolean }[];
    rules?: [number, number, number, number[]][];
  };
  skip_today?: string | null;
  skipped?: string | null;
}

export interface HabitSuggestion {
  key: string;
  plug: string;
  action: "on" | "off";
  time: string;
  days: number[];
  mode: TimeMode;
  offset_min: number;
  hits: number;
  of: number;
}

export interface Room {
  id: string;
  name: string;
  icon?: string;
}

export interface Scene {
  id: string;
  name: string;
  icon: string;
  actions?: Record<string, "on" | "off" | "keep">;
  others?: "keep" | "off";
}

export interface Person {
  id: string;
  name: string;
  macs: string[];
  home: boolean | null;
  since?: number;
}

export interface Hourly {
  t: string;
  temp: number | null;
  feels: number | null;
  pop: number | null;
  code: string | null;
  text: string | null;
  day: number;
}

export interface Daily {
  date: string;
  max: number | null;
  min: number | null;
  pop: number | null;
  code: string | null;
  text: string | null;
  uv: number | null;
}

export interface Weather {
  temp: number | null;
  feels: number | null;
  humidity: number | null;
  wind: number | null;
  obs_text: string | null;
  code: string | null;
  text: string | null;
  day: number;
  station: string | null;
  station_km: number | null;
  obs_at: string | null;
  rain: { station: string; km: number; today: number | null; past24h: number | null } | null;
  air: { site: string; km: number | null; aqi: number | null; status: string | null; pm25: number | null } | null;
  place: string | null;
  hourly: Hourly[];
  daily: Daily[];
  pop_today: number | null;
  pop_tomorrow: number | null;
  rain_mm: number;
  rain_pop: number;
  updated: number | null;
  error: string | null;
  air_key: boolean;
  air_error?: string | null;
}

export interface Truck {
  none?: boolean;
  car?: string;
  at?: string;
  at_stop?: string;
  stops?: number;
  m?: number;
  eta_min?: number;
}

export interface GarbageStop {
  lineid: string;
  line: string;
  rank: number;
  name: string;
  time: string;
  m?: number;
  memo?: string;
  days: Record<"garbage" | "recycling" | "foodscraps", number[]>;
}

export interface Outage {
  id: string;
  kind: "water" | "power";
  src: string;
  start: string;
  end: string;
  area: string;
  reason: string;
  hit: "road" | "town";
  pressure?: boolean;
}

export interface Local {
  garbage: {
    stop: GarbageStop;
    today: string[];
    next: { date: string; kinds: string[] }[];
    truck: Truck | null;
    watching: boolean;
    usual?: string; // 最近幾次實際到的時間（和表定差很多才有）
  } | null;
  stops: GarbageStop[];
  outages: Outage[];
  roads: string[];
  place: string | null;
  errors: Record<string, string>;
  updated: Record<string, number>;
  garbage_supported: boolean;
  garbage_notify: boolean;
  outage_notify: boolean;
  truck_rush?: boolean;
  truck_rush_style?: string;
  fun?: boolean;
}

export interface HubState {
  version: number;
  now: number;
  plugs: Plug[];
  rooms: Room[];
  scenes: Scene[];
  people: Person[];
  summary: { power: number | null; energy_today: number; cost_today: number; cost_month: number };
  settings: {
    long_on_hours?: number;
    away?: { enabled: boolean; start: string; end: string; plugs: string[] };
    [k: string]: unknown;
  };
  schedules: Schedule[];
  habits?: { suggestions: HabitSuggestion[]; days: number };
  sun?: { sunrise: number | null; sunset: number | null; located?: boolean };
  calendar: { holiday: string | null; day_off?: boolean; rain: string | null; weather: Weather | null; weather_show: boolean; local: Local };
  router?: { configured: boolean; ok: boolean; error?: string | null; ssids?: string[]; nodes?: { mac: string; model: string; ip: string; main: boolean }[] };
  assistant?: Assistant;
  notify?: { line: boolean; name: string; error: string | null };
  matter?: { online: boolean; commissioned: boolean; manual_code: string; qr_code: string; fabrics: { vendor: string; label: string }[]; plugs: number; running: boolean };
  net_events?: { start: number; end: number | null; ssid: string; devices: number }[];
}

// /api/energy：插座記錄的開機時間 × 瓦數
export interface EnergyPlug {
  id: string;
  name: string;
  watts: number | null;
  known: boolean;
  room: string | null;
  today_min: number;
  month_min: number;
  same_min: number;
  month_kwh: number;
  month_cost: number;
  days: number[];
  months: number[];
}

export interface Energy {
  price: number;
  season: string;
  day_of_month: number;
  month_days: number;
  today: { kwh: number; hours: number };
  month: { kwh: number; cost: number };
  projected: { kwh: number; cost: number };
  same_period: { kwh: number; cost: number };
  days: { day: string; kwh: number; hours: number }[];
  months: { month: string; kwh: number; hours: number; cost?: number }[];
  rooms: { name: string; kwh: number }[];
  plugs: EnergyPlug[];
  insights: { kind: string; plug?: string; text: string }[];
  updated: number;
}

export interface Assistant {
  configured: boolean;
  model: string;
  models: { id: string; name: string }[];
  month_usd: number;
  month_count: number;
  cap: number;
}

export interface AskAction {
  id: string;
  kind: "power" | "all_off" | "schedule" | "scene";
  label: string;
  plug?: string;
  on?: boolean;
  body?: unknown;
  state?: "done" | "skip" | "err";
  err?: string;
}

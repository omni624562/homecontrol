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
}

export interface Person {
  id: string;
  name: string;
  home: boolean;
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
}

export interface HubState {
  version: number;
  now: number;
  plugs: Plug[];
  rooms: Room[];
  scenes: Scene[];
  people: Person[];
  summary: { power: number | null; energy_today: number; cost_today: number; cost_month: number };
  settings: { long_on_hours?: number; [k: string]: unknown };
  calendar: { holiday: string | null; rain: string | null; weather: Weather | null; weather_show: boolean; local: Local };
  router?: { configured: boolean; ok: boolean; ssids?: string[] };
  assistant?: unknown;
}

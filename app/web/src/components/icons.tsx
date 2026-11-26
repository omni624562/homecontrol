import {
  AirVent, Bath, BatteryCharging, Bed, Building2, Cctv, Cloud, CloudDrizzle, CloudFog, CloudLightning, CloudMoon, CloudRain, CloudRainWind,
  CloudSnow, CloudSun, Coffee, CookingPot, Droplet, Fan, Fish, Flower2, Gamepad2, Heater, Home, Lamp, LampCeiling, LampDesk, LampFloor, LampWallUp,
  Laptop, Lightbulb, LogIn, LogOut, Microwave, Monitor, Moon, Printer, Refrigerator, Router, Sofa, Speaker, Sprout, Star, Sun,
  TreePine, Tv, WashingMachine,
  createLucideIcon, type LucideIcon,
} from "lucide-react";

// 牆上的插座（台灣式：兩個直孔＋下面半圓接地孔）；lucide 只有插頭，沒有插座
export const Outlet = createLucideIcon("outlet", [
  ["rect", { x: "3", y: "3", width: "18", height: "18", rx: "4", key: "o1" }],
  ["path", { d: "M9 8v4", key: "o2" }],
  ["path", { d: "M15 8v4", key: "o3" }],
  ["path", { d: "M10.5 17a1.5 1.5 0 0 1 3 0z", key: "o4" }],
]);

// LED 條燈：一條細長的燈帶＋往外放的光；lucide 沒有
export const LedStrip = createLucideIcon("led-strip", [
  ["rect", { x: "1.5", y: "13", width: "21", height: "5", rx: "2.5", key: "l1" }],
  ["path", { d: "M5 15.5h.01", key: "l2" }],
  ["path", { d: "M8.5 15.5h.01", key: "l3" }],
  ["path", { d: "M12 15.5h.01", key: "l4" }],
  ["path", { d: "M15.5 15.5h.01", key: "l5" }],
  ["path", { d: "M19 15.5h.01", key: "l6" }],
  ["path", { d: "M12 5v4", key: "l7" }],
  ["path", { d: "m5 6.5 2 3", key: "l8" }],
  ["path", { d: "m19 6.5-2 3", key: "l9" }],
]);

// 裝置可以自己選的圖示（代碼要跟後端 store.ICONS 一致）
export const DEVICE_ICONS: { key: string; label: string; group: "燈" | "家電" | "其他"; icon: LucideIcon }[] = [
  { key: "lamp-floor", label: "立燈", group: "燈", icon: LampFloor },
  { key: "lamp-desk", label: "檯燈", group: "燈", icon: LampDesk },
  { key: "lamp-ceiling", label: "吊燈", group: "燈", icon: LampCeiling },
  { key: "lamp-wall", label: "壁燈", group: "燈", icon: LampWallUp },
  { key: "led-strip", label: "LED 條燈", group: "燈", icon: LedStrip },
  { key: "bulb", label: "燈泡", group: "燈", icon: Lightbulb },
  { key: "sparkles", label: "裝飾燈", group: "燈", icon: Lamp },
  { key: "fan", label: "風扇", group: "家電", icon: Fan },
  { key: "aircon", label: "冷氣", group: "家電", icon: AirVent },
  { key: "heater", label: "電暖器", group: "家電", icon: Heater },
  { key: "tv", label: "電視", group: "家電", icon: Tv },
  { key: "monitor", label: "螢幕", group: "家電", icon: Monitor },
  { key: "laptop", label: "電腦", group: "家電", icon: Laptop },
  { key: "speaker", label: "音響", group: "家電", icon: Speaker },
  { key: "game", label: "遊戲機", group: "家電", icon: Gamepad2 },
  { key: "router", label: "路由器", group: "家電", icon: Router },
  { key: "rice", label: "電鍋", group: "家電", icon: CookingPot },
  { key: "microwave", label: "微波爐", group: "家電", icon: Microwave },
  { key: "coffee", label: "咖啡機", group: "家電", icon: Coffee },
  { key: "fridge", label: "冰箱", group: "家電", icon: Refrigerator },
  { key: "washer", label: "洗衣機", group: "家電", icon: WashingMachine },
  { key: "water-heater", label: "熱水器", group: "家電", icon: Bath },
  { key: "printer", label: "印表機", group: "家電", icon: Printer },
  { key: "water", label: "澆水", group: "其他", icon: Droplet },
  { key: "plant", label: "植物", group: "其他", icon: Sprout },
  { key: "fish", label: "魚缸", group: "其他", icon: Fish },
  { key: "tree", label: "聖誕樹", group: "其他", icon: TreePine },
  { key: "charge", label: "充電", group: "其他", icon: BatteryCharging },
  { key: "camera", label: "攝影機", group: "其他", icon: Cctv },
  { key: "outlet", label: "插座", group: "其他", icon: Outlet },
];

// 依名稱猜圖示的代碼（照順序，先對到的算）
const GUESS: [RegExp, string][] = [
  [/立燈|落地燈|floor|standing/, "lamp-floor"],
  [/檯燈|台燈|desk/, "lamp-desk"],
  [/吊燈|ceiling|pendant/, "lamp-ceiling"],
  [/壁燈|wall/, "lamp-wall"],
  [/聖誕|xmas|christmas/, "tree"],
  [/燈條|條燈|燈帶|led|strip/, "led-strip"],
  [/燈|lamp|light/, "bulb"],
  [/風扇|電扇|fan/, "fan"],
  [/冷氣|空調|aircon|air con/, "aircon"],
  [/電暖|暖氣|heater/, "heater"],
  [/電視|tv/, "tv"],
  [/螢幕|screen|monitor/, "monitor"],
  [/電腦|筆電|laptop|pc/, "laptop"],
  [/音響|喇叭|speaker/, "speaker"],
  [/遊戲|game|ps5/, "game"],
  [/路由|分享器|router|modem/, "router"],
  [/電鍋|rice|cooker/, "rice"],
  [/微波|microwave/, "microwave"],
  [/咖啡|coffee/, "coffee"],
  [/冰箱|fridge/, "fridge"],
  [/洗衣|washer/, "washer"],
  [/熱水器|water heater/, "water-heater"],
  [/印表|printer/, "printer"],
  [/澆水|water/, "water"],
  [/植物|plant|grow/, "plant"],
  [/魚缸|水族|fish|aquarium/, "fish"],
  [/充電|charg/, "charge"],
  [/攝影|camera|cam\b/, "camera"],
];
export const guessIcon = (name: string) => GUESS.find(([re]) => re.test(name.toLowerCase()))?.[1] || "outlet";
const BY_KEY = Object.fromEntries(DEVICE_ICONS.map((d) => [d.key, d]));

// 裝置的圖示：自己選的優先，沒選就照名稱猜
export function deviceIcon(d: string | { name: string; icon?: string | null }): LucideIcon {
  const name = typeof d === "string" ? d : d.name;
  const pick = typeof d === "string" ? null : d.icon;
  return (pick && BY_KEY[pick]?.icon) || BY_KEY[guessIcon(name)].icon;
}

// 舊版存的是 MDI 圖示名稱：換成對應的 lucide 圖示
const MDI: Record<string, LucideIcon> = {
  "mdi:sofa": Sofa, "mdi:bed": Bed, "mdi:bed-king": Bed, "mdi:silverware-fork-knife": CookingPot, "mdi:stove": CookingPot,
  "mdi:flower": Flower2, "mdi:flower-outline": Flower2, "mdi:home": Home, "mdi:home-outline": Home,
  "mdi:logout": LogOut, "mdi:login": LogIn, "mdi:weather-night": Moon, "mdi:white-balance-sunny": Sun,
  "mdi:television": Tv, "mdi:lightbulb": Lightbulb, "mdi:star-outline": Star,
};
export const mdiIcon = (name?: string, fallback: LucideIcon = Building2): LucideIcon => (name && MDI[name]) || fallback;

// 氣象署的天氣文字、代碼 → 圖示（晚上換月亮）
export function weatherIcon(code?: string | null, text?: string | null, day = 1): LucideIcon {
  const c = Number(code) || 0;
  const t = String(text || "");
  if (/雷/.test(t) || [15, 16, 17, 18, 21, 22, 33, 34, 35, 36, 41].includes(c)) return CloudLightning;
  if (/雪/.test(t) || [23, 37, 42].includes(c)) return CloudSnow;
  if (/大雨|豪雨/.test(t)) return CloudRainWind;
  if (/毛毛雨/.test(t)) return CloudDrizzle;
  if (/雨/.test(t) || (c >= 8 && c <= 14) || c === 19 || c === 20 || (c >= 29 && c <= 32)) return CloudRain;
  if (/霧|靄/.test(t) || (c >= 24 && c <= 28)) return CloudFog;
  if (/陰/.test(t) || c === 6 || c === 7) return Cloud;
  if (/多雲/.test(t) || (c >= 2 && c <= 5)) return day ? CloudSun : CloudMoon;
  if (/晴/.test(t) || c === 1) return day ? Sun : Moon;
  return Cloud;
}

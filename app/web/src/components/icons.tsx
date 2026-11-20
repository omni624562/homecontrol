import {
  Bed, Building2, Cloud, CloudDrizzle, CloudFog, CloudLightning, CloudMoon, CloudRain, CloudRainWind, CloudSnow, CloudSun,
  CookingPot, Droplet, Fan, Flower2, Home, Laptop, Lightbulb, LogIn, LogOut, Moon, Plug, Sofa, Star, Sun, Tv,
  type LucideIcon,
} from "lucide-react";

// 依名稱猜插座的圖示
export function deviceIcon(name: string): LucideIcon {
  const n = name.toLowerCase();
  if (/燈|lamp|light/.test(n)) return Lightbulb;
  if (/風扇|電扇|fan/.test(n)) return Fan;
  if (/電視|tv|螢幕|screen|monitor/.test(n)) return Tv;
  if (/澆水|water/.test(n)) return Droplet;
  if (/電腦|筆電|laptop|pc/.test(n)) return Laptop;
  return Plug;
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

import { useSyncExternalStore } from "react";

// 手機、平板的選單：左上角「☰」側邊選單，或下方分頁（第 5 格「更多」放其他頁）。存在這台裝置上
export type NavStyle = "menu" | "tabs";
const KEY = "mobile-nav";
const listeners = new Set<() => void>();
let mem: NavStyle | null = null; // 存不了的時候記在這裡

function read(): NavStyle {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "menu" || v === "tabs") return v;
  } catch {
    // 無痕視窗之類
  }
  return mem ?? "menu";
}

export function setNavStyle(v: NavStyle) {
  mem = v;
  try {
    localStorage.setItem(KEY, v);
  } catch {
    // 這次開著的期間有效
  }
  listeners.forEach((f) => f());
}

function subscribe(f: () => void) {
  listeners.add(f);
  const onStorage = (e: StorageEvent) => { if (e.key === KEY || e.key === BAR_KEY) f(); };
  addEventListener("storage", onStorage);
  return () => { listeners.delete(f); removeEventListener("storage", onStorage); };
}

export function useNavStyle(): NavStyle {
  return useSyncExternalStore(subscribe, read, () => "menu");
}

// 下方分頁要直接放哪幾頁（最多 4 個，其他放進「更多」）；照主選單的順序排
const BAR_KEY = "mobile-tabs";
export const BAR_MAX = 4;
export const BAR_DEFAULT = ["plugs", "life", "map", "energy"];
let barMem: string | null = null;
let barCache: { raw: string | null; val: string[] } = { raw: null, val: BAR_DEFAULT };

function readBar(): string[] {
  let raw: string | null = barMem;
  try {
    raw = localStorage.getItem(BAR_KEY) ?? barMem;
  } catch {
    // 無痕視窗之類
  }
  if (raw === barCache.raw) return barCache.val; // 同一份資料回傳同一個陣列（useSyncExternalStore 要求）
  let val = BAR_DEFAULT;
  try {
    const v = JSON.parse(raw || "null");
    if (Array.isArray(v) && v.length && v.every((x) => typeof x === "string")) val = v.slice(0, BAR_MAX);
  } catch {
    // 壞掉就用預設
  }
  barCache = { raw, val };
  return val;
}

export function setBarTabs(keys: string[]) {
  barMem = JSON.stringify(keys.slice(0, BAR_MAX));
  try {
    localStorage.setItem(BAR_KEY, barMem);
  } catch {
    // 這次開著的期間有效
  }
  listeners.forEach((f) => f());
}

export function useBarTabs(): string[] {
  return useSyncExternalStore(subscribe, readBar, () => BAR_DEFAULT);
}

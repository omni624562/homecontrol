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
  const onStorage = (e: StorageEvent) => { if (e.key === KEY) f(); };
  addEventListener("storage", onStorage);
  return () => { listeners.delete(f); removeEventListener("storage", onStorage); };
}

export function useNavStyle(): NavStyle {
  return useSyncExternalStore(subscribe, read, () => "menu");
}

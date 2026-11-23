import { useSyncExternalStore } from "react";

// 首頁卡片收合：收起來的卡片代號存在這台裝置上（手機和牆上的平板可以各自收）
const KEY = "home-collapsed";
const listeners = new Set<() => void>();
let mem: string | null = null;
let cache: { raw: string | null; val: Set<string> } = { raw: null, val: new Set() };

function read(): Set<string> {
  let raw = mem;
  try {
    raw = localStorage.getItem(KEY) ?? mem;
  } catch {
    // 無痕視窗之類
  }
  if (raw === cache.raw) return cache.val;
  let val = new Set<string>();
  try {
    const v = JSON.parse(raw || "[]");
    if (Array.isArray(v)) val = new Set(v.filter((x) => typeof x === "string"));
  } catch {
    // 壞掉就全部展開
  }
  cache = { raw, val };
  return val;
}

function toggle(id: string) {
  const next = new Set(read());
  if (next.has(id)) next.delete(id);
  else next.add(id);
  mem = JSON.stringify([...next]);
  try {
    localStorage.setItem(KEY, mem);
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

export function useCollapsed(id: string): [boolean, () => void] {
  const set = useSyncExternalStore(subscribe, read, () => cache.val);
  return [set.has(id), () => toggle(id)];
}

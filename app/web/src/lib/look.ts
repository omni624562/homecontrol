import { useSyncExternalStore } from "react";

// 外觀：原本的樣子，或「科技感」。存在這台裝置的瀏覽器裡（牆上的平板和手機可以各選各的）。
export type Look = "classic" | "tech";
const KEY = "look";
const listeners = new Set<() => void>();

export function getLook(): Look {
  try {
    return localStorage.getItem(KEY) === "tech" ? "tech" : "classic";
  } catch {
    return "classic";
  }
}

export function applyLook() {
  document.documentElement.dataset.look = getLook();
}

export function setLook(look: Look) {
  try {
    localStorage.setItem(KEY, look);
  } catch {
    // 無痕視窗之類存不了：這次開著的期間還是會換
    document.documentElement.dataset.look = look;
    listeners.forEach((f) => f());
    return;
  }
  applyLook();
  listeners.forEach((f) => f());
}

function subscribe(f: () => void) {
  listeners.add(f);
  const onStorage = (e: StorageEvent) => {
    if (e.key === KEY) {
      applyLook();
      f();
    }
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(f);
    window.removeEventListener("storage", onStorage);
  };
}

export function useLook(): Look {
  return useSyncExternalStore(subscribe, () => (document.documentElement.dataset.look === "tech" ? "tech" : "classic"), () => "classic");
}

// 深色／淺色：平常跟著系統；右鍵選單「切換深色／淺色」可以在這台蓋過去（切回跟系統一樣就恢復跟著系統）
const KEY = "theme";
const mq = matchMedia("(prefers-color-scheme: dark)");
let mem: "dark" | "light" | null = null; // 存不了的時候記在這裡

function override(): "dark" | "light" | null {
  try {
    const v = localStorage.getItem(KEY);
    return v === "dark" || v === "light" ? v : null;
  } catch {
    return mem;
  }
}

export const isDark = () => (override() ?? (mq.matches ? "dark" : "light")) === "dark";

export function applyTheme() {
  document.documentElement.classList.toggle("dark", isDark());
  dispatchEvent(new Event("themechange"));
}

export function toggleTheme() {
  const want = isDark() ? "light" : "dark";
  mem = want === (mq.matches ? "dark" : "light") ? null : want;
  try {
    if (mem) localStorage.setItem(KEY, mem);
    else localStorage.removeItem(KEY);
  } catch {
    // 無痕視窗之類：這次開著的期間有效
  }
  applyTheme();
}

export function watchTheme() {
  applyTheme();
  mq.addEventListener("change", applyTheme);
}

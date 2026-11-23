import { api } from "@/lib/api";

// 功能使用統計：看了哪些頁（只存在樹莓派上，用來判斷哪些功能可以收起來）。攢一下再一起送
let queue: string[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;

export function track(key: string) {
  queue.push(`page:${key}`);
  if (timer) return;
  timer = setTimeout(() => {
    const keys = queue.splice(0, 20);
    queue = [];
    timer = null;
    api("POST", "/api/usage", { keys }).catch(() => {});
  }, 3000);
}

import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

// 合併 Tailwind 的 class（後面的會蓋過前面衝突的）
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

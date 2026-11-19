import { useEffect, useMemo, useState } from "react";
import { useHub } from "@/lib/hub";

// 趣味小動畫：設定可以整個關掉；裝置開了「減少動態效果」也不播
export function useFun() {
  const { state } = useHub();
  const reduced = useMemo(() => matchMedia("(prefers-reduced-motion: reduce)").matches, []);
  return state?.calendar.local?.fun !== false && !reduced;
}

export const playFx = (name: "lights-out") => window.dispatchEvent(new CustomEvent("fx", { detail: name }));

// 蓋在整個畫面上的效果（全部關閉：像關燈一樣由上往下暗一下）
export function FxLayer() {
  const fun = useFun();
  const [fx, setFx] = useState<{ id: number; name: string } | null>(null);
  useEffect(() => {
    const on = (e: Event) => setFx({ id: Date.now(), name: (e as CustomEvent).detail });
    addEventListener("fx", on);
    return () => removeEventListener("fx", on);
  }, []);
  useEffect(() => {
    if (!fx) return;
    const t = setTimeout(() => setFx(null), 1500);
    return () => clearTimeout(t);
  }, [fx]);
  if (!fx || !fun) return null;
  return <div key={fx.id} aria-hidden className="lights-out pointer-events-none fixed inset-0 z-[65]" />;
}

// 下雨（排程因為下雨跳過的那一列）
export function Rain() {
  const drops = useMemo(() => Array.from({ length: 9 }, (_, i) => ({ left: 6 + i * 11 + ((i * 37) % 7), delay: ((i * 53) % 10) / 10, dur: 0.9 + ((i * 29) % 5) / 10 })), []);
  return (
    <span aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden rounded-xl">
      {drops.map((d, i) => (
        <i key={i} className="rain-drop absolute top-0 h-3 w-[2px] rounded-full bg-sky-400/60" style={{ left: `${d.left}%`, animationDelay: `${d.delay}s`, animationDuration: `${d.dur}s` }} />
      ))}
    </span>
  );
}

// 熱氣（開很久的插座）
export function Steam() {
  return (
    <span aria-hidden className="pointer-events-none absolute -top-2 left-1/2 flex -translate-x-1/2 gap-[3px]">
      {[0, 0.5, 0.25].map((d, i) => <i key={i} className="steam block h-2.5 w-[2px] rounded-full bg-red-500/80" style={{ animationDelay: `${d}s` }} />)}
    </span>
  );
}

// 彩帶（電費比上個月少）
export function Confetti() {
  const bits = useMemo(() => {
    const colors = ["#f59e0b", "#10b981", "#3b82f6", "#ef4444", "#a855f7", "#eab308"];
    return Array.from({ length: 22 }, (_, i) => {
      const a = (i / 22) * Math.PI * 2 + ((i * 17) % 5) / 10;
      const r = 46 + ((i * 31) % 40);
      return { x: Math.cos(a) * r, y: Math.sin(a) * r - 22, c: colors[i % colors.length], rot: (i * 67) % 360, delay: ((i * 13) % 6) / 40 };
    });
  }, []);
  return (
    <span aria-hidden className="pointer-events-none absolute top-1/2 left-10 z-10">
      {bits.map((b, i) => (
        <i
          key={i}
          className="confetti absolute block h-2 w-1.5 rounded-[1px]"
          style={{ background: b.c, animationDelay: `${b.delay}s`, ["--x" as string]: `${b.x}px`, ["--y" as string]: `${b.y}px`, ["--r" as string]: `${b.rot}deg` }}
        />
      ))}
    </span>
  );
}

// 有人回家：一個小人走進門
export function WalkIn() {
  return (
    <span aria-hidden className="relative inline-block h-5 w-9 overflow-hidden align-middle">
      <svg viewBox="0 0 36 20" className="absolute inset-0 size-full" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M24 19V5l9-3v17" />
        <path d="M22 19h13" />
        <g className="walk-in">
          <circle cx="6" cy="6" r="2.2" />
          <path d="M6 8.5v5M6 13.5l-2.5 5M6 13.5l2.5 5M3 11l3-1.5 3 1.5" />
        </g>
      </svg>
    </span>
  );
}

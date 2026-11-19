import { useEffect, useMemo, useState } from "react";
import { Truck } from "lucide-react";
import { toast } from "sonner";
import { useHub } from "@/lib/hub";

const NEAR = 2; // 剩這麼多站以內就衝出來
const KEY = "truck-rush-shown";
const store = {
  get: () => { try { return localStorage.getItem(KEY); } catch { return null; } },
  set: (v: string) => { try { localStorage.setItem(KEY, v); } catch { /* 不能存就每次都衝 */ } },
};
type Style = "side" | "front";
const pick = (s?: string): Style => (s === "side" || s === "front" ? s : Math.random() < 0.5 ? "side" : "front");

// 在設定頁按「預覽」
export const previewTruckRush = (style?: string) => window.dispatchEvent(new CustomEvent("truck-rush", { detail: style }));

// 垃圾車快到了：一台大垃圾車衝出來（同一天同一條路線只衝一次；設定可以關、可以選樣式）
export function TruckRush() {
  const { state } = useHub();
  const [run, setRun] = useState<{ id: number; stops: number; style: Style } | null>(null);
  const L = state?.calendar.local;
  const t = L?.garbage?.truck;
  const stops = t && !t.none ? (t.stops ?? -1) : -1;
  const lineid = L?.garbage?.stop.lineid;
  const enabled = L?.truck_rush !== false;
  const style = L?.truck_rush_style;

  useEffect(() => {
    if (!enabled || stops < 0 || stops > NEAR) return;
    const key = `${new Date().toDateString()}|${lineid}`;
    if (store.get() === key) return;
    store.set(key);
    setRun({ id: Date.now(), stops, style: pick(style) });
    // 樣式改了不用重衝
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, stops, lineid]);

  useEffect(() => {
    const on = (e: Event) => setRun({ id: Date.now(), stops: NEAR, style: pick((e as CustomEvent).detail) });
    addEventListener("truck-rush", on);
    return () => removeEventListener("truck-rush", on);
  }, []);

  useEffect(() => {
    if (!run) return;
    // 關掉動態效果的裝置：改用一則通知
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
      toast("垃圾車快到了！", { description: run.stops ? `還有 ${run.stops} 站` : "到了！" });
      setRun(null);
      return;
    }
    // 正面撞上來的那一下，整個畫面震一下
    let shake: ReturnType<typeof setTimeout> | undefined;
    if (run.style === "front") {
      shake = setTimeout(() => {
        document.body.classList.add("screen-shake");
        setTimeout(() => document.body.classList.remove("screen-shake"), 500);
      }, 1150);
    }
    const timer = setTimeout(() => setRun(null), run.style === "front" ? 4600 : 4200);
    return () => {
      clearTimeout(timer);
      clearTimeout(shake);
      document.body.classList.remove("screen-shake");
    };
  }, [run]);

  if (!run) return null;
  const text = `垃圾車快到了！${run.stops ? `還有 ${run.stops} 站` : "到了！"}`;
  return (
    <div key={run.id} className="pointer-events-none fixed inset-0 z-[70] overflow-hidden" role="status" aria-live="assertive">
      <span className="sr-only">{text}</span>
      {run.style === "side" ? (
        <div className="truck-rush absolute top-1/2 left-0 flex items-center gap-4" aria-hidden>
          {/* 速度線 */}
          <div className="flex flex-col gap-3">
            {[72, 112, 56].map((w, i) => <i key={i} className="block h-1.5 rounded-full bg-amber-400/70" style={{ width: w, marginLeft: i === 1 ? 0 : 24 }} />)}
          </div>
          <div className="relative">
            <Truck className="truck-run size-[min(46vw,18rem)] text-amber-500 drop-shadow-[0_12px_24px_rgba(0,0,0,.25)]" strokeWidth={1.6} fill="currentColor" fillOpacity={0.18} />
            <div className="absolute -top-2 left-1/2 -translate-x-1/2 rounded-full bg-foreground px-4 py-1.5 text-base font-bold whitespace-nowrap text-background shadow-lg sm:text-lg">{text}</div>
          </div>
        </div>
      ) : (
        <div aria-hidden>
          {/* 從遠處正面衝過來：小變大 */}
          <div className="truck-front absolute top-1/2 left-1/2"><FrontTruck /></div>
          {/* 撞上螢幕：閃一下，然後是裂痕 */}
          <div className="crash-flash absolute inset-0 bg-white" />
          <Cracks />
          <div className="crash-text absolute inset-x-0 bottom-[18%] flex justify-center">
            <div className="rounded-full bg-foreground px-5 py-2 text-lg font-bold whitespace-nowrap text-background shadow-xl sm:text-xl">{text}</div>
          </div>
        </div>
      )}
    </div>
  );
}

// 垃圾車的正面
function FrontTruck() {
  return (
    <svg viewBox="0 0 200 190" className="h-[38vmin] w-[40vmin] drop-shadow-[0_10px_30px_rgba(0,0,0,.35)]">
      {/* 後面的車斗 */}
      <rect x="22" y="8" width="156" height="70" rx="10" fill="#d97706" />
      <rect x="34" y="18" width="132" height="10" rx="5" fill="#b45309" />
      {/* 車頭 */}
      <rect x="14" y="48" width="172" height="104" rx="16" fill="#f59e0b" />
      {/* 擋風玻璃 */}
      <path d="M34 62h132a6 6 0 0 1 6 6v26a6 6 0 0 1-6 6H34a6 6 0 0 1-6-6V68a6 6 0 0 1 6-6z" fill="#bfdbfe" />
      <path d="M44 66 30 96M70 64 52 100" stroke="#fff" strokeWidth="5" strokeLinecap="round" opacity=".7" />
      <rect x="97" y="62" width="6" height="38" fill="#f59e0b" />
      {/* 後照鏡 */}
      <rect x="0" y="66" width="12" height="26" rx="4" fill="#92400e" />
      <rect x="188" y="66" width="12" height="26" rx="4" fill="#92400e" />
      {/* 水箱罩、車燈 */}
      <rect x="64" y="110" width="72" height="26" rx="5" fill="#78350f" />
      <path d="M72 117h56M72 123h56M72 129h56" stroke="#f59e0b" strokeWidth="3" strokeLinecap="round" />
      <circle cx="40" cy="122" r="13" fill="#fef9c3" stroke="#78350f" strokeWidth="4" />
      <circle cx="160" cy="122" r="13" fill="#fef9c3" stroke="#78350f" strokeWidth="4" />
      {/* 保險桿、輪胎 */}
      <rect x="8" y="146" width="184" height="18" rx="8" fill="#44403c" />
      <rect x="26" y="160" width="34" height="28" rx="8" fill="#1c1917" />
      <rect x="140" y="160" width="34" height="28" rx="8" fill="#1c1917" />
    </svg>
  );
}

// 螢幕的裂痕：從撞擊點放射出去的折線，加上幾圈碎裂的環
function Cracks() {
  const paths = useMemo(() => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const out: string[] = [];
    const cx = 50, cy = 50;
    const rays = 13;
    const pts: [number, number][][] = [];
    for (let i = 0; i < rays; i++) {
      const a = (i / rays) * Math.PI * 2 + (rnd() - 0.5) * 0.35;
      const line: [number, number][] = [[cx, cy]];
      for (let r = 9; r <= 86; r += 9 + rnd() * 6) {
        const j = (rnd() - 0.5) * 0.16;
        line.push([cx + Math.cos(a + j) * r, cy + Math.sin(a + j) * r]);
      }
      pts.push(line);
      out.push("M" + line.map((p) => p.map((v) => v.toFixed(1)).join(" ")).join("L"));
      // 分岔
      if (line.length > 4 && rnd() > 0.35) {
        const p = line[2 + Math.floor(rnd() * 2)];
        const b = a + (rnd() > 0.5 ? 0.5 : -0.5);
        out.push(`M${p[0].toFixed(1)} ${p[1].toFixed(1)}L${(p[0] + Math.cos(b) * 14).toFixed(1)} ${(p[1] + Math.sin(b) * 14).toFixed(1)}`);
      }
    }
    // 環：把相鄰放射線上差不多距離的點連起來
    for (const k of [1, 2, 4]) {
      for (let i = 0; i < rays; i++) {
        const p = pts[i][k], q = pts[(i + 1) % rays][k];
        if (p && q && rnd() > 0.25) out.push(`M${p[0].toFixed(1)} ${p[1].toFixed(1)}L${q[0].toFixed(1)} ${q[1].toFixed(1)}`);
      }
    }
    return out.join("");
  }, []);
  return (
    <svg viewBox="0 0 100 100" preserveAspectRatio="xMidYMid slice" className="crash-cracks absolute inset-0 size-full">
      <path d={paths} fill="none" stroke="rgba(0,0,0,.55)" strokeWidth="3" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
      <path d={paths} fill="none" stroke="rgba(255,255,255,.95)" strokeWidth="1.2" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
      <circle cx="50" cy="50" r="2.2" fill="rgba(255,255,255,.9)" stroke="rgba(0,0,0,.5)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

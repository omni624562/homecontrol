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
export const RUSH_STYLES = [
  ["side", "從旁邊衝過去"],
  ["front", "從正面衝出來（螢幕裂開）"],
  ["drop", "從天而降"],
  ["reverse", "倒車入庫"],
  ["parade", "車隊遊行"],
  ["tilt", "把畫面撞歪"],
  ["chase", "追垃圾車"],
] as const;
type Style = (typeof RUSH_STYLES)[number][0];
const ALL = RUSH_STYLES.map((x) => x[0]) as Style[];
const pick = (s?: string): Style => (ALL.includes(s as Style) ? (s as Style) : ALL[Math.floor(Math.random() * ALL.length)]);
// 每一種播多久（毫秒）、什麼時候讓整個畫面動一下
const PLAN: Record<Style, { ms: number; body?: [string, number, number] }> = {
  side: { ms: 4200 },
  front: { ms: 4600, body: ["screen-shake", 1150, 500] },
  drop: { ms: 4400, body: ["screen-shake", 1250, 500] },
  reverse: { ms: 6200 },
  parade: { ms: 5800 },
  tilt: { ms: 4000, body: ["screen-tilt", 520, 2600] },
  chase: { ms: 6000 },
};

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
    // 撞上來、落地的那一下，整個畫面跟著動
    const plan = PLAN[run.style];
    let t1: ReturnType<typeof setTimeout> | undefined;
    let t2: ReturnType<typeof setTimeout> | undefined;
    const cls = plan.body?.[0];
    if (plan.body && cls) {
      t1 = setTimeout(() => {
        // 內容很長的時候，以現在看到的畫面中間為中心轉
        document.body.style.setProperty("--fx-y", `${scrollY + innerHeight / 2}px`);
        document.body.classList.add(cls);
        t2 = setTimeout(() => document.body.classList.remove(cls), plan.body![2]);
      }, plan.body[1]);
    }
    const timer = setTimeout(() => setRun(null), plan.ms);
    return () => {
      clearTimeout(timer);
      clearTimeout(t1);
      clearTimeout(t2);
      if (cls) document.body.classList.remove(cls);
    };
  }, [run]);

  if (!run) return null;
  const text = `垃圾車快到了！${run.stops ? `還有 ${run.stops} 站` : "到了！"}`;
  const st = run.style;
  const banner = <div className="rounded-full bg-foreground px-4 py-1.5 text-base font-bold whitespace-nowrap text-background shadow-lg sm:text-lg">{text}</div>;
  const big = "size-[min(46vw,18rem)] text-amber-500 drop-shadow-[0_12px_24px_rgba(0,0,0,.25)]";
  const SideTruck = ({ className }: { className?: string }) => <Truck className={className} strokeWidth={1.6} fill="currentColor" fillOpacity={0.18} />;
  return (
    <div key={run.id} className="pointer-events-none fixed inset-0 z-[70] overflow-hidden" role="status" aria-live="assertive">
      <span className="sr-only">{text}</span>
      <div aria-hidden>
        {st === "side" && (
          <div className="truck-rush absolute top-1/2 left-0 flex items-center gap-4">
            <SpeedLines />
            <div className="relative"><SideTruck className={`truck-run ${big}`} /><div className="absolute -top-2 left-1/2 -translate-x-1/2">{banner}</div></div>
          </div>
        )}

        {st === "front" && (
          <>
            {/* 從遠處正面衝過來：小變大；撞上螢幕：閃一下，然後是裂痕 */}
            <div className="truck-front absolute top-1/2 left-1/2"><FrontTruck /></div>
            <div className="crash-flash absolute inset-0 bg-white" />
            <Cracks />
            <div className="crash-text absolute inset-x-0 bottom-[18%] flex justify-center">{banner}</div>
          </>
        )}

        {st === "drop" && (
          <>
            {/* 從上面掉下來，彈兩下，揚起灰塵，再開走 */}
            <div className="truck-dust absolute bottom-[16%] left-1/2 h-10 w-[min(60vw,24rem)] rounded-[50%] bg-neutral-400/50" />
            <div className="truck-drop absolute bottom-[18%] left-1/2"><SideTruck className={big} /></div>
            <div className="fx-text absolute inset-x-0 bottom-[8%] flex justify-center" style={{ animationDelay: "1.3s" }}>{banner}</div>
          </>
        )}

        {st === "reverse" && (
          <div className="truck-reverse absolute top-1/2 left-0 flex items-center">
            {/* 車尾朝左：往左移動就是倒車 */}
            <div className="relative">
              <SideTruck className={big} />
              <i className="tail-blink absolute bottom-[30%] left-[3%] size-[6%] rounded-full bg-red-500 shadow-[0_0_18px_6px_rgba(239,68,68,.7)]" />
              <div className="tail-blink absolute -top-1 left-0 rounded-lg bg-background px-3 py-1 text-sm font-bold shadow-md sm:text-base">嗶——嗶——</div>
              <div className="fx-text absolute -bottom-2 left-1/2 -translate-x-1/2" style={{ animationDelay: "2.2s" }}>{banner}</div>
            </div>
          </div>
        )}

        {st === "parade" && (
          <>
            <div className="truck-parade absolute bottom-[12%] left-0 flex items-end gap-6">
              {/* 最後一台小的落隊，在後面追 */}
              <div className="parade-late"><SideTruck className="truck-run size-14 text-amber-400 sm:size-20" /></div>
              {[0, 1, 2].map((i) => <SideTruck key={i} className="truck-run size-14 text-amber-400 sm:size-20" />)}
              <SideTruck className="truck-run size-[min(34vw,13rem)] text-amber-500 drop-shadow-[0_10px_20px_rgba(0,0,0,.25)]" />
            </div>
            <div className="fx-text absolute inset-x-0 bottom-[42%] flex justify-center" style={{ animationDelay: "0.6s" }}>{banner}</div>
          </>
        )}

        {st === "tilt" && (
          <>
            {/* 從旁邊很快撞過去，整個頁面被撞歪 */}
            <div className="truck-ram absolute top-1/2 left-0 flex items-center gap-4"><SpeedLines /><SideTruck className={big} /></div>
            <div className="fx-text absolute inset-x-0 bottom-[20%] flex justify-center" style={{ animationDelay: "0.7s" }}>{banner}</div>
          </>
        )}

        {st === "chase" && (
          <>
            <div className="truck-cruise absolute bottom-[22%] left-0"><SideTruck className="truck-run size-[min(36vw,14rem)] text-amber-500 drop-shadow-[0_10px_20px_rgba(0,0,0,.25)]" /></div>
            {/* 提著垃圾袋在後面追 */}
            <div className="runner-chase absolute bottom-[22%] left-0">
              <div className="relative">
                <Runner />
                <div className="absolute -top-9 left-6 rounded-xl rounded-bl-none bg-background px-3 py-1 text-sm font-bold whitespace-nowrap shadow-md sm:text-base">等一下～</div>
              </div>
            </div>
            <div className="fx-text absolute inset-x-0 bottom-[8%] flex justify-center" style={{ animationDelay: "0.5s" }}>{banner}</div>
          </>
        )}
      </div>
    </div>
  );
}

function SpeedLines() {
  return (
    <div className="flex flex-col gap-3">
      {[72, 112, 56].map((w, i) => <i key={i} className="block h-1.5 rounded-full bg-amber-400/70" style={{ width: w, marginLeft: i === 1 ? 0 : 24 }} />)}
    </div>
  );
}

// 提著垃圾袋跑步的小人（兩條腿、兩隻手會擺動）
function Runner() {
  return (
    <svg viewBox="0 0 80 100" className="h-[min(22vw,8.5rem)] w-auto overflow-visible" fill="none" strokeLinecap="round" strokeLinejoin="round">
      {/* 垃圾袋 */}
      <g className="runner-bag">
        <path d="M6 50c-5 4-6 16 0 22 6 5 15 4 18-2 3-7 1-16-5-20z" fill="#3f3f46" stroke="#18181b" strokeWidth="2.5" />
        <path d="M12 50 15 43l5 7" stroke="#18181b" strokeWidth="2.5" />
      </g>
      <circle cx="46" cy="16" r="10" fill="#fde68a" stroke="#18181b" strokeWidth="3" />
      <path d="M44 27 38 56" stroke="#2563eb" strokeWidth="9" />
      {/* 手 */}
      <path className="runner-arm-a" d="M42 32 22 46" stroke="#18181b" strokeWidth="4.5" />
      <path className="runner-arm-b" d="M43 33 60 42 68 34" stroke="#18181b" strokeWidth="4.5" />
      {/* 腿 */}
      <path className="runner-leg-a" d="M38 56 52 72 46 92" stroke="#18181b" strokeWidth="5" />
      <path className="runner-leg-b" d="M38 56 26 74 12 80" stroke="#18181b" strokeWidth="5" />
    </svg>
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

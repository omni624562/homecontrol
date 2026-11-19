import { useEffect, useState } from "react";
import { Truck } from "lucide-react";
import { toast } from "sonner";
import { useHub } from "@/lib/hub";

const NEAR = 2; // 剩這麼多站以內就衝出來
const KEY = "truck-rush-shown";
const store = {
  get: () => { try { return localStorage.getItem(KEY); } catch { return null; } },
  set: (v: string) => { try { localStorage.setItem(KEY, v); } catch { /* 不能存就每次都衝 */ } },
};

// 在設定頁按「預覽」
export const previewTruckRush = () => window.dispatchEvent(new Event("truck-rush"));

// 垃圾車快到了：一台大垃圾車從畫面中間衝過去（同一天同一條路線只衝一次；設定可以關）
export function TruckRush() {
  const { state } = useHub();
  const [run, setRun] = useState<{ id: number; stops: number } | null>(null);
  const L = state?.calendar.local;
  const t = L?.garbage?.truck;
  const stops = t && !t.none ? (t.stops ?? -1) : -1;
  const lineid = L?.garbage?.stop.lineid;
  const enabled = L?.truck_rush !== false;

  useEffect(() => {
    if (!enabled || stops < 0 || stops > NEAR) return;
    const key = `${new Date().toDateString()}|${lineid}`;
    if (store.get() === key) return;
    store.set(key);
    setRun({ id: Date.now(), stops });
  }, [enabled, stops, lineid]);

  useEffect(() => {
    const on = () => setRun({ id: Date.now(), stops: NEAR });
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
    const timer = setTimeout(() => setRun(null), 4200);
    return () => clearTimeout(timer);
  }, [run]);

  if (!run) return null;
  return (
    <div key={run.id} className="pointer-events-none fixed inset-0 z-[70] overflow-hidden" role="status" aria-live="assertive">
      <span className="sr-only">垃圾車快到了，{run.stops ? `還有 ${run.stops} 站` : "到了"}</span>
      <div className="truck-rush absolute top-1/2 left-0 flex items-center gap-4" aria-hidden>
        {/* 速度線 */}
        <div className="flex flex-col gap-3">
          {[72, 112, 56].map((w, i) => <i key={i} className="block h-1.5 rounded-full bg-amber-400/70" style={{ width: w, marginLeft: i === 1 ? 0 : 24 }} />)}
        </div>
        <div className="relative">
          <Truck className="truck-run size-[min(46vw,18rem)] text-amber-500 drop-shadow-[0_12px_24px_rgba(0,0,0,.25)]" strokeWidth={1.6} fill="currentColor" fillOpacity={0.18} />
          <div className="absolute -top-2 left-1/2 -translate-x-1/2 rounded-full bg-foreground px-4 py-1.5 text-base font-bold whitespace-nowrap text-background shadow-lg sm:text-lg">
            垃圾車快到了！{run.stops ? `還有 ${run.stops} 站` : "到了！"}
          </div>
        </div>
      </div>
    </div>
  );
}

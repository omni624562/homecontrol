import { useEffect, useState, useSyncExternalStore } from "react";
import { Bike, Bus, Clock, Droplets, Truck, Zap } from "lucide-react";
import { weatherIcon } from "@/components/icons";
import { busEta, fmt, fmtDur, pad2, WEEK } from "@/lib/format";
import { useHub, useTick } from "@/lib/hub";
import { cn } from "@/lib/utils";

// 待機畫面：這台裝置閒置幾分鐘後，換成大時鐘和當下有用的幾件事；碰一下回來。
// 幾分鐘存在這台裝置的瀏覽器裡（0 = 不用），牆上的平板開、手機不開。
const KEY = "standby_min";
const listeners = new Set<() => void>();
export function getStandbyMin(): number {
  try {
    return Math.max(0, Number(localStorage.getItem(KEY)) || 0);
  } catch {
    return 0;
  }
}
export function setStandbyMin(n: number) {
  try {
    localStorage.setItem(KEY, String(n));
  } catch {
    // 存不了就算了
  }
  listeners.forEach((f) => f());
}
export function useStandbyMin(): number {
  return useSyncExternalStore((f) => { listeners.add(f); return () => { listeners.delete(f); }; }, getStandbyMin, () => 0);
}
export const previewStandby = () => window.dispatchEvent(new Event("standby-preview"));

export function Standby() {
  const min = useStandbyMin();
  const [show, setShow] = useState(false);

  useEffect(() => {
    const preview = () => setShow(true);
    window.addEventListener("standby-preview", preview);
    return () => window.removeEventListener("standby-preview", preview);
  }, []);

  // 沒有人碰這麼久就進待機
  useEffect(() => {
    if (!min || show) return;
    let timer = window.setTimeout(() => setShow(true), min * 60000);
    const poke = () => {
      clearTimeout(timer);
      timer = window.setTimeout(() => setShow(true), min * 60000);
    };
    const evs = ["pointerdown", "keydown", "wheel", "touchstart"] as const;
    evs.forEach((e) => window.addEventListener(e, poke, { passive: true }));
    return () => {
      clearTimeout(timer);
      evs.forEach((e) => window.removeEventListener(e, poke));
    };
  }, [min, show]);

  // 待機中按任何鍵也回來
  useEffect(() => {
    if (!show) return;
    const back = () => setShow(false);
    window.addEventListener("keydown", back);
    const was = document.body.style.overflow;
    document.body.style.overflow = "hidden"; // 後面的頁面不要露出捲軸
    return () => {
      window.removeEventListener("keydown", back);
      document.body.style.overflow = was;
    };
  }, [show]);

  return show ? <Screen onClose={() => setShow(false)} /> : null;
}

function Screen({ onClose }: { onClose: () => void }) {
  const { state, isOn, now: hubNow } = useHub();
  useTick(10000);
  const d = new Date();
  // 每分鐘把內容挪幾個像素，免得同一個畫面一直亮在同一個位置
  const shift = [[0, 0], [10, 6], [-8, 10], [6, -8], [-10, -4]][d.getMinutes() % 5];

  const cards: { key: string; icon: React.ElementType; k: string; t: string; n: React.ReactNode; hot?: boolean }[] = [];
  let foot: React.ReactNode = null;
  let weather: React.ReactNode = null;
  if (state) {
    const L = state.calendar.local;
    const g = L?.garbage;
    const tr = g?.truck;
    if (g && g.today.length > 0) {
      const coming = !!tr && !tr.none && (tr.stops ?? -1) >= 0;
      if (coming) cards.push({ key: "tr", icon: Truck, k: "垃圾車快到了", t: `車子在${tr!.at_stop}附近`, n: <>{tr!.stops}<small>站</small></>, hot: true });
      else if (!tr || tr.none) cards.push({ key: "tr", icon: Truck, k: "今天收垃圾", t: g.today.join("、"), n: g.usual || g.stop.time });
    }
    const soon: [string, number, string][] = [];
    for (const rt of L?.bus?.routes || [])
      for (const dir of rt.dirs) if (dir.stop && dir.sec != null && dir.sec >= 0 && dir.sec <= 1800) soon.push([rt.base, dir.sec, `往${dir.to}`]);
    soon.sort((a, b) => a[1] - b[1]);
    if (soon[0])
      cards.push({ key: "bus", icon: Bus, k: `公車・${soon[0][0]} ${soon[0][2]}`, t: soon[1] ? `再來 ${soon[1][0]} ${busEta(soon[1][1])}` : "30 分鐘內只有這一班",
        n: soon[0][1] < 60 ? "進站" : <>{Math.round(soon[0][1] / 60)}<small>分</small></> });
    const yb = L?.bike?.show ? L.bike.near.find((x) => x.sno === L.bike!.main) : undefined;
    if (yb) cards.push({ key: "yb", icon: Bike, k: `YouBike・${yb.name}`, t: `${yb.m} 公尺・空位 ${yb.docks}`, n: yb.ok ? <>{yb.bikes}<small>台</small></> : "暫停", hot: yb.ok && !yb.bikes });
    const out = (L?.outages || []).find((x) => x.hit === "road");
    if (out) {
      const o = new Date(out.start);
      cards.push({ key: "out", icon: out.kind === "power" ? Zap : Droplets, k: out.kind === "power" ? "你家附近要停電" : "你家附近要停水", t: `${pad2(o.getHours())}:${pad2(o.getMinutes())} 開始`, n: `${o.getMonth() + 1}/${o.getDate()}`, hot: true });
    }
    const t = hubNow();
    const limit = (state.settings.long_on_hours || 6) * 3600;
    const long = state.plugs.filter((p) => p.online && isOn(p) && !p.keep_on && p.on_since && t - p.on_since > limit).sort((a, b) => a.on_since! - b.on_since!)[0];
    if (long) cards.push({ key: "long", icon: Clock, k: "開很久了", t: long.name, n: <span className="text-[22px]">{fmtDur(t - long.on_since!)}</span>, hot: true });

    const on = state.plugs.filter((p) => p.online && isOn(p)).length;
    const home = (state.people || []).filter((x) => x.home).length;
    foot = (
      <>
        <span className={cn(on > 0 && "text-amber-600 dark:text-amber-400")}><b>{on}</b>個開著</span>
        {state.summary.power != null && <span><b>{fmt(state.summary.power)}</b>W</span>}
        {(state.people || []).length > 0 && <span><b>{home}</b>人在家</span>}
        {state.summary.hours_today != null && <span>今天開了<b className="ml-1.5">{fmt(state.summary.hours_today)}</b>小時</span>}
      </>
    );
    const w = state.calendar.weather_show !== false ? state.calendar.weather : null;
    if (w && w.temp != null) {
      const WI = weatherIcon(w.code, w.obs_text || w.text, w.day);
      weather = (
        <div className="mt-5 flex items-center gap-3 text-lg text-muted-foreground sm:text-xl">
          <WI className="size-8 text-primary" />
          <b className="tech-mono text-3xl font-semibold text-foreground">{fmt(w.temp)}°</b>
          <span>{w.text || w.obs_text}{(w.hourly[0]?.pop ?? 0) >= 30 ? `・降雨 ${w.hourly[0].pop}%` : ""}</span>
        </div>
      );
    }
  }

  return (
    <div role="button" tabIndex={0} aria-label="待機畫面，碰一下回到首頁" onPointerDown={(e) => { e.preventDefault(); onClose(); }}
      className="standby fixed inset-0 z-[200] cursor-pointer overflow-hidden bg-background text-foreground select-none">
      <div className="flex h-full flex-col gap-5 p-6 transition-transform duration-1000 sm:p-12" style={{ transform: `translate(${shift[0]}px, ${shift[1]}px)` }}>
        <div className="flex justify-between text-xs tracking-[.16em] text-muted-foreground">
          <span>我的家</span>
          <span>{state ? "" : "連線中…"}</span>
        </div>
        <div className="grid flex-1 items-center gap-8 lg:grid-cols-[1.25fr_1fr] lg:gap-14">
          <div>
            <div className="tech-mono text-[26vw] leading-none font-semibold tracking-tighter lg:text-[15vw]">
              {pad2(d.getHours())}<span className="text-primary">:</span>{pad2(d.getMinutes())}
            </div>
            <div className="mt-3 text-xl text-muted-foreground sm:text-2xl">{d.getMonth() + 1} 月 {d.getDate()} 日 星期{WEEK[d.getDay()]}</div>
            {weather}
          </div>
          {cards.length > 0 && (
            <div className="grid gap-3">
              {cards.slice(0, 4).map((c) => (
                <div key={c.key} className={cn("flex items-center gap-4 rounded-2xl border bg-card px-5 py-4", c.hot && "border-amber-400/70 bg-amber-50 dark:bg-amber-500/10")}>
                  <span className={cn("flex size-11 shrink-0 items-center justify-center rounded-xl bg-primary/12 text-primary", c.hot && "bg-amber-500/20 text-amber-600 dark:text-amber-400")}>
                    <c.icon className="size-6" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-xs tracking-wider text-muted-foreground">{c.k}</div>
                    <div className="truncate text-[17px]">{c.t}</div>
                  </div>
                  <div className={cn("tech-mono shrink-0 text-[32px] leading-none font-semibold whitespace-nowrap [&_small]:ml-1 [&_small]:text-sm [&_small]:font-normal [&_small]:text-muted-foreground", c.hot && "text-amber-600 dark:text-amber-400")}>{c.n}</div>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-x-7 gap-y-2 border-t pt-4 text-[15px] text-muted-foreground [&_b]:tech-mono [&_b]:mr-1.5 [&_b]:text-[17px] [&_b]:font-semibold [&_b]:text-foreground">
          {foot}
          <span className="ml-auto text-xs tracking-[.14em]">碰一下回到首頁</span>
        </div>
      </div>
    </div>
  );
}

import { useEffect, useMemo, useRef, useState } from "react";
import { Bus, Droplets, Gauge, Home as HomeIcon, Loader2, Pencil, Power, Truck, Wifi, WifiOff, Zap } from "lucide-react";
import { toast } from "sonner";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/app-shell";
import { DeviceSheet, needsConfirm } from "@/components/device-sheet";
import { WalkIn, playFx, useFun } from "@/components/fx";
import { mdiIcon, weatherIcon } from "@/components/icons";
import { LifeSheet } from "@/components/life-sheet";
import { RoomCard, type Group } from "@/components/room-card";
import { WeatherSheet } from "@/components/weather-sheet";
import { api } from "@/lib/api";
import { busEta, fmt } from "@/lib/format";
import { useHub, useMedia, useTick } from "@/lib/hub";
import type { Plug } from "@/lib/types";
import { cn } from "@/lib/utils";

// 只顯示資訊的小標籤（誰在家、功率、網路）
function Pill({ icon: I, children, tone }: { icon: React.ElementType; children: React.ReactNode; tone?: "ok" | "bad" }) {
  return (
    <span className={cn("inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full border border-transparent bg-muted/70 px-3 text-sm whitespace-nowrap text-muted-foreground",
      tone === "ok" && "text-foreground [&_svg]:text-emerald-600", tone === "bad" && "text-orange-700 dark:text-orange-400")}>
      <I className="size-4" />
      {children}
    </span>
  );
}

// 首頁上方的小按鈕（天氣、垃圾車、停水停電）
function Chip({ onClick, icon: I, label, sub, tone, moving }: { onClick: () => void; icon: React.ElementType; label: string; sub?: string; tone?: "warn"; moving?: boolean }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "inline-flex h-9 shrink-0 items-center gap-2 rounded-full border bg-background px-3.5 text-sm whitespace-nowrap shadow-xs transition-all",
        "hover:bg-muted hover:shadow-sm active:scale-[.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        tone === "warn" && "border-orange-300 dark:border-orange-500/40",
      )}
    >
      <I className={cn("size-4.5", tone === "warn" ? "text-orange-600" : "text-foreground/60", moving && "truck-run text-amber-600")} />
      <span className="font-medium">{label}</span>
      {sub && <span className="text-muted-foreground">{sub}</span>}
    </button>
  );
}

function HomeSkeleton() {
  return (
    <div className="mx-auto max-w-7xl space-y-5 px-4 py-4 sm:px-6 lg:px-8" aria-busy="true" aria-label="載入中">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-16 rounded-xl" />)}
      </div>
      <div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3">
        {[5, 3, 4].map((n, i) => (
          <Card key={i} className="gap-0 py-0">
            <div className="flex items-center gap-3 p-4"><Skeleton className="size-9 rounded-lg" /><Skeleton className="h-5 w-24" /></div>
            {Array.from({ length: n }, (_, j) => (
              <div key={j} className="flex items-center gap-3 px-4 py-3">
                <Skeleton className="size-10 rounded-xl" />
                <div className="flex-1 space-y-2"><Skeleton className="h-4 w-1/2" /><Skeleton className="h-3 w-1/3" /></div>
                <Skeleton className="h-6 w-11 rounded-full" />
              </div>
            ))}
          </Card>
        ))}
      </div>
    </div>
  );
}

export function HomePage() {
  const { state, failed, isOn, setPower } = useHub();
  useTick(30000);
  const [device, setDevice] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Plug | null>(null);
  const [allOff, setAllOff] = useState(false);
  const [sheet, setSheet] = useState<"weather" | "life" | "bus" | null>(null);
  const [running, setRunning] = useState<string | null>(null);
  // 有人回家：在家人數變多的時候，小人走進門幾秒
  const fun = useFun();
  const homeCount = state ? (state.people || []).filter((x) => x.home).length : null;
  const prevHome = useRef<number | null>(null);
  const [arrived, setArrived] = useState(false);
  useEffect(() => {
    if (homeCount === null) return;
    const was = prevHome.current;
    prevHome.current = homeCount;
    if (was === null || homeCount <= was) return;
    setArrived(true);
    const timer = setTimeout(() => setArrived(false), 3400);
    return () => clearTimeout(timer);
  }, [homeCount]);
  const wide3 = useMedia("(min-width: 1536px)");
  const wide2 = useMedia("(min-width: 768px)");
  const cols = wide3 ? 3 : wide2 ? 2 : 1;

  const groups = useMemo<Group[]>(() => {
    if (!state) return [];
    const out: Group[] = [];
    const ids = new Set(state.rooms.map((r) => r.id));
    const loose = state.plugs.filter((p) => !p.room || !ids.has(p.room));
    if (loose.length) out.push({ id: "", name: "還沒分區域", plugs: loose });
    for (const r of state.rooms) {
      const list = state.plugs.filter((p) => p.room === r.id);
      if (list.length) out.push({ ...r, plugs: list });
    }
    return out;
  }, [state]);

  // 照高度（插座數）分到最矮的那一欄
  const columns = useMemo(() => {
    const n = Math.min(cols, Math.max(1, groups.length));
    const cs = Array.from({ length: n }, () => ({ h: 0, items: [] as Group[] }));
    for (const g of groups) {
      const c = cs.reduce((a, b) => (b.h < a.h ? b : a));
      c.items.push(g);
      c.h += 1.4 + g.plugs.length;
    }
    return cs;
  }, [groups, cols]);

  if (!state) {
    if (failed)
      return (
        <div className="mx-auto flex max-w-md flex-col items-center gap-3 px-6 py-24 text-center">
          <WifiOff className="size-10 text-muted-foreground" />
          <h1 className="text-xl font-semibold">連不上家庭中控</h1>
          <p className="leading-relaxed text-muted-foreground">確認這台裝置連著家裡的 Wi-Fi，或是已經開了回家的 VPN。</p>
          <Button onClick={() => location.reload()}>重新連線</Button>
        </div>
      );
    return (
      <>
        <PageHeader title="我的家" sub={<Skeleton className="mt-1.5 h-4 w-36" />} />
        <HomeSkeleton />
      </>
    );
  }

  const onCount = state.plugs.filter((p) => p.online && isOn(p)).length;
  const toggle = (p: Plug) => {
    const target = !isOn(p);
    if (needsConfirm(p, isOn(p))) setConfirm(p);
    else setPower(p, target);
  };
  const runScene = async (id: string, name: string) => {
    setRunning(id);
    try {
      const res = await api<{ count: number }>("POST", `/api/scenes/${id}/run`);
      toast.success(res.count ? `「${name}」：改了 ${res.count} 個插座` : `「${name}」：插座本來就是這樣`, res.count ? { action: { label: "復原", onClick: undo } } : undefined);
    } catch (err) {
      toast.error("沒有成功", { description: (err as Error).message });
    } finally {
      setRunning(null);
    }
  };
  const undo = async () => {
    try {
      const r = await api<{ count: number }>("POST", "/api/restore");
      toast(r.count ? "已經復原" : "已經是原本的樣子了");
    } catch (err) {
      toast.error("沒有成功", { description: (err as Error).message });
    }
  };
  const doAllOff = async () => {
    setRunning("all");
    try {
      const res = await api<{ count: number }>("POST", "/api/off", {});
      if (!res.count) toast("沒有開著的插座");
      else {
        playFx("lights-out");
        toast.success(`已關閉 ${res.count} 個插座`, { action: { label: "復原", onClick: undo }, duration: 8000 });
      }
    } catch (err) {
      toast.error("沒有成功", { description: (err as Error).message });
    } finally {
      setRunning(null);
    }
  };

  // 上方的小按鈕
  const w = state.calendar.weather_show !== false ? state.calendar.weather : null;
  const L = state.calendar.local;
  const g = L?.garbage;
  const truck = g?.truck;
  // 公車：每條路線（含它的支線）最快來的那一班，只列 30 分鐘內的
  const soon = new Map<string, number>();
  for (const rt of L?.bus?.routes || [])
    for (const d of rt.dirs)
      if (d.stop && d.sec != null && d.sec >= 0 && d.sec <= 1800) soon.set(rt.base, Math.min(soon.get(rt.base) ?? Infinity, d.sec));
  const buses = [...soon].map(([n, sec]) => `${n} ${busEta(sec)}`);
  const roadOutages = (L?.outages || []).filter((x) => x.hit === "road");
  const people = state.people || [];
  const home = people.filter((x) => x.home).length;
  const r = state.router;
  const chips = (
    <>
      {people.length > 0 && <Pill icon={HomeIcon} tone={home ? "ok" : undefined}>{home ? `${home} 人在家` : "都出門了"}{arrived && fun && <WalkIn />}</Pill>}
      {state.summary.power != null && <Pill icon={Gauge}>{fmt(state.summary.power)} W</Pill>}
      {r?.configured && <Pill icon={r.ok ? Wifi : WifiOff} tone={r.ok ? undefined : "bad"}>{r.ok ? "網路正常" : "路由器連不上"}</Pill>}
      {g && g.today.length > 0 && (
        <Chip onClick={() => setSheet("life")} icon={Truck} label="垃圾車" moving={!!truck && !truck.none && (truck.stops ?? -1) >= 0}
          sub={truck && !truck.none ? ((truck.stops ?? -1) >= 0 ? `還有 ${truck.stops} 站` : "已經過了") : g.usual ? `約 ${g.usual}` : g.stop.time} />
      )}
      {(L?.bus?.routes.length ?? 0) > 0 && <Chip onClick={() => setSheet("bus")} icon={Bus} label="公車" sub={buses.join("・") || "30 分內沒車"} />}
      {roadOutages[0] && (
        <Chip onClick={() => setSheet("life")} icon={roadOutages[0].kind === "power" ? Zap : Droplets} tone="warn"
          label={`${new Date(roadOutages[0].start).getMonth() + 1}/${new Date(roadOutages[0].start).getDate()} ${roadOutages[0].kind === "power" ? "停電" : "停水"}`}
          sub={roadOutages.length > 1 ? `還有 ${roadOutages.length - 1} 件` : undefined} />
      )}
      {w && w.temp != null && (
        <Chip onClick={() => setSheet("weather")} icon={weatherIcon(w.code, w.obs_text || w.text, w.day)} label={`${fmt(w.temp)}°`}
          sub={`${w.text || w.obs_text || ""}${(w.hourly[0]?.pop ?? 0) >= 30 ? `・降雨 ${w.hourly[0].pop}%` : ""}`} />
      )}
    </>
  );

  return (
    <>
      <PageHeader
        title="我的家"
        sub={<>{onCount ? <b className="font-semibold text-amber-600 dark:text-amber-400">{onCount} 個開著</b> : "全部關著"}・共 {state.plugs.length} 個裝置</>}
        chips={chips}
        actions={
          <Button variant="outline" asChild className="h-9 rounded-full bg-background">
            <a href="#edit" title="排順序、換區域、改情境"><Pencil />編輯</a>
          </Button>
        }
      />
      <div className="mx-auto max-w-7xl px-4 pt-2 sm:px-6 lg:px-8">
        <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-[repeat(auto-fit,minmax(10rem,1fr))]">
          <button
            onClick={() => setAllOff(true)}
            disabled={running === "all"}
            className="flex h-16 items-center gap-3 rounded-xl border bg-card px-4 text-left font-semibold text-destructive shadow-xs transition-all hover:border-destructive/40 hover:bg-destructive/5 hover:shadow-sm active:scale-[.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
          >
            <span className="flex size-9 items-center justify-center rounded-lg bg-destructive/10">
              {running === "all" ? <Loader2 className="size-5 animate-spin" /> : <Power className="size-5" />}
            </span>
            全部關閉
          </button>
          {state.scenes.map((sc) => {
            const I = mdiIcon(sc.icon);
            return (
              <button
                key={sc.id}
                onClick={() => runScene(sc.id, sc.name)}
                disabled={running === sc.id}
                className="flex h-16 items-center gap-3 rounded-xl border bg-card px-4 text-left font-semibold shadow-xs transition-all hover:border-foreground/20 hover:bg-muted/60 hover:shadow-sm active:scale-[.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
              >
                <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-foreground/70">
                  {running === sc.id ? <Loader2 className="size-5 animate-spin" /> : <I className="size-5" />}
                </span>
                <span className="truncate">{sc.name}</span>
              </button>
            );
          })}
        </div>

        <div className="grid items-start gap-4" style={{ gridTemplateColumns: `repeat(${columns.length}, minmax(0, 1fr))` }}>
          {columns.map((c, i) => (
            <div key={i}>
              {c.items.map((grp) => <RoomCard key={grp.id || "none"} g={grp} onOpen={(p) => setDevice(p.id)} onToggle={toggle} />)}
            </div>
          ))}
        </div>
      </div>

      <DeviceSheet id={device} onClose={() => setDevice(null)} />
      <WeatherSheet open={sheet === "weather"} onClose={() => setSheet(null)} />
      <LifeSheet open={sheet === "life" || sheet === "bus"} busFirst={sheet === "bus"} onClose={() => setSheet(null)} />

      <AlertDialog open={allOff} onOpenChange={setAllOff}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>全部關閉？</AlertDialogTitle>
            <AlertDialogDescription className="leading-relaxed">
              會關掉 {onCount} 個開著的插座（設成常開、鎖定的不會關）。關完可以按「復原」恢復。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={doAllOff}>全部關閉</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!confirm} onOpenChange={(v) => !v && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirm && (isOn(confirm) ? `關閉「${confirm.name}」？` : `打開「${confirm.name}」？`)}</AlertDialogTitle>
            <AlertDialogDescription className="leading-relaxed">這個裝置設定了開關前確認，避免誤按。</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={() => confirm && setPower(confirm, !isOn(confirm))}>{confirm && (isOn(confirm) ? "關閉" : "打開")}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

import { useState, useSyncExternalStore } from "react";
import { alertItems } from "@/components/alerts";
import { Bus, DoorOpen, Droplets, Loader2, Moon, Power, Sun, Truck, Umbrella, X, Zap } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/responsive-sheet";
import { needsConfirm } from "@/components/device-sheet";
import { deviceIcon, weatherIcon } from "@/components/icons";
import { api } from "@/lib/api";
import { busEta, fmt, pad2 } from "@/lib/format";
import { useHub } from "@/lib/hub";
import type { HubState, Outage, Plug } from "@/lib/types";
import { cn } from "@/lib/utils";

// 出門時「本來就要開著」的：常開、「出門」情境裡設成不動的
function keepSet(state: HubState) {
  const id = (state.settings.presence as { away_scene?: string | null } | undefined)?.away_scene;
  const sc = id ? state.scenes.find((s) => s.id === id) : undefined;
  return { scene: sc, keep: new Set(Object.entries(sc?.actions || {}).filter(([, a]) => a === "keep").map(([pid]) => pid)) };
}

const ymd = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

// 今天、明天會影響到家裡的停水停電
function soonOutages(state: HubState): { x: Outage; when: string }[] {
  const now = new Date();
  const today = ymd(now);
  const tmr = ymd(new Date(now.getTime() + 86400000));
  return (state.calendar.local?.outages || [])
    .filter((x) => x.hit === "road" && (x.start.slice(0, 10) === today || x.start.slice(0, 10) === tmr) && new Date(x.end) > now)
    .map((x) => ({ x, when: `${x.start.slice(0, 10) === today ? "今天" : "明天"} ${x.start.slice(11, 16)}～${x.end.slice(11, 16)}` }));
}

// 接下來 12 小時最高的降雨機率
function rainSoon(state: HubState) {
  const w = state.calendar.weather_show !== false ? state.calendar.weather : null;
  if (!w) return null;
  const pops = w.hourly.slice(0, 12).map((h) => h.pop ?? 0);
  return { w, pop: Math.max(w.pop_today ?? 0, ...pops) };
}

function Row({ icon: I, tone, title, sub, end }: { icon: React.ElementType; tone?: "warn" | "ok"; title: React.ReactNode; sub?: React.ReactNode; end?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 py-2.5">
      <span className={cn("flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground", tone === "warn" && "bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300", tone === "ok" && "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300")}>
        <I className="size-5" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="font-medium leading-snug">{title}</div>
        {sub && <div className="text-sm leading-relaxed text-muted-foreground">{sub}</div>}
      </div>
      {end}
    </div>
  );
}

// 出門前檢查：還開著的電器、要不要帶傘、垃圾車、停水停電，最後一鍵執行「出門」
export function LeaveSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { state, isOn, setPower } = useHub();
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  if (!state) return null;
  const { scene, keep } = keepSet(state);
  const on = state.plugs.filter((p) => p.online && isOn(p) && !p.keep_on && !keep.has(p.id));
  const kept = state.plugs.filter((p) => p.online && isOn(p) && (p.keep_on || keep.has(p.id)));
  const rain = rainSoon(state);
  const out = soonOutages(state);
  const g = state.calendar.local?.garbage;
  const truck = g?.truck;
  const garbage = g && g.today.length > 0 && !(truck && !truck.none && (truck.stops ?? -1) < 0);

  const off = async (p: Plug) => {
    if (needsConfirm(p, true) && confirm !== p.id) return setConfirm(p.id);
    setConfirm(null);
    setBusy(p.id);
    await setPower(p, false);
    setBusy(null);
  };
  const offAll = async () => {
    const list = on.filter((p) => p.protect !== "lock" && !needsConfirm(p, true));
    setBusy("all");
    await Promise.all(list.map((p) => setPower(p, false)));
    setBusy(null);
    toast.success(`關了 ${list.length} 個`);
  };
  const runScene = async () => {
    if (!scene) return;
    setBusy("scene");
    try {
      const r = await api<{ count: number }>("POST", `/api/scenes/${scene.id}/run`);
      toast.success(r.count ? `「${scene.name}」：改了 ${r.count} 個插座` : `「${scene.name}」：插座本來就是這樣`);
      onClose();
    } catch (e) {
      toast.error("沒有成功", { description: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const WI = rain ? weatherIcon(rain.w.code, rain.w.obs_text || rain.w.text, rain.w.day) : Sun;
  return (
    <Sheet open={open} onOpenChange={(v) => !v && onClose()} title="出門前檢查" icon={<DoorOpen className="size-5" />}
      description={on.length ? `還有 ${on.length} 個電器開著` : "電器都關好了"}>
      <div className="space-y-5">
        <section>
          <h3 className="mb-1 text-sm font-semibold text-muted-foreground">還開著的電器</h3>
          {on.length === 0 ? (
            <Row icon={Power} tone="ok" title="都關好了" sub={kept.length ? `${kept.map((p) => p.name).join("、")} 設定成出門也開著` : undefined} />
          ) : (
            <div className="divide-y">
              {on.map((p) => {
                const I = deviceIcon(p.name);
                const lock = p.protect === "lock";
                return (
                  <Row key={p.id} icon={I} title={p.name} sub={lock ? "已鎖定，要先在裝置詳細解鎖" : undefined}
                    end={!lock && (
                      <Button size="sm" variant={confirm === p.id ? "destructive" : "outline"} disabled={busy === p.id || busy === "all"} onClick={() => off(p)}>
                        {busy === p.id && <Loader2 className="animate-spin" />}{confirm === p.id ? "確定關閉？" : "關閉"}
                      </Button>
                    )} />
                );
              })}
              {kept.length > 0 && <p className="pt-2 text-sm text-muted-foreground">{kept.map((p) => p.name).join("、")} 設定成出門也開著，不用管。</p>}
            </div>
          )}
        </section>

        <section>
          <h3 className="mb-1 text-sm font-semibold text-muted-foreground">外面</h3>
          <div className="divide-y">
            {rain && (
              <Row icon={rain.pop >= 30 ? Umbrella : WI} tone={rain.pop >= 50 ? "warn" : undefined}
                title={rain.pop >= 50 ? "記得帶傘" : rain.pop >= 30 ? "可能會下雨，帶把傘比較保險" : "應該不會下雨"}
                sub={`現在 ${fmt(rain.w.temp)}°・${rain.w.text || rain.w.obs_text || ""}・接下來降雨機率最高 ${rain.pop}%`} />
            )}
            {garbage && (
              <Row icon={Truck} title={`今天收${g!.today.join("、")}`}
                sub={truck && !truck.none && (truck.stops ?? -1) >= 0 ? `垃圾車還有 ${truck.stops} 站${truck.eta_min != null ? `，約 ${truck.eta_min} 分鐘` : ""}` : `大約 ${g!.usual || g!.stop.time} 到「${g!.stop.name}」`} />
            )}
            {out.map(({ x, when }) => (
              <Row key={x.id} icon={x.kind === "power" ? Zap : Droplets} tone="warn" title={`${when} ${x.kind === "power" ? "停電" : "停水"}`} sub={x.reason || undefined} />
            ))}
            {!rain && !garbage && out.length === 0 && <p className="py-2 text-sm text-muted-foreground">沒有要注意的事。</p>}
          </div>
        </section>

        <div className="flex flex-wrap gap-2 border-t pt-4">
          {scene ? (
            <Button className="h-11 flex-1" disabled={busy === "scene"} onClick={runScene}>
              {busy === "scene" ? <Loader2 className="animate-spin" /> : <DoorOpen />}執行「{scene.name}」
            </Button>
          ) : on.length > 0 && (
            <Button className="h-11 flex-1" disabled={busy === "all"} onClick={offAll}>
              {busy === "all" ? <Loader2 className="animate-spin" /> : <Power />}全部關掉
            </Button>
          )}
          {scene && on.length > 0 && (
            <Button variant="outline" className="h-11" disabled={busy === "all"} onClick={offAll}>只關上面這些</Button>
          )}
        </div>
        {!scene && <p className="text-sm text-muted-foreground">在「網路裝置 → 出門與回家」選好出門要執行的情境，這裡就會有一鍵執行的按鈕。</p>}
      </div>
    </Sheet>
  );
}

// 晚安檢查：睡前還開著的電器（常開的、「晚上本來就開著」的不算）、明天的天氣和停水停電
export function NightSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { state, isOn, setPower } = useHub();
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  if (!state) return null;
  const keepIds = new Set(state.settings.goodnight?.keep || []);
  const on = state.plugs.filter((p) => p.online && isOn(p) && !p.keep_on && !keepIds.has(p.id));
  const kept = state.plugs.filter((p) => p.online && isOn(p) && (p.keep_on || keepIds.has(p.id)));
  const w = state.calendar.weather_show !== false ? state.calendar.weather : null;
  const now = new Date();
  // 半夜 12 點以後按的「明天」就是今天
  const day = now.getHours() < 5 ? now : new Date(now.getTime() + 86400000);
  const word = now.getHours() < 5 ? "今天" : "明天";
  const tmr = w?.daily.find((d) => d.date.slice(0, 10) === ymd(day));
  const out = (state.calendar.local?.outages || []).filter((x) => x.hit === "road" && x.start.slice(0, 10) === ymd(day));

  const off = async (p: Plug) => {
    if (needsConfirm(p, true) && confirm !== p.id) return setConfirm(p.id);
    setConfirm(null);
    setBusy(p.id);
    await setPower(p, false);
    setBusy(null);
  };
  const offAll = async () => {
    const list = on.filter((p) => p.protect !== "lock" && !needsConfirm(p, true));
    setBusy("all");
    await Promise.all(list.map((p) => setPower(p, false)));
    setBusy(null);
    const left = on.length - list.length;
    toast.success(`關了 ${list.length} 個${left ? `，還有 ${left} 個要自己確認` : ""}`);
    if (!left) onClose();
  };
  const TI = tmr ? weatherIcon(tmr.code, tmr.text, 1) : Sun;
  return (
    <Sheet open={open} onOpenChange={(v) => !v && onClose()} title="晚安" icon={<Moon className="size-5" />}
      description={on.length ? `還有 ${on.length} 個電器開著` : "電器都關好了，晚安"}>
      <div className="space-y-5">
        <section>
          <h3 className="mb-1 text-sm font-semibold text-muted-foreground">還開著的電器</h3>
          {on.length === 0 ? (
            <Row icon={Power} tone="ok" title="都關好了" sub={kept.length ? `${kept.map((p) => p.name).join("、")} 設定成晚上也開著` : undefined} />
          ) : (
            <div className="divide-y">
              {on.map((p) => {
                const I = deviceIcon(p.name);
                const lock = p.protect === "lock";
                return (
                  <Row key={p.id} icon={I} tone={p.risky ? "warn" : undefined} title={p.name} sub={lock ? "已鎖定，要先在裝置詳細解鎖" : p.risky ? "高風險電器" : undefined}
                    end={!lock && (
                      <Button size="sm" variant={confirm === p.id ? "destructive" : "outline"} disabled={busy === p.id || busy === "all"} onClick={() => off(p)}>
                        {busy === p.id && <Loader2 className="animate-spin" />}{confirm === p.id ? "確定關閉？" : "關閉"}
                      </Button>
                    )} />
                );
              })}
              {kept.length > 0 && <p className="pt-2 text-sm text-muted-foreground">{kept.map((p) => p.name).join("、")} 設定成晚上也開著，不用管。</p>}
            </div>
          )}
        </section>

        <section>
          <h3 className="mb-1 text-sm font-semibold text-muted-foreground">{word}</h3>
          <div className="divide-y">
            {tmr && (
              <Row icon={(tmr.pop ?? 0) >= 50 ? Umbrella : TI} tone={(tmr.pop ?? 0) >= 50 ? "warn" : undefined}
                title={`${tmr.text || "天氣"}・${fmt(tmr.min)}–${fmt(tmr.max)}°`}
                sub={tmr.pop != null ? `降雨機率 ${tmr.pop}%${tmr.pop >= 50 ? "，傘先放門口" : ""}` : undefined} />
            )}
            {out.map((x) => (
              <Row key={x.id} icon={x.kind === "power" ? Zap : Droplets} tone="warn" title={`${x.start.slice(11, 16)}～${x.end.slice(11, 16)} ${x.kind === "power" ? "停電" : "停水"}`}
                sub={x.kind === "power" ? "手機先充電" : "先儲水"} />
            ))}
            {!tmr && out.length === 0 && <p className="py-2 text-sm text-muted-foreground">沒有要注意的事。</p>}
          </div>
        </section>

        {on.length > 0 && (
          <div className="border-t pt-4">
            <Button className="h-11 w-full" disabled={busy === "all"} onClick={offAll}>
              {busy === "all" ? <Loader2 className="animate-spin" /> : <Moon />}全部關掉，晚安
            </Button>
          </div>
        )}
        <p className="text-sm text-muted-foreground">在「設定 → 晚安檢查」可以設定每天幾點自動檢查、哪些電器晚上本來就開著。</p>
      </div>
    </Sheet>
  );
}

// ---- 早上的首頁：5 點到 10 點半，最上面一張「早安」卡（今天可以收起來） ----

const MORNING_KEY = "morning_hidden";
const subs = new Set<() => void>();
const hiddenToday = () => {
  try {
    return localStorage.getItem(MORNING_KEY) === new Date().toDateString();
  } catch {
    return false;
  }
};
function hideToday() {
  try {
    localStorage.setItem(MORNING_KEY, new Date().toDateString());
  } catch { /* 存不了就只收這一次 */ }
  subs.forEach((f) => f());
}
const useHidden = () => useSyncExternalStore((f) => (subs.add(f), () => subs.delete(f)), hiddenToday);

export const isMorning = (d = new Date()) => d.getHours() * 60 + d.getMinutes() >= 300 && d.getHours() * 60 + d.getMinutes() < 630;

export function MorningCard({ onLeave, onSheet }: { onLeave: () => void; onSheet: (s: "weather" | "garbage" | "bus" | "outage") => void }) {
  const { state, isOn, now } = useHub();
  const hidden = useHidden();
  if (!state || hidden || !isMorning(new Date(now() * 1000))) return null;
  const w = state.calendar.weather_show !== false ? state.calendar.weather : null;
  const today = w?.daily[0];
  const rain = rainSoon(state);
  const g = state.calendar.local?.garbage;
  const out = soonOutages(state);
  const { keep } = keepSet(state);
  const on = state.plugs.filter((p) => p.online && isOn(p) && !p.keep_on && !keep.has(p.id)).length;
  const bus: [string, number][] = [];
  for (const rt of state.calendar.local?.bus?.routes || [])
    for (const d of rt.dirs) if (d.stop && d.sec != null && d.sec >= 0 && d.sec <= 1800) bus.push([rt.base, d.sec]);
  bus.sort((a, b) => a[1] - b[1]);

  const items: { key: string; icon: React.ElementType; text: React.ReactNode; warn?: boolean; onClick?: () => void }[] = [];
  for (const a of alertItems(state)) items.push({ key: a.key, icon: a.icon, warn: a.warn, text: a.sub ? `${a.label}・${a.sub}` : a.label, onClick: () => { location.hash = "life"; } });
  if (w) {
    const WI = weatherIcon(w.code, w.obs_text || w.text, w.day);
    items.push({ key: "wx", icon: WI, onClick: () => onSheet("weather"),
      text: <>{fmt(w.temp)}°{today && today.max != null && today.min != null ? <span className="ml-1 text-muted-foreground">{fmt(today.min)}–{fmt(today.max)}°</span> : null}{w.text ? <span className="ml-1">{w.text}</span> : null}</> });
  }
  if (rain && rain.pop >= 30) items.push({ key: "rain", icon: Umbrella, warn: rain.pop >= 50, text: `降雨機率 ${rain.pop}%，記得帶傘`, onClick: () => onSheet("weather") });
  if (g && g.today.length > 0) items.push({ key: "tr", icon: Truck, text: `今天收${g.today.join("、")}・約 ${g.usual || g.stop.time}`, onClick: () => onSheet("garbage") });
  if (bus.length) items.push({ key: "bus", icon: Bus, text: bus.slice(0, 2).map(([n, s]) => `${n} ${busEta(s)}`).join("・"), onClick: () => onSheet("bus") });
  for (const { x, when } of out) items.push({ key: x.id, icon: x.kind === "power" ? Zap : Droplets, warn: true, text: `${when} ${x.kind === "power" ? "停電" : "停水"}`, onClick: () => onSheet("outage") });

  return (
    <div className="mb-5 rounded-xl border bg-card p-4 shadow-xs sm:p-5">
      <div className="mb-3 flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-lg font-bold tracking-tight">早安</div>
          <div className="text-sm text-muted-foreground">出門前看一眼{on ? `・還有 ${on} 個電器開著` : ""}</div>
        </div>
        <Button className="h-10" onClick={onLeave}><DoorOpen />出門前檢查</Button>
        <Button size="icon" variant="ghost" className="size-10 text-muted-foreground" onClick={hideToday} aria-label="今天先收起來" title="今天先收起來"><X /></Button>
      </div>
      {items.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {items.map((it) => (
            <button key={it.key} onClick={it.onClick}
              className={cn("inline-flex min-h-9 items-center gap-2 rounded-lg border px-3 py-1.5 text-left text-sm transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                it.warn && "border-red-300 text-red-700 dark:border-red-500/40 dark:text-red-300")}>
              <it.icon className="size-4 shrink-0" />{it.text}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

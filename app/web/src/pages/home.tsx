import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { DndContext, KeyboardSensor, PointerSensor, closestCorners, useDroppable, useSensor, useSensors, type DragEndEvent, type DragOverEvent } from "@dnd-kit/core";
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Bike, Bus, Clock, DoorOpen, MessageSquareText, Droplets, Gauge, Home as HomeIcon, Loader2, Pencil, Power, Truck, Wifi, WifiOff, Zap } from "lucide-react";
import { toast } from "sonner";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/app-shell";
import { useAsk } from "@/components/ask-sheet";
import { DeviceSheet, needsConfirm } from "@/components/device-sheet";
import { WalkIn, playFx, useFun } from "@/components/fx";
import { mdiIcon, weatherIcon } from "@/components/icons";
import { AskPanel, EnergyPanel, NextPanel, PeoplePanel } from "@/components/home-side";
import { LeaveSheet, MorningCard } from "@/components/leave-check";
import { alertItems } from "@/components/alerts";
import { LifeSheet, type LifeTopic } from "@/components/life-sheet";
import { RoomCard, type DragHandle, type Group } from "@/components/room-card";
import { WeatherSheet } from "@/components/weather-sheet";
import { api } from "@/lib/api";
import { busEta, busIdle, dayLabel, dayPart, fmt, nextPickup, pad2 } from "@/lib/format";
import { useHub, useMedia, useTick } from "@/lib/hub";
import { useLook } from "@/lib/look";
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
        tone === "warn" && "border-red-300 dark:border-red-500/40",
      )}
    >
      <I className={cn("size-4.5", tone === "warn" ? "text-red-600 dark:text-red-400" : "text-foreground/60", moving && "truck-run text-amber-600")} />
      <span className="font-medium">{label}</span>
      {sub && <span className="text-muted-foreground">{sub}</span>}
    </button>
  );
}

// 首頁房間卡片的排列（存在樹莓派上）：{欄數: [[區域 id…], …]}，沒分區域的那張是 "_none"
type HomeLayout = Record<string, string[][]>;
const NONE = "_none";
const gid = (g: Group) => g.id || NONE;
const hgt = (g: Group) => 1.4 + g.plugs.length;

// 可以拖的房間卡片：抓標題列拖
function SortRoom({ g, onOpen, onToggle }: { g: Group; onOpen: (p: Plug) => void; onToggle: (p: Plug) => void }) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: gid(g) });
  return (
    <div ref={setNodeRef} style={{ transform: CSS.Translate.toString(transform), transition }} className={cn(isDragging && "relative z-10")}>
      <RoomCard g={g} onOpen={onOpen} onToggle={onToggle} className={cn(isDragging && "opacity-90 shadow-xl ring-2 ring-primary")}
        handle={{ ref: setActivatorNodeRef, props: { ...attributes, ...listeners, title: "拖拉標題可以換位置", "aria-label": `拖拉移動「${g.name}」（或按空白鍵後用方向鍵）` } }} />
    </div>
  );
}

// 右邊那一欄：抓標題列上下換順序
type SideId = "ask" | "people" | "energy" | "next";
const SIDE_DEFAULT: SideId[] = ["ask", "people", "energy", "next"];
const SIDE_NAMES: Record<SideId, string> = { ask: "問家裡", people: "誰在家", energy: "今天用電", next: "接下來" };

function SortSide({ id, children }: { id: SideId; children: (handle: DragHandle, dragging: boolean) => React.ReactNode }) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id });
  return (
    <div ref={setNodeRef} style={{ transform: CSS.Translate.toString(transform), transition }} className={cn(isDragging && "relative z-10")}>
      {children({ ref: setActivatorNodeRef, props: { ...attributes, ...listeners, title: "拖拉標題可以換位置", "aria-label": `拖拉移動「${SIDE_NAMES[id]}」（或按空白鍵後用方向鍵）` } }, isDragging)}
    </div>
  );
}

function RoomColumn({ id, children, dragging, empty }: { id: string; children: React.ReactNode; dragging: boolean; empty: boolean }) {
  const { setNodeRef, isOver } = useDroppable({ id });
  return (
    <div ref={setNodeRef} className={cn("min-w-0", dragging && "min-h-24")}>
      {children}
      {dragging && empty && (
        <div className={cn("flex h-24 items-center justify-center rounded-xl border-2 border-dashed text-sm text-muted-foreground", isOver && "border-primary bg-primary/5")}>拖到這裡</div>
      )}
    </div>
  );
}

function HomeSkeleton() {
  return (
    <div className="mx-auto max-w-[112rem] space-y-5 px-4 py-4 sm:px-6 lg:px-8" aria-busy="true" aria-label="載入中">
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
  const { state, failed, isOn, setPower, now } = useHub();
  const ask = useAsk();
  useTick(30000);
  const [device, setDevice] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Plug | null>(null);
  const [allOff, setAllOff] = useState(false);
  const [sheet, setSheet] = useState<"weather" | LifeTopic | null>(null);
  const [leave, setLeave] = useState(false);
  const [running, setRunning] = useState<string | null>(null);
  // 有人回家：在家人數變多的時候，小人走進門幾秒
  const fun = useFun();
  const look = useLook();
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
  // 房間欄數：看放房間的那塊有多寬，一欄至少 20rem，放得下幾欄就幾欄
  const [gridW, setGridW] = useState(0);
  const roRef = useRef<ResizeObserver | null>(null);
  const gridRef = (el: HTMLDivElement | null) => {
    roRef.current?.disconnect();
    roRef.current = null;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setGridW(Math.round(e.contentRect.width)));
    ro.observe(el);
    roRef.current = ro;
  };
  // 大螢幕：情境按鈕縮小放進標題列。標題、情境、狀態、按鈕一行放得下才這樣，放不下就維持原本的大按鈕
  const [compact, setCompact] = useState(false);
  const sceneRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const fit = () => {
      const row = document.querySelector<HTMLElement>(".page-header > div");
      const sc = sceneRef.current;
      if (!row || !sc) return;
      if (window.innerWidth < 1280) return setCompact(false);
      const w = (sel: string) => row.querySelector<HTMLElement>(`:scope > [data-ph="${sel}"]`)?.offsetWidth ?? 0;
      const chipsEl = row.querySelector<HTMLElement>(':scope > [data-ph="chips"]');
      const own = chipsEl ? [...chipsEl.children].filter((x) => !(x as HTMLElement).dataset.scene) as HTMLElement[] : [];
      const chipsW = own.reduce((a, x) => a + x.offsetWidth, 0) + Math.max(0, own.length - 1) * 8;
      const cs = getComputedStyle(row);
      const inner = row.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      const need = w("title") + w("actions") + chipsW + sc.offsetWidth + 8 + 1 + 8 + 32 + 16;
      setCompact(need <= inner);
    };
    fit();
    const row = document.querySelector<HTMLElement>(".page-header > div");
    if (!row) return;
    const ro = new ResizeObserver(fit);
    ro.observe(row);
    return () => ro.disconnect();
  });
  const wideSide = useMedia("(min-width: 1280px)"); // 科技感：這麼寬才有右邊那一欄
  const side = look === "tech" && wideSide;
  const cols = gridW ? Math.max(1, Math.floor((gridW + 16) / (20 * 16 + 16))) : 1;
  useEffect(() => {
    if (!side) return;
    document.documentElement.dataset.askPanel = "1";
    return () => { delete document.documentElement.dataset.askPanel; };
  }, [side]);

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

  // 自己排過的照排好的位置放；沒排過的（或新的區域）照高度（插座數）分到最矮的那一欄
  const serverLayout = state?.settings.home_layout as HomeLayout | undefined;
  const serverKey = JSON.stringify(serverLayout || null);
  // 剛拖完、伺服器還沒回來之前先用自己的（伺服器的排列一變就以伺服器為準）
  const [local, setLocal] = useState<{ base: string; lay: HomeLayout } | null>(null);
  const layout = local && local.base === serverKey ? local.lay : serverLayout;
  const nCols = Math.min(cols, Math.max(1, groups.length));
  const custom = nCols >= 2 ? layout?.[String(nCols)] : undefined;
  const columns = useMemo(() => {
    const cs = Array.from({ length: nCols }, () => ({ h: 0, items: [] as Group[] }));
    const byId = new Map(groups.map((g) => [gid(g), g]));
    const placed = new Set<string>();
    custom?.slice(0, nCols).forEach((ids, i) => {
      for (const id of ids) {
        const g = byId.get(id);
        if (!g || placed.has(id)) continue;
        cs[i].items.push(g);
        cs[i].h += hgt(g);
        placed.add(id);
      }
    });
    for (const g of groups) {
      if (placed.has(gid(g))) continue;
      const c = cs.reduce((a, b) => (b.h < a.h ? b : a));
      c.items.push(g);
      c.h += hgt(g);
    }
    return cs;
  }, [groups, nCols, custom]);
  const putLayout = (body: Record<string, unknown>) =>
    api("PUT", "/api/settings", body).catch((err) => toast.error("排列沒有存起來", { description: (err as Error).message }));
  const saveLayout = (n: number, next: string[][] | null) => {
    const lay = { ...(layout || {}) };
    if (next) lay[String(n)] = next;
    else delete lay[String(n)];
    setLocal({ base: serverKey, lay });
    putLayout({ home_layout: { [String(n)]: next } });
  };

  // 右邊那一欄的順序
  const serverSide = state?.settings.home_side as SideId[] | undefined;
  const sideKey = JSON.stringify(serverSide || null);
  const [localSide, setLocalSide] = useState<{ base: string; order: SideId[] | null } | null>(null);
  const sideOrder = (localSide && localSide.base === sideKey ? localSide.order : serverSide) || SIDE_DEFAULT;
  const saveSide = (order: SideId[] | null) => {
    setLocalSide({ base: sideKey, order });
    putLayout({ home_side: order });
  };

  // 拖拉：有滑鼠、而且不只一欄才能拖（手機、平板照常捲動）
  const mouse = useMedia("(pointer: fine)");
  const canDrag = mouse && nCols >= 2;
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  const [dragCols, setDragCols] = useState<string[][] | null>(null);
  const idCols = columns.map((c) => c.items.map(gid));
  const curCols = dragCols || idCols;
  const colOf = (cs: string[][], id: string) => (id.startsWith("col-") ? Number(id.slice(4)) : cs.findIndex((c) => c.includes(id)));
  const onDragOver = ({ active, over }: DragOverEvent) => {
    if (!over) return;
    const from = colOf(curCols, String(active.id)), to = colOf(curCols, String(over.id));
    if (from < 0 || to < 0 || from === to) return;
    const c = curCols.map((x) => [...x]);
    c[from] = c[from].filter((x) => x !== active.id);
    const at = String(over.id).startsWith("col-") ? c[to].length : Math.max(0, c[to].indexOf(String(over.id)));
    c[to].splice(at, 0, String(active.id));
    setDragCols(c);
  };
  const onSideEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const a = sideOrder.indexOf(active.id as SideId), b = sideOrder.indexOf(over.id as SideId);
    if (a >= 0 && b >= 0) saveSide(arrayMove(sideOrder, a, b));
  };
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    let c = curCols.map((x) => [...x]);
    if (over && !String(over.id).startsWith("col-")) {
      const ci = colOf(c, String(active.id));
      const a = c[ci].indexOf(String(active.id)), b = c[ci].indexOf(String(over.id));
      if (b >= 0 && a !== b) c = c.map((x, i) => (i === ci ? arrayMove(x, a, b) : x));
    }
    setDragCols(null);
    if (JSON.stringify(c) !== JSON.stringify(idCols)) saveLayout(nCols, c);
  };

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
        <PageHeader title="我的家" hideTitle />
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
  // 沒有車的時候說清楚是哪一種：收班了、還沒發車，還是只是 30 分鐘內沒有
  const noBus = busIdle(L?.bus?.routes || []);
  const bikeMain = L?.bike?.show ? L.bike.near.find((x) => x.sno === L.bike!.main) : undefined;
  const roadOutages = (L?.outages || []).filter((x) => x.hit === "road");
  const people = state.people || [];
  const home = people.filter((x) => x.home).length;
  const r = state.router;
  const alerts = alertItems(state);
  const toLife = () => { location.hash = "life"; };
  const chips = (
    <>
      {alerts.map((a) => <Chip key={a.key} onClick={toLife} icon={a.icon} label={a.label} sub={a.sub} tone={a.warn ? "warn" : undefined} />)}
      {people.length > 0 && <Pill icon={HomeIcon} tone={home ? "ok" : undefined}>{home ? `${home} 人在家` : "都出門了"}{arrived && fun && <WalkIn />}</Pill>}
      {state.summary.power != null && <Pill icon={Gauge}>{fmt(state.summary.power)} W</Pill>}
      {r?.configured && <Pill icon={r.ok ? Wifi : WifiOff} tone={r.ok ? undefined : "bad"}>{r.ok ? "網路正常" : "路由器連不上"}</Pill>}
      {g && !(g.today.length > 0 && !g.done) && nextPickup(g) && (
        <Chip onClick={() => setSheet("garbage")} icon={Truck} label="垃圾車" sub={nextPickup(g)} />
      )}
      {g && g.today.length > 0 && !g.done && (
        <Chip onClick={() => setSheet("garbage")} icon={Truck} label="垃圾車" moving={!!truck && !truck.none && (truck.stops ?? -1) >= 0}
          sub={truck && !truck.none ? ((truck.stops ?? -1) >= 0 ? `還有 ${truck.stops} 站` : "已經過了") : `${dayPart(g.usual || g.stop.time)} ${g.usual ? "約 " : ""}${g.usual || g.stop.time}`} />
      )}
      {(L?.bus?.routes.length ?? 0) > 0 && <Chip onClick={() => setSheet("bus")} icon={Bus} label="公車" sub={buses.join("・") || noBus} />}
      {bikeMain && (
        <Chip onClick={() => setSheet("bike")} icon={Bike} label="YouBike" tone={bikeMain.ok && bikeMain.bikes > 0 ? undefined : "warn"}
          sub={!bikeMain.ok ? `${bikeMain.name} 暫停` : `${bikeMain.name} ${bikeMain.bikes ? `${bikeMain.bikes} 台` : "沒車"}`} />
      )}
      {roadOutages[0] && (
        <Chip onClick={() => setSheet("outage")} icon={roadOutages[0].kind === "power" ? Zap : Droplets} tone="warn"
          label={`${new Date(roadOutages[0].start).getMonth() + 1}/${new Date(roadOutages[0].start).getDate()} ${roadOutages[0].kind === "power" ? "停電" : "停水"}`}
          sub={roadOutages.length > 1 ? `還有 ${roadOutages.length - 1} 件` : undefined} />
      )}
      {w && w.temp != null && (
        <Chip onClick={() => setSheet("weather")} icon={weatherIcon(w.code, w.obs_text || w.text, w.day)} label={`${fmt(w.temp)}°`}
          sub={`${w.text || w.obs_text || ""}${(w.hourly[0]?.pop ?? 0) >= 30 ? `・降雨 ${w.hourly[0].pop}%` : ""}`} />
      )}
    </>
  );

  // 「科技感」外觀：上面那排小按鈕改成標題右邊的一行（資訊和點了會開的面板都一樣）
  const soonList = [...soon].sort((a, b) => a[1] - b[1]);
  const items: React.ReactNode[] = [];
  const it = (key: string, I: React.ElementType, body: React.ReactNode, opts: { onClick?: () => void; href?: string; tone?: "acc" | "on" | "warn" | "ok"; title: string }) => {
    const cls = cn(
      "tech-item",
      opts.tone === "acc" && "[&_b]:text-primary",
      opts.tone === "on" && "tech-item-on",
      opts.tone === "warn" && "tech-item-warn",
      opts.tone === "ok" && "[&_b]:text-emerald-600 dark:[&_b]:text-emerald-400",
    );
    const inner = <><I className="size-4 shrink-0" />{body}</>;
    items.push(opts.href ? <a key={key} href={opts.href} title={opts.title} className={cls}>{inner}</a> : <button key={key} onClick={opts.onClick} title={opts.title} className={cls}>{inner}</button>);
  };
  for (const a of alerts)
    it(`al-${a.key}`, a.icon, <><b className="!font-sans !text-[14px]">{a.label}</b>{a.sub && <span className="tech-item-sub">{a.sub}</span>}</>, { href: "#life", tone: a.warn ? "warn" : "on", title: a.title });
  if (state.summary.power != null)
    it("pw", Zap, <><b>{fmt(state.summary.power)}</b><small>W</small><span className="tech-item-sub max-2xl:hidden">今天 {fmt(state.summary.energy_today, 1)} 度</span></>, { href: "#energy", tone: "acc", title: `即時用電；今天 ${fmt(state.summary.energy_today, 1)} 度・$${fmt(state.summary.cost_today)}` });
  if (w && w.temp != null) {
    const WI = weatherIcon(w.code, w.obs_text || w.text, w.day);
    const rain = (w.hourly[0]?.pop ?? 0) >= 30 ? `降雨 ${w.hourly[0].pop}%` : "";
    it("wx", WI, <><b>{fmt(w.temp)}°</b><span className="tech-item-sub">{rain || w.text || w.obs_text}</span></>, { onClick: () => setSheet("weather"), title: `天氣：${w.text || w.obs_text || ""}${rain ? `・${rain}` : ""}` });
  }
  const nextReal = g?.next.find((x) => !x.off);
  if (g && !(g.today.length > 0 && !g.done) && nextReal) {
    it("tr", Truck, <><b>{g.usual || g.stop.time}</b><span className="tech-item-sub">{dayLabel(nextReal.date)}</span></>,
      { onClick: () => setSheet("garbage"), title: `垃圾車：下一次${nextPickup(g)}` });
  } else if (g && g.today.length > 0 && !g.done) {
    const coming = !!truck && !truck.none && (truck.stops ?? -1) >= 0;
    const passed = !!truck && !truck.none && !coming;
    it("tr", Truck, coming ? <><b>{truck!.stops}</b><small>站</small>{truck!.eta_min != null && <span className="tech-item-sub">約 {truck!.eta_min} 分</span>}</> : <b>{passed ? "已過" : g.usual || g.stop.time}</b>,
      { onClick: () => setSheet("garbage"), tone: coming ? "on" : undefined, title: `垃圾車：${g.today.join("、")}` });
  }
  if ((L?.bus?.routes.length ?? 0) > 0)
    it("bus", Bus, soonList[0] ? <><span className="tech-item-sub !ml-0">{soonList[0][0]}</span><b>{soonList[0][1] < 60 ? "進站" : Math.round(soonList[0][1] / 60)}</b>{soonList[0][1] >= 60 && <small>分</small>}</> : <span className="tech-item-sub !ml-0">{noBus}</span>,
      { onClick: () => setSheet("bus"), title: soonList.map(([n, sec]) => `${n} ${busEta(sec)}`).join("・") || `公車：${noBus}` });
  if (bikeMain)
    it("yb", Bike, bikeMain.ok ? <><b>{bikeMain.bikes}</b><small>台</small></> : <b>暫停</b>,
      { onClick: () => setSheet("bike"), tone: !bikeMain.ok || !bikeMain.bikes ? "warn" : undefined, title: `YouBike ${bikeMain.name}・${bikeMain.m} 公尺・空位 ${bikeMain.docks}` });
  if (people.length > 0)
    it("pp", HomeIcon, <><b>{home}</b><small>人</small>{arrived && fun && <WalkIn />}</>, { href: "#net", tone: home ? "ok" : undefined, title: home ? `${home} 人在家` : "都出門了" });
  if (r?.configured && !r.ok) it("net", WifiOff, <b>路由器連不上</b>, { href: "#net", tone: "warn", title: r.error || "路由器連不上" });
  if (roadOutages[0]) {
    const d0 = new Date(roadOutages[0].start);
    it("out", roadOutages[0].kind === "power" ? Zap : Droplets, <><b>{d0.getMonth() + 1}/{d0.getDate()}</b><span className="tech-item-sub">{roadOutages[0].kind === "power" ? "停電" : "停水"}{roadOutages.length > 1 ? ` 等 ${roadOutages.length} 件` : ""}</span></>,
      { onClick: () => setSheet("outage"), tone: "warn", title: `${roadOutages[0].kind === "power" ? "停電" : "停水"} ${d0.getMonth() + 1}/${d0.getDate()} ${pad2(d0.getHours())}:${pad2(d0.getMinutes())}` });
  }

  const pill = cn(
    "inline-flex h-9 shrink-0 items-center gap-1.5 border bg-card px-3 text-[13px] font-semibold shadow-xs transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60",
    look === "tech" ? "rounded-[10px]" : "rounded-full",
  );
  const sceneBar = (
    <div ref={sceneRef} data-scene="1" className="flex shrink-0 items-center gap-2" role="group" aria-label="情境">
      <button onClick={() => setAllOff(true)} disabled={running === "all"} className={cn(pill, "text-destructive hover:border-destructive/40 hover:bg-destructive/5")}>
        {running === "all" ? <Loader2 className="size-4 animate-spin" /> : <Power className="size-4" />}全部關閉
      </button>
      {state.scenes.map((sc) => {
        const I = mdiIcon(sc.icon);
        return (
          <button key={sc.id} onClick={() => runScene(sc.id, sc.name)} disabled={running === sc.id} className={pill}>
            {running === sc.id ? <Loader2 className="size-4 animate-spin" /> : <I className="size-4 text-foreground/70" />}
            <span className="max-w-32 truncate">{sc.name}</span>
          </button>
        );
      })}
    </div>
  );
  const sep = <span key="sep" data-scene="1" aria-hidden className="ml-auto h-6 w-px shrink-0 bg-border" />;
  const headChips = look === "tech" ? items : chips;

  return (
    <>
      <PageHeader
        title="我的家"
        hideTitle
        lead={state.assistant ? (
          <button onClick={ask.open} className="flex h-9 w-full items-center gap-2 rounded-full border bg-background px-3.5 text-left text-sm text-muted-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <MessageSquareText className="size-4 shrink-0 text-primary" /><span className="truncate">問家裡…</span>
          </button>
        ) : undefined}
        chips={compact ? <>{sceneBar}{sep}{headChips}</> : headChips}
        chipsClassName={compact ? "xl:justify-start" : look === "tech" ? "xl:justify-start xl:[&>:first-child]:ml-auto" : undefined}
        actions={<>
          <Button variant="outline" className="h-9 rounded-full bg-background" onClick={() => setLeave(true)} title="出門前檢查：還開著的電器、要不要帶傘、垃圾車、停水停電">
            <DoorOpen /><span className="max-sm:sr-only">出門前檢查</span>
          </Button>
          {/* 手機、平板的下方分頁沒有「排程」，從這裡進 */}
          <Button variant="outline" asChild className="h-9 rounded-full bg-background lg:hidden">
            <a href="#schedule" title="排程"><Clock /><span className="sr-only">排程</span></a>
          </Button>
          <Button variant="outline" asChild className="h-9 rounded-full bg-background">
            <a href="#edit" title="排順序、換區域、改情境"><Pencil />編輯</a>
          </Button>
        </>}
      />
      <div className="mx-auto max-w-[112rem] px-4 pt-2 sm:px-6 lg:px-8">
        <MorningCard onLeave={() => setLeave(true)} onSheet={setSheet} />
        {/* 不放進標題列時：在畫面外量情境按鈕要多寬，用來判斷放不放得下 */}
        {!compact && <div aria-hidden className="pointer-events-none invisible fixed top-0 -left-[9999px]">{sceneBar}</div>}
        {!compact && <div className="mb-5 grid grid-cols-4 gap-2 sm:grid-cols-[repeat(auto-fit,minmax(10rem,1fr))] sm:gap-3">
          <button
            onClick={() => setAllOff(true)}
            disabled={running === "all"}
            className="flex flex-col items-center justify-center gap-1.5 rounded-xl border bg-card px-1 py-2.5 text-[13px] font-semibold text-destructive sm:h-16 sm:flex-row sm:justify-start sm:gap-3 sm:px-4 sm:py-0 sm:text-left sm:text-base shadow-xs transition-all hover:border-destructive/40 hover:bg-destructive/5 hover:shadow-sm active:scale-[.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
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
                className="flex min-w-0 flex-col items-center justify-center gap-1.5 rounded-xl border bg-card px-1 py-2.5 text-[13px] font-semibold shadow-xs sm:h-16 sm:flex-row sm:justify-start sm:gap-3 sm:px-4 sm:py-0 sm:text-left sm:text-base transition-all hover:border-foreground/20 hover:bg-muted/60 hover:shadow-sm active:scale-[.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
              >
                <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-foreground/70">
                  {running === sc.id ? <Loader2 className="size-5 animate-spin" /> : <I className="size-5" />}
                </span>
                <span className="max-w-full truncate">{sc.name}</span>
              </button>
            );
          })}
        </div>}

        <div className={cn(side && "grid grid-cols-[minmax(0,1fr)_20rem] items-start gap-4")}>
          <div className="min-w-0">
            <div ref={gridRef} className="grid items-start gap-4" style={{ gridTemplateColumns: `repeat(${columns.length}, minmax(0, 1fr))` }}>
              {canDrag ? (
                <DndContext sensors={sensors} collisionDetection={closestCorners} onDragStart={() => setDragCols(idCols)} onDragOver={onDragOver} onDragEnd={onDragEnd} onDragCancel={() => setDragCols(null)}>
                  {curCols.map((ids, i) => (
                    <SortableContext key={i} id={`col-${i}`} items={ids} strategy={verticalListSortingStrategy}>
                      <RoomColumn id={`col-${i}`} dragging={!!dragCols} empty={!ids.length}>
                        {ids.map((id) => {
                          const grp = groups.find((x) => gid(x) === id);
                          return grp ? <SortRoom key={id} g={grp} onOpen={(p) => setDevice(p.id)} onToggle={toggle} /> : null;
                        })}
                      </RoomColumn>
                    </SortableContext>
                  ))}
                </DndContext>
              ) : (
                columns.map((c, i) => (
                  <div key={i} className="min-w-0">
                    {c.items.map((grp) => <RoomCard key={gid(grp)} g={grp} onOpen={(p) => setDevice(p.id)} onToggle={toggle} />)}
                  </div>
                ))
              )}
            </div>
          </div>
          {look === "tech" && (() => {
            const panel = (id: SideId, handle?: DragHandle, dragging?: boolean) => {
              const cls = cn(dragging && "shadow-xl ring-2 ring-primary");
              return id === "ask" ? <AskPanel handle={handle} className={cls} />
                : id === "people" ? <PeoplePanel state={state} now={now()} handle={handle} className={cls} />
                : id === "energy" ? <EnergyPanel state={state} handle={handle} className={cls} />
                : <NextPanel state={state} now={now()} handle={handle} className={cls} />;
            };
            // 沒設定 AI 的話沒有「問家裡」；沒設定家人沒有「誰在家」；不夠寬（沒有右邊那一欄）也不放「問家裡」
            const ids = sideOrder.filter((id) => (id !== "ask" || (side && state.assistant)) && (id !== "people" || people.length > 0));
            return side && mouse ? (
              <DndContext sensors={sensors} collisionDetection={closestCorners} onDragEnd={onSideEnd}>
                <SortableContext items={ids} strategy={verticalListSortingStrategy}>
                  <div className="grid gap-4">
                    {ids.map((id) => <SortSide key={id} id={id}>{(h, d) => panel(id, h, d)}</SortSide>)}
                  </div>
                </SortableContext>
              </DndContext>
            ) : (
              <div className={cn("grid gap-4", side ? "" : "sm:grid-cols-2")}>
                {ids.map((id) => <div key={id} className="min-w-0">{panel(id)}</div>)}
              </div>
            );
          })()}
        </div>
      </div>

      <DeviceSheet id={device} onClose={() => setDevice(null)} />
      <LeaveSheet open={leave} onClose={() => setLeave(false)} />
      <WeatherSheet open={sheet === "weather"} onClose={() => setSheet(null)} />
      <LifeSheet open={!!sheet && sheet !== "weather"} topic={sheet && sheet !== "weather" ? sheet : undefined} onClose={() => setSheet(null)} />

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

import { useState } from "react";
import { ArrowRight, CalendarClock, ChartColumn, CircleAlert, GripVertical, MapPin, Sparkles, Timer, Users } from "lucide-react";
import { toast } from "sonner";
import { PersonSheet, personStatus } from "@/components/person-sheet";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { Card } from "@/components/ui/card";
import { useAsk } from "@/components/ask-sheet";
import type { DragHandle } from "@/components/room-card";
import { CollapseBtn } from "@/components/collapse-btn";
import { useCollapsed } from "@/lib/collapse";
import { fmt, fmtDur, fmtLeft } from "@/lib/format";
import { useHub } from "@/lib/hub";
import type { HubState } from "@/lib/types";
import { cn } from "@/lib/utils";

const ASKS = ["現在誰開著？", "出門前幫我檢查", "今天比昨天多用在哪"];

// handle：首頁拖拉排列時，標題列當握把
function Head({ icon: I, title, right, accent, handle, shut, onToggle }: { icon: React.ElementType; title: string; right?: React.ReactNode; accent?: boolean; handle?: DragHandle; shut?: boolean; onToggle?: () => void }) {
  return (
    <div ref={handle?.ref} {...handle?.props}
      className={cn("group/head relative flex items-center gap-2 px-4 py-3", !shut && "border-b", handle && "cursor-grab touch-none select-none active:cursor-grabbing focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring")}>
      {handle && <GripVertical aria-hidden className="absolute top-1/2 left-0.5 size-4 -translate-y-1/2 text-muted-foreground opacity-0 transition-opacity group-hover/head:opacity-100" />}
      <I className={cn("size-4.5", accent ? "text-primary" : "text-muted-foreground")} />
      <h2 className={cn("font-semibold", accent && "text-primary")}>{title}</h2>
      <span className="ml-auto truncate text-xs text-muted-foreground" onPointerDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>{right}</span>
      {onToggle && <CollapseBtn shut={!!shut} onToggle={onToggle} label={title} />}
    </div>
  );
}

// 「問家裡」：直接在首頁打字，送出後開對話面板
export function AskPanel({ className, handle }: { className?: string; handle?: DragHandle }) {
  const { state } = useHub();
  const ask = useAsk();
  const [q, setQ] = useState("");
  const st = state?.assistant;
  if (!st) return null;
  return (
    <Card className={cn("gap-0 overflow-hidden border-primary/50 py-0", className)}>
      <Head icon={Sparkles} title="問家裡" right="AI 助理" accent handle={handle} />
      {st.configured ? (
        <div className="space-y-2.5 p-3.5">
          <form
            className="flex h-11 items-center gap-2 rounded-xl border border-input bg-background pr-1.5 pl-3 focus-within:ring-2 focus-within:ring-ring"
            onSubmit={(e) => {
              e.preventDefault();
              ask.open(q.trim() || undefined);
              setQ("");
            }}
          >
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="客廳的燈關掉、這個月誰最耗電…" aria-label="問家裡"
              className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground" />
            <button type="submit" aria-label="送出" className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground transition-transform active:scale-95">
              <ArrowRight className="size-4" />
            </button>
          </form>
          <div className="flex flex-wrap gap-1.5">
            {ASKS.map((t) => (
              <button key={t} onClick={() => ask.open(t)}
                className="rounded-full border px-2.5 py-1 text-[13px] text-muted-foreground transition-colors hover:border-primary/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                {t}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <button onClick={() => ask.open()} className="block w-full p-4 text-left text-sm leading-relaxed text-muted-foreground hover:bg-muted">
          還沒設定。貼上 Anthropic 的 API 金鑰後，就能用打字或說話控制家裡。<span className="font-medium text-primary">設定 ›</span>
        </button>
      )}
    </Card>
  );
}

// 今天使用時間：所有插座今天開了幾小時，和最近兩週每天的長條（插座自己記錄的）
export function EnergyPanel({ state, className, handle }: { state: HubState; className?: string; handle?: DragHandle }) {
  const s = state.summary;
  const hist = (s.history || []).slice(-14);
  const max = Math.max(0.1, ...hist.map((h) => h.hours ?? 0));
  const prev = hist.length >= 2 ? hist[hist.length - 2].hours ?? 0 : 0;
  const on = s.on_count ?? state.plugs.filter((p) => p.online && p.is_on).length;
  const [shut, toggle] = useCollapsed("side:energy");
  const brief = `${fmt(s.hours_today ?? 0)} 小時 ›`;
  return (
    <Card className={cn("gap-0 overflow-hidden py-0", className)}>
      <Head icon={ChartColumn} title="今天使用時間" handle={handle} shut={shut} onToggle={toggle}
        right={<a href="#energy" className="hover:text-foreground">{shut ? brief : "看明細 ›"}</a>} />
      {!shut && <div className="p-4">
        <div className="flex items-end justify-between gap-3">
          <div className="text-[28px] leading-none font-semibold tabular-nums">
            {fmt(s.hours_today ?? 0)}
            <span className="ml-1.5 text-xs font-normal text-muted-foreground">小時</span>
          </div>
          <div className="text-xs text-muted-foreground tabular-nums">目前 {on} 個開著</div>
        </div>
        {hist.length > 1 && (
          <>
            <div className="mt-3 flex h-20 items-end gap-[3px]" role="img" aria-label={`最近 ${hist.length} 天每天的使用時間，昨天 ${fmt(prev)} 小時`}>
              {hist.map((h, i) => (
                <div key={h.day} title={`${Number(h.day.slice(5, 7))}/${Number(h.day.slice(8))}：${fmt(h.hours ?? 0)} 小時`}
                  className={cn("min-h-[2px] flex-1 rounded-t-[3px] bg-primary", i === hist.length - 1 ? "opacity-45" : "opacity-90")}
                  style={{ height: `${((h.hours ?? 0) / max) * 100}%` }} />
              ))}
            </div>
            <div className="mt-1 flex justify-between text-[11px] text-muted-foreground tabular-nums">
              <span>{Number(hist[0].day.slice(5, 7))}/{Number(hist[0].day.slice(8))}</span>
              <span>昨天 {fmt(prev)} 小時</span>
              <span>今</span>
            </div>
          </>
        )}
      </div>}
    </Card>
  );
}

// 接下來：定時關閉中的插座，和今天、明天還會執行的排程
export function NextPanel({ state, now, className, handle }: { state: HubState; now: number; className?: string; handle?: DragHandle }) {
  const d = new Date(now * 1000);
  const today = (d.getDay() + 6) % 7;
  const hms = d.toTimeString().slice(0, 8);
  const names = new Map(state.plugs.map((p) => [p.id, p.name]));
  const items: { key: string; at: number; time: string; text: string; tag: string; on?: boolean; timer?: boolean }[] = [];
  for (const p of state.plugs) {
    if (p.online && p.timer && p.timer > now)
      items.push({ key: `t${p.id}`, at: p.timer - now, time: fmtLeft(p.timer - now), text: `${p.name} 自動關閉`, tag: "定時", timer: true });
  }
  for (const s of state.schedules) {
    if (!s.enabled || !s.days.length) continue;
    const t = s.today || s.time;
    if (!t) continue;
    const [hh, mm, ss] = t.split(":").map(Number);
    const sec = hh * 3600 + mm * 60 + (ss || 0) - (d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds());
    let at: number | null = null;
    if (s.days.includes(today) && t > hms && !s.skip_today) at = sec;
    else if (s.days.includes((today + 1) % 7)) at = sec + 86400;
    if (at === null || at > 86400) continue;
    const what =
      s.action === "scene"
        ? `執行「${state.scenes.find((x) => x.id === s.scene)?.name || "情境"}」`
        : `${names.get(s.plugs[0]) || "插座"}${s.plugs.length > 1 ? ` 等 ${s.plugs.length} 個` : ""}${s.duration_s ? "（會自動關）" : ""}`;
    items.push({ key: s.id, at, time: `${at >= sec + 86400 ? "明 " : ""}${t.slice(0, 5)}`, text: what, tag: s.action === "on" ? "開" : s.action === "off" ? "關" : "情境", on: s.action === "on" });
  }
  items.sort((a, b) => a.at - b.at);
  const [shut, toggle] = useCollapsed("side:next");
  return (
    <Card className={cn("gap-0 overflow-hidden py-0", className)}>
      <Head icon={CalendarClock} title="接下來" handle={handle} shut={shut} onToggle={toggle}
        right={<a href="#schedule" className="hover:text-foreground">{shut && items[0] ? `${items[0].time} ${items[0].text} ›` : "排程 ›"}</a>} />
      {shut ? null : items.length ? (
        <ul className="divide-y px-4">
          {items.slice(0, 5).map((x) => (
            <li key={x.key} className="flex items-center gap-3 py-2.5">
              <span className={cn("w-[4.2rem] shrink-0 text-[13px] font-semibold tabular-nums", x.timer ? "text-violet-600 dark:text-violet-400" : "text-primary")}>
                {x.timer && <Timer className="mr-1 inline size-3.5 -translate-y-px" />}{x.time}
              </span>
              <span className="min-w-0 flex-1 truncate text-sm">{x.text}</span>
              <span className={cn("shrink-0 rounded-md border px-1.5 py-0.5 text-[11px] text-muted-foreground", x.on && "border-amber-400/60 text-amber-600 dark:text-amber-400")}>{x.tag}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="p-4 text-sm text-muted-foreground">24 小時內沒有排程要執行</p>
      )}
    </Card>
  );
}

// 誰在家：每個人在不在家、多久了；教過房間的再加上在哪個房間
export function PeoplePanel({ state, now, className, handle }: { state: HubState; now: number; className?: string; handle?: DragHandle }) {
  const people = [...(state.people || [])].sort((a, b) => Number(!!b.home) - Number(!!a.home));
  const [shut, toggle] = useCollapsed("side:people");
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!people.length) return null;
  const home = people.filter((x) => x.home).length;
  const wait = state.away_wait;
  const left = wait?.until ? Math.max(1, Math.round((wait.until - now) / 60)) : null;
  const awayNow = async () => {
    setBusy(true);
    try {
      await api("POST", "/api/presence/away-now");
      toast.success("已經執行「出門」");
    } catch (e) {
      toast.error("沒有執行", { description: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card className={cn("gap-0 overflow-hidden py-0", className)}>
      <Head icon={Users} title="誰在家" handle={handle} shut={shut} onToggle={toggle} right={<a href="#map" className="hover:text-foreground">{home ? `${home}／${people.length} 人在家` : "都出門了"} ›</a>} />
      {!shut && <ul className="divide-y">
        {people.map((x) => {
          const w = x.home ? x.where : null;
          const room = w ? (w.room ? w.name : w.top[0] ? `可能在${w.top[0].name}` : null) : null;
          const ago = x.since ? fmtDur(now - x.since) : null;
          const unsure = !!x.home && !!x.stay;
          return (
            <li key={x.id}>
              <button type="button" onClick={() => setOpen(x.id)}
                className="flex min-h-14 w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset">
                <span className={cn("flex size-8 shrink-0 items-center justify-center rounded-full text-sm font-semibold",
                  unsure ? "bg-orange-100 text-orange-800 dark:bg-orange-500/15 dark:text-orange-300"
                    : x.home ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300" : "bg-muted text-muted-foreground")}>
                  {x.name.trim().slice(0, 1).toUpperCase() || "?"}
                </span>
                <span className="min-w-0 flex-1">
                  <span className={cn("block truncate text-sm font-medium", !x.home && "text-muted-foreground")}>{x.name}</span>
                  {x.why && <span className={cn("block text-xs leading-relaxed", unsure ? "text-orange-700 dark:text-orange-300" : "text-muted-foreground")}>{x.why}</span>}
                  {room && (
                    <span className="flex items-center gap-1 truncate text-xs text-muted-foreground">
                      <MapPin className="size-3 shrink-0" />{room}
                    </span>
                  )}
                </span>
                <span className="shrink-0 text-right">
                  <span className={cn("block text-[13px] font-medium", unsure ? "text-orange-700 dark:text-orange-300" : x.home ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground")}>
                    {personStatus(x)}
                  </span>
                  {ago && x.home !== null && <span className="block text-[11px] tabular-nums text-muted-foreground">{ago}</span>}
                </span>
              </button>
            </li>
          );
        })}
      </ul>}
      {!shut && wait && (
        <div className="flex items-center gap-3 border-t bg-orange-500/5 px-4 py-3">
          <CircleAlert className="size-4.5 shrink-0 text-orange-700 dark:text-orange-300" aria-hidden />
          <div className="min-w-0 flex-1 text-[13px] leading-relaxed">
            <div className="font-medium">還沒執行「出門」</div>
            <div className="text-muted-foreground">
              {wait.names.length ? `等${wait.names.join("、")}：看到出門，或${left ? ` ${left} 分鐘後` : "之後"}家裡還是沒動靜` : `${wait.why}；一陣子沒動靜就會執行`}
            </div>
          </div>
          <Button variant="outline" className="h-11 shrink-0 bg-background" disabled={busy} onClick={awayNow}>現在執行</Button>
        </div>
      )}
      <PersonSheet person={people.find((x) => x.id === open) || null} state={state} now={now} onClose={() => setOpen(null)} />
    </Card>
  );
}

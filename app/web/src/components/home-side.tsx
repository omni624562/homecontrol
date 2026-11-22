import { useState } from "react";
import { ArrowRight, CalendarClock, ChartColumn, MapPin, Sparkles, Timer, Users } from "lucide-react";
import { Card } from "@/components/ui/card";
import { useAsk } from "@/components/ask-sheet";
import { fmt, fmtDur, fmtLeft } from "@/lib/format";
import { useHub } from "@/lib/hub";
import type { HubState } from "@/lib/types";
import { cn } from "@/lib/utils";

const ASKS = ["現在誰開著？", "出門前幫我檢查", "今天比昨天多用在哪"];

function Head({ icon: I, title, right, accent }: { icon: React.ElementType; title: string; right?: React.ReactNode; accent?: boolean }) {
  return (
    <div className="flex items-center gap-2 border-b px-4 py-3">
      <I className={cn("size-4.5", accent ? "text-primary" : "text-muted-foreground")} />
      <h2 className={cn("font-semibold", accent && "text-primary")}>{title}</h2>
      <span className="ml-auto text-xs text-muted-foreground">{right}</span>
    </div>
  );
}

// 「問家裡」：直接在首頁打字，送出後開對話面板
export function AskPanel({ className }: { className?: string }) {
  const { state } = useHub();
  const ask = useAsk();
  const [q, setQ] = useState("");
  const st = state?.assistant;
  if (!st) return null;
  return (
    <Card className={cn("gap-0 overflow-hidden border-primary/50 py-0", className)}>
      <Head icon={Sparkles} title="問家裡" right="AI 助理" accent />
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

// 今天用電：今天的度數、金額，和最近兩週每天的長條
export function EnergyPanel({ state, className }: { state: HubState; className?: string }) {
  const s = state.summary as HubState["summary"] & { history?: { day: string; kwh: number }[]; energy_month?: number };
  const hist = (s.history || []).slice(-14);
  const max = Math.max(0.1, ...hist.map((h) => h.kwh));
  const prev = hist.length >= 2 ? hist[hist.length - 2].kwh : 0;
  return (
    <Card className={cn("gap-0 overflow-hidden py-0", className)}>
      <Head icon={ChartColumn} title="今天用電" right={<a href="#energy" className="hover:text-foreground">看明細 ›</a>} />
      <div className="p-4">
        <div className="flex items-end justify-between gap-3">
          <div className="text-[28px] leading-none font-semibold tabular-nums">
            {fmt(s.energy_today, 1)}
            <span className="ml-1.5 text-xs font-normal text-muted-foreground">度・${fmt(s.cost_today)}</span>
          </div>
          <div className="text-xs text-muted-foreground tabular-nums">本月 ${fmt(s.cost_month)}</div>
        </div>
        {hist.length > 1 && (
          <>
            <div className="mt-3 flex h-20 items-end gap-[3px]" role="img" aria-label={`最近 ${hist.length} 天每天的用電，昨天 ${fmt(prev, 1)} 度`}>
              {hist.map((h, i) => (
                <div key={h.day} title={`${Number(h.day.slice(5, 7))}/${Number(h.day.slice(8))}：${fmt(h.kwh, 1)} 度`}
                  className={cn("min-h-[2px] flex-1 rounded-t-[3px] bg-primary", i === hist.length - 1 ? "opacity-45" : "opacity-90")}
                  style={{ height: `${(h.kwh / max) * 100}%` }} />
              ))}
            </div>
            <div className="mt-1 flex justify-between text-[11px] text-muted-foreground tabular-nums">
              <span>{Number(hist[0].day.slice(5, 7))}/{Number(hist[0].day.slice(8))}</span>
              <span>昨天 {fmt(prev, 1)} 度</span>
              <span>今</span>
            </div>
          </>
        )}
      </div>
    </Card>
  );
}

// 接下來：定時關閉中的插座，和今天、明天還會執行的排程
export function NextPanel({ state, now, className }: { state: HubState; now: number; className?: string }) {
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
  return (
    <Card className={cn("gap-0 overflow-hidden py-0", className)}>
      <Head icon={CalendarClock} title="接下來" right={<a href="#schedule" className="hover:text-foreground">排程 ›</a>} />
      {items.length ? (
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
export function PeoplePanel({ state, now, className }: { state: HubState; now: number; className?: string }) {
  const people = [...(state.people || [])].sort((a, b) => Number(!!b.home) - Number(!!a.home));
  if (!people.length) return null;
  const home = people.filter((x) => x.home).length;
  return (
    <Card className={cn("gap-0 overflow-hidden py-0", className)}>
      <Head icon={Users} title="誰在家" right={<a href="#map" className="hover:text-foreground">{home ? `${home}／${people.length} 人在家` : "都出門了"} ›</a>} />
      <ul className="divide-y px-4">
        {people.map((x) => {
          const w = x.home ? x.where : null;
          const room = w ? (w.room ? w.name : w.top[0] ? `可能在${w.top[0].name}` : null) : null;
          const ago = x.since ? fmtDur(now - x.since) : null;
          return (
            <li key={x.id} className="flex items-center gap-3 py-2.5">
              <span className={cn("flex size-8 shrink-0 items-center justify-center rounded-full text-sm font-semibold",
                x.home ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300" : "bg-muted text-muted-foreground")}>
                {x.name.trim().slice(0, 1).toUpperCase() || "?"}
              </span>
              <div className="min-w-0 flex-1">
                <div className={cn("truncate text-sm font-medium", !x.home && "text-muted-foreground")}>{x.name}</div>
                {room && (
                  <div className="flex items-center gap-1 truncate text-xs text-muted-foreground">
                    <MapPin className="size-3 shrink-0" />{room}
                  </div>
                )}
              </div>
              <div className="shrink-0 text-right">
                <div className={cn("text-[13px] font-medium", x.home ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground")}>
                  {x.home ? "在家" : x.home === false ? "出門" : "不確定"}
                </div>
                {ago && x.home !== null && <div className="text-[11px] text-muted-foreground tabular-nums">{ago}</div>}
              </div>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

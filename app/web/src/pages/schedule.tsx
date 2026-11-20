import { Fragment, useEffect, useMemo, useState, type ReactNode } from "react";
import { AlertCircle, CalendarClock, Check, ChevronRight, Clock, Home, Info, Loader2, Moon, Plus, PlugZap, ShieldCheck, SkipForward, Sparkles, Sun, Timer, Trash2, Droplets, X } from "lucide-react";
import { toast } from "sonner";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { PageHeader } from "@/components/app-shell";
import { AwaySheet } from "@/components/away-sheet";
import { Rain, useFun } from "@/components/fx";
import { deviceIcon } from "@/components/icons";
import { KasaSheet, ruleMatch, type KasaOpen } from "@/components/kasa-sheet";
import { ScheduleSheet, type SchedOpen } from "@/components/schedule-sheet";
import { SunIcon, Tag, daysText, hmsSec, kasaDays, minText, showT, sunLabel, useRuleMin } from "@/components/schedule-bits";
import { api } from "@/lib/api";
import { fmtLeft, fmtSec, pad2 } from "@/lib/format";
import { useHub, useMedia, useTick } from "@/lib/hub";
import { useLook } from "@/lib/look";
import type { KasaRule, Plug, Schedule } from "@/lib/types";
import { cn } from "@/lib/utils";

const clockSec = (epoch: number) => {
  const d = new Date(epoch * 1000);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
};

async function call(fn: () => Promise<unknown>, ok?: string) {
  try {
    await fn();
    if (ok) toast.success(ok);
    return true;
  } catch (e) {
    toast.error("沒有成功", { description: (e as Error).message });
    return false;
  }
}

// 卡片標題列
function CardHead({ icon: I, title, tone, end }: { icon: React.ElementType; title: string; tone?: "timer"; end?: ReactNode }) {
  return (
    <div className="mb-2 flex items-center gap-3 border-b bg-muted/60 px-4 py-3 sm:px-5 dark:bg-muted/40">
      <div className={cn("flex size-9 items-center justify-center rounded-lg border bg-background text-foreground/70", tone === "timer" && "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-400")}>
        <I className="size-5" />
      </div>
      <h2 className="flex-1 text-lg font-bold tracking-tight">{title}</h2>
      {end}
    </div>
  );
}

const Foot = ({ icon: I, children }: { icon?: React.ElementType; children: ReactNode }) => (
  <p className="flex gap-2 px-4 pt-1 pb-4 text-sm leading-relaxed text-muted-foreground sm:px-5">
    {I && <I className="mt-0.5 size-4 shrink-0" />}
    <span>{children}</span>
  </p>
);

// 排程清單的一列（整列可以點開編輯；右邊的開關直接啟用／暫停）
function SchedItem({ time, sec, top, desc, tags, enabled, onOpen, onToggle, label, rain, next }: {
  time: ReactNode; sec?: string; top: ReactNode; desc: ReactNode; tags: ReactNode; enabled: boolean; onOpen: () => void; onToggle: (v: boolean) => void; label: string; rain?: boolean; next?: boolean;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={label}
      onClick={onOpen}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && e.target === e.currentTarget && (e.preventDefault(), onOpen())}
      className={cn(
        "group relative flex cursor-pointer items-start gap-4 rounded-xl px-3 py-3 transition-colors hover:bg-muted/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:bg-muted",
        !enabled && "opacity-60",
      )}
    >
      {rain && <Rain />}
      <div className={cn("w-16 shrink-0 pt-0.5 text-2xl font-semibold tabular-nums tracking-tight sm:w-20 sm:text-[1.7rem]", next && "text-primary")}>
        {time}
        {sec && <span className="text-sm font-normal text-muted-foreground">:{sec}</span>}
      </div>
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-x-2 text-sm text-muted-foreground">{top}</div>
        <div className="text-[15px] leading-relaxed font-medium">{desc}</div>
        <div className="flex flex-wrap gap-1.5">{tags}</div>
      </div>
      <div className="pt-1" onClick={(e) => e.stopPropagation()}>
        <Switch checked={enabled} onCheckedChange={onToggle} aria-label={`啟用：${label}`} />
      </div>
    </div>
  );
}

// 科技感：排程清單裡「現在」的位置
function NowLine({ now, left }: { now: string; left: string | null }) {
  return (
    <div className="flex items-center gap-2 px-3 py-1 text-xs tabular-nums text-primary" aria-label={`現在 ${now}`}>
      <span className="size-2 rounded-full bg-primary shadow-[0_0_0_3px_color-mix(in_srgb,var(--primary)_25%,transparent)]" />
      <span className="whitespace-nowrap">現在 {now}{left ? `・下一條 ${left}後` : "・今天的排程都跑完了"}</span>
      <span className="h-px flex-1 bg-primary/40" />
    </div>
  );
}

function SchedSkeleton() {
  return (
    <div className="mx-auto grid max-w-[112rem] gap-4 px-4 py-4 sm:px-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] lg:px-8" aria-busy="true" aria-label="載入中">
      <Card className="gap-2 p-4">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="flex gap-4 py-2"><Skeleton className="h-8 w-16" /><div className="flex-1 space-y-2"><Skeleton className="h-4 w-1/3" /><Skeleton className="h-4 w-2/3" /></div><Skeleton className="h-5 w-9 rounded-full" /></div>
        ))}
      </Card>
      <Card className="h-40 p-4"><Skeleton className="h-6 w-28" /></Card>
    </div>
  );
}

export function SchedulePage() {
  const { state, isOn, now } = useHub();
  const fun = useFun();
  const ruleMin = useRuleMin();
  const narrow = !useMedia("(min-width: 1024px)");
  const [sched, setSched] = useState<SchedOpen>(null);
  const [kasa, setKasa] = useState<KasaOpen>(null);
  const [away, setAway] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const tech = useLook() === "tech";
  // 按下開關先顯示新的狀態，等伺服器更新
  const [flip, setFlip] = useState<Record<string, boolean>>({});
  useEffect(() => setFlip({}), [state?.version]);
  const timers = (state?.plugs || []).filter((p) => p.timer && p.online && isOn(p));
  useTick(timers.length ? 1000 : 30000);

  const plug = (id: string) => state?.plugs.find((p) => p.id === id);
  const rows = useMemo(() => {
    if (!state) return [];
    const items: { sec: number; key: string; s?: Schedule; p?: Plug; r?: KasaRule }[] = state.schedules.map((s) => ({ sec: hmsSec(s.today || s.time), key: `s${s.id}`, s }));
    for (const p of state.plugs) for (const r of p.native?.kasa || []) if (r.repeat) items.push({ sec: ruleMin(r) * 60 + 0.5, key: `k${p.id}|${r.sact}|${r.opt}|${r.val}|${r.wday.join("")}`, p, r });
    return items.sort((a, b) => a.sec - b.sec);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  if (!state) return (<><PageHeader title="排程" sub="在固定的時間自動開關插座" /><SchedSkeleton /></>);

  const c = state.calendar;
  const today = (new Date().getDay() + 6) % 7;
  const anyHoliday = state.schedules.some((x) => x.skip_holiday);
  const habits = (state.habits?.suggestions || []).filter((x) => plug(x.plug)).slice(0, 5);
  const habitDays = state.habits?.days || 0;
  const a = state.settings.away;
  const awayN = (a?.plugs || []).filter((id) => plug(id)).length;
  const kasaAway = state.plugs.flatMap((p) => (p.native?.kasa_away || []).map((r) => ({ p, r })));
  const t = now();
  // 現在在清單裡的位置、下一條（啟用中、今天會跑）
  const nd = new Date(t * 1000);
  const nowSec = nd.getHours() * 3600 + nd.getMinutes() * 60 + nd.getSeconds();
  const runsToday = (it: (typeof rows)[number]) => it.s
    ? (flip[it.key] ?? it.s.enabled) && it.s.days.includes(today) && !it.s.skipped && !it.s.skip_today
    : (flip[it.key] ?? !!it.r!.enable) && kasaDays(it.r!.wday).includes(today);
  const nowAt = rows.findIndex((it) => it.sec > nowSec);
  const nextIdx = rows.findIndex((it) => it.sec > nowSec && runsToday(it));
  const nextLeft = nextIdx >= 0 ? (() => { const m = Math.round((rows[nextIdx].sec - nowSec) / 60); return m >= 60 ? `${Math.floor(m / 60)} 小時 ${m % 60} 分` : `${m} 分鐘`; })() : null;

  const desc = (x: Schedule) => {
    let s: string;
    if (x.action === "scene") {
      const sc = state.scenes.find((v) => v.id === x.scene);
      s = sc ? `執行「${sc.name}」` : "情境已刪除，請重新選擇";
    } else {
      const names = x.plugs.map((id) => plug(id)?.name).filter(Boolean) as string[];
      const list = names.length > 3 ? `${names.slice(0, 3).join("、")} 等 ${names.length} 個` : names.join("、") || "沒有選插座";
      s = `${x.action === "on" ? "打開" : "關閉"} ${list}`;
    }
    if (x.action === "off" && x.restore_at) s += `，${x.restore_at < x.time ? "隔天 " : ""}${showT(x.restore_at)} 再打開`;
    else if (x.action === "on" && x.duration_s) s += `，${fmtSec(x.duration_s)}後關閉`;
    return s;
  };
  const backupTag = (x: Schedule) => {
    const b = x.backup_status || { total: 0, ok: 0, issues: [] };
    const home = (text: ReactNode) => <Tag tone="home" icon={Home}>家庭中控{text ? <>・{text}</> : null}</Tag>;
    if (!x.enabled || !b.total || x.backup === false) return home(x.backup === false ? "不備援" : "");
    if (b.ok === b.total) return home(<span className="inline-flex items-center">備援<Check className="ml-0.5 size-3.5" /></span>);
    if (b.issues.every((i) => i.pending)) return home("備援同步中");
    return <>{home("")}<Tag tone="warn" icon={AlertCircle}>備援 {b.ok}／{b.total}</Tag></>;
  };

  const toggleSched = (x: Schedule, v: boolean) => {
    setFlip((f) => ({ ...f, [`s${x.id}`]: v }));
    call(() => api("PUT", `/api/schedules/${x.id}`, { enabled: v }), v ? "排程已啟用" : "排程已暫停").then((ok) => !ok && setFlip((f) => ({ ...f, [`s${x.id}`]: !v })));
  };
  const toggleKasa = (key: string, p: Plug, r: KasaRule, v: boolean) => {
    setFlip((f) => ({ ...f, [key]: v }));
    call(() => api("PUT", "/api/kasa-rules", { plug: p.id, match: ruleMatch(r), set: { enable: v } })).then((ok) => !ok && setFlip((f) => ({ ...f, [key]: !v })));
  };

  // 科技感：標題右邊一行摘要（和首頁一樣的小格子）
  const chips: ReactNode[] = [];
  if (tech) {
    const cls = "tech-item";
    if (nextIdx >= 0) {
      const it = rows[nextIdx];
      const what = it.s ? desc(it.s) : `${it.r!.sact ? "打開" : "關閉"} ${it.p!.name}`;
      chips.push(<span key="next" className={cn(cls, "[&_b]:text-primary")} title={`下一條：${what}`}><Clock className="size-4" /><b>{minText(Math.floor(it.sec / 60))}</b><span className="tech-item-sub max-w-48 truncate">{what}</span></span>);
    }
    const skipped = state.schedules.filter((x) => x.enabled && x.days.includes(today) && (x.skipped || x.skip_today));
    if (skipped.length) chips.push(<span key="skip" className={cn(cls, "tech-item-warn")} title={skipped.map((x) => `${desc(x)}：${x.skipped || x.skip_today}`).join("\n")}><SkipForward className="size-4" /><b>{skipped.length}</b><small>條</small><span className="tech-item-sub">今天跳過</span></span>);
    if (state.sun?.sunrise != null && state.sun?.sunset != null)
      chips.push(<span key="sun" className={cls} title="今天的日出、日落"><Sun className="size-4" /><b>{minText(state.sun.sunrise)}</b><Moon className="ml-1 size-4" /><b>{minText(state.sun.sunset)}</b></span>);
    const bad = state.schedules.filter((x) => x.enabled && x.backup !== false && x.backup_status && x.backup_status.total && x.backup_status.ok < x.backup_status.total && !x.backup_status.issues.every((i) => i.pending));
    if (bad.length) chips.push(<span key="bk" className={cn(cls, "tech-item-warn")} title="這些排程沒有完整寫進插座，樹莓派離線時可能不會執行"><AlertCircle className="size-4" /><b>{bad.length}</b><small>條</small><span className="tech-item-sub">備援沒寫全</span></span>);
    if (timers.length) chips.push(<span key="tm" className={cn(cls, "tech-item-on")} title={timers.map((p) => `${p.name} 還有 ${fmtLeft(p.timer! - t)}`).join("\n")}><Timer className="size-4" /><b>{timers.length}</b><small>個</small><span className="tech-item-sub">定時關閉中</span></span>);
  }

  const calParts: string[] = [];
  if (c.holiday) calParts.push(`今天是「${c.holiday}」`);
  if (c.day_off) calParts.push("今天放假");
  if (c.rain && state.schedules.some((x) => x.skip_rain)) calParts.push(`下雨：${c.rain}`);

  const habitCard = habits.length > 0 && (
    <Card className="gap-0 overflow-hidden py-0">
      <CardHead icon={Sparkles} title="建議的排程" end={<Badge variant="secondary">{habits.length}</Badge>} />
      <div className="divide-y px-4 sm:px-5">
        {habits.map((x) => {
          const p = plug(x.plug)!;
          const opt = x.mode === "sunrise" ? 1 : x.mode === "sunset" ? 2 : 0;
          const base = opt === 1 ? state.sun?.sunrise : state.sun?.sunset;
          const verb = x.action === "on" ? "打開" : "關閉";
          return (
            <div key={x.key} className="flex flex-wrap items-center gap-3 py-3">
              <div className="min-w-0 flex-1 basis-56">
                <div className="flex flex-wrap items-center gap-1 font-medium leading-relaxed">
                  {daysText(x.days)}{" "}
                  {opt ? <span className="inline-flex items-center gap-1"><SunIcon opt={opt} className="size-4 text-amber-600" />{sunLabel(opt, x.offset_min)}</span> : x.time}
                  {opt && base != null ? `（今天約 ${minText(base + x.offset_min)}）` : ""} {verb} {p.name}
                </div>
                <div className="text-sm leading-relaxed text-muted-foreground">過去 {x.of} 天裡有 {x.hits} 天，你都差不多在這時候手動{verb}它</div>
              </div>
              <div className="flex gap-2">
                <Button variant="ghost" disabled={busy === x.key} onClick={async () => { setBusy(x.key); await call(() => api("POST", "/api/habits/dismiss", { key: x.key }), "不會再建議這一條"); setBusy(null); }}>
                  {busy === x.key && <Loader2 className="animate-spin" />}不用
                </Button>
                <Button onClick={() => setSched({ sugg: x })}>做成排程</Button>
              </div>
            </div>
          );
        })}
      </div>
      <Foot>從你手動開關的紀錄找出來的（App、Google Home、插座上的按鈕都算）。按「不用」之後就不會再建議這一條。</Foot>
    </Card>
  );

  return (
    <>
      <PageHeader
        title="排程"
        sub="在固定的時間自動開關插座"
        chips={chips.length ? chips : undefined}
        chipsClassName="xl:justify-start xl:[&>:first-child]:ml-auto"
        actions={<Button className="h-10 transition-all active:scale-95" onClick={() => setSched({})}><Plus />新增</Button>}
      />
      <div className="mx-auto grid max-w-[112rem] items-start gap-4 px-4 py-4 sm:px-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] lg:px-8">
        <div className="min-w-0 space-y-4">
          {narrow && habitCard}
          <Card className="gap-0 overflow-hidden py-0">
            <CardHead
              icon={CalendarClock}
              title="排程"
              end={anyHoliday && (
                <Button
                  variant={c.day_off ? "default" : "outline"}
                  size="sm"
                  aria-pressed={!!c.day_off}
                  disabled={busy === "dayoff"}
                  onClick={async () => {
                    const on = !c.day_off;
                    setBusy("dayoff");
                    await call(() => api("POST", "/api/day-off", { on }), on ? "今天放假：打開「國定假日不執行」的排程今天都跳過" : "取消放假，排程照常執行");
                    setBusy(null);
                  }}
                >
                  {busy === "dayoff" ? <Loader2 className="animate-spin" /> : c.day_off && <Check />}今天放假
                </Button>
              )}
            />
            {calParts.length > 0 && (
              <div className="mx-4 mb-2 flex gap-3 rounded-xl border border-amber-200 bg-amber-50 p-3 sm:mx-5 dark:border-amber-500/30 dark:bg-amber-500/10">
                <Info className="mt-0.5 size-5 shrink-0 text-amber-700 dark:text-amber-400" />
                <div className="text-sm leading-relaxed">
                  <div className="font-semibold">{calParts.join("・")}</div>
                  <div className="text-muted-foreground">打開「{c.rain && !c.holiday && !c.day_off ? "下雨不執行" : "國定假日不執行"}」的排程今天會跳過</div>
                </div>
              </div>
            )}
            {rows.length ? (
              <div className="px-1 sm:px-2">
                {rows.map((it, idx) => {
                  const line = tech && idx === nowAt ? <NowLine key="now" now={`${pad2(nd.getHours())}:${pad2(nd.getMinutes())}`} left={nextLeft} /> : null;
                  const item = (() => {
                  if (it.s) {
                    const x = it.s;
                    const en = flip[it.key] ?? x.enabled;
                    const sunMode = x.time_mode === "sunrise" || x.time_mode === "sunset";
                    const [hh, mm, ss] = (sunMode ? x.today || "" : x.time).split(":");
                    const opt = x.time_mode === "sunrise" ? 1 : 2;
                    return (
                      <SchedItem
                        key={it.key}
                        label={`${hh ? `${hh}:${mm}` : sunLabel(opt, x.offset_min || 0)} ${desc(x)}`}
                        time={sunMode && !x.today ? "—" : `${hh}:${mm}`}
                        sec={ss && ss !== "00" ? ss : undefined}
                        top={<>
                          {sunMode && <span className="inline-flex items-center gap-1 text-amber-700 dark:text-amber-400"><SunIcon opt={opt} className="size-4" />{sunLabel(opt, x.offset_min || 0)}</span>}
                          <span>{daysText(x.days)}{en ? "" : "・已暫停"}</span>
                        </>}
                        desc={desc(x)}
                        tags={<>
                          {backupTag(x)}
                          {x.skip_holiday && <Tag icon={CalendarClock}>假日跳過</Tag>}
                          {x.skip_rain && <Tag icon={Droplets}>下雨跳過</Tag>}
                          {x.enabled && x.days.includes(today) && (x.skipped || x.skip_today) && <Tag tone="warn" icon={Info}>今天不執行：{x.skipped || x.skip_today}</Tag>}
                        </>}
                        rain={fun && x.enabled && x.days.includes(today) && /雨/.test(x.skipped || x.skip_today || "")}
                        enabled={en}
                        onOpen={() => setSched({ id: x.id })}
                        onToggle={(v) => toggleSched(x, v)}
                        next={tech && idx === nextIdx}
                      />
                    );
                  }
                  const p = it.p!;
                  const r = it.r!;
                  const en = flip[it.key] ?? !!r.enable;
                  // 插座自己執行，樹莓派擋不住：和防呆設定衝突時要提醒
                  const warn = !r.enable ? "" : p.protect === "lock" ? "裝置已鎖定，但這條排程仍會開關它" : p.keep_on && !r.sact ? "裝置設為常開，但這條排程仍會關掉它" : "";
                  return (
                    <SchedItem
                      key={it.key}
                      label={`${minText(ruleMin(r))} ${r.sact ? "打開" : "關閉"} ${p.name}（插座內建）`}
                      time={minText(ruleMin(r))}
                      top={<>
                        {!!r.opt && <span className="inline-flex items-center gap-1 text-amber-700 dark:text-amber-400"><SunIcon opt={r.opt} className="size-4" />{sunLabel(r.opt, r.val)}</span>}
                        <span>{daysText(kasaDays(r.wday))}{en ? "" : "・已暫停"}</span>
                      </>}
                      desc={`${r.sact ? "打開" : "關閉"} ${p.name}`}
                      tags={<>
                        <Tag icon={PlugZap}>插座內建・Kasa App</Tag>
                        {warn && <Tag tone="warn" icon={AlertCircle}>{warn}</Tag>}
                      </>}
                      enabled={en}
                      onOpen={() => setKasa({ pid: p.id, rule: r })}
                      onToggle={(v) => toggleKasa(it.key, p, r, v)}
                      next={tech && idx === nextIdx}
                    />
                  );
                  })();
                  return line ? <Fragment key={it.key}>{line}{item}</Fragment> : item;
                })}
                {tech && nowAt < 0 && <NowLine now={`${pad2(nd.getHours())}:${pad2(nd.getMinutes())}`} left={null} />}
              </div>
            ) : (
              <div className="space-y-3 px-4 pb-2 sm:px-5">
                <p className="text-muted-foreground">還沒有排程。可以從這些開始：</p>
                <div className="flex flex-wrap gap-2">
                  {([["night", "每晚 23:00 關燈"], ["leave", "平日 08:30 執行「出門」"], ["water", "每天 06:30 澆水 1 分鐘"]] as const).map(([k, l]) => (
                    <Button key={k} variant="outline" className="rounded-full" onClick={() => setSched({ template: k })}>{l}</Button>
                  ))}
                </div>
              </div>
            )}
            {tech && rows.length > 0 && (
              <div className="flex flex-wrap items-center gap-2 border-t px-4 py-3 sm:px-5">
                <span className="text-sm text-muted-foreground">從範本新增：</span>
                {([["night", "每晚 23:00 關燈"], ["leave", "平日 08:30 執行「出門」"], ["water", "每天 06:30 澆水 1 分鐘"]] as const).map(([k, l]) => (
                  <Button key={k} variant="outline" size="sm" className="rounded-full" onClick={() => setSched({ template: k })}>{l}</Button>
                ))}
              </div>
            )}
            {!habits.length && habitDays < 14 && (
              <Foot icon={Sparkles}>正在記錄你手動開關的習慣{habitDays ? `（已經 ${habitDays} 天）` : ""}；某個插座常在差不多的時間被開關，大約一週後會出現「建議的排程」。</Foot>
            )}
            {rows.length > 0 && (
              <Foot icon={ShieldCheck}>家庭中控的排程也會寫進插座，樹莓派離線時照樣執行。標「插座內建」的是用 Kasa App 設的，存在插座裡，在這裡一樣可以開關、修改、刪除。</Foot>
            )}
          </Card>
        </div>

        <div className="min-w-0 space-y-4">
          {!narrow && habitCard}
          {timers.length > 0 && (
            <Card className="gap-0 overflow-hidden py-0">
              <CardHead icon={Timer} title="定時關閉中" tone="timer" />
              <div className="divide-y px-4 pb-2 sm:px-5">
                {timers.map((p) => {
                  const I = deviceIcon(p.name);
                  return (
                    <div key={p.id} className="flex items-center gap-3 py-3">
                      <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-400"><I className="size-5" /></div>
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-medium">{p.name}</div>
                        <div className="text-sm tabular-nums text-amber-700 dark:text-amber-400">還有 {fmtLeft(p.timer! - t)}・{clockSec(p.timer!)} 關閉</div>
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busy === `t${p.id}`}
                        onClick={async () => { setBusy(`t${p.id}`); await call(() => api("DELETE", `/api/plugs/${encodeURIComponent(p.id)}/timer`), "已取消定時"); setBusy(null); }}
                      >
                        {busy === `t${p.id}` ? <Loader2 className="animate-spin" /> : <X />}取消
                      </Button>
                    </div>
                  );
                })}
              </div>
            </Card>
          )}
          <Card className="gap-0 overflow-hidden py-0">
            <CardHead icon={Home} title="離家模式" end={a?.enabled && <Badge className="bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300">啟用中</Badge>} />
            <button
              onClick={() => setAway(true)}
              className="mx-2 mb-2 flex items-center gap-3 rounded-xl px-3 py-3 text-left transition-colors hover:bg-muted/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:bg-muted"
            >
              <div className="min-w-0 flex-1">
                <div className="font-medium leading-relaxed">{a?.enabled ? `每天 ${a.start}–${a.end}，${awayN} 個插座隨機開關` : "不在家時讓燈隨機開關"}</div>
                <div className="text-sm leading-relaxed text-muted-foreground">看起來像有人在家；由插座自己執行，樹莓派離線也照跑</div>
              </div>
              <ChevronRight className="size-5 text-muted-foreground" />
            </button>
            {kasaAway.length > 0 && (
              <div className="divide-y border-t px-4 sm:px-5">
                {kasaAway.map(({ p, r }) => {
                  const k = `a${p.id}|${r.smin}|${r.emin}|${r.wday.join("")}`;
                  const req = { plug: p.id, match: { smin: r.smin, emin: r.emin, wday: r.wday } };
                  const en = flip[k] ?? !!r.enable;
                  return (
                    <div key={k} className="flex items-center gap-3 py-3">
                      <div className="min-w-0 flex-1">
                        <div className="font-medium">{p.name}・{minText(r.smin)}–{minText(r.emin)}</div>
                        <div className="text-sm text-muted-foreground">{daysText(kasaDays(r.wday))}・插座內建・Kasa App 設的{en ? "" : "・已停用"}</div>
                      </div>
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button variant="ghost" size="icon" className="text-muted-foreground hover:text-destructive" aria-label="刪除這條離家模式"><Trash2 /></Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>刪除這條離家模式？</AlertDialogTitle>
                            <AlertDialogDescription>插座裡這條 Kasa App 設的離家模式會被刪掉，不能復原。</AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>取消</AlertDialogCancel>
                            <AlertDialogAction variant="destructive" onClick={() => call(() => api("DELETE", "/api/kasa-away", req), "已刪除")}>刪除</AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                      <Switch
                        checked={en}
                        aria-label={`啟用 ${p.name} 的離家模式`}
                        onCheckedChange={(v) => {
                          setFlip((f) => ({ ...f, [k]: v }));
                          call(() => api("PUT", "/api/kasa-away", { ...req, enable: v })).then((ok) => !ok && setFlip((f) => ({ ...f, [k]: !v })));
                        }}
                      />
                    </div>
                  );
                })}
              </div>
            )}
          </Card>
        </div>
      </div>

      <ScheduleSheet open={sched} onClose={() => setSched(null)} onOpen={setSched} />
      <KasaSheet open={kasa} onClose={() => setKasa(null)} />
      <AwaySheet open={away} onClose={() => setAway(false)} />
    </>
  );
}

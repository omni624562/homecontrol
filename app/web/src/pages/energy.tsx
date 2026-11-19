import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { AlertCircle, CheckCircle2, ChevronDown, ChevronRight, ChevronUp, Clock, Minus, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/app-shell";
import { BarChart, type Bar } from "@/components/bar-chart";
import { EnergyDeviceSheet } from "@/components/energy-device-sheet";
import { deviceIcon } from "@/components/icons";
import { Segmented } from "@/components/schedule-bits";
import { SettingNumber } from "@/components/settings-bits";
import { api } from "@/lib/api";
import { fmt, fmtMin } from "@/lib/format";
import { useHub, useMedia } from "@/lib/hub";
import type { Energy } from "@/lib/types";
import { cn } from "@/lib/utils";

const money = (v: number) => `$${fmt(v)}`;
const md = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;

// 讀用電資料：打開時讀，之後 5 分鐘更新一次
export function useEnergy() {
  const [e, setE] = useState<Energy | null>(null);
  const [err, setErr] = useState(false);
  const load = useCallback(() => {
    api<Energy>("GET", "/api/energy")
      .then((v) => {
        setE(v);
        setErr(false);
      })
      .catch(() => setErr(true));
  }, []);
  useEffect(() => {
    load();
    const t = setInterval(load, 300000);
    return () => clearInterval(t);
  }, [load]);
  return { e, err, load };
}

function CardTitle({ title, end }: { title: string; end?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b bg-muted/60 px-4 py-3 sm:px-5 dark:bg-muted/40">
      <h2 className="flex-1 text-lg font-bold tracking-tight">{title}</h2>
      {end}
    </div>
  );
}

function Kpi({ label, value, sub, tone }: { label: string; value: ReactNode; sub: ReactNode; tone?: "up" | "down" }) {
  return (
    <Card className="gap-1 px-4 py-4 sm:px-5">
      <div className="text-sm text-muted-foreground">{label}</div>
      <div className={cn("text-2xl font-bold tracking-tight tabular-nums sm:text-3xl", tone === "up" && "text-orange-600 dark:text-orange-400", tone === "down" && "text-emerald-600 dark:text-emerald-400")}>{value}</div>
      <div className="text-sm leading-relaxed text-muted-foreground">{sub}</div>
    </Card>
  );
}

function EnergySkeleton() {
  return (
    <div className="mx-auto max-w-7xl space-y-4 px-4 py-4 sm:px-6 lg:px-8" aria-busy="true" aria-label="載入中">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">{Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-28 rounded-xl" />)}</div>
      <Skeleton className="h-72 rounded-xl" />
      <div className="grid gap-4 lg:grid-cols-2"><Skeleton className="h-56 rounded-xl" /><Skeleton className="h-56 rounded-xl" /></div>
    </div>
  );
}

export function EnergyPage() {
  const { e, err, load } = useEnergy();
  const { state } = useHub();
  const narrow = !useMedia("(min-width: 640px)");
  const [range, setRange] = useState<"days" | "months">("days");
  const [dev, setDev] = useState<string | null>(null);
  const [heatTip, setHeatTip] = useState<string | null>(null);
  // 手機上熱力圖放不下：先捲到最右邊（最近的日子）
  const heatRef = useRef<HTMLDivElement>(null);
  const hasE = !!e;
  useEffect(() => {
    const el = heatRef.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [hasE]);

  const sub = e ? `估算：插座記錄的開機時間 × 瓦數・台電累進電價 ${fmt(e.price, 2)} 元/度（${e.season}）` : "讀取插座記錄的使用時間…";
  if (!e)
    return (
      <>
        <PageHeader title="用電" sub={sub} />
        {err ? (
          <div className="mx-auto flex max-w-md flex-col items-center gap-3 px-6 py-20 text-center">
            <AlertCircle className="size-10 text-muted-foreground" />
            <p className="leading-relaxed text-muted-foreground">讀不到插座的使用時間，稍後再試。</p>
            <Button onClick={load}>再試一次</Button>
          </div>
        ) : (
          <EnergySkeleton />
        )}
      </>
    );

  const useKwh = e.plugs.some((p) => p.watts);
  const unit = useKwh ? "度" : "小時";
  const delta = e.same_period.kwh ? (e.month.kwh - e.same_period.kwh) / e.same_period.kwh : null;

  const series = range === "days" ? e.days : e.months;
  const bars: Bar[] = series.map((x, i) => {
    const last = i === series.length - 1;
    const v = useKwh ? x.kwh : x.hours;
    const cost = "cost" in x && x.cost != null ? x.cost : x.kwh * e.price;
    const when = "day" in x ? `${md(x.day)}${last ? "（今天，還沒過完）" : ""}` : `${x.month.slice(0, 4)} 年 ${Number(x.month.slice(5))} 月${last ? "（本月至今）" : ""}`;
    return {
      v,
      now: last,
      label: "day" in x ? (last ? "今" : i % 5 === 4 ? String(Number(x.day.slice(8))) : "") : `${Number(x.month.slice(5))}月`,
      tip: `${when}：${useKwh ? `${fmt(x.kwh, 1)} 度・約 ${money(cost)}・` : ""}開了 ${fmt(x.hours, 0)} 小時`,
    };
  });

  const rmax = Math.max(0.001, ...e.rooms.map((r) => r.kwh));
  const rtotal = e.rooms.reduce((a, r) => a + r.kwh, 0) || 1;
  const known = e.plugs.filter((p) => p.known).sort((a, b) => (b.month_min || 0) - (a.month_min || 0));
  const totalKwh = known.reduce((a, p) => a + (p.month_kwh || 0), 0) || 1;
  const totalMin = known.reduce((a, p) => a + (p.month_min || 0), 0) || 1;
  const ranked = [...e.plugs].sort((a, b) => (b.month_kwh || 0) - (a.month_kwh || 0) || (b.month_min || 0) - (a.month_min || 0));
  const insightIcon: Record<string, React.ElementType> = { always: Clock, rise: ChevronUp, unset: Zap };
  const heatDefault = narrow ? "每一格是一天，顏色越深開越久・點格子看時數，往左滑看更早的日子" : "每一格是一天，顏色越深開越久・滑過看時數";

  return (
    <>
      <PageHeader title="用電" sub={sub} />
      <div className="mx-auto max-w-7xl space-y-4 px-4 py-4 sm:px-6 lg:px-8">
        {/* 重點數字 */}
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Kpi label="本月至今" value={money(e.month.cost)} sub={`${fmt(e.month.kwh, 1)} 度・${e.day_of_month} 天`} />
          <Kpi label="預估本月" value={money(e.projected.cost)} sub={`${fmt(e.projected.kwh, 0)} 度・照目前每天的平均推算`} />
          <Kpi
            label="比上月同期"
            tone={delta == null ? undefined : delta > 0.02 ? "up" : delta < -0.02 ? "down" : undefined}
            value={
              delta == null ? "—" : (
                <span className="inline-flex items-center">
                  {delta > 0.02 ? <ChevronUp className="size-7" /> : delta < -0.02 ? <ChevronDown className="size-7" /> : <Minus className="size-7" />}
                  {fmt(Math.abs(delta) * 100)}%
                </span>
              )
            }
            sub={delta == null ? "沒有上個月的資料" : `${delta > 0.02 ? "比上月同期多" : delta < -0.02 ? "比上月同期少" : "和上月同期差不多"}・上月同期 ${money(e.same_period.cost)}`}
          />
          <Kpi label="今天" value={<>{fmt(e.today.kwh, 1)}<span className="ml-1 text-base font-normal text-muted-foreground">度</span></>} sub={`約 ${money(e.today.kwh * e.price)}・到現在為止`} />
        </div>

        {/* 趨勢 */}
        <Card className="gap-0 overflow-hidden py-0">
          <CardTitle
            title={`${useKwh ? "用電" : "開機時數"}（${unit}）`}
            end={<div className="w-56"><Segmented label="期間" value={range} onChange={setRange} options={[["days", "近 30 天"], ["months", "近 12 個月"]]} /></div>}
          />
          <div className="px-4 pt-3 pb-4 sm:px-5">
            <BarChart items={bars} unit={unit} name={useKwh ? "每天用電" : "每天開機時數"} height="h-52" />
          </div>
        </Card>

        <div className="grid items-start gap-4 lg:grid-cols-2">
          {/* 依房間 */}
          <Card className="gap-0 overflow-hidden py-0">
            <CardTitle title="本月依房間" />
            <div className="space-y-4 px-4 py-4 sm:px-5">
              {e.rooms.map((r) => (
                <div key={r.name} className="space-y-1.5">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="font-medium">{r.name}</span>
                    <span className="font-semibold tabular-nums">{fmt(r.kwh, 1)} 度</span>
                  </div>
                  <div className="h-2.5 overflow-hidden rounded-full bg-muted">
                    <div className="h-full rounded-full bg-primary/80" style={{ width: `${Math.max(1, (r.kwh / rmax) * 100)}%` }} />
                  </div>
                  <div className="text-sm text-muted-foreground tabular-nums">{fmt((r.kwh / rtotal) * 100)}%・約 {money(r.kwh * e.price)}</div>
                </div>
              ))}
            </div>
          </Card>

          {/* 值得注意 */}
          <Card className="gap-0 overflow-hidden py-0">
            <CardTitle title="值得注意" />
            <div className="px-2 py-2">
              {e.insights.length ? (
                e.insights.map((x, i) => {
                  const I = insightIcon[x.kind] || AlertCircle;
                  const body = (
                    <>
                      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-orange-100 text-orange-700 dark:bg-orange-500/15 dark:text-orange-300"><I className="size-5" /></span>
                      <span className="min-w-0 flex-1 leading-relaxed">{x.text}</span>
                      {x.plug && <ChevronRight className="size-5 text-muted-foreground" />}
                    </>
                  );
                  return x.plug ? (
                    <button key={i} onClick={() => setDev(x.plug!)} className="flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left transition-colors hover:bg-muted/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:bg-muted">
                      {body}
                    </button>
                  ) : (
                    <div key={i} className="flex items-center gap-3 px-3 py-3">{body}</div>
                  );
                })
              ) : (
                <p className="flex gap-2 px-3 py-3 leading-relaxed text-muted-foreground">
                  <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-emerald-600" />沒有特別的狀況：沒有整天開著或最近突然開很久的裝置。
                </p>
              )}
            </div>
          </Card>
        </div>

        {/* 每天開機時數：裝置 × 30 天 */}
        <Card className="gap-0 overflow-hidden py-0">
          <CardTitle
            title="每天開機時數"
            end={
              <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground" aria-hidden>
                0
                {[0.15, 0.4, 0.7, 1].map((a) => <i key={a} className="size-3.5 rounded-[3px] bg-primary" style={{ opacity: a }} />)}
                24 小時
              </span>
            }
          />
          <div className="px-4 pt-3 pb-4 sm:px-5" onMouseLeave={() => setHeatTip(null)}>
            <div className="mb-2 min-h-6 text-sm tabular-nums text-muted-foreground" aria-live="polite">
              <span className={cn(heatTip && "font-medium text-foreground")}>{heatTip || heatDefault}</span>
            </div>
            <div ref={heatRef} className="overflow-x-auto pb-1">
            <div className="grid min-w-[38rem] items-center gap-[3px]" style={{ gridTemplateColumns: `minmax(5.5rem, 9rem) repeat(${e.days.length}, minmax(0, 1fr))` }}>
              <span className="sticky left-0 z-10 h-full bg-card" />
              {e.days.map((d, i) => (
                <span key={d.day} className="text-center text-[10px] text-muted-foreground">{i === e.days.length - 1 ? "今" : i % 5 === 4 ? Number(d.day.slice(8)) : ""}</span>
              ))}
              {known.map((p) => (
                <HeatRow key={p.id} name={p.name} days={p.days} dates={e.days.map((d) => d.day)} onTip={setHeatTip} onOpen={() => setDev(p.id)} />
              ))}
            </div>
            </div>
          </div>
        </Card>

        <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          {/* 裝置排行 */}
          <Card className="gap-0 overflow-hidden py-0">
            <CardTitle title="本月各裝置" end={<span className="text-sm text-muted-foreground">比上月同期・點一下看明細</span>} />
            <div className="divide-y">
              {ranked.map((p) => {
                const I = deviceIcon(p.name);
                const share = p.watts ? (p.month_kwh || 0) / totalKwh : (p.month_min || 0) / totalMin;
                const ch = p.known && p.same_min > 30 ? (p.month_min - p.same_min) / p.same_min : null;
                return (
                  <button
                    key={p.id}
                    onClick={() => setDev(p.id)}
                    aria-label={`${p.name}的用電明細`}
                    className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:outline-none active:bg-muted sm:px-5"
                  >
                    <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground"><I className="size-5" /></span>
                    <span className="min-w-0 flex-1 space-y-1">
                      <span className="block truncate font-medium">{p.name}</span>
                      <span className="flex flex-wrap items-center gap-x-2 text-sm text-muted-foreground">
                        {p.known && <span>開了 {fmtMin(p.month_min)}</span>}
                        {!!p.watts && <span>{fmt(p.watts)} W</span>}
                        {ch != null && (
                          Math.abs(ch) < 0.05 ? <span>持平</span> : (
                            <span className={cn("inline-flex items-center font-medium", ch > 0 ? "text-orange-600 dark:text-orange-400" : "text-emerald-600 dark:text-emerald-400")}>
                              {ch > 0 ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}{fmt(Math.abs(ch) * 100)}%
                            </span>
                          )
                        )}
                      </span>
                      <span className="block h-1.5 overflow-hidden rounded-full bg-muted"><span className="block h-full rounded-full bg-primary/70" style={{ width: `${Math.max(1, share * 100)}%` }} /></span>
                    </span>
                    <span className="shrink-0 text-right">
                      {!p.known ? (
                        <span className="text-sm text-muted-foreground">讀不到</span>
                      ) : p.watts ? (
                        <>
                          <span className="block font-semibold tabular-nums">{fmt(p.month_kwh, 1)} 度</span>
                          <span className="block text-sm text-muted-foreground tabular-nums">{money(p.month_cost)}</span>
                        </>
                      ) : (
                        <span className="rounded-full bg-muted px-2.5 py-1 text-sm">設定瓦數</span>
                      )}
                    </span>
                  </button>
                );
              })}
            </div>
          </Card>

          {/* 電費設定 */}
          <Card className="gap-0 overflow-hidden py-0">
            <CardTitle title="電費設定" />
            <div className="divide-y">
              <div className="flex flex-wrap items-center gap-3 px-4 py-3 sm:px-5">
                <div className="min-w-0 flex-1 basis-40">
                  <div className="font-medium">家裡每月用電</div>
                  <div className="text-sm leading-relaxed text-muted-foreground">電費單上的度數（兩個月一期的話除以 2），用來決定電價級距</div>
                </div>
                <SettingNumber k="household_monthly_kwh" step={10} unit="度" label="家裡每月用電" />
              </div>
              <div className="flex items-center gap-3 px-4 py-3 sm:px-5">
                <div className="min-w-0 flex-1">
                  <div className="font-medium">目前電價</div>
                  <div className="text-sm leading-relaxed text-muted-foreground">依每月用電和季節自動算出（夏月 6～9 月較貴）</div>
                </div>
                <div className="text-right">
                  <div className="font-semibold tabular-nums">{fmt(e.price, 2)} 元/度</div>
                  <div className="text-sm text-muted-foreground">{e.season}</div>
                </div>
              </div>
            </div>
            <p className="px-4 py-3 text-sm leading-relaxed text-muted-foreground sm:px-5">
              所有金額都是估算：開著的時間 × 設定的瓦數。時間是插座自己記錄的（樹莓派停機時也有記錄），實際用電會依電器狀態而不同。
            </p>
          </Card>
        </div>
      </div>

      <EnergyDeviceSheet id={dev} energy={e} plug={state?.plugs.find((p) => p.id === dev)} onClose={() => setDev(null)} onChanged={load} />
    </>
  );
}

function HeatRow({ name, days, dates, onTip, onOpen }: { name: string; days: number[]; dates: string[]; onTip: (t: string) => void; onOpen: () => void }) {
  return (
    <>
      <button onClick={onOpen} title={name} className="sticky left-0 z-10 h-full truncate bg-card pr-2 text-left text-sm hover:text-primary focus-visible:outline-none focus-visible:underline">{name}</button>
      {days.map((m, i) => (
        <i
          key={i}
          onMouseEnter={() => onTip(`${name}・${md(dates[i])}：開了 ${fmtMin(m)}`)}
          onTouchStart={() => onTip(`${name}・${md(dates[i])}：開了 ${fmtMin(m)}`)}
          className={cn("block aspect-square max-h-6 w-full rounded-[3px]", m > 0 ? "bg-primary" : "bg-muted")}
          style={m > 0 ? { opacity: Math.max(0.12, Math.min(1, m / 60 / 24)) } : undefined}
        />
      ))}
    </>
  );
}

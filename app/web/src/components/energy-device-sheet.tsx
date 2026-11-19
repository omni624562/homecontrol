import { useState, type ReactNode } from "react";
import { AlertCircle, ChevronDown, ChevronUp } from "lucide-react";
import { BarChart, type Bar } from "@/components/bar-chart";
import { deviceIcon } from "@/components/icons";
import { Sheet } from "@/components/responsive-sheet";
import { Segmented } from "@/components/schedule-bits";
import { Group, Section } from "@/components/settings-bits";
import { WattsRows } from "@/components/watts-field";
import { fmt, fmtMin } from "@/lib/format";
import { useHub } from "@/lib/hub";
import type { Energy, Plug } from "@/lib/types";
import { cn } from "@/lib/utils";

// 單一裝置的用電明細：本月數字、每天／每月趨勢、接的電器
export function EnergyDeviceSheet({ id, energy: e, plug: p, onClose, onChanged }: { id: string | null; energy: Energy; plug?: Plug; onClose: () => void; onChanged: () => void }) {
  const { state } = useHub();
  const [range, setRange] = useState<"days" | "months">("days");
  const ep = e.plugs.find((x) => x.id === id);
  const open = !!id && !!p && !!ep;
  const I = p ? deviceIcon(p.name) : null;
  const room = state?.rooms.find((r) => r.id === p?.room)?.name || "還沒分區域";

  let body: ReactNode = null;
  if (p && ep) {
    const kw = (p.watts || 0) / 1000;
    const useKwh = !!p.watts;
    const unit = useKwh ? "度" : "小時";
    const items: Bar[] = !ep.known
      ? []
      : range === "days"
        ? ep.days.map((m, i) => {
            const d = e.days[i].day;
            const last = i === ep.days.length - 1;
            const kwh = (m / 60) * kw;
            return {
              v: useKwh ? kwh : m / 60,
              now: last,
              label: last ? "今" : i % 5 === 4 ? String(Number(d.slice(8))) : "",
              tip: `${Number(d.slice(5, 7))}/${Number(d.slice(8))}${last ? "（今天）" : ""}：開了 ${fmtMin(m)}${useKwh ? `・${fmt(kwh, 2)} 度・約 $${fmt(kwh * e.price, 1)}` : ""}`,
            };
          })
        : ep.months.map((m, i) => {
            const mm = e.months[i].month;
            const last = i === ep.months.length - 1;
            const kwh = (m / 60) * kw;
            return {
              v: useKwh ? kwh : m / 60,
              now: last,
              label: `${Number(mm.slice(5))}月`,
              tip: `${mm.slice(0, 4)} 年 ${Number(mm.slice(5))} 月${last ? "（本月至今）" : ""}：開了 ${fmtMin(m)}${useKwh ? `・${fmt(kwh, 1)} 度` : ""}`,
            };
          });
    const ch = ep.known && ep.same_min > 30 ? (ep.month_min - ep.same_min) / ep.same_min : null;
    body = (
      <div className="space-y-5">
        {!ep.known ? (
          <div className="flex gap-3 rounded-xl border border-orange-300 bg-orange-50 p-4 dark:border-orange-500/30 dark:bg-orange-500/10">
            <AlertCircle className="mt-0.5 size-5 shrink-0 text-orange-600" />
            <div className="leading-relaxed"><div className="font-semibold">讀不到這個插座的使用時間</div><div className="text-sm text-muted-foreground">插座離線或還沒讀到，稍後再看</div></div>
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-4 gap-y-1 text-sm">
                <span className="whitespace-nowrap text-muted-foreground">
                  {useKwh && <>開機 <b className="font-semibold text-foreground tabular-nums">{fmt(ep.month_min / 60, 0)}</b> 小時・</>}
                  平均每天 <b className="font-semibold text-foreground tabular-nums">{fmt(ep.month_min / 60 / Math.max(1, e.day_of_month), 1)}</b> 小時
                </span>
                <span className="inline-flex items-center whitespace-nowrap text-muted-foreground">
                  比上月同期
                  {ch == null ? (
                    <b className="ml-1 font-semibold text-foreground">—</b>
                  ) : Math.abs(ch) < 0.05 ? (
                    <b className="ml-1 font-semibold text-foreground">持平</b>
                  ) : (
                    <b className={cn("ml-1 inline-flex items-center font-semibold tabular-nums", ch > 0 ? "text-orange-600 dark:text-orange-400" : "text-emerald-600 dark:text-emerald-400")}>
                      {ch > 0 ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}{fmt(Math.abs(ch) * 100)}%
                    </b>
                  )}
                </span>
              </div>
              <div className="w-52 shrink-0"><Segmented label="期間" value={range} onChange={setRange} options={[["days", "近 30 天"], ["months", "近 12 個月"]]} /></div>
            </div>
            <BarChart items={items} unit={unit} name={`${p.name}${useKwh ? "用電" : "開機時數"}`} height="h-56" />
          </>
        )}
        <Section title="估算方式">
          <Group>
            <WattsRows p={p} hint="改了會馬上重算" onSaved={onChanged} />
          </Group>
        </Section>
      </div>
    );
  }

  return (
    <Sheet open={open} onOpenChange={(v) => !v && onClose()} title={p?.name || ""} description={`${room}・用電明細`}
      icon={I ? <I /> : undefined}
      wide
      aside={
        ep?.known ? (
          <div className="text-right leading-tight">
            <div className="text-2xl font-bold tracking-tight tabular-nums">
              {p?.watts ? fmt(ep.month_kwh, 1) : fmt(ep.month_min / 60, 0)}
              <span className="ml-1 text-sm font-normal text-muted-foreground">{p?.watts ? "度" : "小時"}</span>
            </div>
            <div className="text-sm text-muted-foreground tabular-nums">{p?.watts ? `本月・約 $${fmt(ep.month_cost)}` : "本月開機・沒設瓦數"}</div>
          </div>
        ) : undefined
      }
    >
      {body}
    </Sheet>
  );
}

import { useState, type ReactNode } from "react";
import { AlertCircle, ChevronDown, ChevronUp } from "lucide-react";
import { Card } from "@/components/ui/card";
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

function Mini({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: "up" | "down" }) {
  return (
    <Card className="gap-1 px-4 py-3 shadow-none">
      <div className="text-sm text-muted-foreground">{label}</div>
      <div className={cn("text-xl font-bold tabular-nums", tone === "up" && "text-orange-600 dark:text-orange-400", tone === "down" && "text-emerald-600 dark:text-emerald-400")}>{value}</div>
      {sub && <div className="text-xs leading-relaxed text-muted-foreground">{sub}</div>}
    </Card>
  );
}

// 單一裝置的用電明細：本月數字、每天／每月趨勢、接的電器
export function EnergyDeviceSheet({ id, energy: e, plug: p, onClose, onChanged }: { id: string | null; energy: Energy; plug?: Plug; onClose: () => void; onChanged: () => void }) {
  const { state } = useHub();
  const [range, setRange] = useState<"days" | "months">("days");
  const ep = e.plugs.find((x) => x.id === id);
  const open = !!id && !!p && !!ep;
  const I = p ? deviceIcon(p.name) : null;
  const room = state?.rooms.find((r) => r.id === p?.room)?.name || "還沒分房間";

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
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <Mini label="本月用電" value={useKwh ? <>{fmt(ep.month_kwh, 1)}<span className="ml-1 text-sm font-normal text-muted-foreground">度</span></> : "—"} sub={useKwh ? undefined : "沒設瓦數"} />
              <Mini label="本月電費" value={useKwh ? `$${fmt(ep.month_cost)}` : "—"} sub="估算" />
              <Mini label="本月開機" value={<>{fmt(ep.month_min / 60, 0)}<span className="ml-1 text-sm font-normal text-muted-foreground">小時</span></>} sub={`平均每天 ${fmt(ep.month_min / 60 / Math.max(1, e.day_of_month), 1)} 小時`} />
              <Mini
                label="比上月同期"
                tone={ch == null || Math.abs(ch) < 0.05 ? undefined : ch > 0 ? "up" : "down"}
                value={ch == null ? "—" : Math.abs(ch) < 0.05 ? "持平" : <span className="inline-flex items-center">{ch > 0 ? <ChevronUp className="size-5" /> : <ChevronDown className="size-5" />}{fmt(Math.abs(ch) * 100)}%</span>}
                sub="開機時數"
              />
            </div>
            <Section title={useKwh ? "用電（度）" : "開機時數（小時）"}>
              <div className="w-56"><Segmented label="期間" value={range} onChange={setRange} options={[["days", "近 30 天"], ["months", "近 12 個月"]]} /></div>
              <BarChart items={items} unit={unit} name={`${p.name}${useKwh ? "用電" : "開機時數"}`} />
            </Section>
          </>
        )}
        <Section title="接的電器・決定這個裝置怎麼估算用電">
          <Group>
            <WattsRows p={p} hint="改了會馬上重算" onSaved={onChanged} />
          </Group>
        </Section>
      </div>
    );
  }

  return (
    <Sheet open={open} onOpenChange={(v) => !v && onClose()} title={p?.name || ""} description={`${room}・用電明細`} icon={I ? <I /> : undefined} wide>
      {body}
    </Sheet>
  );
}

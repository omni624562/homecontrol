import { useState } from "react";
import { Droplets, Home, Loader2, Truck, Zap, ZapOff } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Sheet } from "@/components/responsive-sheet";
import { api } from "@/lib/api";
import { dayLabel, pad2, WEEK } from "@/lib/format";
import { useHub } from "@/lib/hub";
import type { Outage } from "@/lib/types";
import { cn } from "@/lib/utils";

const DN = "一二三四五六日"; // 伺服器的星期：0 = 星期一

function range(x: Outage) {
  const a = new Date(x.start);
  const b = new Date(x.end);
  const same = a.toDateString() === b.toDateString();
  const t = (d: Date) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  return `${a.getMonth() + 1}/${a.getDate()}（${WEEK[a.getDay()]}）${t(a)}～${same ? "" : `${b.getMonth() + 1}/${b.getDate()} `}${t(b)}`;
}

export function LifeSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { state } = useHub();
  const L = state?.calendar.local;
  const [roads, setRoads] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  if (!L) return null;
  const g = L.garbage;
  const t = g?.truck;

  const put = async (body: object, ok?: string) => {
    try {
      await api("PUT", "/api/local", body);
      if (ok) toast.success(ok);
    } catch (err) {
      toast.error("沒有成功", { description: (err as Error).message });
    }
  };

  const when = g?.usual ? `約 ${g.usual}` : ` ${g?.stop.time}`;
  const usualNote = g?.usual ? `・表定 ${g.stop.time}，最近實際大約 ${g.usual} 到` : "";
  const status = !g
    ? null
    : !g.today.length
      ? { big: "今天不收", small: g.next[0] ? `下一次：${dayLabel(g.next[0].date)} ${g.stop.time}` : "" }
      : t && !t.none && (t.stops ?? -1) >= 0
        ? { big: `還有 ${t.stops} 站${t.eta_min != null ? `・約 ${t.eta_min} 分鐘` : ""}`, small: `車子在${t.at_stop}附近（${t.car}，${(t.at || "").slice(11, 16)} 回報）` }
        : t && !t.none
          ? { big: "垃圾車已經過了", small: `最後在${t.at_stop}附近` }
          : g.watching
            ? { big: `今天${when}`, small: `還沒看到這條路線的車子出勤${usualNote}` }
            : { big: `今天${when}`, small: `${g.today.join("、")}・表定時間前 45 分鐘開始追蹤車子${usualNote}` };
  const running = !!g && g.today.length > 0 && !!t && !t.none && (t.stops ?? -1) >= 0;
  const days = (d: number[]) => (d.length ? d.map((i) => DN[i]).join("") : "不收");

  return (
    <Sheet open={open} onOpenChange={(v) => !v && onClose()} title="生活資訊"
      description={L.place ? `${L.place}・政府開放資料` : "政府開放資料"}
      icon={<Truck />}
      wide
      aside={
        status ? (
          <div className="text-right leading-tight">
            <div className="text-xs text-muted-foreground">垃圾車</div>
            <div className={cn("text-lg font-bold whitespace-nowrap", running && "text-amber-600 dark:text-amber-400")}>{status.big}</div>
          </div>
        ) : undefined
      }
    >
      <div className="space-y-5">
        <section className="rounded-2xl border p-4">
          <h3 className="mb-3 flex items-center gap-2 font-semibold">
            <Truck className="size-5 text-primary" />
            垃圾車
          </h3>
          {!L.garbage_supported ? (
            <p className="text-sm text-muted-foreground">垃圾車目前只支援新北市</p>
          ) : !g || !status ? (
            <p className="text-sm text-muted-foreground">{L.errors.routes ? `路線下載失敗：${L.errors.routes}` : "正在下載垃圾車路線…"}</p>
          ) : (
            <div className="space-y-4">
              {status.small && <div className="text-sm leading-relaxed text-muted-foreground">{status.small}</div>}
              {running && <TruckRoad stops={t!.stops!} />}
              <div className="flex flex-wrap gap-2">
                {g.next.map((n) => (
                  <div key={n.date} className="rounded-xl bg-muted/60 px-3 py-2 text-sm">
                    <div className="font-medium">
                      {dayLabel(n.date)} {g.stop.time}
                    </div>
                    <div className="text-muted-foreground">{n.kinds.join("、")}</div>
                  </div>
                ))}
              </div>
              <div className="space-y-2">
                <Label>清運點</Label>
                <Select value={`${g.stop.lineid}|${g.stop.rank}`} onValueChange={(v) => { const [lineid, rank] = v.split("|"); put({ stop: { lineid, rank } }, "已更換清運點"); }}>
                  <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {L.stops.map((x) => (
                      <SelectItem key={`${x.lineid}|${x.rank}`} value={`${x.lineid}|${x.rank}`}>
                        {x.name}・{x.time}・{x.line}・{x.m} 公尺
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  一般垃圾 {days(g.stop.days.garbage)}・回收 {days(g.stop.days.recycling)}・廚餘 {days(g.stop.days.foodscraps)}
                </p>
              </div>
              <div className="flex items-center justify-between gap-4">
                <div>
                  <Label htmlFor="g-notify">快到時通知</Label>
                  <p className="text-xs text-muted-foreground">剩 3 站時推播（要先在設定頁設好 LINE 通知）</p>
                </div>
                <Switch id="g-notify" checked={L.garbage_notify} onCheckedChange={(v) => put({ garbage_notify: v })} />
              </div>
            </div>
          )}
        </section>

        <section className="rounded-2xl border p-4">
          <h3 className="mb-3 flex items-center gap-2 font-semibold">
            <ZapOff className="size-5 text-primary" />
            停水、停電
          </h3>
          <div className="space-y-2">
            <Label htmlFor="roads">你家的路名</Label>
            <form
              className="flex gap-2"
              onSubmit={async (e) => {
                e.preventDefault();
                setSaving(true);
                await put({ roads: (roads ?? L.roads.join("、")).split(/[、,，\s]+/).filter(Boolean) }, "已儲存路名");
                setSaving(false);
                setRoads(null);
              }}
            >
              <Input id="roads" value={roads ?? L.roads.join("、")} onChange={(e) => setRoads(e.target.value)} placeholder="中興街、集賢路" className="h-11" />
              <Button type="submit" className="h-11" disabled={saving}>
                {saving && <Loader2 className="animate-spin" />}儲存
              </Button>
            </form>
            <p className="text-xs leading-relaxed text-muted-foreground">停水、停電的範圍寫到這些路就標出來並通知。只存在樹莓派上。</p>
          </div>
          <div className="mt-4 flex items-center justify-between gap-4">
            <div>
              <Label htmlFor="o-notify">有你家的路時通知</Label>
              <p className="text-xs text-muted-foreground">新公告一出來就推播（要先在設定頁設好 LINE 通知）</p>
            </div>
            <Switch id="o-notify" checked={L.outage_notify} onCheckedChange={(v) => put({ outage_notify: v })} />
          </div>
          <h4 className="mt-5 mb-1 text-sm font-medium text-muted-foreground">接下來兩週{L.place ? `・${L.place}` : ""}</h4>
          {L.outages.length ? (
            <ul className="divide-y">
              {L.outages.map((x) => {
                const I = x.kind === "power" ? Zap : Droplets;
                return (
                  <li key={x.id} className="flex gap-3 py-3">
                    <I className={cn("mt-0.5 size-5 shrink-0", x.hit === "road" ? "text-orange-600" : "text-muted-foreground")} />
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2 text-sm font-semibold">
                        {x.kind === "power" ? "停電" : x.pressure ? "停水／降壓" : "停水"} {range(x)}
                        {x.hit === "road" && <Badge className="bg-orange-100 text-orange-700 hover:bg-orange-100 dark:bg-orange-500/15 dark:text-orange-300">有你家的路</Badge>}
                      </div>
                      <p className="mt-0.5 line-clamp-3 text-sm leading-relaxed text-muted-foreground">{x.area}</p>
                      <p className="text-xs text-muted-foreground/80">{x.src}{x.reason && `・${x.reason}`}</p>
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="py-2 text-sm text-muted-foreground">{L.errors.outages ? `查詢失敗：${L.errors.outages}` : L.updated.outages ? "沒有停水、停電的公告" : "查詢中…"}</p>
          )}
        </section>
        <p className="text-xs leading-relaxed text-muted-foreground">
          資料來源：新北市環保局（垃圾車路線、即時位置）、台灣自來水公司、臺北自來水事業處、台電（計畫性工作停電）。整份資料下載到樹莓派上比對，不會送出家裡的位置或地址。
        </p>
      </div>
    </Sheet>
  );
}

// 垃圾車正在開過來：一條小馬路，車子越近越靠右邊的「你家」
function TruckRoad({ stops }: { stops: number }) {
  const FAR = 12; // 這麼多站以外都畫在最左邊
  const pos = Math.max(0, Math.min(1, 1 - stops / FAR));
  return (
    <div className="rounded-xl bg-muted/60 px-4 pt-3 pb-2" role="img" aria-label={`垃圾車正在開過來，還有 ${stops} 站`}>
      <div className="relative h-10">
        {/* 路面 */}
        <div className="absolute inset-x-0 bottom-1 h-1.5 rounded-full bg-neutral-300 dark:bg-neutral-700" />
        <div className="road-run absolute inset-x-2 bottom-[9px] h-[2px] text-neutral-400/70 dark:text-neutral-500" />
        {/* 你家 */}
        <div className="absolute right-0 bottom-2.5 flex flex-col items-center text-primary">
          <Home className="size-6" />
        </div>
        {/* 車子：位置變了會滑過去 */}
        <div className="absolute bottom-2.5 transition-[left] duration-1000 ease-out" style={{ left: `calc(${pos} * (100% - 4.5rem))` }}>
          <Truck className="truck-run size-7 text-amber-600" />
        </div>
      </div>
      <div className="flex justify-between text-xs text-muted-foreground">
        <span>{stops > FAR ? `還很遠（${stops} 站）` : stops === 0 ? "到了！" : `還有 ${stops} 站`}</span>
        <span>你家的清運點</span>
      </div>
    </div>
  );
}

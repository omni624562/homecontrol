import { useEffect, useState } from "react";
import { Bike, Bus, Check, Droplets, Home, Loader2, Plus, Truck, X, Zap, ZapOff } from "lucide-react";
import { toast } from "sonner";
import { BikeMap } from "@/components/bike-map";
import { Badge } from "@/components/ui/badge";
import { Segmented } from "@/components/schedule-bits";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Sheet } from "@/components/responsive-sheet";
import { api } from "@/lib/api";
import { busEta, dayLabel, nextPickup, pad2, WEEK } from "@/lib/format";
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

export type LifeTopic = "garbage" | "bus" | "bike" | "outage";
const TOPICS: { key: LifeTopic; label: string; icon: React.ElementType; src: string }[] = [
  { key: "garbage", label: "垃圾車", icon: Truck, src: "新北市環保局（垃圾車路線、即時位置）" },
  { key: "bus", label: "公車", icon: Bus, src: "新北市交通局、臺北市公車動態資訊中心" },
  { key: "bike", label: "YouBike", icon: Bike, src: "新北市交通局（YouBike 2.0 即時資訊）；地圖 © OpenStreetMap 貢獻者" },
  { key: "outage", label: "停水停電", icon: ZapOff, src: "台灣自來水公司、臺北自來水事業處、台電（計畫性工作停電）" },
];

// 生活資訊：一次只看一件事（按哪個進來就先看哪個），上面的分頁可以換
export function LifeSheet({ open, onClose, topic = "garbage", inline }: { open: boolean; onClose: () => void; topic?: LifeTopic; inline?: boolean }) {
  const { state } = useHub();
  const [tab, setTab] = useState<LifeTopic>(topic);
  useEffect(() => {
    if (open) setTab(topic);
  }, [open, topic]);
  const L = state?.calendar.local;
  const [roads, setRoads] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  if (!L) return null;
  const g = L.garbage;
  const B = L.bus;
  const Y = L.bike;
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
    : g.off_today
      ? { big: "今天停收", small: `${g.off_today}${nextPickup(g) ? `・下一次：${nextPickup(g)}` : ""}` }
    : !g.today.length
      ? { big: "今天不收", small: nextPickup(g) ? `下一次：${nextPickup(g)}` : "" }
      : g.done
        ? { big: "今天收過了", small: nextPickup(g) ? `下一次：${nextPickup(g)}・${g.next.find((x) => !x.off)!.kinds.join("、")}` : "" }
      : t && !t.none && (t.stops ?? -1) >= 0
        ? { big: `還有 ${t.stops} 站${t.eta_min != null ? `・約 ${t.eta_min} 分鐘` : ""}`, small: `車子在${t.at_stop}附近（${t.car}，${(t.at || "").slice(11, 16)} 回報）` }
        : t && !t.none
          ? { big: "垃圾車已經過了", small: `最後在${t.at_stop}附近` }
          : g.watching
            ? { big: `今天${when}`, small: `還沒看到這條路線的車子出勤${usualNote}` }
            : { big: `今天${when}`, small: `${g.today.join("、")}・表定時間前 45 分鐘開始追蹤車子${usualNote}` };
  const running = !!g && g.today.length > 0 && !g.done && !!t && !t.none && (t.stops ?? -1) >= 0;
  const T = TOPICS.find((x) => x.key === tab)!;
  const days = (d: number[]) => (d.length ? d.map((i) => DN[i]).join("") : "不收");

  return (
    <Sheet inline={inline} open={open} onOpenChange={(v) => !v && onClose()} title={T.label}
      description={L.place ? `${L.place}・政府開放資料` : "政府開放資料"}
      icon={<T.icon />}
      wide
      aside={
        tab === "garbage" && status ? (
          <div className="text-right leading-tight">
            <div className="text-xs text-muted-foreground">{g?.today.length && !g.done ? "今天" : "垃圾車"}</div>
            <div className={cn("text-lg font-bold whitespace-nowrap", running && "text-amber-600 dark:text-amber-400")}>{status.big.replace(/^今天/, "")}</div>
          </div>
        ) : tab === "bus" && B?.updated ? (
          <span className="text-xs text-muted-foreground tabular-nums">{new Date(B.updated * 1000).toTimeString().slice(0, 5)} 更新</span>
        ) : tab === "bike" ? (
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            {Y?.show && Y.updated ? <span className="tabular-nums">{new Date(Y.updated * 1000).toTimeString().slice(0, 5)} 更新</span> : "顯示"}
            <Switch checked={Y?.show ?? true} onCheckedChange={(v) => put({ bike_show: v })} aria-label="顯示 YouBike" />
          </label>
        ) : undefined
      }
    >
      <div className="flex flex-col gap-5">
        {!inline && <Segmented label="生活資訊" value={tab} onChange={setTab} options={TOPICS.map((x) => [x.key, <span key={x.key} className="inline-flex items-center justify-center gap-1.5"><x.icon className="size-4 max-sm:hidden" />{x.label}</span>])} />}
{tab === "garbage" && (
                <section>
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
                  <div key={n.date} className={cn("rounded-xl px-3 py-2 text-sm", n.off ? "border border-dashed" : "bg-muted/60")}>
                    <div className={cn("font-medium", n.off && "text-destructive")}>
                      {dayLabel(n.date)}{n.off ? ` ${+n.date.slice(5, 7)}/${+n.date.slice(8)} ${n.off}` : ` ${g.stop.time}`}
                    </div>
                    <div className={cn("text-muted-foreground", n.off && "line-through")}>{n.kinds.join("、")}</div>
                  </div>
                ))}
              </div>
              {g.history && g.history.length >= 2 && <ArrivalHistory rows={g.history} sched={g.stop.time} />}
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
        )}

        {tab === "bus" && (
        <section>
          {B && B.routes.length > 0 && (
            <ul className="mb-4 divide-y">
              {B.routes.flatMap((rt) =>
                rt.dirs.map((d) => (
                  <li key={`${rt.id}:${d.gb}`} className={cn("flex items-center gap-3 py-2.5", !d.stop && "opacity-60")}>
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium">{rt.name}<span className="ml-2 text-sm font-normal text-muted-foreground">往{d.to}</span></div>
                      <Select value={d.stop?.id || "off"} onValueChange={(v) => put({ bus_pick: { [`${rt.id}:${d.gb}`]: v } })}>
                        <SelectTrigger size="sm" className="mt-1 h-8 max-w-full border-0 bg-muted/60 px-2 text-sm shadow-none" aria-label={`${rt.name}往${d.to}的站牌`}><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {d.near.map((x) => <SelectItem key={x.id} value={x.id}>{x.name}・{x.m} 公尺</SelectItem>)}
                          <SelectItem value="off">不顯示這個方向</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    {d.stop && (
                      <div className={cn("shrink-0 text-right text-lg font-bold whitespace-nowrap tabular-nums", d.sec != null && d.sec >= 0 && d.sec < 180 && "text-amber-600 dark:text-amber-400", (d.sec == null || d.sec < 0) && "text-base font-medium text-muted-foreground")}>
                        {busEta(d.sec)}
                      </div>
                    )}
                  </li>
                )),
              )}
            </ul>
          )}
          {B && B.names.length > 0 && !B.routes.length && (
            <p className="mb-4 text-sm text-muted-foreground">{B.error ? `查詢失敗：${B.error}` : B.updated ? "這些路線在你家 800 公尺內沒有站牌" : "正在下載路線…"}</p>
          )}
          {B && B.missing.length > 0 && <p className="mb-3 text-sm text-orange-600">找不到路線：{B.missing.join("、")}</p>}
          <BusPicker names={B?.names || []} nearby={B?.nearby || []} save={(list) => put({ bus_routes: list })} />
        </section>
        )}

        {tab === "bike" && (
        <section>
          {!Y?.show ? (
            <p className="text-sm text-muted-foreground">沒有開啟</p>
          ) : !Y.near.length ? (
            <p className="text-sm text-muted-foreground">{Y.error ? `查詢失敗：${Y.error}` : Y.updated ? "你家 600 公尺內沒有站" : L.garbage_supported ? "查詢中…" : "YouBike 目前只支援新北市"}</p>
          ) : (
            <>
              <BikeMap stations={Y.near} main={Y.main} onPick={(sno) => put({ bike_station: sno })} />
              <div role="radiogroup" aria-label="首頁顯示哪一站" className="mt-2 divide-y">
                {Y.near.map((x) => {
                  const on = x.sno === Y.main;
                  return (
                    <button key={x.sno} role="radio" aria-checked={on} onClick={() => put({ bike_station: x.sno })}
                      className="flex w-full items-center gap-3 py-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                      <span className={cn("flex size-4 shrink-0 items-center justify-center rounded-full border", on && "border-primary")}>{on && <i className="size-2 rounded-full bg-primary" />}</span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium">{x.name}</span>
                        <span className="text-sm text-muted-foreground tabular-nums">{x.m} 公尺・空位 {x.docks}{x.ebikes > 0 && `・電輔 ${x.ebikes}`}</span>
                      </span>
                      <span className={cn("shrink-0 text-lg font-bold whitespace-nowrap tabular-nums", (!x.ok || !x.bikes) && "text-base font-medium text-muted-foreground", x.ok && x.bikes > 0 && x.bikes <= 2 && "text-amber-600 dark:text-amber-400")}>
                        {!x.ok ? "暫停" : x.bikes ? `${x.bikes} 台` : "沒車"}
                      </span>
                    </button>
                  );
                })}
              </div>
              <p className="mt-2 text-xs leading-relaxed text-muted-foreground">圓點選的那一站會顯示在首頁。每 2 分鐘更新。</p>
            </>
          )}
        </section>
        )}

{tab === "outage" && (
                <section>
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
        )}
        <p className="text-xs leading-relaxed text-muted-foreground">
          資料來源：{T.src}。整份資料下載到樹莓派上比對，不會送出家裡的位置或地址。
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

// 要看的路線：家附近的路線點一下就加入／移除；不在附近的可以打名字加
const BUS_MAX = 10;
function BusPicker({ names, nearby, save }: { names: string[]; nearby: { name: string; m: number; stop: string }[]; save: (list: string[]) => Promise<unknown> }) {
  const [all, setAll] = useState(false);
  const [other, setOther] = useState("");
  const [busy, setBusy] = useState(false);
  const set = async (list: string[]) => {
    setBusy(true);
    try {
      await save(list);
    } finally {
      setBusy(false);
    }
  };
  const toggle = (n: string) => set(names.includes(n) ? names.filter((x) => x !== n) : [...names, n]);
  const full = names.length >= BUS_MAX;
  const shown = all ? nearby : nearby.slice(0, 12);
  const farAway = names.filter((n) => !nearby.some((x) => x.name === n));
  return (
    <div className="space-y-3">
      <div>
        <Label>要看的路線</Label>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">新北市的公車，最多 {BUS_MAX} 條。每分鐘更新，站牌預設選離家最近的。</p>
      </div>
      {farAway.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {farAway.map((n) => (
            <Button key={n} type="button" size="sm" variant="default" className="rounded-full" disabled={busy} onClick={() => toggle(n)} aria-label={`移除${n}`}>
              {n}<X />
            </Button>
          ))}
        </div>
      )}
      {nearby.length > 0 ? (
        <div>
          <div className="mb-1.5 text-sm font-medium">家附近的公車<span className="ml-1.5 font-normal text-muted-foreground">點一下加入或移除</span></div>
          <div className="flex flex-wrap gap-2">
            {shown.map((x) => {
              const on = names.includes(x.name);
              return (
                <Button
                  key={x.name} type="button" size="sm" variant={on ? "default" : "outline"} aria-pressed={on}
                  className="h-auto rounded-full py-1.5" disabled={busy || (!on && full)} onClick={() => toggle(x.name)}
                  title={`最近的站牌：${x.stop}・${x.m} 公尺`}
                >
                  {on && <Check />}
                  <span>{x.name}</span>
                  <span className={cn("text-xs font-normal tabular-nums", on ? "opacity-80" : "text-muted-foreground")}>{x.stop}・{x.m}m</span>
                </Button>
              );
            })}
          </div>
          {nearby.length > 12 && (
            <Button type="button" variant="link" size="sm" className="mt-1 px-0" onClick={() => setAll((v) => !v)}>
              {all ? "收起" : `顯示全部 ${nearby.length} 條`}
            </Button>
          )}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">正在找家附近的公車…（要先知道家的位置）</p>
      )}
      <form
        className="flex gap-2"
        onSubmit={async (e) => {
          e.preventDefault();
          const add = other.split(/[、,，\s]+/).map((x) => x.trim()).filter((x) => x && !names.includes(x));
          if (!add.length) return;
          await set([...names, ...add].slice(0, BUS_MAX));
          setOther("");
        }}
      >
        <Input value={other} onChange={(e) => setOther(e.target.value)} placeholder="其他路線，例如 965" className="h-10" aria-label="其他路線" />
        <Button type="submit" variant="outline" className="h-10" disabled={busy || full || !other.trim()}><Plus />加入</Button>
      </form>
    </div>
  );
}

// 最近幾次垃圾車實際到的時間：橘點畫在時間軸上，虛線是表定時間
function ArrivalHistory({ rows, sched }: { rows: { d: string; m: number }[]; sched: string }) {
  const [sh, sm] = sched.split(":").map(Number);
  const s = sh * 60 + sm;
  const ms = rows.map((r) => r.m).sort((a, b) => a - b);
  const lo = Math.floor((Math.min(ms[0], s) - 5) / 10) * 10;
  const hi = Math.ceil((Math.max(ms[ms.length - 1], s) + 5) / 10) * 10;
  const x = (m: number) => `${((m - lo) / (hi - lo)) * 100}%`;
  const hm = (m: number) => `${pad2(Math.floor(m / 60))}:${pad2(m % 60)}`;
  const ticks: number[] = [];
  for (let t = lo; t <= hi; t += 10) ticks.push(t);
  return (
    <div className="space-y-2">
      <Label>最近 {rows.length} 次幾點到</Label>
      <div className="relative mx-2 h-16" role="img" aria-label={`最近 ${rows.length} 次在 ${hm(ms[0])} 到 ${hm(ms[ms.length - 1])} 之間到，表定 ${sched}`}>
        <div className="absolute inset-x-0 top-7 h-0.5 bg-border" />
        <div className="absolute top-[22px] h-3.5 rounded-full bg-amber-500/20" style={{ left: x(ms[0]), width: `calc(${x(ms[ms.length - 1])} - ${x(ms[0])})` }} />
        <div className="absolute top-3 h-9 border-l-2 border-dashed border-primary" style={{ left: x(s) }}>
          <span className="absolute -top-3.5 -translate-x-1/2 text-[11px] whitespace-nowrap text-primary">表定 {sched}</span>
        </div>
        {rows.map((r) => (
          <span key={r.d} title={`${+r.d.slice(5, 7)}/${+r.d.slice(8)} ${hm(r.m)}`}
            className="absolute top-[22px] size-3.5 -translate-x-1/2 rounded-full border-2 border-card bg-amber-500" style={{ left: x(r.m) }} />
        ))}
        {ticks.map((t) => (
          <span key={t} className="absolute top-10 -translate-x-1/2 font-mono text-[11px] text-muted-foreground tabular-nums" style={{ left: x(t) }}>{hm(t)}</span>
        ))}
      </div>
      <p className="text-xs text-muted-foreground tabular-nums">
        最早 {hm(ms[0])}・中間 {hm(ms[Math.floor(ms.length / 2)])}・最晚 {hm(ms[ms.length - 1])}
      </p>
    </div>
  );
}

import { useEffect, useState } from "react";
import { Bike, Bus, Check, Droplets, Home, Loader2, Plus, Settings, Truck, X, Zap, ZapOff } from "lucide-react";
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
import { busEta, busIdle, dayLabel, nextPickup, pad2, WEEK } from "@/lib/format";
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
    if (open) {
      setTab(topic);
      setSetup(false);
      setMore(false);
    }
  }, [open, topic]);
  const L = state?.calendar.local;
  const [roads, setRoads] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [setup, setSetup] = useState(false); // 齒輪：這一頁的設定
  const [more, setMore] = useState(false); // 看全部
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

  const pick = (k: LifeTopic) => {
    setTab(k);
    setSetup(false);
    setMore(false);
  };
  const hm = (m: number) => `${pad2(Math.floor(m / 60))}:${pad2(m % 60)}`;
  const upd = (sec: number | null | undefined) => (sec ? `${new Date(sec * 1000).toTimeString().slice(0, 5)} 更新` : null);
  const md = (iso: string) => `${+iso.slice(5, 7)}/${+iso.slice(8)}`;

  // 每一頁都排成一樣：狀態（band）→ 固定 4 列（rows）→ 看全部；設定收在齒輪裡
  let page: TopicPage;
  if (tab === "garbage") {
    const hist = g?.history || [];
    const ms = hist.map((x) => x.m).sort((x, y) => x - y);
    page = {
      band: !L.garbage_supported ? { big: "不支援", small: "垃圾車目前只支援新北市" }
        : !g || !status ? { big: "下載中", small: L.errors.routes ? `路線下載失敗：${L.errors.routes}` : "正在下載垃圾車路線…" }
        : running ? { custom: <TruckRoad stops={t!.stops!} /> }
        : { big: status.big, small: status.small, hot: running },
      rows: [
        ...(g?.next || []).map((n) => (
          <Row key={n.date} title={`${dayLabel(n.date)} ${md(n.date)}`} sub={n.kinds.join("、")} subClass={n.off ? "line-through" : undefined}
            value={n.off || g!.stop.time} valueClass={n.off ? "text-base text-destructive" : undefined} />
        )),
        ...(ms.length >= 2 ? [<Row key="hist" title={`最近 ${ms.length} 次幾點到`} sub={`表定 ${g!.stop.time}`} value={`${hm(ms[0])}–${hm(ms[ms.length - 1]).slice(3)}`} />] : []),
      ],
      empty: "沒有收運資料",
      more: g && hist.length >= 2 ? <ArrivalHistory rows={hist} sched={g.stop.time} /> : undefined,
      settings: g ? (
        <>
          <div className="space-y-2">
            <Label>清運點</Label>
            <Select value={`${g.stop.lineid}|${g.stop.rank}`} onValueChange={(v) => { const [lineid, rank] = v.split("|"); put({ stop: { lineid, rank } }, "已更換清運點"); }}>
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                {L.stops.map((x) => (
                  <SelectItem key={`${x.lineid}|${x.rank}`} value={`${x.lineid}|${x.rank}`}>{x.name}・{x.time}・{x.line}・{x.m} 公尺</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs leading-relaxed text-muted-foreground">
              一般垃圾 {days(g.stop.days.garbage)}・回收 {days(g.stop.days.recycling)}・廚餘 {days(g.stop.days.foodscraps)}・春節（除夕晚上～初三）停收
            </p>
          </div>
          <SwitchRow id="g-notify" label="快到時通知" note="剩 3 站時推播（要先在設定頁設好 LINE 通知）" checked={L.garbage_notify} onChange={(v) => put({ garbage_notify: v })} />
        </>
      ) : null,
    };
  } else if (tab === "bus") {
    const dirs = (B?.routes || []).flatMap((rt) => rt.dirs.filter((d) => d.stop).map((d) => ({ rt, d })));
    const soon = dirs.filter((x) => x.d.sec != null && x.d.sec >= 0).sort((x, y) => x.d.sec! - y.d.sec!)[0];
    page = {
      aside: upd(B?.updated),
      band: !B?.names.length ? { big: "還沒選路線", small: "按右上角的齒輪選家附近的公車" }
        : B.error && !B.routes.length ? { big: "查詢失敗", small: B.error }
        : soon ? { big: `${soon.rt.name} ${busEta(soon.d.sec)}`, small: `${soon.d.stop!.name}・往${soon.d.to}`, hot: soon.d.sec! < 180 }
        : dirs.length ? { big: busIdle(B.routes), small: `${B.names.join("、")}` }
        : { big: "沒有站牌", small: B.updated ? "這些路線在你家 800 公尺內沒有站牌" : "正在下載路線…" },
      rows: dirs.map(({ rt, d }) => (
        <Row key={`${rt.id}:${d.gb}`} title={<>{rt.name}<span className="ml-2 text-sm font-normal text-muted-foreground">往{d.to}</span></>}
          sub={`${d.stop!.name}・${d.stop!.m} 公尺`} value={busEta(d.sec)}
          valueClass={cn(d.sec != null && d.sec >= 0 && d.sec < 180 && "text-amber-600 dark:text-amber-400", (d.sec == null || d.sec < 0) && "text-base font-medium text-muted-foreground")} />
      )),
      empty: B?.names.length ? "這些路線附近沒有站牌" : "還沒選路線",
      settings: (
        <>
          {B && B.missing.length > 0 && <p className="text-sm text-orange-600">找不到路線：{B.missing.join("、")}</p>}
          <BusPicker names={B?.names || []} nearby={B?.nearby || []} save={(list) => put({ bus_routes: list })} />
          {B && B.routes.length > 0 && (
            <div className="space-y-2">
              <Label>在哪一站等</Label>
              <ul className="divide-y">
                {B.routes.flatMap((rt) => rt.dirs.map((d) => (
                  <li key={`${rt.id}:${d.gb}`} className="flex items-center gap-3 py-2">
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">{rt.name}<span className="ml-1.5 font-normal text-muted-foreground">往{d.to}</span></span>
                    <Select value={d.stop?.id || "off"} onValueChange={(v) => put({ bus_pick: { [`${rt.id}:${d.gb}`]: v } })}>
                      <SelectTrigger size="sm" className="h-8 w-44 max-w-[50%]" aria-label={`${rt.name}往${d.to}的站牌`}><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {d.near.map((x) => <SelectItem key={x.id} value={x.id}>{x.name}・{x.m} 公尺</SelectItem>)}
                        <SelectItem value="off">不顯示這個方向</SelectItem>
                      </SelectContent>
                    </Select>
                  </li>
                )))}
              </ul>
            </div>
          )}
        </>
      ),
    };
  } else if (tab === "bike") {
    const main = Y?.near.find((x) => x.sno === Y.main) || Y?.near[0];
    const bikes = (x: { ok: boolean; bikes: number }) => (!x.ok ? "暫停" : x.bikes ? `${x.bikes} 台` : "沒車");
    page = {
      aside: Y?.show ? upd(Y.updated) : null,
      band: !Y?.show ? { big: "沒有開啟", small: "按右上角的齒輪打開 YouBike" }
        : main ? { big: bikes(main), small: `${main.name}・空位 ${main.docks}${main.ebikes ? `・電輔 ${main.ebikes}` : ""}`, hot: main.ok && main.bikes > 0 && main.bikes <= 2 }
        : { big: "附近沒有站", small: Y.error ? `查詢失敗：${Y.error}` : Y.updated ? "你家 600 公尺內沒有站" : L.garbage_supported ? "查詢中…" : "YouBike 目前只支援新北市" },
      rows: Y?.show ? Y.near.map((x) => (
        <Row key={x.sno} title={<>{x.name}{x.sno === Y.main && <Badge variant="secondary" className="ml-2 align-middle">首頁</Badge>}</>}
          sub={`${x.m} 公尺・空位 ${x.docks}${x.ebikes > 0 ? `・電輔 ${x.ebikes}` : ""}`} value={bikes(x)}
          valueClass={cn((!x.ok || !x.bikes) && "text-base font-medium text-muted-foreground", x.ok && x.bikes > 0 && x.bikes <= 2 && "text-amber-600 dark:text-amber-400")} />
      )) : [],
      empty: Y?.show ? "附近沒有站" : "沒有開啟",
      more: Y?.show && Y.near.length ? <BikeMap stations={Y.near} main={Y.main} onPick={(sno) => put({ bike_station: sno })} /> : undefined,
      moreAlways: true,
      settings: (
        <>
          <SwitchRow id="y-show" label="顯示 YouBike" note="首頁和生活資訊顯示附近的站" checked={Y?.show ?? true} onChange={(v) => put({ bike_show: v })} />
          {Y?.show && Y.near.length > 0 && (
            <div className="space-y-1">
              <Label>首頁顯示哪一站</Label>
              <div role="radiogroup" aria-label="首頁顯示哪一站" className="divide-y">
                {Y.near.map((x) => {
                  const on = x.sno === Y.main;
                  return (
                    <button key={x.sno} role="radio" aria-checked={on} onClick={() => put({ bike_station: x.sno })}
                      className="flex w-full items-center gap-3 py-2 text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                      <span className={cn("flex size-4 shrink-0 items-center justify-center rounded-full border", on && "border-primary")}>{on && <i className="size-2 rounded-full bg-primary" />}</span>
                      <span className="min-w-0 flex-1 truncate">{x.name}</span>
                      <span className="text-muted-foreground tabular-nums">{x.m} 公尺</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </>
      ),
    };
  } else {
    const hits = L.outages.filter((x) => x.hit === "road");
    page = {
      band: L.errors.outages && !L.outages.length ? { big: "查詢失敗", small: L.errors.outages }
        : hits.length ? { big: `${hits.length} 則有你家的路`, small: `接下來兩週・${range(hits[0])}`, hot: true }
        : { big: "沒有影響", small: `接下來兩週${L.outages.length ? ` ${L.outages.length} 則公告都沒寫到` : ""}・${L.roads.length ? L.roads.join("、") : "還沒設定路名"}` },
      rows: L.outages.map((x) => {
        const I = x.kind === "power" ? Zap : Droplets;
        return (
          <Row key={x.id} icon={<I className={cn("size-5", x.hit === "road" ? "text-orange-600" : "text-muted-foreground")} />}
            title={<>{x.kind === "power" ? "停電" : x.pressure ? "停水／降壓" : "停水"} {range(x)}{x.hit === "road" && <Badge className="ml-2 bg-orange-100 align-middle text-orange-700 hover:bg-orange-100 dark:bg-orange-500/15 dark:text-orange-300">有你家的路</Badge>}</>}
            sub={x.area} wrap={more} />
        );
      }),
      empty: L.updated.outages ? "接下來兩週沒有停水、停電的公告" : "查詢中…",
      settings: (
        <>
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
              <Button type="submit" className="h-11" disabled={saving}>{saving && <Loader2 className="animate-spin" />}儲存</Button>
            </form>
            <p className="text-xs leading-relaxed text-muted-foreground">停水、停電的範圍寫到這些路就標出來並通知。只存在樹莓派上。</p>
          </div>
          <SwitchRow id="o-notify" label="有你家的路時通知" note="新公告一出來就推播（要先在設定頁設好 LINE 通知）" checked={L.outage_notify} onChange={(v) => put({ outage_notify: v })} />
        </>
      ),
    };
  }

  return (
    <Sheet inline={inline} open={open} onOpenChange={(v) => !v && onClose()} title={T.label}
      description={L.place ? `${L.place}・政府開放資料` : "政府開放資料"}
      icon={<T.icon />}
      wide
      aside={
        <>
          {page.aside && <span className="text-xs text-muted-foreground tabular-nums">{page.aside}</span>}
          <Button type="button" variant={setup ? "default" : "outline"} size="icon" className="size-9" aria-pressed={setup}
            aria-label={setup ? `完成${T.label}設定` : `${T.label}設定`} onClick={() => { setSetup((v) => !v); setMore(false); }}>
            {setup ? <Check /> : <Settings />}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {!inline && <Segmented label="生活資訊" value={tab} onChange={pick} options={TOPICS.map((x) => [x.key, <span key={x.key} className="inline-flex items-center justify-center gap-1.5"><x.icon className="size-4 max-sm:hidden" />{x.label}</span>])} />}
        <TopicBody page={page} setup={setup} more={more} setMore={setMore} src={T.src} />
      </div>
    </Sheet>
  );
}

// 一頁的內容：band 是最上面的狀態，rows 一列一筆
interface TopicPage {
  aside?: string | null;
  band: { big?: string; small?: string; hot?: boolean; custom?: React.ReactNode };
  rows: React.ReactNode[];
  empty: string;
  more?: React.ReactNode; // 按「看全部」才出現（圖表、地圖）
  moreAlways?: boolean; // 只有 4 列以內也給「看全部」（為了看 more）
  settings: React.ReactNode;
}

const ROWS = 4;
// 四頁一樣高：狀態 84px＋4 列×56px＋底下一行；設定、看全部都在同一個高度裡捲動
function TopicBody({ page, setup, more, setMore, src }: { page: TopicPage; setup: boolean; more: boolean; setMore: (v: boolean) => void; src: string }) {
  const { band, rows } = page;
  const canMore = rows.length > ROWS || (!!page.more && (page.moreAlways || rows.length > 0));
  if (setup)
    return (
      <div className="h-[364px] space-y-5 overflow-x-hidden overflow-y-auto overscroll-contain pr-1">
        {page.settings}
        <p className="text-xs leading-relaxed text-muted-foreground">資料來源：{src}。整份資料下載到樹莓派上比對，不會送出家裡的位置或地址。</p>
      </div>
    );
  const shown = more ? rows : rows.slice(0, ROWS);
  const blanks = more ? 0 : Math.max(0, ROWS - Math.max(1, shown.length));
  return (
    <div className="flex h-[364px] flex-col gap-3">
      <div className="flex h-[84px] shrink-0 flex-col justify-center rounded-xl bg-muted/60 px-4">
        {band.custom ?? (
          <>
            <div className={cn("truncate text-xl font-bold tracking-tight tabular-nums", band.hot && "text-amber-600 dark:text-amber-400")}>{band.big}</div>
            {band.small && <div className="line-clamp-2 text-sm leading-snug text-muted-foreground">{band.small}</div>}
          </>
        )}
      </div>
      <div className={cn("min-h-0 flex-1", more && "space-y-3 overflow-x-hidden overflow-y-auto overscroll-contain pr-1")}>
        {more && page.more}
        <ul className="divide-y">
          {shown.length ? shown.map((r, i) => <li key={i}>{r}</li>) : <li className="flex h-14 items-center justify-center text-sm text-muted-foreground">{page.empty}</li>}
          {Array.from({ length: blanks }, (_, i) => <li key={`b${i}`} aria-hidden className="h-14" />)}
        </ul>
      </div>
      <div className="flex h-8 shrink-0 items-center justify-between gap-3 text-sm">
        {canMore ? (
          <Button type="button" variant="link" size="sm" className="h-8 px-0" onClick={() => setMore(!more)}>
            {more ? "收起" : rows.length > ROWS ? `看全部 ${rows.length} 筆` : "看更多"}
          </Button>
        ) : <span />}
        <span className="truncate text-xs text-muted-foreground">資料：{src.split(/[（、；]/)[0]}</span>
      </div>
    </div>
  );
}

function Row({ title, sub, value, icon, valueClass, subClass, wrap }: {
  title: React.ReactNode; sub?: React.ReactNode; value?: React.ReactNode; icon?: React.ReactNode; valueClass?: string; subClass?: string; wrap?: boolean;
}) {
  return (
    <div className={cn("flex items-center gap-3", wrap ? "min-h-14 py-2" : "h-14")}>
      {icon && <span className="shrink-0">{icon}</span>}
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium">{title}</div>
        {sub && <div className={cn("text-sm text-muted-foreground", wrap ? "leading-relaxed" : "truncate", subClass)}>{sub}</div>}
      </div>
      {value != null && <div className={cn("shrink-0 text-right text-lg font-bold whitespace-nowrap tabular-nums", valueClass)}>{value}</div>}
    </div>
  );
}

function SwitchRow({ id, label, note, checked, onChange }: { id: string; label: string; note: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div>
        <Label htmlFor={id}>{label}</Label>
        <p className="text-xs text-muted-foreground">{note}</p>
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
    </div>
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
      <div className="relative mx-5 h-16" role="img" aria-label={`最近 ${rows.length} 次在 ${hm(ms[0])} 到 ${hm(ms[ms.length - 1])} 之間到，表定 ${sched}`}>
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

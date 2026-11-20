import { Fragment, useCallback, useEffect, useState, type ReactNode } from "react";
import { AlertCircle, BarChart3, Cable, ChevronRight, CircleHelp, Home, Info, Plug, Plus, ShieldCheck, Router, User, Wand2, Wifi, WifiOff } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { PageHeader } from "@/components/app-shell";
import { NetTitle } from "@/components/net-view";
import { NetDevSheet, PersonSheet } from "@/components/net-sheets";
import { ChoiceChip } from "@/components/schedule-bits";
import { api } from "@/lib/api";
import { useHub } from "@/lib/hub";
import { useLook } from "@/lib/look";
import { KIND, devKind, fmtBytes, isRawName, netAgo, netName, type NetClient, type NetData } from "@/lib/net";
import { cn } from "@/lib/utils";

function NCard({ icon: I, title, end, children }: { icon: React.ElementType; title: string; end?: ReactNode; children: ReactNode }) {
  return (
    <Card className="gap-0 overflow-hidden py-0">
      <div className="flex items-center gap-3 border-b bg-muted/60 px-4 py-3 sm:px-5 dark:bg-muted/40">
        <div className="flex size-9 items-center justify-center rounded-lg border bg-background text-foreground/70"><I className="size-5" /></div>
        <h2 className="flex-1 text-lg font-bold tracking-tight">{title}</h2>
        {end}
      </div>
      {children}
    </Card>
  );
}

function SRow({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-3 px-4 py-3.5 sm:px-5">
      <div className="min-w-0 flex-1 basis-48">
        <div className="font-medium leading-snug">{label}</div>
        {hint && <div className="text-sm leading-relaxed text-muted-foreground">{hint}</div>}
      </div>
      {children}
    </div>
  );
}

const Foot = ({ icon: I, children }: { icon?: React.ElementType; children: ReactNode }) => (
  <p className="flex gap-2 px-4 py-3 text-sm leading-relaxed text-muted-foreground sm:px-5">{I && <I className="mt-0.5 size-4 shrink-0" />}<span>{children}</span></p>
);

const putPres = async (body: object) => {
  try {
    await api("PUT", "/api/settings", { presence: body });
    toast.success("已儲存");
  } catch (e) {
    toast.error("沒有成功", { description: (e as Error).message });
  }
};

type Filter = "all" | "mobile" | "computer" | "media" | "unnamed";

export function NetPage() {
  const { state } = useHub();
  const [net, setNet] = useState<NetData | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [dev, setDev] = useState<string | null>(null);
  const [person, setPerson] = useState<string | null>(null);
  const tech = useLook() === "tech";
  const load = useCallback(() => {
    api<NetData>("GET", "/api/net").then(setNet).catch(() => {});
  }, []);
  useEffect(() => {
    load();
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, [load]);

  const r = state?.router;
  const people = state?.people || [];
  const routerLine = !r?.configured
    ? "還沒連到路由器"
    : !r.ok
      ? `連不上路由器${r.error ? `：${r.error}` : ""}`
      : `${(r.nodes || []).map((n) => n.model).join(" + ")}${people.length ? `・${people.some((x) => x.home) ? `${people.filter((x) => x.home).length} 人在家` : "大家都出門了"}` : "・看誰在家、陌生裝置通知"}`;
  const head = (chips?: ReactNode[]) => (
    <PageHeader
      title={<NetTitle view="list" />}
      sub={routerLine}
      chips={chips?.length ? chips : undefined}
      chipsClassName="xl:justify-start xl:[&>:first-child]:ml-auto"
    />
  );
  const header = head();
  if (!state) return header;
  if (!r?.configured) return <>{header}<div className="mx-auto max-w-[112rem] px-4 py-10 text-center text-muted-foreground">還沒設定要讀哪一台路由器。</div></>;
  if (!net)
    return (
      <>
        {header}
        <div className="mx-auto grid max-w-[112rem] gap-4 px-4 py-4 sm:px-6 lg:grid-cols-2 lg:px-8" aria-busy="true" aria-label="載入中">
          {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-56 rounded-xl" />)}
        </div>
      </>
    );

  const pres = (state.settings.presence || {}) as { away_scene?: string | null; home_scene?: string | null; home_dark_only?: boolean; left_on?: string; grace_min?: number; risky_off?: boolean };
  const client = (mac: string) => net.clients.find((c) => c.mac === mac);

  // 「ERIC watch」「ERIC Phone」看起來是同一個人：建議合併
  const groups: Record<string, typeof people> = {};
  for (const x of people) {
    const k = x.name.trim().split(/\s+/)[0];
    if (k && k !== x.name.trim()) (groups[k] ||= []).push(x);
  }
  const merge = Object.entries(groups).find(([, xs]) => xs.length > 1);
  const doMerge = async (v: string) => {
    const xs = people.filter((x) => x.name.trim().split(/\s+/)[0] === v && x.name.trim() !== v);
    if (xs.length < 2) return;
    const macs = [...new Set(xs.flatMap((x) => x.macs))];
    try {
      await api("PUT", `/api/people/${xs[0].id}`, { name: v, macs });
      for (const x of xs.slice(1)) await api("DELETE", `/api/people/${x.id}`);
      load();
      toast.success(`已合併成「${v}」：${macs.length} 台裝置`);
    } catch (e) {
      toast.error("沒有成功", { description: (e as Error).message });
    }
  };

  // 家裡的裝置
  const day = 86400;
  const online = net.clients.filter((c) => c.online && !c.plug);
  const plugCount = net.clients.filter((c) => c.online && c.plug).length;
  const match = (c: NetClient) => {
    const k = devKind(c);
    if (filter === "mobile") return ["phone", "tablet", "watch"].includes(k);
    if (filter === "computer") return k === "computer";
    if (filter === "media") return k === "tv" || k === "speaker";
    if (filter === "unnamed") return !c.label && isRawName(c.name);
    return k !== "network";
  };
  const raw = (c: NetClient) => !c.label && isRawName(c.name);
  const order = (a: NetClient, b: NetClient) => Number(raw(a)) - Number(raw(b)) || netName(a).localeCompare(netName(b), "zh-Hant");
  const shown = online.filter(match).sort(order);
  const gear = online.filter((c) => devKind(c) === "network");
  // 按連線方式分區：Wi-Fi 連主機、Wi-Fi 連各個節點、有線
  const subNodes = net.nodes.filter((x) => !x.main);
  const sections: { key: string; title: string; icon: React.ElementType; list: NetClient[] }[] = [
    { key: "main", title: subNodes.length ? "Wi-Fi・主機" : "Wi-Fi", icon: Wifi, list: shown.filter((c) => !c.wired && !subNodes.some((x) => x.mac === c.node)) },
    ...subNodes.map((x, i) => ({ key: x.mac, title: `Wi-Fi・節點${subNodes.length > 1 ? ` ${i + 1}` : ""}`, icon: Wifi, list: shown.filter((c) => !c.wired && c.node === x.mac) })),
    { key: "wired", title: "有線", icon: Cable, list: shown.filter((c) => c.wired) },
  ].filter((g) => g.list.length > 0);
  const SecHead = ({ icon: I, title, n }: { icon: React.ElementType; title: string; n: number }) => (
    <div className="flex items-center gap-2 border-t bg-muted/40 px-4 py-2 text-sm font-semibold text-muted-foreground sm:px-5">
      <I className="size-4" />{title}<span className="ml-auto font-normal tabular-nums">{n} 台</span>
    </div>
  );
  const offline = net.clients.filter((c) => !c.online && !c.plug && (c.person || c.map || c.label));
  const unnamed = online.filter(raw).length;
  const sig = (v: number | null) => (v == null ? "" : v >= -60 ? "訊號好" : v >= -70 ? "訊號普通" : "訊號弱");

  const DevRow = ({ c }: { c: NetClient }) => {
    const k = devKind(c);
    const I = KIND[k].icon;
    const isRaw = raw(c);
    // 連線中的已經按「Wi-Fi・主機／節點／有線」分區，這裡不用再說連在哪
    const where = c.online
      ? [c.wired ? "" : [c.band, sig(c.rssi)].filter(Boolean).join("・"), c.ip || ""].filter(Boolean).join("・")
      : c.wired ? "有線" : c.band || "";
    const sub = [isRaw ? KIND[k].label : c.vendor && c.vendor !== c.name && !/dhcp|MSFT/i.test(c.vendor) ? c.vendor : "", where, c.online ? "" : c.seen ? `最後看到 ${netAgo(c.seen, net.now)}` : ""].filter(Boolean).join("・");
    return (
      <button
        onClick={() => setDev(c.mac)}
        className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:outline-none active:bg-muted sm:px-5"
      >
        <span className={cn("flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground", c.online && !isRaw && "bg-primary/10 text-primary")}><I className="size-5" /></span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-1.5">
            <span className={cn("truncate font-medium", isRaw && "text-muted-foreground")}>{isRaw ? `${KIND[k].label}（還沒取名字）` : netName(c)}</span>
            {c.person && <span className="inline-flex items-center gap-0.5 rounded-md bg-muted px-1.5 text-xs leading-5 text-muted-foreground"><User className="size-3" />{c.person}</span>}
            {c.map && <span className="inline-flex items-center gap-0.5 rounded-md bg-muted px-1.5 text-xs leading-5 text-muted-foreground"><Wifi className="size-3" />地圖</span>}
            {c.first && net.now - c.first < day && <span className="rounded-md bg-amber-100 px-1.5 text-xs leading-5 font-medium text-amber-800 dark:bg-amber-500/15 dark:text-amber-300">新</span>}
          </span>
          <span className="block truncate text-sm text-muted-foreground">{isRaw ? [c.name, where].filter(Boolean).join("・") : sub}</span>
        </span>
        {!!c.today_bytes && <span className="shrink-0 text-sm tabular-nums text-muted-foreground">{fmtBytes(c.today_bytes)}</span>}
      </button>
    );
  };

  const heavy = online.filter((c) => (c.today_bytes || 0) > 0).sort((a, b) => (b.today_bytes || 0) - (a.today_bytes || 0)).slice(0, 5);
  const maxB = heavy[0]?.today_bytes || 1;
  const newAlert = state.settings.new_device_alert !== false;
  const sceneOpts = [["none", "不做事"], ...state.scenes.map((s) => [s.id, `執行「${s.name}」`])];

  // 科技感：標題右邊一行摘要（在家、連線中、還沒取名字、今天用最多）
  const chips: ReactNode[] = [];
  if (tech) {
    const homeN = people.filter((x) => x.home).length;
    if (people.length) chips.push(<span key="pp" className={cn("tech-item", homeN && "[&_b]:text-emerald-600 dark:[&_b]:text-emerald-400")} title={homeN ? `${homeN} 人在家` : "大家都出門了"}><Home className="size-4" /><b>{homeN}</b><small>/ {people.length} 人</small><span className="tech-item-sub">在家</span></span>);
    chips.push(<span key="on" className="tech-item [&_b]:text-primary" title={`另外還有 ${plugCount} 台插座`}><Wifi className="size-4" /><b>{online.length}</b><small>台</small><span className="tech-item-sub">連線中</span></span>);
    if (unnamed) chips.push(<button key="un" className="tech-item tech-item-warn" onClick={() => setFilter("unnamed")} title="點一下只看還沒取名字的"><CircleHelp className="size-4" /><b>{unnamed}</b><small>台</small><span className="tech-item-sub">還沒取名字</span></button>);
    if (heavy[0]) chips.push(<button key="hv" className="tech-item" onClick={() => setDev(heavy[0].mac)} title="今天用最多網路的裝置"><BarChart3 className="size-4" /><b>{fmtBytes(heavy[0].today_bytes!)}</b><span className="tech-item-sub max-w-40 truncate">{netName(heavy[0])}</span></button>);
  }

  return (
    <>
      {head(chips)}
      <div className="mx-auto max-w-[112rem] space-y-4 px-4 py-4 sm:px-6 lg:px-8">
        {!net.ok && (
          <div className="flex gap-2 rounded-xl border border-orange-300 bg-orange-50 px-4 py-3 text-sm leading-relaxed text-orange-800 dark:border-orange-500/30 dark:bg-orange-500/10 dark:text-orange-300">
            <AlertCircle className="mt-0.5 size-4 shrink-0" />連不上路由器{net.error ? `：${net.error}` : ""}。下面是最後讀到的資料。
          </div>
        )}
        <div className="grid items-start gap-4 lg:grid-cols-2">
          <div className="min-w-0 space-y-4">
            {/* 誰在家 */}
            <NCard icon={Home} title="誰在家" end={<Button variant="outline" size="sm" className="bg-background" onClick={() => setPerson("")}><Plus />新增家人</Button>}>
              {merge && (
                <div className="m-4 flex flex-wrap items-center gap-3 rounded-xl border border-primary/20 bg-primary/5 p-3">
                  <Info className="size-5 shrink-0 text-primary" />
                  <div className="min-w-0 flex-1 basis-48 text-sm leading-relaxed">
                    <div className="font-semibold">{merge[1].map((x) => `「${x.name}」`).join("和")}是同一個人嗎？</div>
                    <div className="text-muted-foreground">一個人可以有好幾台裝置（手機、手錶、平板），任何一台在家就算在家</div>
                  </div>
                  <Button size="sm" onClick={() => doMerge(merge[0])}><Wand2 />合併成「{merge[0]}」</Button>
                </div>
              )}
              {people.length ? (
                <div className="divide-y">
                  {people.map((x) => {
                    const devs = x.macs.map(client).filter(Boolean) as NetClient[];
                    const when = x.since ? `${netAgo(x.since, net.now)} ${x.home ? "回來" : "出門"}` : "";
                    return (
                      <button key={x.id} onClick={() => setPerson(x.id)} className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:outline-none active:bg-muted sm:px-5">
                        <span className={cn("flex size-11 shrink-0 items-center justify-center rounded-full bg-muted text-lg font-bold text-muted-foreground", x.home && "bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300")}>{[...x.name][0] || "?"}</span>
                        <span className="min-w-0 flex-1 space-y-1">
                          <span className="flex items-center gap-2 font-medium">
                            {x.name}
                            <Badge variant="secondary" className={cn(x.home && "bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300")}>{x.home == null ? "—" : x.home ? "在家" : "出門"}</Badge>
                            {when && <span className="text-sm font-normal text-muted-foreground">{when}</span>}
                          </span>
                          <span className="flex flex-wrap gap-1.5">
                            {devs.length ? devs.map((c) => {
                              const I = KIND[devKind(c)].icon;
                              return (
                                <span key={c.mac} className={cn("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs text-muted-foreground", c.online && "border-emerald-300 text-emerald-700 dark:border-emerald-500/40 dark:text-emerald-400")}>
                                  <I className="size-3.5" />{netName(c)}
                                </span>
                              );
                            }) : <span className="text-xs text-muted-foreground">還沒選裝置</span>}
                          </span>
                        </span>
                        <ChevronRight className="size-5 shrink-0 text-muted-foreground" />
                      </button>
                    );
                  })}
                </div>
              ) : (
                <p className="px-4 py-4 leading-relaxed text-muted-foreground sm:px-5">新增家人、選他的手機（和手錶），就能看誰在家，最後一個人出門時自動執行「出門」。</p>
              )}
              <div className="border-t"><Foot icon={ShieldCheck}>只看裝置有沒有連著家裡的 Wi-Fi，紀錄只留在樹莓派上；請先讓家人知道。</Foot></div>
            </NCard>

            {/* 出門與回家 */}
            {people.length > 0 && (
              <NCard icon={Wand2} title="出門與回家">
                <div className="divide-y">
                  <SRow label="大家都出門時" hint={`最後一個人離開 ${pres.grace_min || 10} 分鐘後`}>
                    <PSelect value={pres.away_scene || "none"} opts={sceneOpts} onChange={(v) => putPres({ away_scene: v === "none" ? null : v })} label="大家都出門時" />
                  </SRow>
                  <SRow label="有人回家時" hint="大家都出門之後，第一個人回來">
                    <PSelect value={pres.home_scene || "none"} opts={sceneOpts} onChange={(v) => putPres({ home_scene: v === "none" ? null : v })} label="有人回家時" />
                  </SRow>
                  {pres.home_scene && (
                    <SRow label="只在天黑後" hint="白天回家不執行（日落前 30 分鐘到日出之間才執行）">
                      <Switch checked={!!pres.home_dark_only} onCheckedChange={(v) => putPres({ home_dark_only: v })} aria-label="只在天黑後" />
                    </SRow>
                  )}
                  <SRow label="沒人在家還有電器開著" hint="設成「常開」的、「出門」情境裡設成不動的不算；同一次出門只講一次">
                    <PSelect value={pres.left_on || "notify"} opts={[["notify", "通知我"], ["off", "自動關掉"], ["none", "不用管"]]} onChange={(v) => putPres({ left_on: v })} label="怎麼處理" />
                  </SRow>
                  <SRow
                    label="高風險電器"
                    hint={(() => {
                      const r = state.plugs.filter((p) => p.risky).map((p) => p.name);
                      return `${r.length ? r.join("、") : "還沒有，在裝置詳細 → 進階打開"}・大家一出門就處理，不等 10 分鐘`;
                    })()}
                  >
                    <PSelect value={pres.risky_off === false ? "notify" : "off"} opts={[["off", "馬上關掉"], ["notify", "只緊急通知"]]} onChange={(v) => putPres({ risky_off: v === "off" })} label="高風險電器" />
                  </SRow>
                  <SRow label="離開多久才算出門" hint="手機睡著時偶爾會斷線一下，太短會誤判">
                    <PSelect value={String(pres.grace_min || 10)} opts={[5, 10, 15, 20, 30].map((m) => [String(m), `${m} 分鐘`])} onChange={(v) => putPres({ grace_min: +v })} label="分鐘" />
                  </SRow>
                </div>
              </NCard>
            )}

            {/* 今天用最多網路 */}
            {heavy.length > 0 && (
              <NCard icon={BarChart3} title="今天用最多網路">
                <div className="space-y-1 px-2 py-2">
                  {heavy.map((c) => (
                    <button key={c.mac} onClick={() => setDev(c.mac)} className="grid w-full grid-cols-[minmax(0,8rem)_1fr_auto] items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:outline-none sm:grid-cols-[minmax(0,10rem)_1fr_auto]">
                      <span className="truncate text-sm font-medium">{netName(c)}</span>
                      <span className="h-2.5 overflow-hidden rounded-full bg-muted"><span className="block h-full rounded-full bg-primary/80" style={{ width: `${Math.max(3, ((c.today_bytes || 0) / maxB) * 100)}%` }} /></span>
                      <span className="w-16 text-right text-sm tabular-nums text-muted-foreground">{fmtBytes(c.today_bytes || 0)}</span>
                    </button>
                  ))}
                </div>
                <Foot>下載加上傳；只算連在主路由器 Wi-Fi 上的裝置</Foot>
              </NCard>
            )}

            <Card className="gap-0 py-0">
              <SRow label="新裝置通知" hint="沒看過的裝置連上家裡的網路就通知你">
                <Switch
                  checked={newAlert}
                  aria-label="新裝置通知"
                  onCheckedChange={async (v) => {
                    try {
                      await api("PUT", "/api/settings", { new_device_alert: v });
                      toast.success(v ? "新裝置通知已打開" : "新裝置通知已關閉");
                    } catch (e) {
                      toast.error("沒有成功", { description: (e as Error).message });
                    }
                  }}
                />
              </SRow>
            </Card>
          </div>

          {/* 家裡的裝置 */}
          <NCard icon={Wifi} title="家裡的裝置" end={<Badge variant="secondary">{online.length} 台連線中</Badge>}>
            <div className="flex flex-wrap gap-2 px-4 pt-3 pb-2 sm:px-5">
              {([["all", "全部"], ["mobile", "手機・手錶"], ["computer", "電腦"], ["media", "電視・音箱"], ["unnamed", "還沒取名字"]] as [Filter, string][]).map(([k, l]) => (
                <ChoiceChip key={k} selected={filter === k} onClick={() => setFilter(k)}>{l}{k === "unnamed" && unnamed ? ` ${unnamed}` : ""}</ChoiceChip>
              ))}
            </div>
            {filter === "unnamed" && unnamed > 0 && (
              <p className="px-4 pb-2 text-sm leading-relaxed text-muted-foreground sm:px-5">點一下取個好認的名字。不知道是哪一台：右邊是它今天用的網路量；也可以把懷疑的裝置的 Wi-Fi 關掉，看哪一台消失。</p>
            )}
            {sections.length ? sections.map((g) => (
              <Fragment key={g.key}>
                <SecHead icon={g.icon} title={g.title} n={g.list.length} />
                <div className="divide-y border-t">{g.list.map((c) => <DevRow key={c.mac} c={c} />)}</div>
              </Fragment>
            )) : <p className="border-t px-4 py-4 text-muted-foreground sm:px-5">沒有這類的裝置</p>}
            {filter === "all" && gear.length > 0 && (
              <>
                <SecHead icon={Router} title="網路設備" n={gear.length} />
                <div className="divide-y border-t">{gear.map((c) => <DevRow key={c.mac} c={c} />)}</div>
              </>
            )}
            {filter === "all" && offline.length > 0 && (
              <>
                <SecHead icon={WifiOff} title="現在沒連線" n={offline.length} />
                <div className="divide-y border-t">{offline.map((c) => <DevRow key={c.mac} c={c} />)}</div>
              </>
            )}
            {plugCount > 0 && <div className="border-t"><Foot icon={Plug}>另外還有 {plugCount} 台插座（在首頁管理）</Foot></div>}
          </NCard>
        </div>
        <p className="text-sm leading-relaxed text-muted-foreground">從路由器讀（只讀，不改路由器的設定）。點裝置可以取名字、指定是誰的、放到訊號地圖。</p>
      </div>

      {dev && <NetDevSheet mac={dev} net={net} onClose={() => setDev(null)} onSaved={(n) => (n?.clients ? setNet(n) : load())} />}
      <PersonSheet open={person} net={net} onClose={() => setPerson(null)} onSaved={load} />
    </>
  );
}

function PSelect({ value, opts, onChange, label }: { value: string; opts: string[][]; onChange: (v: string) => void; label: string }) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="w-48 bg-background" aria-label={label}><SelectValue /></SelectTrigger>
      <SelectContent>{opts.map(([v, l]) => <SelectItem key={v} value={v}>{l}</SelectItem>)}</SelectContent>
    </Select>
  );
}

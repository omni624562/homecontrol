import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AlertCircle, Check, CheckCircle2, ChevronLeft, ImagePlus, LayoutGrid, Pencil, Plus, Trash2, Wifi, WifiOff, X } from "lucide-react";
import { toast } from "sonner";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/app-shell";
import { MapCanvas, type MapSel } from "@/components/map-canvas";
import { Segmented } from "@/components/schedule-bits";
import { api } from "@/lib/api";
import { fmt } from "@/lib/format";
import { useHub, useMedia } from "@/lib/hub";
import {
  AP_HEIGHTS, AP_Z, DEV_HEIGHTS, DEV_Z, autoAps, autoLayout, fpPayload, mapDevices, mapLinks, type Floorplan, type FpAp, type MapSense,
} from "@/lib/map-model";
import { cn } from "@/lib/utils";

const qText = { good: "適合偵測走動", ok: "勉強可以偵測走動", poor: "不太適合偵測走動" };

function SideCard({ title, children, onClose }: { title: string; children: ReactNode; onClose?: () => void }) {
  return (
    <Card className="gap-0 overflow-hidden py-0">
      <div className="flex items-center gap-3 border-b bg-muted/60 px-4 py-3 sm:px-5 dark:bg-muted/40">
        <h2 className="flex-1 text-lg font-bold tracking-tight">{title}</h2>
        {onClose && <Button variant="ghost" size="icon" className="size-8" onClick={onClose} aria-label="關閉"><X /></Button>}
      </div>
      <div className="space-y-3 px-4 py-4 sm:px-5">{children}</div>
    </Card>
  );
}

const Q = ({ children, sub }: { children: ReactNode; sub?: ReactNode }) => (
  <div className="text-sm font-medium">{children}{sub && <span className="ml-1.5 font-normal text-muted-foreground">{sub}</span>}</div>
);
const Note = ({ children, icon: I, tone }: { children: ReactNode; icon?: React.ElementType; tone?: "warn" | "ok" }) => (
  <p className={cn("flex gap-2 text-sm leading-relaxed text-muted-foreground", tone === "warn" && "text-orange-700 dark:text-orange-400")}>
    {I && <I className={cn("mt-0.5 size-4 shrink-0", tone === "ok" && "text-emerald-600")} />}
    <span>{children}</span>
  </p>
);

// 高度選單（公尺）；目前的值不在選項裡就多一個
function HeightSelect({ value, opts, onChange }: { value: number; opts: [number, string][]; onChange: (v: number) => void }) {
  const known = opts.some(([v]) => Math.abs(v - value) < 0.01);
  const cur = known ? String(opts.find(([v]) => Math.abs(v - value) < 0.01)![0]) : String(value);
  return (
    <Select value={cur} onValueChange={(v) => onChange(Number(v))}>
      <SelectTrigger className="w-full bg-background" aria-label="高度"><SelectValue /></SelectTrigger>
      <SelectContent>
        {opts.map(([v, l]) => <SelectItem key={v} value={String(v)}>{l}（{v} 公尺）</SelectItem>)}
        {!known && <SelectItem value={String(value)}>{value} 公尺</SelectItem>}
      </SelectContent>
    </Select>
  );
}

// 失焦或按 Enter 才存的文字欄
function CommitInput({ value, onCommit, ...rest }: { value: string; onCommit: (v: string) => void } & Omit<React.ComponentProps<typeof Input>, "value" | "onChange">) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return (
    <Input
      {...rest}
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => v !== value && onCommit(v)}
      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
    />
  );
}

function Confirm({ trigger, title, text, ok, onOk, safe }: { trigger: ReactNode; title: string; text: string; ok: string; onOk: () => void; safe?: boolean }) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>{trigger}</AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{text}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>取消</AlertDialogCancel>
          <AlertDialogAction variant={safe ? "default" : "destructive"} onClick={onOk}>{ok}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function MapPage() {
  const { state } = useHub();
  const narrow = !useMedia("(min-width: 1024px)");
  const [fp, setFpState] = useState<Floorplan | null>(null);
  const [failed, setFailed] = useState(false);
  const [sense, setSense] = useState<MapSense | null>(null);
  const [edit, setEdit] = useState(false);
  const [layer, setLayer] = useState<"signal" | "motion">("signal");
  const [sel, setSel] = useState<MapSel>(null);
  const [tip, setTip] = useState<string | null>(null);
  const fpRef = useRef<Floorplan | null>(null);
  const saveT = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const fileRef = useRef<HTMLInputElement>(null);
  const sideRef = useRef<HTMLDivElement>(null);

  const setFp = useCallback((f: Floorplan) => {
    fpRef.current = f;
    setFpState(f);
  }, []);
  // 改了就存（停 0.4 秒再存，拖曳時不會一直送）
  const save = useCallback(() => {
    clearTimeout(saveT.current);
    saveT.current = setTimeout(() => {
      if (!fpRef.current) return;
      api("PUT", "/api/floorplan", fpPayload(fpRef.current)).catch((err) => toast.error("地圖沒有存到", { description: (err as Error).message }));
    }, 400);
  }, []);
  const update = useCallback((f: Floorplan) => {
    setFp(f);
    save();
  }, [setFp, save]);

  const devs = useMemo(() => mapDevices(state?.plugs || [], sense), [state?.plugs, sense]);
  const devsRef = useRef(devs);
  devsRef.current = devs;

  // 讀地圖；第一次（還沒有區域）用家庭中控的區域排出草圖
  const roomsReady = !!state;
  useEffect(() => {
    if (!roomsReady) return;
    let alive = true;
    api<Floorplan>("GET", "/api/floorplan")
      .then((f) => {
        if (!alive) return;
        if (!f.rooms) {
          const laid = autoLayout(f, state!.rooms, devsRef.current, false);
          fpRef.current = laid;
          setFpState(laid);
          save();
        } else setFp(f);
      })
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomsReady]);

  // 動靜和路由器資料：每 10 秒更新
  useEffect(() => {
    let alive = true;
    const load = () => api<MapSense>("GET", "/api/sensing").then((d) => alive && setSense(d)).catch(() => {});
    load();
    const t = setInterval(load, 10000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  // 路由器讀到的主路由器、節點自動擺上去
  useEffect(() => {
    const f = fpRef.current;
    if (!f) return;
    const next = autoAps(f, sense?.net?.nodes || [], devs);
    if (next) update(next);
  }, [sense, fp?.rooms, devs, update]);

  useEffect(() => () => clearTimeout(saveT.current), []);

  const pick = (s: MapSel) => {
    setSel(s);
    if (s && narrow) requestAnimationFrame(() => sideRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }));
  };

  const head = (
    <PageHeader
      title={<span className="flex items-center gap-1"><a href="#settings" className="-ml-2 inline-flex size-9 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground" aria-label="回設定"><ChevronLeft className="size-6" /></a>訊號地圖</span>}
      sub={edit ? "拖曳區域和裝置到實際的位置；拉右下角改大小" : "各裝置的 Wi-Fi 訊號：藍色好、橘色弱；點裝置看詳細、設定高度"}
      actions={
        <Button variant={edit ? "default" : "outline"} className="h-10" onClick={() => { setEdit((v) => !v); setSel(null); }}>
          {edit ? <><Check />完成</> : <><Pencil />編輯</>}
        </Button>
      }
    />
  );

  if (!fp || !fp.rooms)
    return (
      <>
        {head}
        <div className="mx-auto max-w-[112rem] px-4 py-4 sm:px-6 lg:px-8">
          {failed ? <p className="py-16 text-center text-muted-foreground">讀不到地圖，稍後再試。</p> : <Skeleton className="aspect-[10/7] w-full rounded-xl" />}
        </div>
      </>
    );

  const motion = Object.fromEntries((sense?.devices || []).map((d) => [d.key, d.now]));
  const links = mapLinks(fp, devs);
  const nodes = sense?.net?.nodes || [];
  const ssids = [...new Set(devs.map((d) => d.ssid).filter(Boolean))] as string[];

  // 上傳平面圖：縮到最長邊 1600px；地圖的比例跟著平面圖
  const upload = async (file: File) => {
    try {
      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const im = new Image();
        im.onload = () => resolve(im);
        im.onerror = reject;
        im.src = URL.createObjectURL(file);
      });
      const scale = Math.min(1, 1600 / Math.max(img.width, img.height));
      const c = document.createElement("canvas");
      c.width = Math.round(img.width * scale);
      c.height = Math.round(img.height * scale);
      c.getContext("2d")!.drawImage(img, 0, 0, c.width, c.height);
      const data = c.toDataURL("image/jpeg", 0.85);
      const f = fpRef.current!;
      const nh = Math.round((1000 * c.height) / c.width);
      const sy = nh / f.h;
      const scaled: Floorplan = {
        ...f,
        w: 1000,
        h: nh,
        rooms: f.rooms!.map((r) => ({ ...r, y: r.y * sy, h: r.h * sy })),
        items: Object.fromEntries(Object.entries(f.items).map(([key, it]) => [key, { ...it, y: it.y * sy }])),
      };
      clearTimeout(saveT.current);
      await api("PUT", "/api/floorplan", fpPayload(scaled));
      setFp(await api<Floorplan>("POST", "/api/floorplan/image", { data }));
      toast.success("已上傳平面圖");
    } catch (err) {
      toast.error("上傳沒有成功", { description: (err as Error)?.message || String(err) });
    }
  };

  // 選取的項目
  let picked: ReactNode = null;
  if (edit && !sel)
    picked = (
      <>
        <Note>點區域、裝置或 Wi-Fi 基地台可以選取；拖曳移動，區域拉右下角的小方塊改大小。</Note>
        <Q sub="用來算距離">地圖的實際寬度</Q>
        <div className="flex items-center gap-2">
          <CommitInput
            type="number" min={2} max={100} step={0.5} inputMode="decimal" aria-label="實際寬度" className="h-10 w-28"
            value={String(fp.meters || 12)}
            onCommit={(v) => { const n = Number(v); if (n >= 2 && n <= 100) update({ ...fp, meters: n }); else toast.error("請輸入 2～100 公尺"); }}
          />
          <span className="text-sm text-muted-foreground">公尺</span>
        </div>
      </>
    );
  else if (sel?.kind === "room" && edit) {
    const r = fp.rooms.find((x) => x.id === sel.id);
    if (r)
      picked = (
        <>
          <Q>區域名稱</Q>
          <div className="flex gap-2">
            <CommitInput maxLength={20} aria-label="區域名稱" className="h-10" value={r.name}
              onCommit={(v) => update({ ...fp, rooms: fp.rooms!.map((x) => (x.id === r.id ? { ...x, name: v.trim().slice(0, 20) || x.name } : x)) })} />
            <Confirm
              trigger={<Button variant="outline" className="h-10 text-destructive hover:text-destructive"><Trash2 />移除</Button>}
              title="從地圖移除這個區域？" text="只影響地圖，家庭中控的區域設定不變。" ok="移除"
              onOk={() => { update({ ...fp, rooms: fp.rooms!.filter((x) => x.id !== r.id) }); setSel(null); }}
            />
          </div>
        </>
      );
  } else if (sel?.kind === "ap") {
    const a = fp.aps.find((x) => x.id === sel.id);
    const setAp = (patch: Partial<FpAp>) => update({ ...fp, aps: fp.aps.map((x) => (x.id === sel.id ? { ...x, ...patch } : x)) });
    if (a)
      picked = (
        <>
          {edit ? (
            <>
              <Q>Wi-Fi 基地台名稱</Q>
              <div className="flex gap-2">
                <CommitInput maxLength={30} aria-label="名稱" className="h-10" value={a.name} onCommit={(v) => setAp({ name: v.trim().slice(0, 30) || a.name })} />
                <Confirm
                  trigger={<Button variant="outline" className="h-10 text-destructive hover:text-destructive"><Trash2 />移除</Button>}
                  title="移除這個 Wi-Fi 基地台？" text="只從地圖移除。" ok="移除"
                  onOk={() => {
                    const items = { ...fp.items };
                    delete items[`ap:${a.id}`];
                    update({ ...fp, aps: fp.aps.filter((x) => x.id !== a.id), items });
                    setSel(null);
                  }}
                />
              </div>
            </>
          ) : (
            <div className="text-base font-semibold">{a.name}</div>
          )}
          {nodes.length ? (
            <>
              <Q sub="從路由器讀到的；連在這台的裝置會自動畫線">這是哪一台</Q>
              <Select
                value={a.node || "none"}
                onValueChange={(v) => {
                  const node = v === "none" ? null : v;
                  const n = nodes.find((x) => x.mac === node);
                  setAp({ node, ...(n && /^Wi-Fi 基地台 \d+$/.test(a.name) ? { name: n.model } : {}) });
                }}
              >
                <SelectTrigger className="w-full bg-background" aria-label="哪一台"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">還沒選</SelectItem>
                  {nodes.map((n) => <SelectItem key={n.mac} value={n.mac}>{n.model}（{n.main ? "主路由器" : "節點"}）</SelectItem>)}
                </SelectContent>
              </Select>
            </>
          ) : (
            <>
              <Q sub="連這個 Wi-Fi 的插座會畫一條線連到它">它發出的 Wi-Fi</Q>
              <Select value={a.ssid || "none"} onValueChange={(v) => setAp({ ssid: v === "none" ? null : v })}>
                <SelectTrigger className="w-full bg-background" aria-label="Wi-Fi 名稱"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">還沒選</SelectItem>
                  {ssids.map((x) => <SelectItem key={x} value={x}>{x}</SelectItem>)}
                </SelectContent>
              </Select>
            </>
          )}
          <Q sub="放高一點，訊號線才會穿過人的身體">放的高度</Q>
          <HeightSelect value={a.z ?? AP_Z} opts={AP_HEIGHTS} onChange={(z) => setAp({ z })} />
          <Note>{links.filter((l) => l.ap.id === a.id).length} 台裝置連到這裡</Note>
        </>
      );
  } else if (sel?.kind === "dev") {
    const d = devs.find((x) => x.key === sel.id);
    const l = links.find((x) => x.dev.key === sel.id);
    if (d && fp.items[d.key]) {
      const linkTxt = l ? (
        <>連到「{l.ap.name}」{l.guess ? "（同名的 Wi-Fi 有好幾台，先猜最近的）" : ""}，相距約 {fmt(l.L, 1)} 公尺，其中約 {fmt(l.band, 1)} 公尺經過人的腰到胸的高度：<b className="text-foreground">{qText[l.q]}</b></>
      ) : d.node ? (
        `連在 ${nodes.find((n) => n.mac === d.node)?.model || ""}，在地圖上加一台 Wi-Fi 基地台、選這一台，就會畫出連線`
      ) : d.ssid ? (
        `連「${d.ssid}」，在地圖上加一台 Wi-Fi 基地台、選這個 Wi-Fi，就會畫出連線`
      ) : null;
      picked = (
        <>
          <div className="text-base font-semibold leading-snug">{d.full}</div>
          <Note>訊號 {d.rssi ?? "—"} dBm{linkTxt ? <>・{linkTxt}</> : null}</Note>
          <Q>{d.router ? "放在多高" : "插在多高"}</Q>
          <HeightSelect value={fp.items[d.key].z ?? DEV_Z} opts={DEV_HEIGHTS} onChange={(z) => update({ ...fp, items: { ...fp.items, [d.key]: { ...fp.items[d.key], z } } })} />
          {edit && (
            <Button variant="outline" size="sm" onClick={() => { const items = { ...fp.items }; delete items[d.key]; update({ ...fp, items }); setSel(null); }}>
              從地圖拿下來
            </Button>
          )}
        </>
      );
    }
  }

  const tray = devs.filter((d) => !fp.items[d.key]);
  const weakDevs = devs.filter((d) => d.online && d.rssi != null && d.rssi < -70);
  const off = devs.filter((d) => !d.online);
  const good = links.filter((l) => l.q === "good");
  const dflt = layer === "signal" ? "滑過裝置看訊號強度" : sense?.enabled === false ? "Wi-Fi 感測已暫停（設定 → Wi-Fi 感測）" : "橘色光圈越大，那附近越可能有人在走動・每 10 秒更新";

  return (
    <>
      {head}
      <div className="mx-auto grid max-w-[112rem] items-start gap-4 px-4 py-4 sm:px-6 lg:grid-cols-[minmax(0,1fr)_22rem] lg:px-8">
        <Card className="gap-3 px-3 py-3 sm:px-4 sm:py-4">
          {edit ? (
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" onClick={() => {
                const id = `r${Date.now().toString(36)}`;
                update({ ...fp, rooms: [...fp.rooms!, { id, name: "新區域", x: fp.w / 2 - 120, y: fp.h / 2 - 90, w: 240, h: 180 }] });
                setSel({ kind: "room", id });
              }}><Plus />區域</Button>
              <Button variant="outline" size="sm" onClick={() => {
                const id = `a${Date.now().toString(36)}`;
                update({ ...fp, aps: [...fp.aps, { id, name: `Wi-Fi 基地台 ${fp.aps.length + 1}` }], items: { ...fp.items, [`ap:${id}`]: { x: fp.w / 2, y: fp.h / 2 } } });
                setSel({ kind: "ap", id });
              }}><Wifi />Wi-Fi 基地台</Button>
              <Button variant="outline" size="sm" onClick={() => fileRef.current?.click()}><ImagePlus />{fp.image ? "換" : "上傳"}平面圖</Button>
              {fp.image && (
                <Confirm
                  trigger={<Button variant="outline" size="sm">移除平面圖</Button>}
                  title="移除平面圖？" text="只移除底圖，區域和裝置的位置會保留。" ok="移除"
                  onOk={async () => {
                    try {
                      setFp(await api<Floorplan>("DELETE", "/api/floorplan/image"));
                    } catch (e) {
                      toast.error("沒有成功", { description: (e as Error).message });
                    }
                  }}
                />
              )}
              <Confirm
                safe
                trigger={<Button variant="outline" size="sm"><LayoutGrid />重新自動排版</Button>}
                title="重新自動排版？" text="區域會依家庭中控的區域重新排列，裝置放回各自的區域；Wi-Fi 基地台的位置保留。" ok="重新排版"
                onOk={() => { update(autoLayout(fp, state?.rooms || [], devs, true)); setSel(null); }}
              />
              <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); e.target.value = ""; }} />
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <div className="w-56"><Segmented label="圖層" value={layer} onChange={setLayer} options={[["signal", "訊號強度"], ["motion", "動靜"]]} /></div>
              <div className="ml-auto flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground" aria-hidden>
                {layer === "signal" ? (
                  <span className="inline-flex items-center gap-1.5">
                    <b className="size-3 rounded-full border-[2.5px] border-primary" />強
                    <b className="size-3 rounded-full border-[2.5px]" style={{ borderColor: "color-mix(in srgb, var(--primary) 45%, var(--card))" }} />普通
                    <b className="size-3 rounded-full border-[2.5px] border-orange-500" />弱
                  </span>
                ) : (
                  <>
                    <span className="inline-flex items-center gap-1">安靜{[0.15, 0.4, 0.7, 1].map((a) => <i key={a} className="size-3 rounded-full bg-orange-500" style={{ opacity: a }} />)}擾動大</span>
                    {links.length > 0 && (
                      <span className="inline-flex items-center gap-1.5">
                        <svg width="22" height="6"><line x1="1" y1="3" x2="21" y2="3" stroke="var(--muted-foreground)" strokeWidth="2.5" strokeLinecap="round" /></svg>適合偵測的線
                        <svg width="22" height="6"><line x1="1" y1="3" x2="21" y2="3" stroke="var(--muted-foreground)" strokeWidth="2.5" strokeDasharray="2 5" strokeLinecap="round" opacity=".5" /></svg>不太適合
                      </span>
                    )}
                  </>
                )}
              </div>
            </div>
          )}
          <div className="min-h-6 text-sm tabular-nums text-muted-foreground" aria-live="polite">
            <span className={cn(tip && "font-medium text-foreground")}>{tip || dflt}</span>
          </div>
          <MapCanvas
            fp={fp} devs={devs} links={links} layer={layer} edit={edit} sel={sel} motion={motion}
            onChange={setFp} onDragEnd={save} onPick={pick} onTip={setTip}
          />
        </Card>

        <div ref={sideRef} className="min-w-0 space-y-4">
          {edit ? (
            <SideCard title="選取的項目">
              {picked || <Note>點區域、裝置或 Wi-Fi 基地台可以選取。</Note>}
              {tray.length > 0 && (
                <div className="space-y-2 border-t pt-3">
                  <Q>還沒擺上去的裝置</Q>
                  <div className="flex flex-wrap gap-2">
                    {tray.map((d) => (
                      <Button key={d.key} variant="outline" size="sm" className="rounded-full" onClick={() => update({ ...fp, items: { ...fp.items, [d.key]: { x: fp.w / 2 + (Math.random() - 0.5) * 80, y: fp.h / 2 + (Math.random() - 0.5) * 80 } } })}>
                        <Plus />{d.name}
                      </Button>
                    ))}
                  </div>
                </div>
              )}
            </SideCard>
          ) : (
            <>
              {picked && (sel?.kind === "dev" || sel?.kind === "ap") && (
                <SideCard title={sel.kind === "ap" ? "Wi-Fi 基地台" : "裝置"} onClose={() => setSel(null)}>{picked}</SideCard>
              )}
              <SideCard title="訊號狀況">
                {weakDevs.length ? (
                  weakDevs.map((d) => <Note key={d.key} icon={AlertCircle} tone="warn"><b>{d.full}</b>：訊號 {d.rssi} dBm，偏弱，容易斷線。可以考慮把 Wi-Fi 基地台移近一點。</Note>)
                ) : (
                  <Note icon={CheckCircle2} tone="ok">所有裝置的訊號都在 -70 dBm 以上。</Note>
                )}
                {off.length > 0 && <Note icon={WifiOff} tone="warn">{off.length} 台離線：{off.map((d) => d.name).join("、")}</Note>}
                {layer === "motion" ? (
                  links.length ? (
                    <Note><b className="text-foreground">{good.length} 條線適合偵測走動</b>{good.length ? `：${good.map((l) => l.dev.name).join("、")}` : ""}。實線穿過人的腰到胸的高度，有人走過去訊號會明顯跳動；虛線大多貼著地面或太短。</Note>
                  ) : (
                    <Note>在「編輯」裡加上 Wi-Fi 基地台、選它是哪一台和放的高度，就會畫出每台裝置到基地台的訊號線，看得出哪幾條適合偵測走動。電視、電腦也能當感測器：到「設定 → 網路裝置」點它、打開「放到訊號地圖」。</Note>
                  )
                ) : (
                  !fp.aps.length && <Note>按右上角「編輯」可以把你的 Wi-Fi 基地台也擺上去，比較容易看出哪裡離基地台太遠。</Note>
                )}
                <Note>點裝置或 Wi-Fi 基地台可以設定它放的高度。裝置周圍的顏色是它的訊號：藍色強（-55 dBm 以上）、淡藍普通、橘色弱（低於 -70，容易斷線）。</Note>
              </SideCard>
            </>
          )}
        </div>
      </div>
    </>
  );
}

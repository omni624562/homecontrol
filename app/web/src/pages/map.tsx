import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AlertCircle, AppWindow, List, Check, Pause, Play, Radio, CheckCircle2, DoorOpen, FlipHorizontal2, ImagePlus, LayoutGrid, Minus, MousePointer2, Pencil, Plus, Square, Trash2, Wifi, WifiOff, X } from "lucide-react";
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
import { MapCanvas, ROOM_ACTIVE, ROOM_STRONG, type MapPerson, type MapSel, type MapTool } from "@/components/map-canvas";
import { Segmented } from "@/components/schedule-bits";
import { api } from "@/lib/api";
import { fmt } from "@/lib/format";
import { useHub, useMedia } from "@/lib/hub";
import {
  AP_HEIGHTS, AP_Z, DEV_HEIGHTS, DEV_Z, autoAps, autoLayout, fpPayload, mapDevices, mapLinks, type Floorplan, type FpAp, type MapSense, type MapReplay, type FpRoom,
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
  const [tool, setTool] = useState<MapTool>("select");
  const [tip, setTip] = useState<string | null>(null);
  const [replay, setReplay] = useState<MapReplay | null>(null);
  const [frame, setFrame] = useState<number | null>(null); // null = 現在
  const [playing, setPlaying] = useState(false);
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

  // 動靜回放的資料：看動靜圖層時才讀，每 5 分鐘更新
  const wantReplay = layer === "motion" && !edit;
  useEffect(() => {
    if (!wantReplay) return;
    let alive = true;
    const load = () => api<MapReplay>("GET", "/api/sensing/replay?hours=24").then((d) => alive && setReplay(d)).catch(() => {});
    load();
    const t = setInterval(load, 300000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [wantReplay]);
  useEffect(() => {
    if (!wantReplay) {
      setFrame(null);
      setPlaying(false);
    }
  }, [wantReplay]);
  // 播放：每 0.3 秒往後一格（5 分鐘），播到最後回到「現在」
  useEffect(() => {
    if (!playing || !replay) return;
    const t = setInterval(() => {
      setFrame((f) => {
        const next = (f ?? -1) + 1;
        if (next >= replay.n) {
          setPlaying(false);
          return null;
        }
        return next;
      });
    }, 300);
    return () => clearInterval(t);
  }, [playing, replay]);

  // 路由器讀到的主路由器、節點自動擺上去
  useEffect(() => {
    const f = fpRef.current;
    if (!f) return;
    const next = autoAps(f, sense?.net?.nodes || [], devs);
    if (next) update(next);
  }, [sense, fp?.rooms, devs, update]);

  useEffect(() => () => clearTimeout(saveT.current), []);

  // 編輯時按 Delete 刪掉選取的牆或門；Esc 回到選取工具
  useEffect(() => {
    if (!edit) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest("input, textarea, select, [contenteditable]")) return;
      const f = fpRef.current;
      if (e.key === "Escape") setTool("select");
      if ((e.key === "Delete" || e.key === "Backspace") && f && sel && (sel.kind === "wall" || sel.kind === "door")) {
        e.preventDefault();
        update(sel.kind === "wall"
          ? { ...f, walls: (f.walls || []).filter((x) => x.id !== sel.id), doors: (f.doors || []).filter((x) => x.wall !== sel.id) }
          : { ...f, doors: (f.doors || []).filter((x) => x.id !== sel.id) });
        setSel(null);
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [edit, sel, update]);

  const pick = (s: MapSel) => {
    setSel(s);
    if (s && narrow) requestAnimationFrame(() => sideRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }));
  };

  const head = (
    <PageHeader
      title="家中地圖"
      sub={edit ? "拖曳區域和裝置到實際的位置；選了區域可以改形狀；也可以畫牆、放門窗" : "家人在哪、哪裡有動靜、各裝置的 Wi-Fi 訊號；點裝置看詳細、設定高度"}
      actions={
        <>
        {!edit && <Button asChild variant="ghost" className="h-10 lg:hidden"><a href="#net"><List />網路裝置</a></Button>}
        <Button variant={edit ? "default" : "outline"} className="h-10" onClick={() => { setEdit((v) => !v); setSel(null); setTool("select"); }}>
          {edit ? <><Check />完成</> : <><Pencil />編輯</>}
        </Button>
        </>
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

  const past = frame != null && replay ? frame : null;
  const motion: Record<string, number | null> = past != null
    ? Object.fromEntries(Object.entries(replay!.devices).map(([k, v]) => [k, v[past]]))
    : Object.fromEntries((sense?.devices || []).map((d) => [d.key, d.now]));
  const roomHeat: Record<string, number | null> = past != null
    ? Object.fromEntries(Object.entries(replay!.rooms).map(([k, v]) => [k, v[past]]))
    : Object.fromEntries(Object.entries(sense?.rooms || {}).map(([k, v]) => [k, v.score]));
  const roomCover = sense?.rooms || {};
  const links = mapLinks(fp, devs);
  // 家人在哪個房間（在家、教過房間、地圖上有那個區域才標）
  const fpRooms = new Set(fp.rooms.map((r) => r.id));
  const people: MapPerson[] = (state?.people || []).flatMap((p) => {
    const w = p.home ? p.where : null;
    const room = w?.room || w?.top[0]?.room;
    if (!w || !room || !fpRooms.has(room)) return [];
    // 名字用家庭中控的區域名（地圖上的區域名可能是舊的，例如工作區寫成「臥室」）
    const roomName = (w.room ? w.name : w.top[0].name) || fp.rooms!.find((r) => r.id === room)?.name || "";
    return [{ id: p.id, name: p.name, room, roomName, sure: !!w.room, p: w.room ? w.p : w.top[0].p }];
  });
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
        rooms: f.rooms!.map((r) => ({ ...r, y: r.y * sy, h: r.h * sy, pts: r.pts ? r.pts.map(([x, y]) => [x, y * sy] as [number, number]) : null })),
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
        <Note>{tool === "wall" ? "畫牆：在地圖上按住，拖到牆的另一端放開。會自動對齊別的牆和區域的轉角；按住 Shift 可以畫斜的。畫完按「選取」或 Esc。" : tool === "door" ? "放門：點一道牆，就在那裡開一扇門（預設 90 公分）。之後可以選它改寬度、換開門方向。" : tool === "window" ? "放窗：點一道牆，就在那裡開一扇窗（預設一般窗 120 公分）。之後可以選它改成落地窗、改寬度。" : "點區域、裝置、牆、門或 Wi-Fi 基地台可以選取、拖曳移動。選了區域可以拖轉角、拖牆改形狀。上面的「畫牆」「放門」「放窗」可以加上實牆和門窗。"}</Note>
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
          <Note>拖<b>圓點</b>（轉角）改大小、形狀；拖<b>牆中間的短條</b>把整道牆推進、拉出。<br />L 形：在要缺一塊的那個<b>圓點上按兩下</b>，角會切掉一塊，再拖新的圓點調整大小。<br />凹字形：在<b>短條上按兩下</b>，那道牆多兩個轉角，再把中間那段推進去或拉出來。<br />推平的轉角會自動消失。</Note>
          {r.pts && (
            <Button variant="outline" className="h-10 self-start" onClick={() => update({ ...fp, rooms: fp.rooms!.map((x) => (x.id === r.id ? { ...x, pts: null } : x)) })}>
              <Square />改回長方形
            </Button>
          )}
        </>
      );
  } else if (sel?.kind === "wall" && edit) {
    const w = (fp.walls || []).find((x) => x.id === sel.id);
    const mpu = (fp.meters || 12) / fp.w;
    if (w)
      picked = (
        <>
          <Q sub={`長 ${fmt(Math.hypot(w.x2 - w.x1, w.y2 - w.y1) * mpu, 1)} 公尺`}>牆</Q>
          <Note>拖牆移動、拖兩端的圓點改長度（會對齊別的牆和轉角，按住 Shift 可以斜的）。按 Delete 也能刪掉。</Note>
          <Button variant="outline" className="h-10 self-start text-destructive hover:text-destructive"
            onClick={() => { update({ ...fp, walls: (fp.walls || []).filter((x) => x.id !== w.id), doors: (fp.doors || []).filter((x) => x.wall !== w.id) }); setSel(null); }}>
            <Trash2 />刪掉這道牆{(fp.doors || []).some((x) => x.wall === w.id) ? "（和上面的門窗）" : ""}
          </Button>
        </>
      );
  } else if (sel?.kind === "door" && edit) {
    const d = (fp.doors || []).find((x) => x.id === sel.id);
    const u = fp.w / (fp.meters || 12);
    const setDoor = (patch: Partial<NonNullable<typeof d>>) => update({ ...fp, doors: (fp.doors || []).map((x) => (x.id === sel.id ? { ...x, ...patch } : x)) });
    const isWin = !!d?.kind;
    const widths = isWin ? [0.6, 0.9, 1.2, 1.5, 1.8, 2.4, 3] : [0.7, 0.8, 0.9, 1.2, 1.6];
    if (d && isWin)
      picked = (
        <>
          <Q>哪一種窗</Q>
          <Segmented label="窗的種類" value={d.kind!} onChange={(v) => setDoor({ kind: v as "win" | "fwin" })} options={[["win", "一般窗"], ["fwin", "落地窗"]]} />
          <Q>窗寬</Q>
          <Segmented label="窗寬" value={String(widths.reduce((a, b) => (Math.abs(b * u - d.w) < Math.abs(a * u - d.w) ? b : a)))}
            onChange={(v) => setDoor({ w: Math.round(Number(v) * u) })}
            options={widths.map((x) => [String(x), String(Math.round(x * 100))] as [string, string])} />
          <p className="text-xs text-muted-foreground">公分。</p>
          <Button variant="outline" className="h-10 w-fit text-destructive hover:text-destructive" onClick={() => { update({ ...fp, doors: (fp.doors || []).filter((x) => x.id !== d.id) }); setSel(null); }}><Trash2 />刪掉</Button>
          <Note>沿著牆拖曳可以移動窗的位置。一般窗畫成牆上的細框，落地窗多畫兩片拉門的樣子。</Note>
        </>
      );
    else if (d)
      picked = (
        <>
          <Q>門寬</Q>
          <Segmented label="門寬" value={String(widths.reduce((a, b) => (Math.abs(b * u - d.w) < Math.abs(a * u - d.w) ? b : a)))}
            onChange={(v) => setDoor({ w: Math.round(Number(v) * u) })}
            options={[["0.7", "70"], ["0.8", "80"], ["0.9", "90"], ["1.2", "120"], ["1.6", "160"]]} />
          <p className="text-xs text-muted-foreground">公分。廁所門大約 70～80、房門 90、大門或雙開 120 以上。</p>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" className="h-10" onClick={() => setDoor({ flip: ((d.flip || 0) + 1) % 4 })}><FlipHorizontal2 />換開門方向</Button>
            <Button variant="outline" className="h-10 text-destructive hover:text-destructive" onClick={() => { update({ ...fp, doors: (fp.doors || []).filter((x) => x.id !== d.id) }); setSel(null); }}><Trash2 />刪掉</Button>
          </div>
          <Note>沿著牆拖曳可以移動門的位置。「換開門方向」每按一次換一種（往裡、往外、鉸鏈在左、在右）。</Note>
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
        <>連到「{l.ap.name}」{l.guess ? "（同名的 Wi-Fi 有好幾台，先猜最近的）" : ""}，相距約 {fmt(l.L, 1)} 公尺，其中約 {fmt(l.band, 1)} 公尺經過人的腰到胸的高度{l.walls ? `，中間隔了 ${l.walls} 道牆（門窗的地方不算）` : (fp.walls || []).length ? "，中間沒有隔牆" : ""}：<b className="text-foreground">{qText[l.q]}</b>{l.walls >= 2 ? "（牆會吃掉訊號，人走過去的跳動比較小）" : ""}{l.rooms.length > 0 && <>。這條線有動靜時，人可能在{l.rooms.join("、")}</>}</>
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
  const hot = links.filter((l) => (motion[l.dev.key] ?? 0) > 0.15).sort((a, b) => motion[b.dev.key]! - motion[a.dev.key]!);
  const dflt = layer === "signal" ? "滑過裝置看訊號強度" : sense?.enabled === false ? "Wi-Fi 感測已暫停（設定 → Wi-Fi 感測）" : "橘色光圈越大，那附近越可能有人在走動・每 10 秒更新";

  return (
    <>
      {head}
      <div className="mx-auto grid max-w-[112rem] grid-cols-[minmax(0,1fr)] items-start gap-4 px-4 py-4 sm:px-6 lg:grid-cols-[minmax(0,1fr)_22rem] lg:px-8">
        <Card className="gap-3 px-3 py-3 sm:px-4 sm:py-4">
          {edit ? (
            <div className="flex flex-wrap gap-2">
              <div className="flex rounded-lg border bg-muted/50 p-0.5" role="group" aria-label="工具">
                {([["select", MousePointer2, "選取"], ["wall", Minus, "畫牆"], ["door", DoorOpen, "放門"], ["window", AppWindow, "放窗"]] as const).map(([t, I, label]) => (
                  <Button key={t} size="sm" variant={tool === t ? "default" : "ghost"} className="h-8" aria-pressed={tool === t} onClick={() => setTool(t)}><I />{label}</Button>
                ))}
              </div>
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
          {/* 手機：地圖放大到 600px 寬，可以左右滑 */}
          <div className="-mx-4 overflow-x-auto px-4 pb-1 sm:mx-0 sm:overflow-visible sm:px-0 sm:pb-0">
            <MapCanvas
              fp={fp} devs={devs} links={links} layer={layer} edit={edit} sel={sel} motion={motion} roomHeat={roomHeat} people={past != null ? [] : people} tool={tool}
              onChange={setFp} onDragEnd={save} onPick={pick} onTip={setTip}
            />
          </div>
          {wantReplay && replay && replay.n > 0 && (
            <ReplayBar replay={replay} frame={frame} playing={playing}
              onFrame={(f) => { setPlaying(false); setFrame(f); }}
              onPlay={() => { if (playing) setPlaying(false); else { if (frame == null) setFrame(Math.max(0, replay.n - 72)); setPlaying(true); } }} />
          )}
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
              {people.length > 0 && (
                <SideCard title="誰在哪裡">
                  {people.map((p) => (
                    <Note key={p.id}>
                      <b className="text-foreground">{p.name}</b>：{p.sure ? "大概在" : "可能在"}{p.roomName}（{Math.round(p.p * 100)}%{p.sure ? " 把握" : "，不確定"}）
                    </Note>
                  ))}
                  <Note>用手機的 Wi-Fi 訊號猜的（實驗）；房間在「網路裝置 → 誰在家 → 點人 → 在哪個房間」教。</Note>
                </SideCard>
              )}
              <SideCard title="訊號狀況">
                {weakDevs.length ? (
                  weakDevs.map((d) => <Note key={d.key} icon={AlertCircle} tone="warn"><b>{d.full}</b>：訊號 {d.rssi} dBm，偏弱，容易斷線。可以考慮把 Wi-Fi 基地台移近一點。</Note>)
                ) : (
                  <Note icon={CheckCircle2} tone="ok">所有裝置的訊號都在 -70 dBm 以上。</Note>
                )}
                {off.length > 0 && <Note icon={WifiOff} tone="warn">{off.length} 台離線：{off.map((d) => d.name).join("、")}</Note>}
                {layer === "motion" && (
                  <RoomMotionList rooms={fp.rooms} heat={roomHeat} covered={past != null ? replay!.rooms : roomCover} past={past != null} />
                )}
                {layer === "motion" ? (
                  links.length ? (
                    <>
                      {hot.length > 0 && (
                        <Note tone="warn"><b className="text-foreground">現在有動靜</b>：{hot.map((l) => `${l.dev.name}${l.rooms.length ? `（${l.rooms.join("、")}）` : ""}`).join("；")}</Note>
                      )}
                      <Note><b className="text-foreground">{good.length} 條線適合偵測走動</b>{good.length ? `：${good.map((l) => l.dev.name).join("、")}` : ""}。實線穿過人的腰到胸的高度，有人走過去訊號會明顯跳動；虛線大多貼著地面、太短，或隔了兩道以上的牆{(fp.walls || []).length ? "" : "（畫上實牆會算得更準）"}。</Note>
                    </>
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

// 各房間的動靜：有人走動／有動靜／安靜／沒有線經過
function RoomMotionList({ rooms, heat, covered, past }: { rooms: FpRoom[]; heat: Record<string, number | null>; covered: Record<string, unknown>; past: boolean }) {
  const rows = rooms.map((r) => ({ r, h: heat[r.id], has: r.id in covered })).sort((a, b) => (b.h ?? -1) - (a.h ?? -1));
  const none = rows.filter((x) => !x.has);
  return (
    <div className="space-y-1.5">
      <Q>{past ? "那時候各房間" : "現在各房間"}</Q>
      <ul className="divide-y rounded-lg border text-sm">
        {rows.filter((x) => x.has).map(({ r, h }) => (
          <li key={r.id} className="flex items-center gap-2 px-3 py-1.5">
            <span className="flex-1">{r.name}</span>
            {h == null ? <span className="text-xs text-muted-foreground">沒有讀數</span>
              : h >= ROOM_STRONG ? <b className="text-orange-600 dark:text-orange-400">有人走動</b>
              : h >= ROOM_ACTIVE ? <span className="text-orange-600 dark:text-orange-400">有動靜</span>
              : <span className="text-muted-foreground">安靜</span>}
            <span className="w-8 text-right text-xs tabular-nums text-muted-foreground">{h == null ? "" : fmt(h, 1)}</span>
          </li>
        ))}
      </ul>
      {none.length > 0 && <p className="text-xs text-muted-foreground">{none.map((x) => x.r.name).join("、")}：沒有訊號線經過，偵測不到（不代表沒人）。</p>}
    </div>
  );
}

// 動靜回放：最近 24 小時，每 5 分鐘一格；上面的小長條是那時候最熱的房間有多熱
function ReplayBar({ replay, frame, playing, onFrame, onPlay }: { replay: MapReplay; frame: number | null; playing: boolean; onFrame: (f: number | null) => void; onPlay: () => void }) {
  const peaks = useMemo(() => Array.from({ length: replay.n }, (_, i) => Math.max(0, ...Object.values(replay.rooms).map((v) => v[i] ?? 0))), [replay]);
  const at = frame == null ? null : new Date((replay.start + frame * replay.bucket) * 1000);
  const label = at == null ? "現在" : `${at.toDateString() === new Date().toDateString() ? "今天" : "昨天"} ${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
  const val = frame ?? replay.n;
  return (
    <div className="flex items-center gap-3 rounded-lg border px-3 py-2">
      <Button type="button" size="icon" variant="outline" className="size-9 shrink-0" aria-label={playing ? "暫停" : "播放最近 6 小時"} onClick={onPlay}>{playing ? <Pause /> : <Play />}</Button>
      <div className="min-w-0 flex-1">
        <div className="flex h-5 items-end gap-px" aria-hidden>
          {peaks.map((p, i) => (
            <i key={i} className={cn("flex-1 rounded-t-sm", i === frame ? "bg-primary" : "bg-orange-500")} style={{ height: `${Math.max(8, Math.min(100, p * 60))}%`, opacity: i === frame ? 1 : p >= ROOM_ACTIVE ? 0.85 : 0.2 }} />
          ))}
        </div>
        <input type="range" min={0} max={replay.n} value={val} aria-label="回放時間" className="w-full accent-primary"
          onChange={(e) => { const v = Number(e.target.value); onFrame(v >= replay.n ? null : v); }} />
      </div>
      <button type="button" className={cn("w-20 shrink-0 text-right text-sm tabular-nums", frame == null ? "font-medium text-foreground" : "text-primary underline-offset-2 hover:underline")}
        onClick={() => onFrame(null)} title="回到現在">
        {frame == null ? <span className="inline-flex items-center gap-1"><Radio className="size-3.5 text-emerald-500" />現在</span> : label}
      </button>
    </div>
  );
}

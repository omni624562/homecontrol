// 攝影機頁：每台一張卡片（即時畫面、在做什麼、還差哪一步）；點進去分三頁：畫面（框門、不要看的地方、基本設定）、要做什麼、紀錄
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Cat, ChevronLeft, ChevronRight, DoorOpen, Lightbulb, Loader2, Plus, ScanFace, ShieldAlert, Trash2, UserRoundX } from "lucide-react";
import { toast } from "sonner";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { PageHeader } from "@/components/app-shell";
import { DetectEditor } from "@/components/cam-detect";
import { CamAccessBox, CamLive, SLOT, hhmm, type Cam, type CamAccess, type FacePerson, type FaceRep } from "@/components/camera-bits";
import type { MotionRule } from "@/components/motion-rules";
import { api } from "@/lib/api";
import { useHub } from "@/lib/hub";
import type { Plug } from "@/lib/types";
import { cn } from "@/lib/utils";

type Room = { id: string; name: string };
type Tab = "view" | "tasks" | "log";
const PET = { cat: "貓", dog: "狗" } as Record<string, string>;
const WINDOWS: [string, string, string][] = [["all", "", "整天"], ["evening", "18:00-06:00", "晚上 18:00～06:00"], ["night", "23:00-06:00", "半夜 23:00～06:00"]];
const winOf = (r: MotionRule) => (!r.start ? "all" : WINDOWS.find(([, v]) => v === `${r.start}-${r.end}`)?.[0] || "custom");

async function call<T>(method: string, path: string, body?: unknown, ok?: string): Promise<T | null> {
  try {
    const r = await api<T>(method, path, body);
    if (ok) toast.success(ok);
    return r;
  } catch (e) {
    toast.error("沒有成功", { description: (e as Error).message });
    return null;
  }
}

// 攝影機現在的一張畫面（列表的縮圖）：幾秒換一張
function Thumb({ cam, every = 5000, children }: { cam: Cam; every?: number; children?: ReactNode }) {
  const [t, setT] = useState(() => Date.now());
  const [bad, setBad] = useState(false);
  useEffect(() => {
    const id = setInterval(() => setT(Date.now()), every);
    return () => clearInterval(id);
  }, [every]);
  return (
    <div className="relative aspect-video overflow-hidden rounded-lg bg-muted">
      {cam.enabled && !bad && <img src={`/api/cameras/${cam.id}/snapshot.jpg?t=${t}`} alt={`${cam.name} 現在的畫面`} className="size-full object-cover" onError={() => setBad(true)} onLoad={() => setBad(false)} />}
      {(bad || !cam.enabled) && <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">{cam.enabled ? "讀不到畫面" : "已停用"}</div>}
      {children}
    </div>
  );
}

function Chip({ tone, children }: { tone?: "hot" | "ok" | "info"; children: ReactNode }) {
  return (
    <span className={cn("rounded-full px-2 py-0.5 text-xs font-semibold backdrop-blur",
      tone === "hot" ? "bg-orange-500/90 text-white" : tone === "ok" ? "bg-emerald-600/90 text-white" : tone === "info" ? "bg-primary/90 text-primary-foreground" : "bg-background/85 text-foreground")}>
      {children}
    </span>
  );
}

// 這台在做什麼（一行字）和還差哪一步
function summary(c: Cam, rule: MotionRule | undefined): string[] {
  const out: string[] = [];
  if (c.faces !== false && c.role === "entry") out.push("認出家人執行動作");
  if (c.alert) out.push("不認得的人通知");
  if ((c.zones || []).some((z) => z.kind === "door" && z.act.notify !== "off")) out.push("開門通知");
  if (rule?.enabled) out.push("有人就開燈");
  if (c.fall) out.push("跌倒通知");
  if (c.pets !== false) out.push("認貓狗");
  return out;
}

function todos(c: Cam, faces: FaceRep | null): { text: string; tab: Tab }[] {
  const out: { text: string; tab: Tab }[] = [];
  if (!c.enabled) return out;
  if (!c.room) out.push({ text: "選拍的區域", tab: "view" });
  if (c.faces !== false && faces?.family.length) {
    const done = faces.family.filter((p) => p.samples > 0).length;
    if (done < faces.family.length) out.push({ text: `登記家人的臉（${done}/${faces.family.length}）`, tab: "tasks" });
  }
  const doors = (c.zones || []).filter((z) => z.kind === "door");
  if (doors.some((z) => !z.day)) out.push({ text: "記住門關著的樣子", tab: "view" });
  else if (doors.some((z) => !z.night)) out.push({ text: "晚上再記一次門關著的樣子", tab: "view" });
  return out;
}

export function CamerasPage() {
  const { state } = useHub();
  const [cams, setCams] = useState<Cam[] | null>(null);
  const [acc, setAcc] = useState<CamAccess | null>(null);
  const [faces, setFaces] = useState<FaceRep | null>(null);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [rules, setRules] = useState<MotionRule[]>([]);
  const [sel, setSel] = useState<{ id: string; tab: Tab } | null>(null);
  const can = !!acc?.can_view;

  const loadCams = useCallback(() => api<{ cameras: Cam[]; access: CamAccess }>("GET", "/api/cameras").then((r) => { setCams(r.cameras); setAcc(r.access); }).catch(() => {}), []);
  const loadFaces = useCallback(() => api<FaceRep>("GET", "/api/faces").then(setFaces).catch(() => {}), []);
  const loadRules = useCallback(() => api<{ rules: MotionRule[] }>("GET", "/api/motion-rules").then((r) => setRules(r.rules)).catch(() => {}), []);
  useEffect(() => {
    loadCams();
    api<{ rooms?: Room[] }>("GET", "/api/floorplan").then((f) => setRooms(f.rooms || [])).catch(() => {});
    const t = setInterval(loadCams, 3000);
    return () => clearInterval(t);
  }, [loadCams]);
  const enrolling = !!faces?.enroll;
  useEffect(() => {
    if (!can) return;
    loadFaces();
    loadRules();
    const t = setInterval(loadFaces, enrolling ? 1500 : 10000);
    return () => clearInterval(t);
  }, [can, enrolling, loadFaces, loadRules]);
  const shown = useRef<string | null>(null);
  useEffect(() => {
    const r = faces?.result;
    if (r && r.msg !== shown.current) {
      shown.current = r.msg;
      if (r.ok) toast.success(r.msg);
      else toast.error("沒有登記成功", { description: r.msg });
    }
  }, [faces?.result]);

  const ruleOf = (c: Cam) => rules.find((r) => c.room && r.room === c.room);
  const cam = sel ? cams?.find((c) => c.id === sel.id) : null;
  if (cam && can) {
    return (
      <CamDetail key={cam.id} cam={cam} tab={sel!.tab} setTab={(tab) => setSel({ id: cam.id, tab })} onBack={() => setSel(null)}
        rooms={rooms} faces={faces} rules={rules} plugs={state?.plugs || []} scenes={state?.scenes || []}
        setCams={setCams} setFaces={setFaces} setRules={setRules} />
    );
  }
  return (
    <>
      <PageHeader title="攝影機" sub="即時畫面、這台要幫我做什麼、紀錄；影像只在樹莓派上處理、不存檔" />
      <div className="mx-auto max-w-[112rem] space-y-4 px-4 py-4 sm:px-6 lg:px-8">
        {acc && !acc.can_view && <Card className="gap-0 py-0 pb-3"><CamAccessBox acc={acc} onChange={(a) => { setAcc(a); loadCams(); }} /></Card>}
        {cams === null ? (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{[0, 1].map((i) => <Skeleton key={i} className="h-72 rounded-xl" />)}</div>
        ) : cams.length === 0 ? (
          <Card className="p-6 text-center text-muted-foreground">還沒有攝影機。{can && "按下面的「新增攝影機」。"}</Card>
        ) : (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {cams.map((c) => {
              const seen = faces?.log.find((x) => x.camera === c.name && x.kind === "family" && Date.now() / 1000 - x.t < 120);
              const sum = summary(c, ruleOf(c));
              const todo = can ? todos(c, faces) : [];
              const chips = (
                <div className="absolute top-2 left-2 flex flex-wrap gap-1.5">
                  {c.ok === false ? <Chip tone="hot">連不上</Chip> : <Chip tone={c.person ? "hot" : undefined}>{c.person ? "有人" : "沒人"}</Chip>}
                  {seen && <Chip tone="ok">認出 {seen.name}</Chip>}
                  {c.pets_here?.map((x) => <Chip key={x} tone="info">看到{PET[x] || x}</Chip>)}
                  {(c.zones || []).filter((z) => z.kind === "door" && z.refs).map((z) => <Chip key={z.id} tone={z.open ? "hot" : undefined}>{z.name}{z.open ? "開著" : "關著"}</Chip>)}
                </div>
              );
              return (
                <Card key={c.id} className="gap-0 overflow-hidden py-0">
                  <button className="block w-full text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:cursor-default" disabled={!can}
                    onClick={() => setSel({ id: c.id, tab: "tasks" })} aria-label={`${c.name} 的設定`}>
                    <div className="p-2 pb-0">
                      {can ? <Thumb cam={c}>{chips}</Thumb> : <div className="relative aspect-video rounded-lg bg-muted">{chips}<span className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">開通後才看得到畫面</span></div>}
                    </div>
                    <div className="space-y-1 px-4 pt-3 pb-1">
                      <div className="flex items-center gap-2">
                        <span className="text-lg font-bold">{c.name}</span>
                        <Badge variant="secondary">{c.role === "entry" ? "門口" : "房間"}</Badge>
                        {!c.enabled && <Badge variant="outline">已停用</Badge>}
                        {can && <ChevronRight className="ml-auto size-5 text-muted-foreground" />}
                      </div>
                      <div className="text-sm text-muted-foreground">{c.enabled ? (sum.length ? sum.join("・") : "只認有沒有人") : "不會認人、也不會通知"}</div>
                    </div>
                  </button>
                  {can && c.enabled && (
                    <div className="space-y-1 px-4 pt-1 pb-3">
                      {todo.length ? todo.map((t) => (
                        <button key={t.text} onClick={() => setSel({ id: c.id, tab: t.tab })} className="flex w-full items-center gap-2 rounded-md py-1 text-left text-sm hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                          <span className="size-3.5 shrink-0 rounded-sm border-2 border-muted-foreground/60" aria-hidden />
                          <span className="flex-1">{t.text}</span><span className="font-medium text-primary">去設定 ›</span>
                        </button>
                      )) : <div className="flex items-center gap-2 text-sm text-emerald-700 dark:text-emerald-400"><span className="size-3.5 rounded-sm bg-emerald-600" aria-hidden />都設定好了</div>}
                    </div>
                  )}
                </Card>
              );
            })}
          </div>
        )}
        {can && <AddCamera onAdded={loadCams} />}
        {can && acc && <Card className="gap-0 py-0 pb-4"><CamAccessBox acc={acc} onChange={setAcc} /></Card>}
      </div>
    </>
  );
}

function AddCamera({ onAdded }: { onAdded: () => void }) {
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ host: "", user: "", pwd: "" });
  const [busy, setBusy] = useState(false);
  if (!open) return <Button variant="outline" onClick={() => setOpen(true)}><Plus />新增攝影機</Button>;
  return (
    <Card className="p-4">
      <form className="grid gap-2 sm:grid-cols-[1fr_1fr_1fr_auto]" onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        const r = await call<{ camera: Cam }>("POST", "/api/cameras", { host: f.host.trim(), user: f.user, pwd: f.pwd });
        setBusy(false);
        if (r) { toast.success(`加好了：${r.camera.name}，點它設定要做什麼`); setOpen(false); setF({ host: "", user: "", pwd: "" }); onAdded(); }
      }}>
        <Input id="cam-host" placeholder="IP，例如 10.0.2.185" value={f.host} onChange={(e) => setF({ ...f, host: e.target.value })} aria-label="攝影機 IP" />
        <Input id="cam-user" placeholder="帳號" autoComplete="off" value={f.user} onChange={(e) => setF({ ...f, user: e.target.value })} aria-label="攝影機帳號" />
        <Input id="cam-pwd" type="password" placeholder="密碼" autoComplete="new-password" value={f.pwd} onChange={(e) => setF({ ...f, pwd: e.target.value })} aria-label="攝影機密碼" />
        <div className="flex gap-2">
          <Button type="submit" disabled={busy || !f.host.trim()}>{busy && <Loader2 className="animate-spin" />}加入</Button>
          <Button type="button" variant="ghost" onClick={() => setOpen(false)}>取消</Button>
        </div>
        <p className="text-xs text-muted-foreground sm:col-span-4">目前支援 Foscam（HD 系列）。帳密只存在樹莓派上；建議在攝影機另外開一個「訪客」權限的帳號給它用。</p>
      </form>
    </Card>
  );
}

// ---- 一台攝影機的詳細頁 ----

interface DetailProps {
  cam: Cam; tab: Tab; setTab: (t: Tab) => void; onBack: () => void; rooms: Room[]; faces: FaceRep | null; rules: MotionRule[]; plugs: Plug[];
  scenes: { id: string; name: string }[];
  setCams: (c: Cam[]) => void; setFaces: (f: FaceRep) => void; setRules: (r: MotionRule[]) => void;
}

function CamDetail(p: DetailProps) {
  const { cam, tab, setTab } = p;
  const upd = async (body: object, ok?: string) => {
    const r = await call<{ cameras: Cam[] }>("PUT", `/api/cameras/${cam.id}`, body, ok);
    if (r) p.setCams(r.cameras);
  };
  return (
    <>
      <PageHeader title={cam.name} sub={`${cam.model ? `${cam.model}・` : ""}${cam.host}`}
        lead={<Button variant="ghost" className="-ml-2 h-9" onClick={p.onBack}><ChevronLeft />全部攝影機</Button>}
        actions={<Button variant="ghost" className="h-9 max-lg:hidden" onClick={p.onBack}><ChevronLeft />全部攝影機</Button>}
        chips={(["view", "tasks", "log"] as Tab[]).map((t) => (
          <button key={t} onClick={() => setTab(t)} aria-pressed={tab === t}
            className={cn("shrink-0 rounded-full border px-4 py-1.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", tab === t ? "border-primary bg-primary text-primary-foreground" : "bg-background text-muted-foreground hover:bg-muted")}>
            {t === "view" ? "畫面" : t === "tasks" ? "要做什麼" : "紀錄"}
          </button>
        ))} />
      <div className="mx-auto max-w-3xl space-y-4 px-4 py-4 sm:px-6">
        {tab === "view" && <ViewTab {...p} upd={upd} />}
        {tab === "tasks" && <TasksTab {...p} upd={upd} />}
        {tab === "log" && <LogTab faces={p.faces} cam={cam} />}
      </div>
    </>
  );
}

// 畫面：偵測（門、有人進來、東西、線、不要看的地方）＋基本設定
function ViewTab({ cam, rooms, scenes, setCams, upd, onBack }: DetailProps & { upd: (b: object, ok?: string) => Promise<void> }) {
  const [name, setName] = useState(cam.name);
  return (
    <>
      <DetectEditor cam={cam} scenes={scenes} setCams={setCams} upd={upd} />

      <Card className="gap-0 divide-y py-0">
        <div className="space-y-2 px-4 py-3.5">
          <div className="font-medium">這台拍的是？</div>
          <div className="grid grid-cols-2 gap-2">
            {([["entry", "門口", "大門、玄關、陽台門：認出誰回家、門口的陌生人"], ["room", "房間裡", "客廳、臥室、走廊：有人就開燈、跌倒"]] as const).map(([k, label, hint]) => (
              <button key={k} aria-pressed={cam.role === k} onClick={() => cam.role !== k && upd({ role: k, defaults: true }, `改成「${label}」，常用的功能已經幫你打開，可以到「要做什麼」調整`)}
                className={cn("rounded-xl border-2 p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", cam.role === k ? "border-primary bg-primary/10" : "hover:bg-muted")}>
                <div className="font-semibold">{label}</div><div className="text-xs leading-relaxed text-muted-foreground">{hint}</div>
              </button>
            ))}
          </div>
        </div>
        <label className="flex items-center gap-3 px-4 py-3.5">
          <span className="flex-1"><span className="block font-medium">拍的區域</span><span className="text-sm text-muted-foreground">看到人時，家中地圖上這一區算有人；「有人就開燈」也看這一區</span></span>
          <Select value={cam.room || "_none"} onValueChange={(v) => upd({ room: v === "_none" ? null : v }, "已更新")}>
            <SelectTrigger className="w-32 bg-background" aria-label="拍的區域"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="_none">不指定</SelectItem>{rooms.map((r) => <SelectItem key={r.id} value={r.id}>{r.name}</SelectItem>)}</SelectContent>
          </Select>
        </label>
        <form className="flex items-center gap-3 px-4 py-3.5" onSubmit={(e) => { e.preventDefault(); if (name.trim() && name !== cam.name) upd({ name: name.trim() }, "已改名"); }}>
          <label htmlFor="cam-name" className="flex-1 font-medium">名稱</label>
          <Input id="cam-name" className="w-40 bg-background" value={name} onChange={(e) => setName(e.target.value)} />
          {name.trim() && name !== cam.name && <Button type="submit" size="sm">改名</Button>}
        </form>
        <label className="flex items-center gap-3 px-4 py-3.5">
          <span className="flex-1"><span className="block font-medium">啟用</span><span className="text-sm text-muted-foreground">停用就不會看這台、也不會通知</span></span>
          <Switch checked={cam.enabled} onCheckedChange={(v) => upd({ enabled: v }, v ? "開始看這台" : "已停用")} aria-label="啟用" />
        </label>
        <div className="px-4 py-3">
          <AlertDialog>
            <AlertDialogTrigger asChild><Button variant="ghost" size="sm" className="text-muted-foreground hover:text-destructive"><Trash2 />移除這台攝影機</Button></AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>移除「{cam.name}」？</AlertDialogTitle>
                <AlertDialogDescription>樹莓派不會再看這台攝影機，存著的帳密也會刪掉。攝影機本身的設定不會動。</AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>取消</AlertDialogCancel>
                <AlertDialogAction variant="destructive" onClick={async () => { const r = await call<{ cameras: Cam[] }>("DELETE", `/api/cameras/${cam.id}`, undefined, `已移除 ${cam.name}`); if (r) { setCams(r.cameras); onBack(); } }}>移除</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </Card>
    </>
  );
}

// 一項「要做什麼」：開關＋一句話；打開才展開細節
function Task({ icon: I, title, hint, on, onChange, children, disabled }: { icon: React.ElementType; title: string; hint: ReactNode; on: boolean; onChange: (v: boolean) => void; children?: ReactNode; disabled?: boolean }) {
  return (
    <div className={cn("rounded-xl border p-3.5 transition-colors", on && "border-primary/60 bg-primary/5")}>
      <label className="flex items-start gap-3">
        <span className={cn("flex size-9 shrink-0 items-center justify-center rounded-lg", on ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground")}><I className="size-5" /></span>
        <span className="min-w-0 flex-1"><span className="block font-semibold">{title}</span><span className="block text-sm leading-relaxed text-muted-foreground">{hint}</span></span>
        <Switch checked={on} disabled={disabled} onCheckedChange={onChange} aria-label={title} />
      </label>
      {on && children && <div className="mt-3 space-y-3 border-t pt-3">{children}</div>}
    </div>
  );
}

function TasksTab({ cam, faces, rules, plugs, scenes, setFaces, setRules, setCams, setTab, upd }: DetailProps & { upd: (b: object, ok?: string) => Promise<void> }) {
  const [guest, setGuest] = useState("");
  const entry = cam.role === "entry";
  const rule = rules.find((r) => cam.room && r.room === cam.room);
  const facesCall = async (method: string, path: string, body?: object, ok?: string) => { const r = await call<FaceRep>(method, path, body, ok); if (r) setFaces(r); };
  const saveRules = async (next: MotionRule[], ok?: string) => { const r = await call<{ rules: MotionRule[] }>("PUT", "/api/motion-rules", { rules: next }, ok); if (r) setRules(r.rules); };
  const lights = plugs.filter((p) => /燈|lamp|light/i.test(p.name));
  const setRule = (patch: Partial<MotionRule>, ok?: string) => {
    if (!cam.room) return;
    const base: MotionRule = rule || { room: cam.room, plug: (lights[0] || plugs[0])?.id || "", start: "18:00", end: "06:00", off_min: 5, need_home: true, enabled: true };
    const next = { ...base, ...patch };
    saveRules(rule ? rules.map((r) => (r === rule ? next : r)) : [...rules, next], ok);
  };
  const doors = (cam.zones || []).filter((z) => z.kind === "door");
  const e = faces?.enroll;
  const enroll = (person: string | null, name?: string) => facesCall("POST", "/api/faces/enroll", { person, name, camera: cam.id });
  const personRow = (pp: FacePerson, extra?: ReactNode) => (
    <div key={pp.id} className="flex flex-wrap items-center gap-2">
      <span className="min-w-0 flex-1 basis-32"><span className="font-medium">{pp.name}</span><span className="ml-2 text-sm text-muted-foreground">{pp.samples ? `已登記 ${pp.samples} 個角度` : "還沒登記臉"}</span></span>
      {extra}
      <Button variant="outline" size="sm" className="bg-background" disabled={!!e} onClick={() => enroll(pp.id)}><ScanFace />{pp.samples ? "重新登記" : "登記臉"}</Button>
      {(pp.samples > 0 || pp.kind === "guest") && (
        <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-destructive" aria-label={`刪除 ${pp.name} 的臉`} onClick={() => facesCall("DELETE", `/api/faces/${pp.id}`, undefined, "已刪除")}><Trash2 /></Button>
      )}
    </div>
  );
  return (
    <>
      {e && e.cam === cam.id && (
        <Card className="gap-3 p-4">
          <div className="font-semibold">正在登記「{e.name}」</div>
          <p className="text-sm text-muted-foreground">請站在這台攝影機前 1～2 公尺、畫面裡只有一個人，慢慢左右轉頭、抬頭低頭。</p>
          <CamLive id={cam.id} name={cam.name} />
          <div className="flex items-center gap-3">
            <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted"><div className="h-full bg-primary transition-all" style={{ width: `${Math.min(100, (e.count / (e.need * 3)) * 100)}%` }} /></div>
            <span className="text-sm tabular-nums text-muted-foreground">拍到 {e.count} 張・剩 {e.left} 秒</span>
            <Button variant="ghost" size="sm" onClick={() => facesCall("DELETE", "/api/faces/enroll")}>取消</Button>
          </div>
        </Card>
      )}
      <div className="px-1 text-lg font-bold">這台要幫我做什麼？</div>

      <Task icon={ScanFace} title="認出家人就執行他的動作" on={cam.faces !== false} onChange={(v) => upd({ faces: v }, v ? "會認臉" : "不認臉，只認有沒有人")}
        hint={entry ? "門口認出家人回來，依時段執行他的情境（比手機連上 Wi-Fi 還早）" : "這台是「房間」：認臉只用來分辨家人和陌生人；回家動作要「門口」的攝影機才會執行"}>
        {faces?.family.length ? faces.family.map((pp) => {
          const a = faces.actions[pp.id] || {};
          return (
            <div key={pp.id} className="space-y-2 rounded-lg border bg-background p-3">
              {personRow(pp)}
              {entry && (
                <>
                  <div className="grid gap-2 sm:grid-cols-3">
                    {SLOT.map(([k, label]) => (
                      <label key={k} className="flex items-center gap-2 text-sm">
                        <span className="w-20 shrink-0 text-muted-foreground">{label}回家</span>
                        <Select value={a[k] || "_none"} onValueChange={(v) => facesCall("PUT", "/api/faces/actions", { [pp.id]: { [k]: v === "_none" ? null : v } })}>
                          <SelectTrigger className="h-8 min-w-0 flex-1 bg-background" aria-label={`${pp.name} ${label}回家執行的情境`}><SelectValue /></SelectTrigger>
                          <SelectContent><SelectItem value="_none">不做事</SelectItem>{scenes.map((sc) => <SelectItem key={sc.id} value={sc.id}>{sc.name}</SelectItem>)}</SelectContent>
                        </Select>
                      </label>
                    ))}
                  </div>
                  <label className="flex items-center gap-2 text-sm"><Switch checked={!!a.notify} onCheckedChange={(v) => facesCall("PUT", "/api/faces/actions", { [pp.id]: { notify: v } }, v ? `${pp.name} 回家時會通知` : "不通知")} aria-label={`${pp.name} 回家時通知`} />回家時通知大家</label>
                </>
              )}
            </div>
          );
        }) : <p className="text-sm text-muted-foreground">先在「網路裝置 → 誰在家」新增家人。</p>}
        {entry && <p className="text-xs text-muted-foreground">家裡只剩他一個、門口又認出他時，會提醒他還開著的電器（多半是要出門）。</p>}
      </Task>

      <Task icon={UserRoundX} title="不認得的人通知我" on={cam.alert} onChange={(v) => upd({ alert: v }, v ? "會通知" : "不會通知")}
        hint={entry ? "看清楚的臉、跟登記的人都不像，在門口待 30 秒以上才通知；沒人在家或半夜是緊急通知" : "沒人在家或半夜才通知；家裡有人時只記紀錄（多半是客人）"}>
        <div className="space-y-2">
          <div className="text-sm font-medium">常來的人（不算陌生人）</div>
          {faces?.guests.map((g) => personRow(g, (
            <label className="flex items-center gap-1.5 text-sm"><Switch checked={g.notify !== false} onCheckedChange={(v) => facesCall("PUT", `/api/faces/${g.id}`, { notify: v }, v ? `${g.name} 來了會通知` : `${g.name} 來了不通知`)} aria-label={`${g.name} 來了通知`} />來了通知</label>
          )))}
          <form className="flex gap-2" onSubmit={(ev) => { ev.preventDefault(); if (guest.trim()) { enroll(null, guest.trim()); setGuest(""); } }}>
            <Input id="guest-name" placeholder="例如：清潔阿姨" className="max-w-48 bg-background" value={guest} onChange={(ev) => setGuest(ev.target.value)} aria-label="常來的人的名字" />
            <Button type="submit" variant="outline" className="bg-background" disabled={!!e || !guest.trim()}><Plus />新增並登記</Button>
          </form>
        </div>
        {entry && (
          <label className="flex items-center gap-2 text-sm">
            <span className="flex-1">半夜看到陌生人時，打開</span>
            <Select value={cam.light || "_none"} onValueChange={(v) => upd({ light: v === "_none" ? null : v }, v === "_none" ? "不開燈" : "半夜看到陌生人會開這個 5 分鐘")}>
              <SelectTrigger className="h-8 w-36 bg-background" aria-label="半夜看到陌生人時打開的插座"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="_none">不開</SelectItem>{plugs.map((pl) => <SelectItem key={pl.id} value={pl.id}>{pl.name}</SelectItem>)}</SelectContent>
            </Select>
          </label>
        )}
      </Task>

      <Task icon={DoorOpen} title="開門時通知" on={doors.some((z) => z.act.notify !== "off")}
        hint={doors.length ? doors.map((z) => `${z.name}：${z.act.notify === "always" ? "每次開了都通知" : z.act.notify === "away" ? "沒人在家時開了才通知" : "不通知"}`).join("・") : "先到「畫面」按「新增偵測」選「門」"}
        onChange={async (v) => {
          if (!doors.length) { setTab("view"); toast("在畫面上按「新增偵測」，選「門」"); return; }
          const r = await call<{ cameras: Cam[] }>("PUT", `/api/cameras/${cam.id}/zones`, { zones: (cam.zones || []).map((z) => (z.kind === "door" ? { ...z, act: { ...z.act, notify: v ? "away" : "off" } } : z)) }, v ? "沒人在家時開門會通知" : "開門不通知");
          if (r) setCams(r.cameras);
        }}>
        <p className="text-sm text-muted-foreground">每個門什麼時候通知、要不要執行情境，在「畫面」點那個門就能改。沒人在家時門開了，會先等 3 分鐘：有家人的手機連上 Wi-Fi、或門口認出家人，就不通知。</p>
      </Task>

      <Task icon={Lightbulb} title="有人就開燈" on={!!rule?.enabled} disabled={!cam.room}
        hint={cam.room ? "看到人就開，沒人一陣子自動關；手動關掉後要等安靜夠久才會再自動開" : "先到「畫面」選這台拍的區域"}
        onChange={(v) => setRule({ enabled: v }, v ? "有人就會開燈" : "不會自動開燈")}>
        {rule && (
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="flex items-center gap-2 text-sm"><span className="w-16 shrink-0 text-muted-foreground">開</span>
              <Select value={rule.plug} onValueChange={(v) => setRule({ plug: v }, "已更新")}>
                <SelectTrigger className="h-8 min-w-0 flex-1 bg-background" aria-label="有人時開哪個插座"><SelectValue /></SelectTrigger>
                <SelectContent>{plugs.map((pl) => <SelectItem key={pl.id} value={pl.id}>{pl.name}</SelectItem>)}</SelectContent>
              </Select>
            </label>
            <label className="flex items-center gap-2 text-sm"><span className="w-16 shrink-0 text-muted-foreground">時段</span>
              <Select value={winOf(rule)} onValueChange={(v) => { const w = WINDOWS.find(([k]) => k === v); if (w) { const [s, e2] = w[1] ? w[1].split("-") : ["", ""]; setRule({ start: s, end: e2 }, "已更新"); } }}>
                <SelectTrigger className="h-8 min-w-0 flex-1 bg-background" aria-label="什麼時段自動開"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {WINDOWS.map(([k, , label]) => <SelectItem key={k} value={k}>{label}</SelectItem>)}
                  {winOf(rule) === "custom" && <SelectItem value="custom">{rule.start}～{rule.end}</SelectItem>}
                </SelectContent>
              </Select>
            </label>
            <label className="flex items-center gap-2 text-sm"><span className="w-16 shrink-0 text-muted-foreground">沒人後</span>
              <Select value={String(rule.off_min)} onValueChange={(v) => setRule({ off_min: Number(v) }, "已更新")}>
                <SelectTrigger className="h-8 min-w-0 flex-1 bg-background" aria-label="沒人多久後關"><SelectValue /></SelectTrigger>
                <SelectContent>{[...new Set([3, 5, 10, 15, 30, rule.off_min])].sort((a, b) => a - b).map((m) => <SelectItem key={m} value={String(m)}>{m} 分鐘關</SelectItem>)}</SelectContent>
              </Select>
            </label>
            <label className="flex items-center gap-2 text-sm"><Switch checked={rule.need_home} onCheckedChange={(v) => setRule({ need_home: v }, "已更新")} aria-label="只在有人在家時" />只在家人在家時</label>
          </div>
        )}
      </Task>

      <Task icon={ShieldAlert} title={"有人跌倒通知我"} on={!!cam.fall} onChange={(v) => upd({ fall: v }, v ? "會偵測跌倒" : "不偵測跌倒")}
        hint={<>站著突然倒下、20 秒沒起來就緊急通知；慢慢坐下再躺下不算 <Badge variant="secondary">實驗</Badge></>} />

      <Task icon={Cat} title="看到貓狗" on={cam.pets !== false} onChange={(v) => upd({ pets: v }, v ? "會認貓、狗" : "不認貓、狗")}
        hint="記在紀錄裡、地圖上顯示；貓狗不會被當成人">
        <label className="flex items-center gap-2 text-sm"><Switch checked={!!cam.pet_notify} onCheckedChange={(v) => upd({ pet_notify: v }, v ? "看到貓狗會通知" : "只記紀錄")} aria-label="看到貓狗通知" />看到時通知（每 10 分鐘最多一次）</label>
      </Task>
    </>
  );
}

function LogTab({ faces, cam }: { faces: FaceRep | null; cam: Cam }) {
  const items = (faces?.log || []).filter((x) => x.camera === cam.name);
  const tone = (k: string) => (k === "stranger" || k === "fall" ? "bg-orange-500" : k === "family" ? "bg-emerald-500" : k === "door" ? "bg-primary" : "bg-muted-foreground");
  const text = (x: (typeof items)[number]) => x.kind === "stranger" ? "不認得的人" : x.kind === "guest" ? `${x.name}（訪客）` : x.kind === "pet" ? `看到${x.name}` : x.kind === "fall" ? "可能有人跌倒" : x.kind === "door" ? "門打開了" : `認出 ${x.name}`;
  return (
    <Card className="gap-0 py-0">
      <div className="border-b px-4 py-3 font-semibold">最近 7 天</div>
      {items.length === 0 ? <p className="px-4 py-6 text-sm text-muted-foreground">還沒有紀錄。</p> : (
        <ul className="divide-y">
          {items.map((x) => (
            <li key={x.id} className="flex items-center gap-3 px-4 py-2.5">
              <span className="w-24 shrink-0 text-sm tabular-nums text-muted-foreground">{hhmm(x.t)}</span>
              <span className={cn("size-2.5 shrink-0 rounded-full", tone(x.kind))} aria-hidden />
              <span className={cn("min-w-0 flex-1 text-sm", (x.kind === "stranger" || x.kind === "fall") && "font-semibold text-orange-600 dark:text-orange-400")}>{text(x)}{x.sim != null && <span className="ml-1 text-xs text-muted-foreground">相似度 {x.sim}</span>}</span>
              {x.thumb && <img src={`/api/faces/log/${x.id}.jpg`} alt={text(x)} className="size-12 shrink-0 rounded-md object-cover" loading="lazy" />}
            </li>
          ))}
        </ul>
      )}
      <p className="border-t px-4 py-2.5 text-xs text-muted-foreground">只有陌生人和跌倒會存小圖，7 天後自動刪掉；家人、訪客只記名字。</p>
    </Card>
  );
}

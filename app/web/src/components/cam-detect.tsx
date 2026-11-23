import { useEffect, useRef, useState } from "react";
import { Ban, ChevronLeft, DoorOpen, Loader2, Minus, Moon, Package, Plus, Sun, Trash2, UserRound } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { hhmm, type Act, type Cam, type Line, type Zone } from "@/components/camera-bits";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

// 攝影機的偵測：門、有人進來、東西多了／少了、經過的線、不要看的地方，全部在同一個清單。
// 「新增偵測」一步一步做：選種類 → 點出形狀 → 取名字 → （門、東西）記住正常的樣子 → 要做什麼。
// 點畫面上的形狀＝選它：拖圓點調整形狀，下面出現它的設定。

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

type P = number[];
type Kind = "door" | "area" | "object" | "line" | "ignore";
type Sel = { t: "zone" | "line" | "ignore"; i: number };

const C_DOOR = "var(--primary)";
const C_ZONE = "rgb(139 92 246)";
const C_IGN = "rgb(245 158 11)";
const TXT_ZONE = "rgb(109 40 217)";
const TXT_IGN = "rgb(180 83 9)";

const KINDS: { k: Kind; icon: React.ElementType; title: string; hint: string }[] = [
  { k: "door", icon: DoorOpen, title: "門", hint: "大門、電梯門：開了、關了" },
  { k: "area", icon: UserRound, title: "有人進來", hint: "門前、陽台：有人、待太久" },
  { k: "object", icon: Package, title: "東西多了／少了", hint: "包裹、腳踏車" },
  { k: "line", icon: Minus, title: "經過的線", hint: "樓梯口：上來、下去" },
  { k: "ignore", icon: Ban, title: "不要看的地方", hint: "路人、樹影、電視畫面，不會被當成有人" },
];
const NAMES: Record<Kind, string[]> = {
  door: ["大門", "電梯", "後門", "陽台門", "鐵捲門"],
  area: ["門前", "玄關", "陽台", "車位", "樓梯間"],
  object: ["門口地板", "包裹", "腳踏車", "鞋櫃"],
  line: ["樓梯口", "走廊", "大門口"],
  ignore: [],
};
const KIND_NAME: Record<Kind, string> = { door: "門", area: "有人進來", object: "東西多了／少了", line: "經過的線", ignore: "不要看的地方" };
const near = (a: P, b: P) => Math.hypot(a[0] - b[0], (a[1] - b[1]) * 0.5625) < 0.03; // 0.5625 = 9/16：換成畫面上的距離
const r4 = (q: P[]) => q.map(([x, y]) => [Math.round(x * 1e4) / 1e4, Math.round(y * 1e4) / 1e4]);
const off: Act = { notify: "off", scene: null, dark: false };

function notifyText(a: Act, what: string) {
  const n = a.notify === "always" ? `每次${what}都通知` : a.notify === "away" ? `沒人在家時${what}才通知` : "只顯示，不通知";
  return a.scene ? `${n}・${a.dark ? "天黑" : ""}執行情境` : n;
}

interface Props { cam: Cam; scenes: { id: string; name: string }[]; setCams: (c: Cam[]) => void; upd: (b: object, ok?: string) => Promise<void> }

export function DetectEditor({ cam, scenes, setCams, upd }: Props) {
  const zones = cam.zones || [], lines = cam.lines || [], ignore = cam.ignore || [];
  const [t, setT] = useState(() => Date.now());
  const [sel, setSel] = useState<Sel | null>(null);
  const [draft, setDraft] = useState<P[] | null>(null); // 選到的形狀，拖過圓點之後的樣子（還沒存）
  const [wiz, setWiz] = useState<{ step: number; kind: Kind; pts: P[]; name: string; id?: string } | null>(null);
  const [hover, setHover] = useState<P | null>(null);
  const [busy, setBusy] = useState(false);
  const svgRef = useRef<SVGSVGElement>(null);
  const dragging = useRef<number | null>(null);
  useEffect(() => {
    const id = setInterval(() => setT(Date.now()), 2000);
    return () => clearInterval(id);
  }, []);
  useEffect(() => { setDraft(null); }, [sel?.t, sel?.i]);

  const pos = (e: { clientX: number; clientY: number }): P => {
    const r = svgRef.current!.getBoundingClientRect();
    return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))];
  };
  const putZones = async (zs: Zone[], ok?: string) => { const r = await call<{ cameras: Cam[] }>("PUT", `/api/cameras/${cam.id}/zones`, { zones: zs }, ok); if (r) setCams(r.cameras); return r?.cameras.find((c) => c.id === cam.id) || null; };
  const putLines = async (ls: Line[], ok?: string) => { const r = await call<{ cameras: Cam[] }>("PUT", `/api/cameras/${cam.id}/lines`, { lines: ls }, ok); if (r) setCams(r.cameras); return r?.cameras.find((c) => c.id === cam.id) || null; };
  const remember = async (z: Zone) => {
    setBusy(true);
    const r = await call<{ cameras: Cam[]; is_night: boolean }>("POST", `/api/cameras/${cam.id}/zones/${z.id}/ref`);
    setBusy(false);
    if (!r) return false;
    setCams(r.cameras);
    const now = r.cameras.find((c) => c.id === cam.id)?.zones?.find((x) => x.id === z.id);
    if (z.kind === "door") {
      const need = now && !now.night ? "天黑後（畫面變黑白）門關著時再記一次" : now && !now.day ? "白天門關著時再記一次" : "白天、晚上都記好了";
      toast.success(`記住了${r.is_night ? "晚上" : "白天"}關著的樣子`, { description: need });
    } else toast.success("記住了：現在的樣子是正常的");
    return true;
  };

  // ---- 新增偵測 ----
  const startWiz = () => { setSel(null); setWiz({ step: 1, kind: "door", pts: [], name: "" }); };
  const pickKind = (k: Kind) => setWiz({ step: 2, kind: k, pts: [], name: NAMES[k][0] || "" });
  const drawDone = async () => {
    if (!wiz) return;
    if (wiz.kind === "ignore") {
      await upd({ ignore: [...ignore, r4(wiz.pts)] }, "存好了：這一塊之後不會看（路人、樹影不會被當成有人）");
      setWiz(null);
      return;
    }
    setWiz({ ...wiz, step: 3 });
  };
  const nameDone = async () => {
    if (!wiz) return;
    const name = wiz.name.trim() || NAMES[wiz.kind][0] || KIND_NAME[wiz.kind];
    if (wiz.kind === "line") {
      const ln: Line = { id: "", name, a: r4([wiz.pts[0]])[0], b: r4([wiz.pts[1]])[0], in: { notify: "away", scene: null, dark: false }, out: off };
      const c = await putLines([...lines, ln]);
      if (!c) return;
      setWiz({ ...wiz, name, step: 5, id: c.lines?.[c.lines.length - 1]?.id });
      return;
    }
    const z: Zone = { id: "", name, kind: wiz.kind as Zone["kind"], poly: r4(wiz.pts), linger: 0, act: { notify: "away", scene: null, dark: wiz.kind === "door" } };
    const c = await putZones([...zones, z]);
    if (!c) return;
    const id = c.zones?.[c.zones.length - 1]?.id;
    setWiz({ ...wiz, name, id, step: wiz.kind === "area" ? 5 : 4 });
  };
  const wizZone = wiz?.id ? zones.find((z) => z.id === wiz.id) : undefined;
  const wizLine = wiz?.id ? lines.find((l) => l.id === wiz.id) : undefined;

  const onTap = (e: React.MouseEvent) => {
    if (wiz?.step === 2) {
      const q = pos(e);
      if (wiz.kind === "line") {
        const pts = [...wiz.pts, q].slice(0, 2);
        setWiz({ ...wiz, pts });
        return;
      }
      if (wiz.pts.length >= 3 && near(q, wiz.pts[0])) { drawDone(); return; }
      if (wiz.pts.length < 12) setWiz({ ...wiz, pts: [...wiz.pts, q] });
      return;
    }
    if (!wiz) setSel(null); // 點空白：取消選取
  };

  // ---- 選到的那一項 ----
  const selZone = sel?.t === "zone" ? zones[sel.i] : undefined;
  const selLine = sel?.t === "line" ? lines[sel.i] : undefined;
  const selIgn = sel?.t === "ignore" ? ignore[sel.i] : undefined;
  const selPts: P[] | null = draft || (selZone ? selZone.poly : selIgn ? selIgn : selLine ? [selLine.a, selLine.b] : null);
  const saveShape = async () => {
    if (!draft || !sel) return;
    if (sel.t === "zone") await putZones(zones.map((z, j) => (j === sel.i ? { ...z, poly: r4(draft) } : z)), selZone?.kind === "door" ? "形狀存好了；門關著時請重新記住樣子" : "形狀存好了");
    else if (sel.t === "line") await putLines(lines.map((l, j) => (j === sel.i ? { ...l, a: r4([draft[0]])[0], b: r4([draft[1]])[0] } : l)), "存好了");
    else await upd({ ignore: ignore.map((z, j) => (j === sel.i ? r4(draft) : z)) }, "存好了");
    setDraft(null);
  };
  const remove = async () => {
    if (!sel) return;
    if (sel.t === "zone") await putZones(zones.filter((_, j) => j !== sel.i), "已移除");
    else if (sel.t === "line") await putLines(lines.filter((_, j) => j !== sel.i), "已移除");
    else await upd({ ignore: ignore.filter((_, j) => j !== sel.i) }, "已移除");
    setSel(null);
  };
  const setZ = (i: number, patch: Partial<Zone>, ok = "已更新") => putZones(zones.map((z, j) => (j === i ? { ...z, ...patch } : z)), ok);
  const setL = (i: number, patch: Partial<Line>, ok = "已更新") => putLines(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)), ok);

  // ---- 畫面上的形狀 ----
  const path = (q: P[]) => q.map(([x, y]) => `${x},${y}`).join(" ");
  const center = (q: P[]) => [q.reduce((s, p) => s + p[0], 0) / q.length, q.reduce((s, p) => s + p[1], 0) / q.length];
  const label = (q: P[], text: string, fill: string, size = 0.042) => {
    const [x, y] = center(q);
    return <text x={x} y={y} textAnchor="middle" dominantBaseline="middle" fill={fill} stroke="var(--card)" strokeWidth={0.006} paintOrder="stroke" style={{ fontSize: size, fontWeight: 700, pointerEvents: "none" }}>{text}</text>;
  };
  const zoneText = (z: Zone) => z.kind === "door" ? `${z.name}・${z.refs ? (z.open ? "開著" : "關著") : "還沒記"}` : z.kind === "area" ? `${z.name}・${z.busy ? "有人" : "沒人"}` : z.name;
  const pick = (s: Sel) => (e: React.MouseEvent) => { if (wiz) return; e.stopPropagation(); setSel(s); };
  const isSel = (s: Sel) => sel?.t === s.t && sel.i === s.i;
  const drawing = wiz?.step === 2;
  const doorsNeedNight = cam.night ? zones.filter((z) => z.kind === "door" && !z.night) : [];

  const hint = wiz?.step === 2
    ? (wiz.kind === "line" ? (wiz.pts.length === 0 ? "點一下線的起點（例如樓梯口的一邊）" : wiz.pts.length === 1 ? "再點一下線的終點" : "好了按「下一步」；點錯可以「復原上一點」")
      : wiz.pts.length < 3 ? `點出${wiz.kind === "door" ? "門" : wiz.kind === "ignore" ? "不要看的地方" : "這一區"}的角（已點 ${wiz.pts.length} 個）` : `繼續點，或點回第一個點／按「下一步」（已點 ${wiz.pts.length} 個）`)
    : sel && !wiz && selPts ? "拖圓點調整形狀" : null;

  return (
    <>
      <Card className="gap-3 p-3">
        {doorsNeedNight.length > 0 && !wiz && (
          <div className="flex flex-wrap items-center gap-2 rounded-lg bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-300">
            <Moon className="size-4 shrink-0" />
            <span className="min-w-0 flex-1">現在是晚上（畫面黑白）。{doorsNeedNight.map((z) => z.name).join("、")}關著的話，記一下晚上的樣子。</span>
            {doorsNeedNight.map((z) => <Button key={z.id} size="sm" disabled={busy} onClick={() => remember(z)}>{busy && <Loader2 className="animate-spin" />}記住{z.name}</Button>)}
          </div>
        )}
        {hint && <div className="rounded-lg bg-primary/10 px-3 py-2 text-center text-sm font-medium text-primary" aria-live="polite">{hint}</div>}
        <div className="relative aspect-video w-full select-none overflow-hidden rounded-lg bg-muted">
          <img src={`/api/cameras/${cam.id}/snapshot.jpg?t=${t}`} alt={`${cam.name} 現在的畫面`} className="pointer-events-none size-full object-fill" draggable={false} />
          <svg ref={svgRef} viewBox="0 0 1 1" preserveAspectRatio="none" className={cn("absolute inset-0 size-full", (drawing || sel) && "touch-none", drawing && "cursor-crosshair")}
            onClick={onTap}
            onPointerMove={(e) => {
              if (drawing) setHover(pos(e));
              if (sel && dragging.current != null && selPts) { const q = pos(e); setDraft(selPts.map((p, i) => (i === dragging.current ? q : p))); }
            }}
            onPointerUp={() => { dragging.current = null; }} onPointerLeave={() => setHover(null)}>
            {ignore.map((z, i) => {
              const s: Sel = { t: "ignore", i }, q = isSel(s) && draft ? draft : z;
              return (
                <g key={`i${i}`} onClick={pick(s)} style={{ cursor: wiz ? undefined : "pointer" }}>
                  <polygon points={path(q)} fill={C_IGN} fillOpacity={isSel(s) ? 0.32 : 0.2} stroke={C_IGN} strokeDasharray="6 4" vectorEffect="non-scaling-stroke" style={{ strokeWidth: isSel(s) ? 3 : 2 }} />
                  {label(q, "不要看", TXT_IGN, 0.038)}
                </g>
              );
            })}
            {zones.map((z, i) => {
              const s: Sel = { t: "zone", i }, q = isSel(s) && draft ? draft : z.poly;
              const lit = z.busy || z.open, door = z.kind === "door";
              const col = lit ? "rgb(249 115 22)" : door ? C_DOOR : C_ZONE;
              return (
                <g key={`z${z.id || i}`} onClick={pick(s)} style={{ cursor: wiz ? undefined : "pointer" }}>
                  <polygon points={path(q)} fill={col} fillOpacity={isSel(s) ? 0.34 : lit ? 0.28 : 0.16} stroke={col} strokeDasharray={z.kind === "object" ? "5 3" : undefined} vectorEffect="non-scaling-stroke" style={{ strokeWidth: isSel(s) ? 3.5 : 2 }} />
                  {label(q, zoneText(z), lit ? "rgb(234 88 12)" : door ? C_DOOR : TXT_ZONE)}
                </g>
              );
            })}
            {lines.map((ln, i) => {
              const s: Sel = { t: "line", i };
              const [[ax, ay], [bx, by]] = isSel(s) && draft ? draft : [ln.a, ln.b];
              // 箭頭：在線中間、指向「回來」那一邊（畫面是 16:9，算垂直方向時要換成畫面比例）
              const dx = (bx - ax) * 16, dy = (by - ay) * 9, L = Math.hypot(dx, dy) || 1;
              const nx = ((dy / L) * 1.6) / 16, ny = ((-dx / L) * 1.6) / 9;
              const mx = (ax + bx) / 2, my = (ay + by) / 2;
              return (
                <g key={`l${ln.id || i}`} onClick={pick(s)} style={{ cursor: wiz ? undefined : "pointer" }}>
                  <line x1={ax} y1={ay} x2={bx} y2={by} stroke="transparent" vectorEffect="non-scaling-stroke" style={{ strokeWidth: 22 }} />
                  <line x1={ax} y1={ay} x2={bx} y2={by} stroke={C_ZONE} vectorEffect="non-scaling-stroke" style={{ strokeWidth: isSel(s) ? 4.5 : 3 }} />
                  <line x1={mx - nx * 0.4} y1={my - ny * 0.4} x2={mx + nx} y2={my + ny} stroke={C_ZONE} vectorEffect="non-scaling-stroke" style={{ strokeWidth: 2 }} markerEnd="url(#det-arrow)" />
                  <text x={mx + nx * 1.5} y={my + ny * 1.5} textAnchor="middle" dominantBaseline="middle" fill={TXT_ZONE} stroke="var(--card)" strokeWidth={0.006} paintOrder="stroke" style={{ fontSize: 0.036, fontWeight: 700, pointerEvents: "none" }}>回來</text>
                  {label([[ax, ay], [bx, by]], ln.name, TXT_ZONE)}
                </g>
              );
            })}
            <defs><marker id="det-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill={C_ZONE} /></marker></defs>
            {drawing && wiz && wiz.pts.length > 0 && (() => {
              const col = wiz.kind === "door" ? C_DOOR : wiz.kind === "ignore" ? C_IGN : C_ZONE;
              const live = hover && !(wiz.kind === "line" && wiz.pts.length >= 2) ? [...wiz.pts, hover] : wiz.pts;
              return (
                <g style={{ pointerEvents: "none" }}>
                  {wiz.kind === "line"
                    ? <polyline points={path(live)} fill="none" stroke={col} strokeDasharray={wiz.pts.length < 2 ? "6 4" : undefined} vectorEffect="non-scaling-stroke" style={{ strokeWidth: 3 }} />
                    : <polyline points={path(live)} fill={col} fillOpacity={0.14} stroke={col} vectorEffect="non-scaling-stroke" style={{ strokeWidth: 2 }} />}
                  {wiz.pts.map((p, i) => {
                    const first = i === 0 && wiz.kind !== "line" && wiz.pts.length >= 3;
                    return <ellipse key={i} cx={p[0]} cy={p[1]} rx={first ? 0.018 : 0.011} ry={(first ? 0.018 : 0.011) * 1.78} fill={first ? "var(--card)" : col} stroke={col} vectorEffect="non-scaling-stroke" style={{ strokeWidth: 2 }} />;
                  })}
                </g>
              );
            })()}
            {sel && !wiz && selPts && selPts.map((p, i) => (
              <ellipse key={`h${i}`} cx={p[0]} cy={p[1]} rx={0.018} ry={0.032} fill="var(--card)" stroke={sel.t === "ignore" ? C_IGN : selZone?.kind === "door" ? C_DOOR : C_ZONE} vectorEffect="non-scaling-stroke"
                style={{ strokeWidth: 2.5, cursor: "grab" }} onClick={(e) => e.stopPropagation()}
                onPointerDown={(e) => { e.stopPropagation(); (e.currentTarget.ownerSVGElement as SVGSVGElement).setPointerCapture(e.pointerId); dragging.current = i; }} />
            ))}
          </svg>
        </div>

        {wiz ? Wizard() : (
          <Button className="w-full" onClick={startWiz}><Plus />新增偵測</Button>
        )}
      </Card>

      {!wiz && sel && (selZone || selLine || selIgn) && (
        <Card className="gap-3 border-primary/50 p-4">
          {selZone && ZoneEdit({ z: selZone, i: sel.i })}
          {selLine && LineEdit({ l: selLine, i: sel.i })}
          {selIgn && <div className="flex items-center gap-2"><Ban className="size-5 text-amber-600" /><span className="font-semibold">不要看的地方 {sel.i + 1}</span></div>}
          {selIgn && <p className="text-sm text-muted-foreground">認人之前先把這一塊塗掉：路人、樹影、電視畫面就不會被當成有人。</p>}
          <div className="flex flex-wrap gap-2 border-t pt-3">
            {draft && <Button size="sm" onClick={saveShape}>儲存形狀</Button>}
            {draft && <Button size="sm" variant="outline" onClick={() => setDraft(null)}>復原形狀</Button>}
            <Button size="sm" variant="ghost" className="text-muted-foreground hover:text-destructive" onClick={remove}><Trash2 />刪除</Button>
            <Button size="sm" variant={draft ? "ghost" : "default"} className="ml-auto" onClick={() => setSel(null)}>好了</Button>
          </div>
        </Card>
      )}

      {!wiz && DetectList()}
    </>
  );

  // ---- 清單 ----
  function DetectList() {
    const rows: { s: Sel; icon: React.ElementType; name: string; chips: React.ReactNode; desc: string }[] = [
      ...zones.map((z, i) => ({
        s: { t: "zone", i } as Sel, icon: z.kind === "door" ? DoorOpen : z.kind === "area" ? UserRound : Package, name: z.name,
        chips: z.kind === "door" ? <>{z.refs ? <Chip tone={z.open ? "hot" : "ok"}>{z.open ? "開著" : "關著"}</Chip> : <Chip tone="hot">還沒記樣子</Chip>}<DayNight z={z} /></>
          : z.kind === "area" ? <Chip tone={z.busy ? "hot" : undefined}>{z.busy ? "有人" : "沒人"}</Chip> : <Chip>{z.refs ? "看著" : "學習中"}</Chip>,
        desc: (z.kind === "area" && z.linger ? `待超過 ${z.linger >= 60 ? `${z.linger / 60} 分鐘` : `${z.linger} 秒`}・` : "") + notifyText(z.act, z.kind === "door" ? "開了" : z.kind === "area" ? "有人" : "有變化"),
      })),
      ...lines.map((l, i) => ({ s: { t: "line", i } as Sel, icon: Minus, name: l.name, chips: l.last ? <Chip>上次 {hhmm(l.last.t)} {l.last.way === "in" ? "回來" : "出去"}</Chip> : null, desc: `回來：${notifyText(l.in, "有人回來")}` })),
      ...ignore.map((_, i) => ({ s: { t: "ignore", i } as Sel, icon: Ban, name: `不要看的地方 ${i + 1}`, chips: null, desc: "這一塊不會被當成有人" })),
    ];
    if (!rows.length) return <p className="px-1 text-sm text-muted-foreground">還沒有偵測。按「新增偵測」，例如框出大門，開了就通知你。</p>;
    return (
      <Card className="gap-0 divide-y overflow-hidden py-0">
        {rows.map((r) => {
          const I = r.icon;
          return (
            <button key={`${r.s.t}${r.s.i}`} onClick={() => setSel(isSel(r.s) ? null : r.s)} aria-pressed={isSel(r.s)}
              className={cn("flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset", isSel(r.s) && "bg-primary/10")}>
              <span className={cn("flex size-9 shrink-0 items-center justify-center rounded-lg", r.s.t === "ignore" ? "bg-amber-500/15 text-amber-700 dark:text-amber-300" : "bg-muted text-foreground/70")}><I className="size-5" /></span>
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-1.5 font-medium">{r.name}{r.chips}</span>
                <span className="block truncate text-sm text-muted-foreground">{r.desc}</span>
              </span>
            </button>
          );
        })}
      </Card>
    );
  }

  // ---- 新增偵測的每一步 ----
  function Wizard() {
    if (!wiz) return null;
    const bar = (
      <div className="flex gap-1" aria-label={`第 ${wiz.step} 步，共 5 步`}>{[1, 2, 3, 4, 5].map((n) => <i key={n} className={cn("h-1 flex-1 rounded-full", n <= wiz.step ? "bg-primary" : "bg-muted")} />)}</div>
    );
    const cancel = <Button variant="ghost" size="sm" onClick={() => setWiz(null)}>取消</Button>;
    if (wiz.step === 1)
      return (
        <div className="space-y-3">
          {bar}
          <div className="font-semibold">要偵測什麼？</div>
          <div className="grid grid-cols-2 gap-2">
            {KINDS.map(({ k, icon: I, title, hint }) => (
              <button key={k} onClick={() => pickKind(k)} className={cn("flex items-start gap-2.5 rounded-xl border-2 p-3 text-left transition-colors hover:border-primary/60 hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", k === "ignore" && "col-span-2")}>
                <I className="mt-0.5 size-5 shrink-0 text-primary" />
                <span className="min-w-0"><span className="block font-semibold">{title}</span><span className="block text-xs leading-relaxed text-muted-foreground">{hint}</span></span>
              </button>
            ))}
          </div>
          <div className="flex">{cancel}</div>
        </div>
      );
    if (wiz.step === 2) {
      const ready = wiz.kind === "line" ? wiz.pts.length === 2 : wiz.pts.length >= 3;
      return (
        <div className="space-y-3">
          {bar}
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={() => setWiz({ ...wiz, step: 1, pts: [] })}><ChevronLeft />上一步</Button>
            <Button variant="outline" size="sm" disabled={!wiz.pts.length} onClick={() => setWiz({ ...wiz, pts: wiz.pts.slice(0, -1) })}>復原上一點</Button>
            {cancel}
            <Button size="sm" className="ml-auto" disabled={!ready} onClick={drawDone}>{wiz.kind === "ignore" ? "完成" : "下一步"}</Button>
          </div>
          <p className="text-xs text-muted-foreground">{wiz.kind === "line" ? "人走過這條線就算；之後可以把方向反過來。" : "照著實際的形狀點角就好，斜的門也框得剛好；點回第一個點也會完成。"}</p>
        </div>
      );
    }
    if (wiz.step === 3)
      return (
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); nameDone(); }}>
          {bar}
          <label htmlFor="det-name" className="block font-semibold">取個名字</label>
          <Input id="det-name" autoFocus maxLength={12} value={wiz.name} onChange={(e) => setWiz({ ...wiz, name: e.target.value })} className="bg-background" />
          <div className="flex flex-wrap gap-1.5">
            {NAMES[wiz.kind].map((n) => (
              <button type="button" key={n} onClick={() => setWiz({ ...wiz, name: n })} aria-pressed={wiz.name === n}
                className={cn("rounded-full border px-3 py-1 text-sm", wiz.name === n ? "border-primary bg-primary/10 font-semibold text-primary" : "hover:bg-muted")}>{n}</button>
            ))}
          </div>
          <div className="flex gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => setWiz({ ...wiz, step: 2 })}><ChevronLeft />上一步</Button>
            {cancel}
            <Button type="submit" size="sm" className="ml-auto">下一步</Button>
          </div>
        </form>
      );
    if (wiz.step === 4 && wizZone) {
      const door = wizZone.kind === "door";
      return (
        <div className="space-y-3">
          {bar}
          <div className="space-y-2.5 rounded-xl border-2 border-primary/60 bg-primary/5 p-3">
            <div className="font-semibold">{door ? `${wizZone.name}現在是關著的嗎？` : `${wizZone.name}現在的樣子是正常的嗎？`}</div>
            <div className="flex flex-wrap gap-2">
              <Button disabled={busy} onClick={async () => { if (await remember(wizZone)) setWiz({ ...wiz, step: 5 }); }}>{busy && <Loader2 className="animate-spin" />}是，記住</Button>
              <Button variant="outline" className="bg-background" onClick={() => setWiz({ ...wiz, step: 5 })}>{door ? "現在開著，晚點再記" : "晚點再說"}</Button>
            </div>
          </div>
          {door ? <DayNight z={wizZone} big /> : <p className="text-sm text-muted-foreground">沒記的話，沒人、畫面穩定 1 分鐘後會自己記。</p>}
          {door && <p className="text-xs text-muted-foreground">樹莓派自己看是白天（彩色）還是晚上（黑白）。晚上門關著時，這一頁會提醒你補記一次。</p>}
        </div>
      );
    }
    // 第 5 步：要做什麼
    const z = wizZone, l = wizLine;
    const act = z ? z.act : l ? l.in : off;
    const what = z?.kind === "door" ? "開了" : z?.kind === "area" ? "有人" : z?.kind === "object" ? "有變化" : "有人回來";
    const setAct = (a: Act) => { if (z) setZ(zones.indexOf(z), { act: a }, ""); else if (l) setL(lines.indexOf(l), { in: a }, ""); };
    return (
      <div className="space-y-3">
        {bar}
        <div className="font-semibold">{z?.name || l?.name}{what}的時候</div>
        <div className="grid gap-2">
          {([["off", "只顯示", "畫面、清單上看得到，不通知"], ["away", `沒人在家時${what}才通知`, "建議：家人在家時不會吵；會先等 3 分鐘確認不是家人回來"], ["always", `每次${what}都通知`, ""]] as const).map(([k, title, sub]) => (
            <button key={k} onClick={() => setAct({ ...act, notify: k })} aria-pressed={act.notify === k}
              className={cn("flex items-start gap-2.5 rounded-xl border p-3 text-left", act.notify === k ? "border-primary bg-primary/10" : "hover:bg-muted")}>
              <span className={cn("mt-0.5 size-4 shrink-0 rounded-full border-2", act.notify === k ? "border-[5px] border-primary" : "border-muted-foreground/60")} />
              <span><span className="block font-medium">{title}</span>{sub && <span className="block text-xs text-muted-foreground">{sub}</span>}</span>
            </button>
          ))}
        </div>
        {z?.kind === "area" && (
          <label className="flex items-center gap-2 text-sm"><span className="flex-1">待多久才算</span>{Linger({ z, i: zones.indexOf(z) })}</label>
        )}
        {scenes.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span>同時執行</span>
            {SceneSelect({ act, onChange: setAct })}
            {act.scene && <label className="flex items-center gap-1.5"><Switch checked={act.dark} onCheckedChange={(v) => setAct({ ...act, dark: v })} aria-label="只在天黑後" />只在天黑後</label>}
          </div>
        )}
        <Button className="w-full" onClick={() => { setWiz(null); toast.success(`「${z?.name || l?.name}」設定好了`); }}>完成</Button>
      </div>
    );
  }

  // ---- 修改一項 ----
  function ZoneEdit({ z, i }: { z: Zone; i: number }) {
    const I = z.kind === "door" ? DoorOpen : z.kind === "area" ? UserRound : Package;
    const what = z.kind === "door" ? "開了" : z.kind === "area" ? "有人" : "有變化";
    return (
      <>
        <div className="flex flex-wrap items-center gap-2">
          <I className="size-5 text-primary" />
          <Input key={z.id} className="h-9 w-36 bg-background font-semibold" defaultValue={z.name} maxLength={12} aria-label="名稱" onBlur={(e) => e.target.value.trim() && e.target.value !== z.name && setZ(i, { name: e.target.value.trim() }, "已改名")} />
          <Badge variant="secondary">{KIND_NAME[z.kind]}</Badge>
          {z.kind === "door" && z.refs ? <Chip tone={z.open ? "hot" : "ok"}>{z.open ? "開著" : "關著"}</Chip> : null}
        </div>
        {z.kind !== "area" && (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="w-20 shrink-0 text-muted-foreground">記住的樣子</span>
            {z.kind === "door" ? <DayNight z={z} /> : <span>{z.refs ? `記了 ${z.refs} 張` : "還沒記（沒人、畫面穩定 1 分鐘後會自己記）"}</span>}
            <Button size="sm" variant="outline" className="bg-background" disabled={busy} onClick={() => remember(z)}>{busy && <Loader2 className="animate-spin" />}{z.kind === "door" ? `現在關著，記住${cam.night ? "（晚上）" : "（白天）"}` : "現在是正常的"}</Button>
          </div>
        )}
        {z.kind === "area" && <label className="flex items-center gap-2 text-sm"><span className="w-20 shrink-0 text-muted-foreground">待多久才算</span>{Linger({ z, i })}</label>}
        <label className="flex items-center gap-2 text-sm">
          <span className="w-20 shrink-0 text-muted-foreground">{what}的時候</span>
          <Select value={z.act.notify} onValueChange={(v) => setZ(i, { act: { ...z.act, notify: v as Act["notify"] } })}>
            <SelectTrigger className="h-8 w-48 bg-background" aria-label={`${what}的時候`}><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="off">只顯示，不通知</SelectItem><SelectItem value="away">沒人在家時才通知</SelectItem><SelectItem value="always">每次都通知</SelectItem></SelectContent>
          </Select>
        </label>
        {scenes.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="w-20 shrink-0 text-muted-foreground">同時執行</span>
            {SceneSelect({ act: z.act, onChange: (a) => setZ(i, { act: a }) })}
            {z.act.scene && <label className="flex items-center gap-1.5"><Switch checked={z.act.dark} onCheckedChange={(v) => setZ(i, { act: { ...z.act, dark: v } })} aria-label="只在天黑後" />只在天黑後</label>}
          </div>
        )}
      </>
    );
  }

  function LineEdit({ l, i }: { l: Line; i: number }) {
    const row = (way: "in" | "out", text: string) => (
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="w-20 shrink-0 text-muted-foreground">{text}</span>
        <Select value={l[way].notify} onValueChange={(v) => setL(i, { [way]: { ...l[way], notify: v as Act["notify"] } })}>
          <SelectTrigger className="h-8 w-44 bg-background" aria-label={text}><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value="off">不通知</SelectItem><SelectItem value="away">沒人在家時才通知</SelectItem><SelectItem value="always">每次都通知</SelectItem></SelectContent>
        </Select>
        {scenes.length > 0 && SceneSelect({ act: l[way], onChange: (a) => setL(i, { [way]: a }) })}
      </div>
    );
    return (
      <>
        <div className="flex flex-wrap items-center gap-2">
          <Minus className="size-5 text-primary" />
          <Input key={l.id} className="h-9 w-36 bg-background font-semibold" defaultValue={l.name} maxLength={12} aria-label="名稱" onBlur={(e) => e.target.value.trim() && e.target.value !== l.name && setL(i, { name: e.target.value.trim() }, "已改名")} />
          <Badge variant="secondary">經過的線</Badge>
          <Button size="sm" variant="outline" className="ml-auto bg-background" onClick={() => setL(i, { a: l.b, b: l.a, in: l.out, out: l.in }, "方向反過來了")}>方向反過來</Button>
        </div>
        {row("in", "有人回來")}
        {row("out", "有人出去")}
        <p className="text-xs text-muted-foreground">往箭頭那邊走是「回來」。{l.last && `上次：${hhmm(l.last.t)} ${l.last.way === "in" ? "回來" : "出去"}`}</p>
      </>
    );
  }

  function Linger({ z, i }: { z: Zone; i: number }) {
    return (
      <Select value={String(z.linger || 0)} onValueChange={(v) => setZ(i, { linger: Number(v) })}>
        <SelectTrigger className="h-8 w-40 bg-background" aria-label="待多久才算"><SelectValue /></SelectTrigger>
        <SelectContent>{[0, 10, 30, 60, 120, 300].map((sec) => <SelectItem key={sec} value={String(sec)}>{sec ? `待超過 ${sec >= 60 ? `${sec / 60} 分鐘` : `${sec} 秒`}` : "一進來就算"}</SelectItem>)}</SelectContent>
      </Select>
    );
  }

  function SceneSelect({ act, onChange }: { act: Act; onChange: (a: Act) => void }) {
    return (
      <Select value={act.scene || "_none"} onValueChange={(v) => onChange({ ...act, scene: v === "_none" ? null : v })}>
        <SelectTrigger className="h-8 w-40 bg-background" aria-label="同時執行的情境"><SelectValue /></SelectTrigger>
        <SelectContent><SelectItem value="_none">不執行情境</SelectItem>{scenes.map((sc) => <SelectItem key={sc.id} value={sc.id}>「{sc.name}」</SelectItem>)}</SelectContent>
      </Select>
    );
  }
}

function Chip({ tone, children }: { tone?: "ok" | "hot"; children: React.ReactNode }) {
  return <span className={cn("inline-flex items-center gap-1 rounded-full px-2 py-px text-xs font-semibold whitespace-nowrap", tone === "ok" ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300" : tone === "hot" ? "bg-orange-100 text-orange-800 dark:bg-orange-500/15 dark:text-orange-300" : "bg-muted text-muted-foreground")}>{children}</span>;
}

// 門記住的樣子：白天、晚上各記了沒
function DayNight({ z, big }: { z: Zone; big?: boolean }) {
  const cell = (ok: boolean, I: React.ElementType, text: string) => big ? (
    <div className={cn("flex flex-1 flex-col items-center gap-0.5 rounded-xl border p-2.5 text-sm", ok ? "border-emerald-500/60 font-semibold text-emerald-700 dark:text-emerald-300" : "text-muted-foreground")}>
      <I className="size-5" />{text}<span className="text-xs">{ok ? "✓ 記好了" : "還沒記"}</span>
    </div>
  ) : <Chip tone={ok ? "ok" : "hot"}><I className="size-3" />{text} {ok ? "✓" : "✗"}</Chip>;
  return <span className={cn("inline-flex gap-1.5", big && "flex w-full gap-2")}>{cell(!!z.day, Sun, "白天")}{cell(!!z.night, Moon, "晚上")}</span>;
}

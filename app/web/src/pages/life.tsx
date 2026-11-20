import { useState } from "react";
import { DndContext, KeyboardSensor, PointerSensor, closestCorners, useDroppable, useSensor, useSensors, type DragEndEvent, type DragOverEvent } from "@dnd-kit/core";
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Check, Eye, EyeOff, GripVertical, LayoutGrid, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/app-shell";
import { AlertsCard } from "@/components/alerts";
import { LifeSheet } from "@/components/life-sheet";
import { WeatherSheet } from "@/components/weather-sheet";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { useHub, useMedia } from "@/lib/hub";
import { cn } from "@/lib/utils";

const noop = () => {};

type CardId = "alerts" | "weather" | "bike" | "bus" | "garbage" | "outage";
interface Layout { cols: CardId[][]; hidden: CardId[] }
const NAMES: Record<CardId, string> = { alerts: "停班停課與警報", weather: "天氣", bike: "YouBike", bus: "公車", garbage: "垃圾車", outage: "停水停電" };
const DEFAULT: Layout = { cols: [["alerts", "weather"], ["bike", "garbage"], ["bus", "outage"]], hidden: [] };

// 三欄的排法是主要的；比較窄的畫面照「第一欄、第二欄、第三欄」的順序重新分欄
const flat = (cols: CardId[][]) => cols.flat();
// 窄畫面調整順序後放回三欄：每欄張數不變
const refill = (list: CardId[], like: CardId[][]) => {
  let k = 0;
  return like.map((c) => list.slice(k, (k += c.length)));
};
const split = (list: CardId[], n: number) => {
  const cols: CardId[][] = Array.from({ length: n }, () => []);
  list.forEach((x, i) => cols[i % n].push(x));
  return cols;
};

// 排列模式的一條：拖左邊的握把移動（手機上只有握把能拖，其他地方照常捲動）
function Bar({ id, children }: { id: CardId; children: (grip: React.ReactNode) => React.ReactNode }) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id });
  const grip = (
    <button ref={setActivatorNodeRef} type="button" aria-label={`拖拉移動「${NAMES[id]}」（或按空白鍵後用方向鍵）`}
      className="-ml-1 flex size-10 shrink-0 cursor-grab touch-none items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing"
      {...attributes} {...listeners}>
      <GripVertical className="size-5" />
    </button>
  );
  return (
    <div ref={setNodeRef} style={{ transform: CSS.Translate.toString(transform), transition }} className={cn("relative", isDragging && "z-10 opacity-80 [&>div]:shadow-lg [&>div]:ring-2 [&>div]:ring-primary")}>
      {children(grip)}
    </div>
  );
}

function Column({ id, children, empty }: { id: string; children: React.ReactNode; empty: boolean }) {
  const { setNodeRef, isOver } = useDroppable({ id });
  return (
    <div ref={setNodeRef} className={cn("flex min-h-14 min-w-0 flex-col gap-2 rounded-xl", empty && "border-2 border-dashed", empty && isOver && "border-primary bg-primary/5")}>
      {children}
      {empty && <p className="m-auto text-sm text-muted-foreground">拖到這裡</p>}
    </div>
  );
}

// 生活：天氣、YouBike、公車、垃圾車、停水停電攤開在一頁（首頁上方的小標籤點開是同樣的內容）
// 每一直欄各自往下排；按「排列」可以自己移動、藏起卡片（存在樹莓派上，每台裝置都一樣）
export function LifePage() {
  const { state } = useHub();
  const L = state?.calendar.local;
  const wide3 = useMedia("(min-width: 1536px)");
  const wide2 = useMedia("(min-width: 1024px)");
  const [edit, setEdit] = useState(false);
  const [draft, setDraft] = useState<Layout | null>(null);
  const saved = (state?.settings.life_layout as Layout | undefined) || DEFAULT;
  const lay = draft || saved;

  const save = (next: Layout | null) => {
    setDraft(next || DEFAULT);
    api("PUT", "/api/settings", { life_layout: next }).catch((err) => toast.error("沒有存起來", { description: (err as Error).message }));
  };
  const n = wide3 ? 3 : wide2 ? 2 : 1;
  const cols: CardId[][] = n === 3 ? lay.cols : split(flat(lay.cols), n);

  const move = (id: CardId, dir: "up" | "down" | "left" | "right") => {
    if (n === 3) {
      const c = lay.cols.map((x) => [...x]);
      const ci = c.findIndex((x) => x.includes(id));
      const i = c[ci].indexOf(id);
      if (dir === "up" || dir === "down") {
        const j = dir === "up" ? i - 1 : i + 1;
        if (j < 0 || j >= c[ci].length) return;
        [c[ci][i], c[ci][j]] = [c[ci][j], c[ci][i]];
      } else {
        const cj = dir === "left" ? ci - 1 : ci + 1;
        if (cj < 0 || cj > 2) return;
        c[ci].splice(i, 1);
        c[cj].splice(Math.min(i, c[cj].length), 0, id);
      }
      save({ ...lay, cols: c });
    } else {
      // 窄畫面：照順序往前、往後移（排回三欄時一列一列放）
      const f = flat(lay.cols);
      const i = f.indexOf(id);
      const j = dir === "up" || dir === "left" ? i - 1 : i + 1;
      if (j < 0 || j >= f.length) return;
      [f[i], f[j]] = [f[j], f[i]];
      save({ ...lay, cols: refill(f, lay.cols) });
    }
  };
  const toggleHide = (id: CardId) => save({ ...lay, hidden: lay.hidden.includes(id) ? lay.hidden.filter((x) => x !== id) : [...lay.hidden, id] });

  const body: Record<CardId, React.ReactNode> = {
    alerts: <AlertsCard A={state?.calendar.alerts} />,
    weather: <WeatherSheet inline open onClose={noop} />,
    bike: <LifeSheet inline open onClose={noop} topic="bike" />,
    bus: <LifeSheet inline open onClose={noop} topic="bus" />,
    garbage: <LifeSheet inline open onClose={noop} topic="garbage" />,
    outage: <LifeSheet inline open onClose={noop} topic="outage" />,
  };

  // 排列模式：大螢幕三欄（可以拖到別欄），窄畫面一條清單
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  const [dragCols, setDragCols] = useState<CardId[][] | null>(null);
  const editCols = dragCols || (n === 3 ? lay.cols : [flat(lay.cols)]);
  const colOf = (cols: CardId[][], id: string) => (id.startsWith("col-") ? Number(id.slice(4)) : cols.findIndex((c) => c.includes(id as CardId)));
  const onOver = ({ active, over }: DragOverEvent) => {
    if (!over) return;
    const from = colOf(editCols, String(active.id)), to = colOf(editCols, String(over.id));
    if (from < 0 || to < 0 || from === to) return;
    const c = editCols.map((x) => [...x]);
    c[from] = c[from].filter((x) => x !== active.id);
    const at = String(over.id).startsWith("col-") ? c[to].length : Math.max(0, c[to].indexOf(over.id as CardId));
    c[to].splice(at, 0, active.id as CardId);
    setDragCols(c);
  };
  const onEnd = ({ active, over }: DragEndEvent) => {
    let c = editCols.map((x) => [...x]);
    if (over && !String(over.id).startsWith("col-")) {
      const ci = colOf(c, String(active.id));
      const a = c[ci].indexOf(active.id as CardId), b = c[ci].indexOf(over.id as CardId);
      if (b >= 0 && a !== b) c = c.map((x, i) => (i === ci ? arrayMove(x, a, b) : x));
    }
    setDragCols(null);
    const next = n === 3 ? c : refill(c[0], lay.cols);
    if (JSON.stringify(next) !== JSON.stringify(lay.cols)) save({ ...lay, cols: next });
  };

  const bar = (id: CardId, ci: number, i: number, col: CardId[]) => {
    const hidden = lay.hidden.includes(id);
    const btn = (I: React.ElementType, label: string, onClick: () => void, disabled?: boolean) => (
      <Button size="icon" variant="ghost" className="size-8 max-sm:hidden" onClick={onClick} disabled={disabled} aria-label={`${NAMES[id]}${label}`} title={label}><I /></Button>
    );
    return (
      <Bar key={id} id={id}>
        {(grip) => (
          <div className={cn("flex h-14 items-center gap-1 rounded-xl border bg-card pr-2 pl-2 shadow-xs", hidden && "border-dashed bg-background/60 shadow-none")}>
            {grip}
            <span className={cn("mr-auto truncate font-semibold", hidden && "text-muted-foreground")}>{NAMES[id]}{hidden && <span className="ml-2 text-sm font-normal">已藏起來</span>}</span>
            {n === 3 && btn(ArrowLeft, "往左一欄", () => move(id, "left"), ci === 0)}
            {btn(ArrowUp, "往上", () => move(id, "up"), i === 0)}
            {btn(ArrowDown, "往下", () => move(id, "down"), i === col.length - 1)}
            {n === 3 && btn(ArrowRight, "往右一欄", () => move(id, "right"), ci === 2)}
            <Button size="icon" variant="ghost" className="size-9" onClick={() => toggleHide(id)} aria-label={`${NAMES[id]}${hidden ? "顯示" : "藏起來"}`} title={hidden ? "顯示" : "藏起來"}>{hidden ? <Eye /> : <EyeOff />}</Button>
          </div>
        )}
      </Bar>
    );
  };

  return (
    <>
      <PageHeader title="生活" sub={L?.place ? `${L.place}・政府開放資料，每幾分鐘更新` : "政府開放資料，每幾分鐘更新"}
        actions={edit ? (
          <>
            <Button variant="outline" className="h-9 rounded-full bg-background" onClick={() => save(null)}><RotateCcw />恢復預設</Button>
            <Button className="h-9 rounded-full" onClick={() => { setEdit(false); setDraft(null); }}><Check />完成</Button>
          </>
        ) : (
          <Button variant="outline" className="h-9 rounded-full bg-background" onClick={() => setEdit(true)} title="移動、藏起卡片"><LayoutGrid /><span className="max-sm:sr-only">排列</span></Button>
        )}
      />
      <div className="mx-auto max-w-[112rem] px-4 py-4 sm:px-6 lg:px-8">
        {edit && <p className="mb-4 text-sm text-muted-foreground">按住左邊的握把拖到想要的位置{n === 3 ? "，可以拖到別欄" : ""}；眼睛圖示可以藏起不需要的卡片。排好的位置每台裝置都一樣。</p>}
        {edit ? (
          <DndContext sensors={sensors} collisionDetection={closestCorners} onDragOver={onOver} onDragEnd={onEnd} onDragCancel={() => setDragCols(null)}>
            <div className={cn("grid items-start gap-4", n === 3 ? "grid-cols-3" : "mx-auto max-w-xl grid-cols-1")}>
              {editCols.map((col, ci) => (
                <SortableContext key={ci} id={`col-${ci}`} items={col} strategy={verticalListSortingStrategy}>
                  <Column id={`col-${ci}`} empty={!col.length}>{col.map((id, i) => bar(id, ci, i, col))}</Column>
                </SortableContext>
              ))}
            </div>
          </DndContext>
        ) : (
          <div className={cn("grid items-start gap-4", n === 3 ? "grid-cols-3" : n === 2 ? "grid-cols-2" : "grid-cols-1")}>
            {cols.map((col, ci) => (
              <div key={ci} className="flex min-w-0 flex-col gap-4">{col.filter((id) => !lay.hidden.includes(id)).map((id) => <div key={id}>{body[id]}</div>)}</div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

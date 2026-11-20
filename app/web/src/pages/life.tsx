import { useState } from "react";
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Check, Eye, EyeOff, LayoutGrid, RotateCcw } from "lucide-react";
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

  const card = (id: CardId, ci: number, i: number, col: CardId[]) => {
    const hidden = lay.hidden.includes(id);
    if (hidden && !edit) return null;
    const fi = flat(lay.cols).indexOf(id);
    const last = n === 3 ? i === col.length - 1 : fi === flat(lay.cols).length - 1;
    const first = n === 3 ? i === 0 : fi === 0;
    const btn = (I: React.ElementType, label: string, onClick: () => void, disabled?: boolean) => (
      <Button size="icon" variant="ghost" className="size-8" onClick={onClick} disabled={disabled} aria-label={`${NAMES[id]}${label}`} title={label}><I /></Button>
    );
    return (
      <div key={id}>
        {edit && (
          <div className={cn("flex h-14 items-center gap-1 rounded-xl border bg-card px-3 shadow-xs", hidden && "border-dashed bg-transparent shadow-none")}>
            <span className={cn("mr-auto font-semibold", hidden && "text-muted-foreground")}>{NAMES[id]}{hidden && <span className="ml-2 text-sm font-normal">已藏起來</span>}</span>
            {n === 3 && btn(ArrowLeft, "往左一欄", () => move(id, "left"), ci === 0)}
            {btn(ArrowUp, "往上", () => move(id, "up"), first)}
            {btn(ArrowDown, "往下", () => move(id, "down"), last)}
            {n === 3 && btn(ArrowRight, "往右一欄", () => move(id, "right"), ci === 2)}
            {btn(hidden ? Eye : EyeOff, hidden ? "顯示" : "藏起來", () => toggleHide(id))}
          </div>
        )}
        {!edit && body[id]}
      </div>
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
        {edit && <p className="mb-4 text-sm text-muted-foreground">用箭頭移動卡片{n === 3 ? "（左右換欄、上下換順序）" : "；在大螢幕上可以左右換欄"}，眼睛圖示可以藏起不需要的卡片。排好的位置每台裝置都一樣。</p>}
        <div className={cn("grid items-start gap-4", n === 3 ? "grid-cols-3" : n === 2 ? "grid-cols-2" : "grid-cols-1")}>
          {cols.map((col, ci) => (
            <div key={ci} className={cn("flex min-w-0 flex-col", edit ? "gap-2" : "gap-4")}>{col.map((id, i) => card(id, ci, i, col))}</div>
          ))}
        </div>
      </div>
    </>
  );
}

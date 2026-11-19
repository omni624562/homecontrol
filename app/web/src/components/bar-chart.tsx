import { useState } from "react";
import { fmt } from "@/lib/format";
import { cn } from "@/lib/utils";

export interface Bar {
  v: number;
  label: string;
  tip: string;
  now?: boolean;
}

// 單一數列的長條圖：平均線（不算還沒過完的最後一根）、滑過或用方向鍵看每一根的讀數
export function BarChart({ items, unit, name, height = "h-44" }: { items: Bar[]; unit: string; name: string; height?: string }) {
  const [active, setActive] = useState<number | null>(null);
  const max = Math.max(0.001, ...items.map((x) => x.v));
  const done = items.slice(0, -1);
  const avg = done.length ? done.reduce((a, x) => a + x.v, 0) / done.length : 0;
  const readout = active != null ? items[active].tip : `平均 ${fmt(avg, 1)} ${unit}・滑過長條看每一根`;
  return (
    <div className="space-y-2">
      <div className="min-h-6 text-sm tabular-nums text-muted-foreground" aria-live="polite">
        <span className={cn(active != null && "font-medium text-foreground")}>{readout}</span>
      </div>
      <div
        role="group"
        tabIndex={0}
        aria-label={`${name}，共 ${items.length} 根，用左右方向鍵逐一查看`}
        onKeyDown={(e) => {
          if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
          e.preventDefault();
          setActive((i) => {
            const n = i == null ? items.length - 1 : i + (e.key === "ArrowRight" ? 1 : -1);
            return Math.max(0, Math.min(items.length - 1, n));
          });
        }}
        onBlur={() => setActive(null)}
        onMouseLeave={() => setActive(null)}
        className="rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <div className={cn("relative flex items-end border-b border-border", height)}>
          {items.map((x, i) => (
            <div key={i} className="flex h-full flex-1 cursor-default items-end justify-center px-[1px]" onMouseEnter={() => setActive(i)} onTouchStart={() => setActive(i)}>
              <i
                className={cn(
                  "block w-full max-w-6 rounded-t-[4px] bg-primary/80 transition-colors",
                  x.now && "bg-primary/35",
                  active === i && "bg-primary",
                )}
                style={{ height: `${x.v > 0 ? Math.max(1.5, (x.v / max) * 100) : 0}%` }}
              />
            </div>
          ))}
          {avg > 0 && (
            <div className="pointer-events-none absolute inset-x-0 border-t border-dashed border-foreground/40" style={{ bottom: `${(avg / max) * 100}%` }}>
              <span className="absolute -top-5 right-0 rounded bg-background/90 px-1 text-xs text-muted-foreground">平均 {fmt(avg, 1)}</span>
            </div>
          )}
        </div>
        <div className="mt-1 flex text-[11px] text-muted-foreground">
          {items.map((x, i) => <span key={i} className="flex-1 text-center whitespace-nowrap">{x.label}</span>)}
        </div>
      </div>
    </div>
  );
}

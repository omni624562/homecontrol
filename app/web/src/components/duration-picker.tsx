import { Minus, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";

// 選時間長度：時、分、秒各一格，可以直接打數字，也可以按 −／＋
export function DurationPicker({ value, onChange, max = 86400 }: { value: number; onChange: (sec: number) => void; max?: number }) {
  const h = Math.floor(value / 3600);
  const m = Math.floor((value % 3600) / 60);
  const s = value % 60;
  const set = (hh: number, mm: number, ss: number) => onChange(Math.max(0, Math.min(max, hh * 3600 + mm * 60 + ss)));
  const parts: [string, number, number, (v: number) => void][] = [
    ["時", h, 23, (v) => set(v, m, s)],
    ["分", m, 59, (v) => set(h, v, s)],
    ["秒", s, 59, (v) => set(h, m, v)],
  ];
  return (
    <div className="grid grid-cols-3 gap-2">
      {parts.map(([label, v, top, put]) => (
        <div key={label} className="flex flex-col items-center gap-1 rounded-xl border bg-background p-2">
          <span className="text-xs text-muted-foreground">{label}</span>
          <div className="flex items-center gap-1">
            <Button type="button" variant="ghost" size="icon" className="size-8" aria-label={`${label}減一`} onClick={() => put(v > 0 ? v - 1 : top)}>
              <Minus />
            </Button>
            <input
              inputMode="numeric"
              aria-label={label}
              value={String(v).padStart(2, "0")}
              onFocus={(e) => e.target.select()}
              onChange={(e) => {
                const n = Number(e.target.value.replace(/\D/g, "").slice(-2));
                put(Math.min(top, Number.isFinite(n) ? n : 0));
              }}
              className="w-9 rounded-md bg-transparent text-center text-xl font-semibold tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            <Button type="button" variant="ghost" size="icon" className="size-8" aria-label={`${label}加一`} onClick={() => put(v < top ? v + 1 : 0)}>
              <Plus />
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
}

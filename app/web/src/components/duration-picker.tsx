import { Minus, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";

// 一格數字：可以直接打，也可以按 −／＋（到頭會繞回來）
export function NumField({ label, value, top, onChange }: { label: string; value: number; top: number; onChange: (v: number) => void }) {
  return (
    <div className="flex flex-col items-center gap-1 rounded-xl border bg-background p-2">
      <span className="text-xs text-muted-foreground">{label}</span>
      <div className="flex items-center gap-1">
        <Button type="button" variant="ghost" size="icon" className="size-8" aria-label={`${label}減一`} onClick={() => onChange(value > 0 ? value - 1 : top)}>
          <Minus />
        </Button>
        <input
          inputMode="numeric"
          aria-label={label}
          value={String(value).padStart(2, "0")}
          onFocus={(e) => e.target.select()}
          onChange={(e) => {
            const n = Number(e.target.value.replace(/\D/g, "").slice(-2));
            onChange(Math.min(top, Number.isFinite(n) ? n : 0));
          }}
          className="w-9 rounded-md bg-transparent text-center text-xl font-semibold tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        <Button type="button" variant="ghost" size="icon" className="size-8" aria-label={`${label}加一`} onClick={() => onChange(value < top ? value + 1 : 0)}>
          <Plus />
        </Button>
      </div>
    </div>
  );
}

// 選時間長度：時、分、秒
export function DurationPicker({ value, onChange, max = 86400 }: { value: number; onChange: (sec: number) => void; max?: number }) {
  const h = Math.floor(value / 3600);
  const m = Math.floor((value % 3600) / 60);
  const s = value % 60;
  const set = (hh: number, mm: number, ss: number) => onChange(Math.max(0, Math.min(max, hh * 3600 + mm * 60 + ss)));
  return (
    <div className="grid grid-cols-3 gap-2">
      <NumField label="時" value={h} top={23} onChange={(v) => set(v, m, s)} />
      <NumField label="分" value={m} top={59} onChange={(v) => set(h, v, s)} />
      <NumField label="秒" value={s} top={59} onChange={(v) => set(h, m, v)} />
    </div>
  );
}

// 選幾點：「HH:MM:SS」或只到分鐘的「HH:MM」
export function ClockPicker({ value, onChange, seconds = true }: { value: string; onChange: (t: string) => void; seconds?: boolean }) {
  const [h = 0, m = 0, s = 0] = String(value || "00:00").split(":").map(Number);
  const p = (n: number) => String(n).padStart(2, "0");
  const put = (hh: number, mm: number, ss: number) => onChange(seconds ? `${p(hh)}:${p(mm)}:${p(ss)}` : `${p(hh)}:${p(mm)}`);
  return (
    <div className="grid grid-cols-3 gap-2">
      <NumField label="時" value={h} top={23} onChange={(v) => put(v, m, s)} />
      <NumField label="分" value={m} top={59} onChange={(v) => put(h, v, s)} />
      {seconds ? (
        <NumField label="秒" value={s} top={59} onChange={(v) => put(h, m, v)} />
      ) : (
        // 只到分鐘：秒那格留著（大小一致），說明為什麼不能設
        <div className="flex flex-col items-center justify-center gap-1 rounded-xl border border-dashed p-2 text-center text-muted-foreground" aria-hidden>
          <span className="text-xs">秒</span>
          <span className="text-sm leading-tight">只到分鐘</span>
        </div>
      )}
    </div>
  );
}

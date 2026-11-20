import { useEffect, useState, type ReactNode } from "react";
import { Minus, Plus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { useHub } from "@/lib/hub";
import { cn } from "@/lib/utils";

// 左右兩欄裡的一個區塊
export function Section({ title, children, note }: { title: string; children: ReactNode; note?: ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="text-sm font-medium text-muted-foreground">{title}</h3>
      {children}
      {note && <p className="text-xs leading-relaxed text-muted-foreground">{note}</p>}
    </section>
  );
}

export function Group({ children }: { children: ReactNode }) {
  return <div className="divide-y overflow-hidden rounded-xl border bg-muted/30">{children}</div>;
}

export function Row({ label, hint, children, warn, htmlFor }: { label: ReactNode; hint?: ReactNode; children?: ReactNode; warn?: boolean; htmlFor?: string }) {
  return (
    <div className="flex min-h-14 items-center gap-3 px-4 py-2.5">
      <div className="min-w-0 flex-1">
        <label htmlFor={htmlFor} className="block text-[15px] font-medium leading-snug">{label}</label>
        {hint && <div className={cn("text-xs leading-relaxed text-muted-foreground", warn && "text-orange-600 dark:text-orange-400")}>{hint}</div>}
      </div>
      {children}
    </div>
  );
}

export const Value = ({ children, tone }: { children: ReactNode; tone?: "warn" | "ok" | "muted" }) => (
  <span className={cn("text-right text-sm tabular-nums", tone === "warn" && "text-orange-600 dark:text-orange-400", tone === "ok" && "text-emerald-600 dark:text-emerald-400", tone === "muted" && "text-muted-foreground")}>
    {children}
  </span>
);


// 數字設定：−／＋ 或直接打，離開欄位或按 Enter 就存到 /api/settings
export function SettingNumber({ k, step, unit, label, min = 0 }: { k: string; step: number; unit: string; label: string; min?: number }) {
  const { state } = useHub();
  const server = Number(state?.settings[k] ?? 0);
  const [v, setV] = useState(String(server));
  useEffect(() => setV(String(server)), [server]);
  const save = async (n: number) => {
    if (!Number.isFinite(n) || n < min) return setV(String(server));
    const val = Math.round(n * 10) / 10;
    setV(String(val));
    try {
      await api("PUT", "/api/settings", { [k]: val });
      toast.success(`${label}：${val} ${unit}`);
    } catch (err) {
      toast.error("沒有成功", { description: (err as Error).message });
      setV(String(server));
    }
  };
  return (
    <div className="flex shrink-0 items-center gap-1">
      <Button variant="outline" size="icon" className="size-10" aria-label={`${label}減少 ${step}`} onClick={() => save(Number(v) - step)}><Minus /></Button>
      <input
        type="number"
        inputMode="decimal"
        aria-label={`${label}（${unit}）`}
        value={v}
        step={step}
        onChange={(e) => setV(e.target.value)}
        onBlur={() => Number(v) !== server && save(Number(v))}
        onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
        className="h-10 w-20 rounded-md border bg-background text-center text-base tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
      <Button variant="outline" size="icon" className="size-10" aria-label={`${label}增加 ${step}`} onClick={() => save(Number(v) + step)}><Plus /></Button>
      <span className="ml-1 w-8 text-sm text-muted-foreground">{unit}</span>
    </div>
  );
}

import { useMemo, type ReactNode } from "react";
import { Check, Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import { pad2 } from "@/lib/format";
import { useHub } from "@/lib/hub";
import type { KasaRule, Plug, TimeMode } from "@/lib/types";
import { cn } from "@/lib/utils";

// 星期：0 = 星期一（跟伺服器一樣）
export const DAYS = ["一", "二", "三", "四", "五", "六", "日"];

export function daysText(days: number[]) {
  const sorted = [...days].sort();
  const key = sorted.join();
  if (key === "0,1,2,3,4,5,6") return "每天";
  if (key === "0,1,2,3,4") return "平日";
  if (key === "5,6") return "週末";
  if (!days.length) return "沒有選日子";
  return "星期" + sorted.map((d) => DAYS[d]).join("、");
}

// 日出日落：opt 1 = 日出、2 = 日落；val = 提早（負）／延後（正）幾分鐘
export const sunLabel = (opt: number, val: number) => `${opt === 1 ? "日出" : "日落"}${val ? `${val < 0 ? "前" : "後"} ${Math.abs(val)} 分` : ""}`;
export const SunIcon = ({ opt, className }: { opt: number; className?: string }) => (opt === 1 ? <Sun className={className} /> : <Moon className={className} />);
export const minText = (m: number) => `${pad2(Math.floor(m / 60))}:${pad2(m % 60)}`;
export const hmsSec = (t: string) => {
  const [h = 0, m = 0, s = 0] = t.split(":").map(Number);
  return h * 3600 + m * 60 + s;
};
// 「07:00:00」→「07:00」，有秒才顯示秒
export const showT = (t?: string | null) => (t && t.endsWith(":00") && t.length === 8 ? t.slice(0, 5) : t || "");

// 插座的 wday（星期日開始）↔ 我們的星期（0 = 星期一）
export const kasaDays = (wday: number[]) => wday.map((v, i) => (v ? (i + 6) % 7 : -1)).filter((d) => d >= 0).sort();
export const toKasaWday = (days: number[]) => [0, 1, 2, 3, 4, 5, 6].map((i) => (days.includes((i + 6) % 7) ? 1 : 0));

// 插座規則今天是第幾分鐘（日出日落的用樹莓派算的今天時間）
export function useRuleMin() {
  const { state } = useHub();
  return (r: Pick<KasaRule, "opt" | "val"> & { smin?: number }) => {
    if (!r.opt) return r.val;
    const base = r.opt === 1 ? state?.sun?.sunrise : state?.sun?.sunset;
    return base != null ? base + r.val : r.smin || 0;
  };
}

// 分段選擇（一排按鈕選一個）
export function Segmented<T extends string | number>({ value, options, onChange, label }: { value: T; options: [T, ReactNode][]; onChange: (v: T) => void; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="grid auto-cols-fr grid-flow-col gap-1 rounded-xl bg-muted p-1">
      {options.map(([k, text]) => (
        <button
          key={String(k)}
          type="button"
          role="radio"
          aria-checked={value === k}
          onClick={() => onChange(k)}
          className={cn(
            "h-10 rounded-lg px-2 text-[15px] font-medium text-muted-foreground transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            "hover:text-foreground active:scale-[.97]",
            value === k && "bg-background text-foreground shadow-sm",
          )}
        >
          {text}
        </button>
      ))}
    </div>
  );
}

// 可以選取的小圓角按鈕
export function ChoiceChip({ selected, onClick, children, disabled, title }: { selected?: boolean; onClick: () => void; children: ReactNode; disabled?: boolean; title?: string }) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      disabled={disabled}
      title={title}
      onClick={onClick}
      className={cn(
        "inline-flex h-10 items-center gap-1.5 rounded-full border bg-background px-3.5 text-[15px] transition-all",
        "hover:bg-muted active:scale-[.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-45",
        selected && "border-primary bg-primary/10 font-medium text-primary hover:bg-primary/15",
      )}
    >
      {selected && <Check className="size-4" />}
      {children}
    </button>
  );
}

// 星期一到日，加上每天／平日／週末
export function DayPicker({ days, onChange, presets = true }: { days: number[]; onChange: (d: number[]) => void; presets?: boolean }) {
  const toggle = (i: number) => onChange(days.includes(i) ? days.filter((x) => x !== i) : [...days, i].sort());
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-7 gap-1.5" role="group" aria-label="星期">
        {DAYS.map((d, i) => (
          <button
            key={i}
            type="button"
            aria-pressed={days.includes(i)}
            aria-label={`星期${d}`}
            onClick={() => toggle(i)}
            className={cn(
              "h-11 rounded-xl border bg-background text-[15px] font-medium transition-all hover:bg-muted active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              days.includes(i) && "border-primary bg-primary text-primary-foreground hover:bg-primary/90",
            )}
          >
            {d}
          </button>
        ))}
      </div>
      {presets && (
        <div className="flex gap-2">
          {([["每天", [0, 1, 2, 3, 4, 5, 6]], ["平日", [0, 1, 2, 3, 4]], ["週末", [5, 6]]] as [string, number[]][]).map(([l, v]) => (
            <Button key={l} type="button" variant="outline" size="sm" className="rounded-full" onClick={() => onChange(v)}>
              {l}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}

// 固定時間／日出／日落
export function TimeModePicker({ value, onChange }: { value: TimeMode; onChange: (v: TimeMode) => void }) {
  return (
    <Segmented
      label="時間的算法"
      value={value}
      onChange={onChange}
      options={[
        ["clock", "固定時間"],
        ["sunrise", <span className="inline-flex items-center gap-1.5"><Sun className="size-4" />日出</span>],
        ["sunset", <span className="inline-flex items-center gap-1.5"><Moon className="size-4" />日落</span>],
      ]}
    />
  );
}

// 日出日落：提早／延後幾分鐘，顯示今天大約幾點
export function SunOffset({ mode, offset, onChange }: { mode: TimeMode; offset: number; onChange: (v: number) => void }) {
  const { state } = useHub();
  const opt = mode === "sunrise" ? 1 : 2;
  const base = opt === 1 ? state?.sun?.sunrise : state?.sun?.sunset;
  const clamp = (v: number) => Math.max(-180, Math.min(180, v));
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Button type="button" variant="outline" className="h-12 w-14 text-base" aria-label="提早 5 分鐘" onClick={() => onChange(clamp(offset - 5))}>−5</Button>
        <div className="flex h-12 flex-1 flex-col items-center justify-center rounded-xl border bg-background" aria-live="polite">
          <span className="inline-flex items-center gap-1.5 font-semibold"><SunIcon opt={opt} className="size-4 text-amber-600" />{sunLabel(opt, offset)}</span>
          <span className="text-xs text-muted-foreground">{base != null ? `今天約 ${minText(Math.min(1439, Math.max(0, base + offset)))}` : "還不知道家裡的位置，算不出今天幾點"}</span>
        </div>
        <Button type="button" variant="outline" className="h-12 w-14 text-base" aria-label="延後 5 分鐘" onClick={() => onChange(clamp(offset + 5))}>+5</Button>
      </div>
      <div className="flex flex-wrap gap-2">
        {[-30, -15, 0, 15, 30].map((m) => (
          <ChoiceChip key={m} selected={offset === m} onClick={() => onChange(m)}>
            {m === 0 ? "準時" : `${m < 0 ? "提早" : "延後"} ${Math.abs(m)} 分`}
          </ChoiceChip>
        ))}
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">每天跟著日出日落自動調整；寫進插座的備援也用插座內建的日出日落，離線好幾天也準。</p>
    </div>
  );
}

// 依房間分組的插座
export function usePlugGroups() {
  const { state } = useHub();
  return useMemo(() => {
    if (!state) return [];
    const ids = new Set(state.rooms.map((r) => r.id));
    const out: { id: string; name: string; plugs: Plug[] }[] = [];
    const loose = state.plugs.filter((p) => !p.room || !ids.has(p.room));
    if (loose.length) out.push({ id: "", name: "還沒分房間", plugs: loose });
    for (const r of state.rooms) {
      const list = state.plugs.filter((p) => p.room === r.id);
      if (list.length) out.push({ id: r.id, name: r.name, plugs: list });
    }
    return out;
  }, [state]);
}

// 選插座：依房間分組，每組可以全選／取消
export function PlugPicker({
  selected, onChange, disabled, hide, roomToggle = true,
}: {
  selected: string[];
  onChange: (ids: string[]) => void;
  disabled?: (p: Plug) => string | false;
  hide?: (p: Plug) => boolean;
  roomToggle?: boolean;
}) {
  const groups = usePlugGroups();
  const shown = groups.map((g) => ({ ...g, plugs: g.plugs.filter((p) => !hide?.(p)) })).filter((g) => g.plugs.length);
  if (!shown.length) return <p className="text-sm text-muted-foreground">沒有可以用的插座。</p>;
  return (
    <div className="space-y-3">
      {shown.map((g) => {
        const ids = g.plugs.filter((p) => !disabled?.(p)).map((p) => p.id);
        const all = ids.length > 0 && ids.every((id) => selected.includes(id));
        return (
          <div key={g.id} className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">{g.name}</span>
              {roomToggle && ids.length > 0 && (
                <Button
                  type="button"
                  variant="link"
                  size="sm"
                  className="h-auto px-0"
                  onClick={() => onChange(all ? selected.filter((id) => !ids.includes(id)) : [...new Set([...selected, ...ids])])}
                >
                  {all ? "取消全選" : "全選"}
                </Button>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              {g.plugs.map((p) => {
                const why = disabled?.(p);
                const sel = selected.includes(p.id) && !why;
                return (
                  <ChoiceChip
                    key={p.id}
                    selected={sel}
                    disabled={!!why}
                    title={why || undefined}
                    onClick={() => onChange(sel ? selected.filter((x) => x !== p.id) : [...selected, p.id])}
                  >
                    {p.name}
                  </ChoiceChip>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// 狀態小標籤
export function Tag({ children, tone, icon: I }: { children: ReactNode; tone?: "warn" | "ok" | "home"; icon?: React.ElementType }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-xs leading-5 text-muted-foreground",
        tone === "warn" && "bg-orange-100 text-orange-800 dark:bg-orange-500/15 dark:text-orange-300",
        tone === "ok" && "bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300",
        tone === "home" && "bg-primary/10 text-primary",
      )}
    >
      {I && <I className="size-3.5" />}
      {children}
    </span>
  );
}

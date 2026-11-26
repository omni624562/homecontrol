import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Row } from "@/components/settings-bits";
import { api } from "@/lib/api";
import { fmt } from "@/lib/format";
import type { Plug, Usage } from "@/lib/types";
import { cn } from "@/lib/utils";

const WATT_PRESETS: [string, number][] = [["燈", 10], ["風扇", 40], ["電腦", 60], ["電視", 100], ["電暖器", 1000]];

// 照使用習慣算：常見電器（瓦數、運作比例要跟後端 store.USAGE_KINDS 一致）
const KINDS: { key: string; label: string; watts: number; duty: number }[] = [
  { key: "air-fryer", label: "氣炸鍋", watts: 1500, duty: 0.7 },
  { key: "rice", label: "電鍋", watts: 800, duty: 0.7 },
  { key: "kettle", label: "熱水壺", watts: 1500, duty: 1 },
  { key: "microwave", label: "微波爐", watts: 1100, duty: 1 },
];
const kindOf = (k: string) => KINDS.find((x) => x.key === k);
const useKwh = (u: Usage) => (u.watts / 1000) * (u.minutes / 60) * (kindOf(u.kind)?.duty ?? 1);

function Pick({ label, value, opts, onChange, custom }: { label: string; value: number; opts: [number, string][]; onChange: (v: number) => void; custom?: { max: number; unit: string } }) {
  const isOwn = !opts.some(([v]) => v === value);
  const [own, setOwn] = useState(isOwn ? String(value) : "");
  const chip = (on: boolean) => cn("rounded-md border px-2.5 py-1 text-sm transition-colors hover:bg-accent", on && "border-primary bg-primary/10 font-medium text-primary");
  return (
    <div className="space-y-1">
      <div className="text-xs font-bold text-muted-foreground">{label}</div>
      <div className="flex flex-wrap items-center gap-1.5">
        {opts.map(([v, l]) => (
          <button key={v} type="button" aria-pressed={v === value} onClick={() => onChange(v)} className={chip(v === value)}>{l}</button>
        ))}
        {custom && (
          <label className={cn("flex items-center gap-1 rounded-md border px-2 py-0.5 text-sm", isOwn && "border-primary bg-primary/10 text-primary")}>
            自訂
            <Input type="number" inputMode="numeric" min={1} max={custom.max} value={own} aria-label={`自訂${label}`}
              onFocus={() => Number(own) > 0 && onChange(Number(own))}
              onChange={(e) => { setOwn(e.target.value); const n = Math.round(Number(e.target.value)); if (n >= 1 && n <= custom.max) onChange(n); }}
              className="h-7 w-16 bg-background px-2" />
            {custom.unit}
          </label>
        )}
      </div>
    </div>
  );
}

// 插座常開、電器自己運作的（氣炸鍋、電鍋…）：填習慣，App 換算平均瓦數
function UsageForm({ p, price, compact, onCancel, onSave }: { p: Plug; price?: number; compact?: boolean; onCancel: () => void; onSave: (u: Usage) => Promise<boolean> }) {
  const [u, setU] = useState<Usage>(p.usage || { kind: "air-fryer", watts: 1500, days: 7, times: 1, minutes: 30 });
  const [own, setOwn] = useState(String(p.usage?.kind === "custom" ? p.usage.watts : ""));
  const set = (patch: Partial<Usage>) => setU((x) => ({ ...x, ...patch }));
  const once = useKwh(u);
  const month = (once * u.times * u.days * 30) / 7;
  return (
    <form
      className={compact ? "col-span-full space-y-2.5 rounded-lg bg-muted/50 px-3 py-3" : "space-y-2.5 px-4 py-3"}
      onSubmit={async (e) => {
        e.preventDefault();
        if (!(u.watts >= 1 && u.watts <= 5000)) return toast.error("電器瓦數請填 1～5000 W");
        if (await onSave(u)) onCancel();
      }}
    >
      <div className="space-y-1">
        <div className="text-xs font-bold text-muted-foreground">什麼電器</div>
        <div className="flex flex-wrap items-center gap-1.5">
          {KINDS.map((k) => (
            <button key={k.key} type="button" aria-pressed={u.kind === k.key} onClick={() => set({ kind: k.key, watts: k.watts })}
              className={cn("rounded-md border px-2.5 py-1 text-sm transition-colors hover:bg-accent", u.kind === k.key && "border-primary bg-primary/10 font-medium text-primary")}>{k.label} {k.watts} W</button>
          ))}
          <label className={cn("flex items-center gap-1 rounded-md border px-2 py-0.5 text-sm", u.kind === "custom" && "border-primary bg-primary/10 text-primary")}>
            自訂
            <Input type="number" inputMode="decimal" min={1} max={5000} value={own} placeholder="瓦數" aria-label="自訂電器瓦數"
              onFocus={() => set({ kind: "custom", watts: Number(own) || 0 })}
              onChange={(e) => { setOwn(e.target.value); set({ kind: "custom", watts: Number(e.target.value) || 0 }); }}
              className="h-7 w-20 bg-background px-2" />
            W
          </label>
        </div>
      </div>
      <Pick label="一週用幾天" value={u.days} opts={[[7, "每天"], [5, "5 天"], [3, "3 天"], [1, "1 天"]]} onChange={(v) => set({ days: v })} />
      <Pick label="一天用幾次" value={u.times} opts={[[1, "1 次"], [2, "2 次"], [3, "3 次"], [5, "5 次"]]} onChange={(v) => set({ times: v })} custom={{ max: 20, unit: "次" }} />
      <Pick label="一次多久" value={u.minutes} opts={[[3, "3 分"], [5, "5 分"], [10, "10 分"], [20, "20 分"], [30, "30 分"], [45, "45 分"], [60, "1 小時"]]} onChange={(v) => set({ minutes: v })} custom={{ max: 240, unit: "分" }} />
      {u.watts > 0 && (
        <div className="rounded-lg bg-emerald-500/10 px-3 py-2 text-sm">
          用一次大約 <b className="text-emerald-700 dark:text-emerald-400">{fmt(once, once < 0.1 ? 3 : 2)} 度</b>、一個月 <b className="text-emerald-700 dark:text-emerald-400">{fmt(month, month < 10 ? 1 : 0)} 度</b>
          {price ? <>、約 <b className="text-emerald-700 dark:text-emerald-400">${fmt(Math.round(month * price))}</b></> : null}
          {(kindOf(u.kind)?.duty ?? 1) < 1 && <div className="text-xs text-muted-foreground">到溫度後會斷斷續續加熱，已經打過折</div>}
        </div>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>取消</Button>
        <Button type="submit" size="sm">儲存</Button>
      </div>
    </form>
  );
}

// 接的電器（瓦數）：常見電器、不估算、自訂；改了馬上存
export function WattsRows({ p, hint = "估算用電", onSaved, compact, price }: { p: Plug; hint?: string; onSaved?: () => void; compact?: boolean; price?: number }) {
  const [custom, setCustom] = useState<string | null>(null);
  const [habit, setHabit] = useState(false);
  const preset = WATT_PRESETS.find(([, w]) => w === p.watts);
  const value = p.usage ? "usage" : !p.watts ? "none" : preset ? String(p.watts) : "custom";
  const save = async (watts: number | null, ok?: string, usage?: Usage) => {
    try {
      await api("PATCH", `/api/plugs/${encodeURIComponent(p.id)}`, usage ? { usage } : { watts });
      if (ok) toast.success(ok);
      onSaved?.();
      return true;
    } catch (err) {
      toast.error("沒有成功", { description: (err as Error).message });
      return false;
    }
  };
  const select = (
    <Select
      value={habit ? "usage" : custom !== null ? "custom" : value}
      onValueChange={(v) => {
        if (v === "usage") { setCustom(null); return setHabit(true); }
        setHabit(false);
        if (v === "custom") return setCustom(p.watts ? String(p.watts) : "");
        setCustom(null);
        save(v === "none" ? null : Number(v));
      }}
    >
      <SelectTrigger className={compact ? "w-full bg-background" : "w-40 bg-background"} aria-label="接的電器"><SelectValue /></SelectTrigger>
      <SelectContent>
        <SelectItem value="none">不估算</SelectItem>
        {WATT_PRESETS.map(([l, w]) => <SelectItem key={w} value={String(w)}>{l} {w} W</SelectItem>)}
        <SelectItem value="custom">{value === "custom" ? `自訂 ${fmt(p.watts)} W` : "自訂…"}</SelectItem>
        <SelectSeparator />
        <SelectItem value="usage">{p.usage ? `照使用習慣・${kindOf(p.usage.kind)?.label || `${fmt(p.usage.watts)} W 電器`}` : "照使用習慣算…（插座常開的電器）"}</SelectItem>
      </SelectContent>
    </Select>
  );
  return (
    <>
      {compact ? (
        <div className="space-y-1">
          <div className="text-sm font-medium">接的電器<span className="ml-1.5 text-xs font-normal text-muted-foreground">{hint}</span></div>
          {select}
        </div>
      ) : (
        <Row label="接的電器" hint={hint}>{select}</Row>
      )}
      {value === "usage" && !habit && (
        <button type="button" onClick={() => setHabit(true)} className={cn("text-left text-xs text-muted-foreground hover:underline", compact ? "col-span-full" : "px-4 pb-3")}>
          {p.usage!.days === 7 ? "每天" : `一週 ${p.usage!.days} 天`}・一天 {p.usage!.times} 次・一次 {p.usage!.minutes} 分（平均 {fmt(p.watts)} W）・點一下修改
        </button>
      )}
      {habit && <UsageForm p={p} price={price} compact={compact} onCancel={() => setHabit(false)} onSave={(u) => save(null, "使用習慣存好了", u)} />}
      {custom !== null && (
        <form
          className={compact ? "col-span-full flex flex-wrap items-center gap-2 rounded-lg bg-muted/50 px-3 py-2" : "flex flex-wrap items-center gap-2 px-4 py-3"}
          onSubmit={async (e) => {
            e.preventDefault();
            const w = Number(custom);
            if (!(w > 0 && w <= 5000)) return toast.error("請輸入 1～5000 W");
            if (await save(w, `已設定 ${fmt(w)} W`)) setCustom(null);
          }}
        >
          <span className="text-sm text-muted-foreground">大約</span>
          <Input autoFocus type="number" inputMode="decimal" min={1} max={5000} value={custom} onChange={(e) => setCustom(e.target.value)} className="h-10 w-28 bg-background" aria-label="瓦數" />
          <span className="text-sm text-muted-foreground">W（看電器背面的標示）</span>
          <Button type="submit" size="sm" className="ml-auto">儲存</Button>
        </form>
      )}
    </>
  );
}

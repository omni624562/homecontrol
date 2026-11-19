import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Row } from "@/components/settings-bits";
import { api } from "@/lib/api";
import { fmt } from "@/lib/format";
import type { Plug } from "@/lib/types";

const WATT_PRESETS: [string, number][] = [["燈", 10], ["風扇", 40], ["電腦", 60], ["電視", 100], ["電暖器", 1000]];

// 接的電器（瓦數）：常見電器、不估算、自訂；改了馬上存
export function WattsRows({ p, hint = "估算用電", onSaved, compact }: { p: Plug; hint?: string; onSaved?: () => void; compact?: boolean }) {
  const [custom, setCustom] = useState<string | null>(null);
  const preset = WATT_PRESETS.find(([, w]) => w === p.watts);
  const value = !p.watts ? "none" : preset ? String(p.watts) : "custom";
  const save = async (watts: number | null, ok?: string) => {
    try {
      await api("PATCH", `/api/plugs/${encodeURIComponent(p.id)}`, { watts });
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
      value={custom !== null ? "custom" : value}
      onValueChange={(v) => {
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

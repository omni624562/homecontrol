import { useEffect, useState } from "react";
import { Home, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { ClockPicker } from "@/components/duration-picker";
import { Sheet } from "@/components/responsive-sheet";
import { PlugPicker } from "@/components/schedule-bits";
import { Section } from "@/components/settings-bits";
import { api } from "@/lib/api";
import { useHub } from "@/lib/hub";
import type { Plug } from "@/lib/types";

const usable = (p: Plug) => !p.keep_on && !p.max_on_s && p.protect !== "lock";

// 離家模式：不在家時讓燈隨機開關（寫進插座，由插座自己執行）
export function AwaySheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { state } = useHub();
  const [d, setD] = useState<{ enabled: boolean; start: string; end: string; plugs: string[]; auto_on: boolean; auto_h: number; auto_off: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  useEffect(() => {
    if (!open || !state) return setD(null);
    const a = state.settings.away;
    const lights = state.plugs.filter((p) => /燈|lamp|light/i.test(p.name) && usable(p)).map((p) => p.id);
    setErr("");
    setD({ enabled: !!a?.enabled, start: a?.start || "18:00", end: a?.end || "23:00", plugs: a?.plugs?.length ? [...a.plugs] : lights,
      auto_on: !!a?.auto_on, auto_h: a?.auto_h || 4, auto_off: a?.auto_off !== false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const up = (x: Partial<NonNullable<typeof d>>) => {
    setErr("");
    setD((v) => (v ? { ...v, ...x } : v));
  };
  const save = async () => {
    if (!d) return;
    if ((d.enabled || d.auto_on) && !d.plugs.length) return setErr("請至少選一個插座");
    setBusy(true);
    try {
      await api("PUT", "/api/away", d);
      toast.success(d.enabled ? "離家模式已啟用" : "已儲存");
      onClose();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet open={open && !!d} onOpenChange={(v) => !v && onClose()} title="離家模式"
      description="不在家時讓燈隨機開關；由插座自己執行"
      icon={<Home />}
      wide
      aside={
        d ? (
          <label className="flex items-center gap-2 text-sm font-medium">
            {d.enabled ? "啟用中" : "沒有啟用"}
            <Switch size="lg" checked={d.enabled} onCheckedChange={(v) => up({ enabled: v })} aria-label="啟用離家模式" />
          </label>
        ) : undefined
      }
    >
      {d && (
        <div className="space-y-5">
          <Section title="每天這段時間">
            <div className="grid gap-3">
              <div className="space-y-1.5"><div className="text-sm">開始</div><ClockPicker seconds={false} value={d.start} onChange={(t) => up({ start: t })} /></div>
              <div className="space-y-1.5"><div className="text-sm">結束</div><ClockPicker seconds={false} value={d.end} onChange={(t) => up({ end: t })} /></div>
            </div>
          </Section>
          <Section title="自動開關・要先在「網路裝置 → 誰在家」設好家人的手機">
            <div className="divide-y rounded-xl border">
              <div className="flex flex-wrap items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1 basis-48">
                  <div className="font-medium">大家出門夠久就自動打開</div>
                  <div className="text-sm text-muted-foreground">出遠門忘了開也沒關係</div>
                </div>
                {d.auto_on && (
                  <Select value={String(d.auto_h)} onValueChange={(v) => up({ auto_h: Number(v) })}>
                    <SelectTrigger className="w-32 bg-background" aria-label="出門多久後自動打開"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {(([2, 4, 8, 12, 24] as number[]).includes(d.auto_h) ? [2, 4, 8, 12, 24] : [d.auto_h, 2, 4, 8, 12, 24]).map((h) => <SelectItem key={h} value={String(h)}>出門 {h} 小時後</SelectItem>)}
                    </SelectContent>
                  </Select>
                )}
                <Switch checked={d.auto_on} onCheckedChange={(v) => up({ auto_on: v })} aria-label="大家出門夠久就自動打開離家模式" />
              </div>
              <div className="flex items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="font-medium">有人回家就自動關閉</div>
                  <div className="text-sm text-muted-foreground">回到家燈就不會再自己亂開關</div>
                </div>
                <Switch checked={d.auto_off} onCheckedChange={(v) => up({ auto_off: v })} aria-label="有人回家就自動關閉離家模式" />
              </div>
            </div>
          </Section>
          <Section title="要隨機開關的插座・常開、鎖定、有最長開啟時間的不會出現">
            <PlugPicker selected={d.plugs} onChange={(ids) => up({ plugs: ids })} hide={(p) => !usable(p)} />
          </Section>
          <div className="sticky -bottom-6 -mx-6 -mb-6 flex flex-wrap items-center gap-2 border-t bg-background/95 px-6 py-3 backdrop-blur max-md:-mx-4 max-md:px-4">
            {err && <p role="alert" className="w-full text-sm text-destructive">{err}</p>}
            <Button variant="ghost" onClick={onClose}>取消</Button>
            <Button className="ml-auto h-11 min-w-28" onClick={save} disabled={busy}>{busy && <Loader2 className="animate-spin" />}儲存</Button>
          </div>
        </div>
      )}
    </Sheet>
  );
}

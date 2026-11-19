import { useEffect, useState } from "react";
import { Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { deviceIcon, mdiIcon } from "@/components/icons";
import { Sheet } from "@/components/responsive-sheet";
import { Segmented, usePlugGroups } from "@/components/schedule-bits";
import { Section } from "@/components/settings-bits";
import { api } from "@/lib/api";
import { useHub } from "@/lib/hub";
import type { Plug } from "@/lib/types";
import { cn } from "@/lib/utils";

export const SCENE_ICONS = ["mdi:logout", "mdi:home", "mdi:weather-night", "mdi:white-balance-sunny", "mdi:television", "mdi:lightbulb", "mdi:star-outline"];
type Act = "on" | "off" | "keep";
interface Draft { name: string; icon: string; actions: Record<string, Act>; others: "keep" | "off" }

// 情境內容摘要：「打開 2 個・關閉 9 個」
export function sceneSummary(actions?: Record<string, Act>) {
  const acts = Object.values(actions || {});
  const on = acts.filter((a) => a === "on").length;
  const off = acts.filter((a) => a === "off").length;
  const parts = [on && `打開 ${on} 個`, off && `關閉 ${off} 個`].filter(Boolean);
  return parts.length ? parts.join("・") : "還沒設定";
}

// 新增／編輯情境；open = 情境 id，"" 是新增
export function SceneSheet({ open, onClose }: { open: string | null; onClose: () => void }) {
  const { state } = useHub();
  const groups = usePlugGroups();
  const sc = open ? state?.scenes.find((s) => s.id === open) : undefined;
  const [d, setD] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  useEffect(() => {
    if (open === null) return setD(null);
    setErr("");
    setD(sc ? { name: sc.name, icon: sc.icon, actions: { ...(sc.actions || {}) }, others: sc.others || "keep" } : { name: "", icon: "mdi:star-outline", actions: {}, others: "keep" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const up = (x: Partial<Draft>) => {
    setErr("");
    setD((v) => (v ? { ...v, ...x } : v));
  };
  const save = async () => {
    if (!d) return;
    const name = d.name.trim();
    if (!name) return setErr("請輸入情境名稱");
    setBusy(true);
    try {
      const body = { name, icon: d.icon, actions: d.actions, others: d.others };
      if (sc) await api("PUT", `/api/scenes/${sc.id}`, body);
      else await api("POST", "/api/scenes", body);
      toast.success(sc ? "情境已更新" : `已新增「${name}」`);
      onClose();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!sc) return;
    try {
      await api("DELETE", `/api/scenes/${sc.id}`);
      toast.success(`已刪除「${sc.name}」`);
      onClose();
    } catch (e) {
      toast.error("沒有成功", { description: (e as Error).message });
    }
  };
  const I = mdiIcon(d?.icon);

  const row = (p: Plug) => {
    const act = d!.actions[p.id] || "keep";
    const I2 = deviceIcon(p.name);
    return (
      <div key={p.id} className={cn("flex items-center gap-3 rounded-xl px-2 py-2", act === "on" && "bg-amber-50 dark:bg-amber-500/10")}>
        <span className={cn("flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground", act === "on" && "bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300")}><I2 className="size-5" /></span>
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium">{p.name}</div>
          {p.keep_on && <div className="text-xs text-muted-foreground">常開</div>}
        </div>
        <div className="w-48 shrink-0">
          <SceneSeg value={act} keepOn={p.keep_on} onChange={(v) => up({ actions: { ...d!.actions, [p.id]: v } })} />
        </div>
      </div>
    );
  };

  return (
    <Sheet open={open !== null && !!d && (open === "" || !!sc)} onOpenChange={(v) => !v && onClose()} title={sc ? "編輯情境" : "新增情境"} description="按一下情境按鈕，一次設定好多個插座" icon={<I />} wide="xl">
      {d && (
        <div className="space-y-5">
          <div className="grid gap-5 md:grid-cols-2">
            <div className="space-y-5">
              <Section title="名稱">
                <Input autoFocus value={d.name} maxLength={20} placeholder="例如：看電影、回家" aria-label="情境名稱" onChange={(e) => up({ name: e.target.value })} className="h-11" />
              </Section>
              <Section title="圖示">
                <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="圖示">
                  {SCENE_ICONS.map((x) => {
                    const Ic = mdiIcon(x);
                    return (
                      <button
                        key={x}
                        type="button"
                        role="radio"
                        aria-checked={d.icon === x}
                        aria-label="選這個圖示"
                        onClick={() => up({ icon: x })}
                        className={cn("flex size-11 items-center justify-center rounded-xl border bg-background transition-all hover:bg-muted active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", d.icon === x && "border-primary bg-primary/10 text-primary")}
                      >
                        <Ic className="size-5" />
                      </button>
                    );
                  })}
                </div>
              </Section>
            </div>
            <div className="space-y-5">
              <Section title="按下時，每個插座要：">
                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" className="rounded-full" onClick={() => up({ actions: { ...d.actions, ...Object.fromEntries((state?.plugs || []).filter((p) => !p.keep_on).map((p) => [p.id, "off"])) } })}>全部設成關閉</Button>
                  <Button variant="outline" className="rounded-full" onClick={() => up({ actions: { ...d.actions, ...Object.fromEntries((state?.plugs || []).map((p) => [p.id, "keep"])) } })}>全部設成不動</Button>
                </div>
              </Section>
              <Section title="之後新找到的插座：">
                <Segmented label="之後新找到的插座" value={d.others} onChange={(v) => up({ others: v })} options={[["keep", "不動"], ["off", "關閉"]]} />
              </Section>
            </div>
          </div>
          <Section title="每個插座">
            <div className="gap-x-6 md:columns-2">
              {groups.map((g) => (
                <div key={g.id} className="contents">
                  <div className="break-after-avoid px-2 pt-3 pb-1 text-sm font-semibold">{g.name}</div>
                  {g.plugs.map((p) => <div key={p.id} className="break-inside-avoid">{row(p)}</div>)}
                </div>
              ))}
            </div>
          </Section>

          <div className="sticky -bottom-6 -mx-6 -mb-6 flex flex-wrap items-center gap-2 border-t bg-background/95 px-6 py-3 backdrop-blur max-md:-mx-4 max-md:px-4">
            {err && <p role="alert" className="w-full text-sm text-destructive">{err}</p>}
            {sc ? (
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="ghost" className="text-destructive hover:bg-destructive/10 hover:text-destructive"><Trash2 />刪除情境</Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>刪除這個情境？</AlertDialogTitle>
                    <AlertDialogDescription>用到這個情境的排程會先暫停，不能復原。</AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>取消</AlertDialogCancel>
                    <AlertDialogAction variant="destructive" onClick={remove}>刪除</AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            ) : (
              <Button variant="ghost" onClick={onClose}>取消</Button>
            )}
            <Button className="ml-auto h-11 min-w-28" onClick={save} disabled={busy}>{busy && <Loader2 className="animate-spin" />}儲存</Button>
          </div>
        </div>
      )}
    </Sheet>
  );
}

// 打開／關閉／不動；常開的插座不能設成關閉
function SceneSeg({ value, keepOn, onChange }: { value: Act; keepOn: boolean; onChange: (v: Act) => void }) {
  const opts: [Act, string][] = [["on", "打開"], ["off", "關閉"], ["keep", "不動"]];
  return (
    <div role="radiogroup" className="grid grid-cols-3 gap-0.5 rounded-lg bg-muted p-0.5">
      {opts.map(([k, l]) => {
        const dis = k === "off" && keepOn;
        return (
          <button
            key={k}
            type="button"
            role="radio"
            aria-checked={value === k}
            disabled={dis}
            title={dis ? "常開的插座不會被關" : undefined}
            onClick={() => onChange(k)}
            className={cn(
              "h-9 rounded-md text-sm font-medium text-muted-foreground transition-all hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40",
              value === k && "bg-background text-foreground shadow-sm",
              value === k && k === "on" && "bg-amber-500 text-white",
              value === k && k === "off" && "bg-neutral-700 text-white dark:bg-neutral-200 dark:text-neutral-900",
            )}
          >
            {l}
          </button>
        );
      })}
    </div>
  );
}

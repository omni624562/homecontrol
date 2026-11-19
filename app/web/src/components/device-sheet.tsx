import { useState } from "react";
import { ExternalLink, Loader2, Lock, Power, Timer, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/responsive-sheet";
import { deviceIcon } from "@/components/icons";
import { api } from "@/lib/api";
import { fmtDur, fmtLeft, fmtSec, fmtWatts } from "@/lib/format";
import { useHub, useTick } from "@/lib/hub";
import type { Plug } from "@/lib/types";
import { cn } from "@/lib/utils";

const TIMERS = [15 * 60, 30 * 60, 3600, 2 * 3600];

export function DeviceSheet({ id, onClose }: { id: string | null; onClose: () => void }) {
  const { state, isOn, isPending, setPower, now } = useHub();
  useTick(1000);
  const [busy, setBusy] = useState<string | null>(null);
  const p = state?.plugs.find((x) => x.id === id);
  if (!p) return <Sheet open={false} onOpenChange={onClose} title="" children={null} />;
  const on = isOn(p);
  const room = state?.rooms.find((r) => r.id === p.room)?.name || "還沒分房間";
  const Icon = deviceIcon(p.name);
  const t = now();

  const timer = async (seconds: number | null) => {
    setBusy(seconds === null ? "cancel" : String(seconds));
    try {
      if (seconds === null) await api("DELETE", `/api/plugs/${encodeURIComponent(p.id)}/timer`);
      else await api("POST", `/api/plugs/${encodeURIComponent(p.id)}/timer`, { seconds });
      toast.success(seconds === null ? "已取消定時" : `${fmtSec(seconds)}後自動關閉`);
    } catch (err) {
      toast.error("沒有成功", { description: (err as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const facts: [string, string][] = [
    ["狀態", !p.online ? "連不上" : on ? "開著" : "關著"],
    ["開了多久", on && p.on_since ? fmtDur(t - p.on_since) : "—"],
    [p.power != null ? "現在功率" : "估計功率", p.power != null ? fmtWatts(p.power) : p.watts ? fmtWatts(p.watts) : "—"],
    ["型號", p.model || "—"],
  ];

  return (
    <Sheet open={!!id} onOpenChange={(v) => !v && onClose()} title={p.name} description={room} icon={<Icon />}>
      <div className="space-y-5 pt-2">
        <div
          className={cn(
            "flex items-center gap-4 rounded-2xl border p-4 transition-colors duration-300",
            on ? "border-amber-200 bg-amber-50 dark:border-amber-500/30 dark:bg-amber-500/10" : "bg-muted/50",
          )}
        >
          <div className="min-w-0 flex-1">
            <div className="text-lg font-semibold">{!p.online ? "連不上" : on ? "開著" : "關著"}</div>
            <div className="text-sm leading-relaxed text-muted-foreground">
              {p.protect === "lock"
                ? "已鎖定：App、Google Home、情境、排程都不能開關"
                : on && p.timer
                  ? `${fmtLeft(p.timer - t)}後自動關閉`
                  : p.keep_on
                    ? "設定成常開：全部關閉不會關它"
                    : "點右邊的按鈕開關"}
            </div>
          </div>
          {p.protect === "lock" ? (
            <Lock className="size-6 text-muted-foreground" />
          ) : (
            <Button
              size="lg"
              disabled={!p.online || isPending(p.id)}
              onClick={() => setPower(p, !on)}
              className={cn("h-12 min-w-28 text-base transition-all active:scale-95", on ? "" : "bg-amber-500 text-white hover:bg-amber-600")}
              variant={on ? "outline" : "default"}
            >
              {isPending(p.id) ? <Loader2 className="animate-spin" /> : <Power />}
              {on ? "關閉" : "打開"}
            </Button>
          )}
        </div>

        {p.online && p.protect !== "lock" && (
          <section>
            <h3 className="mb-2 flex items-center gap-2 text-sm font-medium text-muted-foreground">
              <Timer className="size-4" />
              {on ? "定時關閉" : "打開後定時關閉"}
            </h3>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {TIMERS.map((s) => (
                <Button key={s} variant="outline" className="h-11 transition-all active:scale-95" disabled={!!busy} onClick={() => timer(s)}>
                  {busy === String(s) && <Loader2 className="animate-spin" />}
                  {fmtSec(s)}
                </Button>
              ))}
            </div>
            {on && p.timer && (
              <Button variant="ghost" className="mt-2 w-full text-muted-foreground" disabled={!!busy} onClick={() => timer(null)}>
                {busy === "cancel" ? <Loader2 className="animate-spin" /> : <X />}
                取消定時（還有 {fmtLeft(p.timer - t)}）
              </Button>
            )}
          </section>
        )}

        <dl className="grid grid-cols-2 gap-2">
          {facts.map(([k, v]) => (
            <div key={k} className="rounded-xl bg-muted/60 px-3 py-2.5">
              <dt className="text-xs text-muted-foreground">{k}</dt>
              <dd className="mt-0.5 font-medium tabular-nums">{v}</dd>
            </div>
          ))}
        </dl>

        <Button variant="link" asChild className="h-auto px-0 text-muted-foreground">
          <a href="/#plugs">
            名稱、房間、防呆、用電明細等設定，目前在舊版
            <ExternalLink />
          </a>
        </Button>
      </div>
    </Sheet>
  );
}

// 設了防呆的插座：開關前先確認
export function needsConfirm(p: Plug, on: boolean) {
  return p.protect === "confirm" || (p.protect === "confirm_off" && on);
}

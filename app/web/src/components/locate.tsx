import { useEffect, useState } from "react";
import { Loader2, MapPin, Square, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Section } from "@/components/settings-bits";
import { api } from "@/lib/api";
import type { Where } from "@/lib/types";
import { cn } from "@/lib/utils";

// 人在哪個房間（實驗）：拿著手機站在房間裡按「我在這裡」，記 2 分鐘訊號；之後就拿最近的訊號跟各房間比。

interface LocateData {
  rooms: { id: string; name: string; count: number }[];
  where: Where | null;
  training: { room: string; left: number } | null;
  min: number;
  train_s: number;
  online: boolean;
}

export function whereText(w: Where | null | undefined): string {
  if (!w) return "";
  if (w.name) return `大概在${w.name}`;
  const two = w.top.slice(0, 2).map((t) => t.name);
  return two.length > 1 ? `${two[0]}或${two[1]}` : "";
}

export function LocateSection({ personId }: { personId: string }) {
  const [d, setD] = useState<LocateData | null>(null);
  const [busy, setBusy] = useState("");
  const load = () => api<LocateData>("GET", `/api/locate/${personId}`).then(setD).catch(() => {});
  useEffect(() => {
    load();
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [personId]);
  if (!d) return null;

  const act = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    try {
      await fn();
      await load();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy("");
    }
  };
  const taught = d.rooms.filter((r) => r.count >= d.min).length;
  const tr = d.training;

  return (
    <Section
      title="在哪個房間（實驗）"
      note={<>拿著他的手機站在房間裡，按「我在這裡」，手機照平常的樣子拿著或放著 {Math.round(d.train_s / 60)} 分鐘。至少教兩間才會開始猜；只有 2 台路由器，隔一道牆的房間常分不出來，可以多教幾次（不同位置、手機放口袋或桌上）。訊號只存在樹莓派上。</>}
    >
      <div className="rounded-xl border p-3">
        <div className="flex items-center gap-2 text-sm">
          <MapPin className="size-4 text-muted-foreground" />
          {d.where ? (
            <span>
              <b className="font-medium">{d.where.name ? d.where.name : "不確定"}</b>
              <span className="text-muted-foreground">
                {d.where.name ? `（${Math.round(d.where.p * 100)}% 把握）` : `：可能是${d.where.top.slice(0, 2).map((t) => `${t.name} ${Math.round(t.p * 100)}%`).join("、")}`}
              </span>
            </span>
          ) : (
            <span className="text-muted-foreground">{!d.online ? "手機現在沒連著 Wi-Fi" : taught < 2 ? `還要教 ${2 - taught} 間` : "訊號不夠，等一下"}</span>
          )}
        </div>
        {tr && (
          <div className="mt-3 flex items-center gap-3 rounded-lg bg-primary/5 p-2 text-sm">
            <Loader2 className="size-4 animate-spin text-primary" />
            <span className="flex-1">正在記「{d.rooms.find((r) => r.id === tr.room)?.name}」的訊號，還有 {tr.left} 秒</span>
            <Button type="button" size="sm" variant="outline" onClick={() => act("stop", () => api("DELETE", `/api/locate/${personId}/train`))}><Square />停止</Button>
          </div>
        )}
      </div>
      <div className="divide-y rounded-xl border">
        {d.rooms.map((r) => (
          <div key={r.id} className="flex items-center gap-2 px-3 py-2">
            <span className="min-w-0 flex-1">
              <span className="font-medium">{r.name}</span>
              <span className={cn("ml-2 text-xs", r.count >= d.min ? "text-emerald-700 dark:text-emerald-400" : "text-muted-foreground")}>
                {r.count ? `${r.count} 筆${r.count < d.min ? "（不夠）" : ""}` : "還沒教"}
              </span>
            </span>
            {r.count > 0 && (
              <Button type="button" size="icon" variant="ghost" aria-label={`清掉${r.name}的訊號`} disabled={!!busy}
                onClick={() => act(`x${r.id}`, () => api("DELETE", `/api/locate/${personId}?room=${encodeURIComponent(r.id)}`))}><Trash2 /></Button>
            )}
            <Button type="button" size="sm" variant={tr?.room === r.id ? "default" : "outline"} disabled={!!busy || !!tr || !d.online}
              onClick={() => act(r.id, () => api("POST", `/api/locate/${personId}/train`, { room: r.id }))}>
              {busy === r.id && <Loader2 className="animate-spin" />}我在這裡
            </Button>
          </div>
        ))}
      </div>
    </Section>
  );
}

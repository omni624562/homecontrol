// 點「誰在家」的一個人：現在為什麼這樣判斷（大門口、手機、攝影機各說了什麼）、最近每一筆變化；判斷錯了可以手動改
import { useEffect, useState } from "react";
import { Check, Minus, Play } from "lucide-react";
import { toast } from "sonner";
import { ClipPlayer, type ClipTarget } from "@/components/clip-player";
import { Sheet } from "@/components/responsive-sheet";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { fmtDur } from "@/lib/format";
import type { HubState, Person } from "@/lib/types";
import { cn } from "@/lib/utils";

const pad2 = (n: number) => String(n).padStart(2, "0");
const hm = (t: number) => { const d = new Date(t * 1000); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };
const dayHm = (t: number, now: number) => {
  const d = new Date(t * 1000), n = new Date(now * 1000);
  const days = Math.round((new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime() - new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()) / 864e5);
  return days === 0 ? hm(t) : days === 1 ? `昨天 ${hm(t)}` : `${d.getMonth() + 1}/${d.getDate()} ${hm(t)}`;
};

export const personStatus = (p: Person) => (p.home ? (p.stay ? "先當作在家" : "在家") : p.home === false ? "出門" : "不確定");

export function PersonSheet({ person: p, state, now, onClose }: { person: Person | null; state: HubState; now: number; onClose: () => void }) {
  const [canView, setCanView] = useState(false);
  const [clip, setClip] = useState<ClipTarget | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (p) api<{ access: { can_view: boolean } }>("GET", "/api/cameras").then((r) => setCanView(r.access.can_view)).catch(() => setCanView(false));
  }, [p]);
  if (!p) return <Sheet open={false} onOpenChange={() => onClose()} title="">{null}</Sheet>;

  const log = (state.presence_log || []).filter((e) => e.name === p.name).slice(-8).reverse();
  const room = state.room_seen || 0;
  const online = !!p.phone && now - p.phone < 120;
  const fix = async (home: boolean) => {
    setBusy(true);
    try {
      await api("POST", `/api/people/${encodeURIComponent(p.id)}/presence`, { home });
      toast.success(`${p.name}已改成${home ? "在家" : "出門"}`);
      onClose();
    } catch (e) {
      toast.error("沒有成功", { description: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  const watch = (cam: string, t: number) => (
    <Button variant="ghost" size="sm" className="h-9 shrink-0 text-primary" onClick={() => setClip({ cam, t, title: `大門口 ${hm(t)}` })}><Play />看那 10 秒</Button>
  );
  const Row = ({ ok, children, end }: { ok: boolean; children: React.ReactNode; end?: React.ReactNode }) => (
    <li className="flex items-center gap-2.5 text-sm">
      {ok ? <Check className="size-4 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden /> : <Minus className="size-4 shrink-0 text-muted-foreground" aria-hidden />}
      <span className={cn("min-w-0 flex-1", !ok && "text-muted-foreground")}>{children}</span>
      {end}
    </li>
  );

  return (
    <>
      <Sheet open onOpenChange={(v) => !v && onClose()} title={`${p.name}・${personStatus(p)}${p.since && p.home !== null ? ` ${fmtDur(now - p.since)}` : ""}`} description={p.why}>
        <div className="space-y-5">
          <section>
            <h3 className="mb-2 text-xs font-bold text-muted-foreground">現在的依據</h3>
            <ul className="space-y-2">
              {p.home === false && p.door_t
                ? <Row ok end={canView && p.door_cam ? watch(p.door_cam, p.door_t) : undefined}>大門口 {hm(p.door_t)} 看到一個人出去</Row>
                : !online && <Row ok={false}>大門口沒看到人出去</Row>}
              {online ? <Row ok>手機現在連著 Wi-Fi</Row> : p.phone ? <Row ok={p.home === false}>手機 {dayHm(p.phone, now)} 之後沒連上 Wi-Fi</Row> : <Row ok={false}>沒看過這支手機</Row>}
              {room > 0 && (now - room < 900
                ? <Row ok={!!p.home}>攝影機 {Math.max(1, Math.round((now - room) / 60))} 分鐘前看到有人走動</Row>
                : <Row ok={false}>攝影機 {dayHm(room, now)} 之後沒看到人走動</Row>)}
            </ul>
          </section>
          {log.length > 0 && (
            <section>
              <h3 className="mb-2 text-xs font-bold text-muted-foreground">最近</h3>
              <ol className="space-y-3">
                {log.map((e, i) => (
                  <li key={`${e.t}-${i}`} className="flex items-start gap-3 text-sm">
                    <span className="w-20 shrink-0 pt-px text-[13px] tabular-nums text-muted-foreground">{dayHm(e.t, now)}</span>
                    <span className="min-w-0 flex-1 leading-relaxed">
                      <span className={cn("font-medium", e.stay && "text-orange-700 dark:text-orange-300")}>{e.stay ? "先當作還在家" : e.home ? "回家" : "出門"}</span>
                      <span className="block text-[13px] text-muted-foreground">{e.why}</span>
                    </span>
                    {canView && e.cam && e.door_t ? watch(e.cam, e.door_t) : null}
                  </li>
                ))}
              </ol>
            </section>
          )}
          {(p.home === false || p.stay) && (
            <div className="flex items-center gap-3 border-t pt-4">
              <span className="flex-1 text-sm text-muted-foreground">判斷錯了？</span>
              <Button variant="outline" className="h-11" disabled={busy} onClick={() => fix(p.home === false)}>{p.home === false ? "其實在家" : "其實出門了"}</Button>
            </div>
          )}
        </div>
      </Sheet>
      <ClipPlayer target={clip} onClose={() => setClip(null)} />
    </>
  );
}

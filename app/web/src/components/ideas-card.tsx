import { useEffect, useState } from "react";
import { Activity, CalendarClock, House, Lightbulb, Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { api } from "@/lib/api";
import { applyAction } from "@/lib/actions";
import type { AskAction } from "@/lib/types";

type Idea = AskAction & { reason?: string; key: string };
interface IdeasInfo { configured: boolean; busy: boolean; t: number | null; items: Idea[]; error?: string | null }

const KIND: Record<string, [string, React.ElementType]> = { schedule: ["排程", CalendarClock], arrive: ["回家自動開", House], motion: ["動靜自動化", Activity] };

// Claude 從習慣建議的自動化（每週日晚上更新）；有建議時取代原本的「建議的排程」
export function useIdeas() {
  const [info, setInfo] = useState<IdeasInfo | null>(null);
  useEffect(() => {
    api<IdeasInfo>("GET", "/api/ideas").then(setInfo).catch(() => setInfo(null));
  }, []);
  return [info, setInfo] as const;
}

export function IdeasCard({ info, setInfo, onCreated }: { info: IdeasInfo; setInfo: (i: IdeasInfo) => void; onCreated?: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const drop = async (x: Idea, what: "done" | "dismiss") => setInfo(await api<IdeasInfo>("POST", `/api/ideas/${encodeURIComponent(x.id)}/${what}`));
  const create = async (x: Idea) => {
    setBusy(x.id);
    try {
      await applyAction(x);
      await drop(x, "done");
      toast.success("建立好了");
      onCreated?.();
    } catch (e) {
      toast.error("沒有成功", { description: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };
  const refresh = async () => {
    setBusy("run");
    try {
      const r = await api<IdeasInfo>("POST", "/api/ideas/run");
      setInfo(r);
      if (r.error) toast.error("沒有成功", { description: r.error });
      else if (!r.items.length) toast.success("Claude 看過了，目前沒有明顯的規律可以自動化");
    } catch (e) {
      toast.error("沒有成功", { description: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };
  return (
    <Card className="gap-0 overflow-hidden py-0">
      <div className="flex items-center gap-3 border-b bg-muted/60 px-4 py-3 sm:px-5 dark:bg-muted/40">
        <div className="flex size-9 items-center justify-center rounded-lg border bg-background text-foreground/70"><Lightbulb className="size-5" /></div>
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-bold tracking-tight">Claude 建議</h2>
          <div className="text-xs text-muted-foreground">每週日晚上看過去 4 週的習慣</div>
        </div>
        <Badge variant="secondary">{info.items.length}</Badge>
      </div>
      <div className="divide-y px-4 sm:px-5">
        {info.items.map((x) => {
          const [kind, I] = KIND[x.kind] || ["", Lightbulb];
          return (
            <div key={x.id} className="flex flex-wrap items-center gap-3 py-3">
              <div className="min-w-0 flex-1 basis-56">
                <div className="flex items-center gap-1 text-xs text-muted-foreground"><I className="size-3.5" />{kind}</div>
                <div className="font-medium leading-relaxed">{x.label}</div>
                {x.reason && <div className="text-sm leading-relaxed text-muted-foreground">{x.reason}</div>}
              </div>
              <div className="flex gap-2">
                <Button variant="ghost" disabled={!!busy} onClick={async () => { setBusy(x.id); try { await drop(x, "dismiss"); toast.success("不會再建議這一條"); } finally { setBusy(null); } }}>不要</Button>
                <Button disabled={!!busy} onClick={() => create(x)}>{busy === x.id && <Loader2 className="animate-spin" />}建立</Button>
              </div>
            </div>
          );
        })}
      </div>
      <p className="flex flex-wrap items-center gap-2 px-4 pt-1 pb-4 text-sm leading-relaxed text-muted-foreground sm:px-5">
        <span className="flex-1">按「不要」的同樣建議不會再出現。</span>
        <Button variant="ghost" size="sm" disabled={!!busy || info.busy} onClick={refresh}>
          {busy === "run" ? <Loader2 className="animate-spin" /> : <RefreshCw />}重新看一次
        </Button>
      </p>
    </Card>
  );
}

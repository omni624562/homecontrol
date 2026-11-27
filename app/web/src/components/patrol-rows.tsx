import { useEffect, useState } from "react";
import { Bell, Check, Loader2, Power, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Segmented } from "@/components/schedule-bits";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

interface PatrolInfo {
  on: boolean;
  time: string;
  items: string[];
  items_all: Record<string, string>;
  extra: string;
  notify: "issue" | "always";
  busy: boolean;
  last: { t: number; issue?: boolean; text?: string; offers?: { id: string; name: string }[]; notified?: boolean; error?: string } | null;
}

const when = (t: number) => {
  const d = new Date(t * 1000);
  const today = new Date().toDateString() === d.toDateString();
  const yest = new Date(Date.now() - 86400000).toDateString() === d.toDateString();
  return `${today ? "今天" : yest ? "昨天" : `${d.getMonth() + 1}/${d.getDate()}`} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

// Claude 巡家：每天固定時間看一次家裡今天的狀況（文字），有事才通知；只看不動手
export function PatrolRows() {
  const [c, setC] = useState<PatrolInfo | null>(null);
  const [extra, setExtra] = useState("");
  const [running, setRunning] = useState(false);
  const [closed, setClosed] = useState<string[]>([]);
  useEffect(() => {
    api<PatrolInfo>("GET", "/api/patrol").then((r) => { setC(r); setExtra(r.extra); }).catch(() => setC(null));
  }, []);
  if (!c) return null;
  const put = async (body: Partial<PatrolInfo>, ok?: string) => {
    try {
      setC(await api<PatrolInfo>("PUT", "/api/patrol", body));
      if (ok) toast.success(ok);
    } catch (e) {
      toast.error("沒有成功", { description: (e as Error).message });
    }
  };
  const run = async () => {
    setRunning(true);
    try {
      setC(await api<PatrolInfo>("POST", "/api/patrol/run"));
      setClosed([]);
    } catch (e) {
      toast.error("巡家失敗", { description: (e as Error).message });
    } finally {
      setRunning(false);
    }
  };
  const turnOff = async (id: string, name: string) => {
    try {
      await api("POST", `/api/plugs/${encodeURIComponent(id)}/power`, { on: false });
      setClosed((x) => [...x, id]);
      toast.success(`${name} 關掉了`);
    } catch (e) {
      toast.error("沒有成功", { description: (e as Error).message });
    }
  };
  const last = c.last;
  return (
    <div className="border-t">
      <div className="flex items-center gap-3 px-4 py-3.5 sm:px-5">
        <ShieldCheck className="size-5 shrink-0 text-primary" />
        <span className="min-w-0 flex-1">
          <span className="block font-medium">Claude 巡家</span>
          <span className="text-sm text-muted-foreground">每天看一次家裡今天的狀況，有事才通知；只看、不會自己開關東西，不送攝影機畫面</span>
        </span>
        <Switch checked={c.on} onCheckedChange={(v) => put({ on: v }, v ? `Claude 巡家打開了：每天 ${c.time}` : "Claude 巡家關了")} aria-label="Claude 巡家" />
      </div>
      {c.on && (
        <div className="space-y-4 px-4 pb-4 sm:px-5">
          <div className="flex items-center gap-3">
            <label htmlFor="patrol-time" className="flex-1 font-medium">每天幾點巡</label>
            <Input id="patrol-time" type="time" className="w-32" value={c.time} onChange={(e) => e.target.value && put({ time: e.target.value })} />
          </div>
          <div>
            <div className="mb-2 font-medium">看哪些</div>
            <div className="flex flex-wrap gap-2">
              {Object.entries(c.items_all).map(([k, label]) => {
                const on = c.items.includes(k);
                return (
                  <button key={k} type="button" aria-pressed={on}
                    onClick={() => put({ items: on ? c.items.filter((x) => x !== k) : [...c.items, k] })}
                    className={cn("inline-flex min-h-9 items-center gap-1 rounded-full border px-3 text-sm", on ? "border-primary/40 bg-primary/10 text-primary" : "text-muted-foreground hover:bg-accent")}>
                    {on && <Check className="size-3.5" />}{label}
                  </button>
                );
              })}
            </div>
          </div>
          <div>
            <label htmlFor="patrol-extra" className="mb-2 block font-medium">另外交代 Claude</label>
            <textarea id="patrol-extra" rows={3} maxLength={300} value={extra} onChange={(e) => setExtra(e.target.value)}
              onBlur={() => extra !== c.extra && put({ extra }, "記住了")}
              placeholder="例如：廚房電源 10 點後還開著要提醒我"
              className="w-full resize-none rounded-lg border bg-background px-3 py-2 text-sm leading-relaxed outline-none focus-visible:ring-2 focus-visible:ring-ring" />
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <span className="flex-1 font-medium">通知</span>
            <Segmented label="巡家通知" value={c.notify} onChange={(v) => put({ notify: v })} options={[["issue", "有事才通知"], ["always", "每天都傳"]]} />
          </div>
          {last && (
            <div className="space-y-2 rounded-xl border bg-muted/40 p-3">
              <div className="flex items-center gap-2 text-sm font-medium">
                <Bell className={cn("size-4", last.issue ? "text-orange-600" : "text-muted-foreground")} />
                {when(last.t)}・{last.error ? "沒有成功" : last.notified ? "有傳通知" : "沒事，沒傳通知"}
              </div>
              <p className={cn("text-sm leading-relaxed", last.error && "text-destructive")}>{last.error || last.text}</p>
              {last.offers?.filter((o) => !closed.includes(o.id)).map((o) => (
                <Button key={o.id} variant="outline" size="sm" onClick={() => turnOff(o.id, o.name)}><Power />要我關掉{o.name}嗎</Button>
              ))}
            </div>
          )}
          <Button variant="outline" className="w-full" disabled={running || c.busy} onClick={run}>
            {running ? <><Loader2 className="animate-spin" />巡家中…</> : "現在巡一次"}
          </Button>
        </div>
      )}
    </div>
  );
}

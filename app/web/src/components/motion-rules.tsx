// 動靜自動開關：房間有人走動就開某個插座，沒動靜幾分鐘後自動關
import { useEffect, useState } from "react";
import { Plus, Trash2, Zap } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Segmented } from "@/components/schedule-bits";
import { api } from "@/lib/api";
import type { Plug } from "@/lib/types";

export interface MotionRule { id?: string; room: string; plug: string; start: string; end: string; off_min: number; need_home: boolean; enabled: boolean }
interface RuleState { own: boolean; last: number | null; fired: number | null }
interface Resp { rules: MotionRule[]; state: Record<string, RuleState> }

const OFF = [1, 2, 5, 10, 15, 30];
const ago = (t: number) => {
  const s = Date.now() / 1000 - t;
  return s < 90 ? "剛剛" : s < 3600 ? `${Math.round(s / 60)} 分鐘前` : s < 86400 ? `${Math.round(s / 3600)} 小時前` : `${Math.round(s / 86400)} 天前`;
};

export function MotionRules({ rooms, plugs }: { rooms: { id: string; name: string }[]; plugs: Plug[] }) {
  const [data, setData] = useState<Resp | null>(null);
  const [draft, setDraft] = useState<MotionRule | null>(null);
  const [mode, setMode] = useState<"all" | "night" | "custom">("night");

  useEffect(() => {
    let alive = true;
    const load = () => api<Resp>("GET", "/api/motion-rules").then((d) => alive && setData(d)).catch(() => {});
    load();
    const t = setInterval(load, 15000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const save = async (rules: MotionRule[]) => {
    try {
      setData(await api<Resp>("PUT", "/api/motion-rules", { rules }));
      return true;
    } catch (err) {
      toast.error("沒有存到", { description: (err as Error).message });
      return false;
    }
  };

  if (!data) return null;
  const roomName = (id: string) => rooms.find((r) => r.id === id)?.name || "（已刪除的區域）";
  const plugName = (id: string) => plugs.find((p) => p.id === id)?.name || "（找不到插座）";
  const startNew = () => {
    setMode("night");
    setDraft({ room: rooms[0]?.id || "", plug: plugs[0]?.id || "", start: "23:00", end: "06:00", off_min: 5, need_home: true, enabled: true });
  };
  const setMode2 = (m: "all" | "night" | "custom") => {
    setMode(m);
    if (draft) setDraft({ ...draft, ...(m === "all" ? { start: "", end: "" } : m === "night" ? { start: "23:00", end: "06:00" } : { start: draft.start || "18:00", end: draft.end || "23:00" }) });
  };

  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-sm font-medium">動靜自動開關</span>
        <span className="text-xs text-muted-foreground">有人走動就開，沒動靜就關</span>
      </div>
      {data.rules.length > 0 && (
        <ul className="divide-y rounded-lg border text-sm">
          {data.rules.map((r, i) => {
            const st = r.id ? data.state[r.id] : undefined;
            return (
              <li key={r.id || i} className="flex items-start gap-2 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <div><b>{roomName(r.room)}</b> 有人走動 → 開「{plugName(r.plug)}」</div>
                  <div className="text-xs text-muted-foreground">
                    {r.start ? `${r.start}～${r.end}` : "整天"}・沒動靜 {r.off_min} 分鐘後關{r.need_home ? "・有人在家才開" : ""}
                    {st?.own ? <span className="text-emerald-600 dark:text-emerald-400">・現在是它開的</span> : st?.fired ? `・上次 ${ago(st.fired)}` : ""}
                  </div>
                </div>
                <Switch checked={r.enabled} aria-label="啟用" onCheckedChange={(v) => save(data.rules.map((x, j) => (j === i ? { ...x, enabled: v } : x)))} />
                <Button type="button" size="icon" variant="ghost" className="size-8 text-muted-foreground" aria-label="刪掉這條"
                  onClick={() => save(data.rules.filter((_, j) => j !== i))}><Trash2 /></Button>
              </li>
            );
          })}
        </ul>
      )}
      {draft ? (
        <div className="space-y-2.5 rounded-lg border p-3">
          <div className="grid grid-cols-[4.5rem_1fr] items-center gap-2 text-sm">
            <span className="text-muted-foreground">哪一間</span>
            <Select value={draft.room} onValueChange={(v) => setDraft({ ...draft, room: v })}>
              <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
              <SelectContent>{rooms.map((r) => <SelectItem key={r.id} value={r.id}>{r.name}</SelectItem>)}</SelectContent>
            </Select>
            <span className="text-muted-foreground">開哪個</span>
            <Select value={draft.plug} onValueChange={(v) => setDraft({ ...draft, plug: v })}>
              <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
              <SelectContent>{plugs.map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <Segmented label="時段" value={mode} onChange={setMode2} options={[["night", "晚上 23～6 點"], ["all", "整天"], ["custom", "自訂"]]} />
          {mode === "custom" && (
            <div className="flex items-center gap-2 text-sm">
              <Input type="time" className="h-9 w-32" value={draft.start} onChange={(e) => setDraft({ ...draft, start: e.target.value })} aria-label="開始" />～
              <Input type="time" className="h-9 w-32" value={draft.end} onChange={(e) => setDraft({ ...draft, end: e.target.value })} aria-label="結束" />
            </div>
          )}
          <div className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">沒動靜</span>
            <Select value={String(draft.off_min)} onValueChange={(v) => setDraft({ ...draft, off_min: Number(v) })}>
              <SelectTrigger className="h-9 w-24"><SelectValue /></SelectTrigger>
              <SelectContent>{OFF.map((m) => <SelectItem key={m} value={String(m)}>{m} 分鐘</SelectItem>)}</SelectContent>
            </Select>
            <span className="text-muted-foreground">後關掉</span>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <Switch checked={draft.need_home} onCheckedChange={(v) => setDraft({ ...draft, need_home: v })} />有人在家才開（避免寵物、微波爐誤觸）
          </label>
          <div className="flex gap-2">
            <Button type="button" className="h-9" disabled={!draft.room || !draft.plug} onClick={async () => { if (await save([...data.rules, draft])) setDraft(null); }}><Zap />加上</Button>
            <Button type="button" variant="ghost" className="h-9" onClick={() => setDraft(null)}>取消</Button>
          </div>
          <p className="text-xs text-muted-foreground">只在插座本來是關的時候才開；它開的才會自動關。你自己關掉後，要等那間安靜一陣子才會再自動開。</p>
        </div>
      ) : (
        <Button type="button" variant="outline" className="h-9" disabled={!rooms.length || !plugs.length} onClick={startNew}><Plus />新增</Button>
      )}
    </div>
  );
}

// 回家自動開：誰（的手機連上 Wi-Fi）回家 → 打開插座或執行情境。可以新增、修改、刪除、暫停（後端 /api/arrive-rules）
import { useEffect, useState } from "react";
import { Lightbulb, Plus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { HubState } from "@/lib/types";

type When = "all" | "dark" | "range";
type Days = "all" | "weekday" | "weekend";
type Kind = "plugs" | "scene";
export interface ArriveRule {
  id: string; enabled: boolean; who: string; only_empty: boolean; when: When; start: string; end: string;
  days: Days; kind: Kind; plugs: string[]; scene: string | null; for_min: number; last: number | null;
}
interface Suggestion { who: string; name: string; plug: string; plug_name: string; hits: number; n: number }
interface Data { rules: ArriveRule[]; suggestions: Suggestion[] }

const BLANK: Omit<ArriveRule, "id" | "last"> = { enabled: true, who: "any", only_empty: false, when: "all", start: "17:00", end: "22:00", days: "all", kind: "plugs", plugs: [], scene: null, for_min: 0 };
const FOR_MIN: [number, string][] = [[0, "不自動關"], [10, "10 分鐘"], [30, "30 分鐘"], [60, "1 小時"], [120, "2 小時"], [180, "3 小時"]];

async function call(method: string, path: string, body?: unknown, ok?: string): Promise<Data | null> {
  try {
    const r = await api<Data>(method, path, body);
    if (ok) toast.success(ok);
    return r;
  } catch (e) {
    toast.error("沒有成功", { description: (e as Error).message });
    return null;
  }
}

// 一排可以選一個的按鈕
function Pick<T extends string>({ value, opts, onChange, label }: { value: T; opts: [T, string][]; onChange: (v: T) => void; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-1.5">
      {opts.map(([k, text]) => (
        <button key={k} type="button" role="radio" aria-checked={value === k} onClick={() => onChange(k)}
          className={cn("rounded-lg border px-3 py-1 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            value === k ? "border-primary bg-primary/10 font-medium text-primary" : "bg-background text-muted-foreground hover:bg-muted")}>
          {text}
        </button>
      ))}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="space-y-1.5"><div className="text-xs font-bold text-muted-foreground">{label}</div>{children}</div>;
}

export function ArriveRules({ s }: { s: HubState }) {
  const [d, setD] = useState<Data | null>(null);
  const [edit, setEdit] = useState<{ id: string | null; r: Omit<ArriveRule, "id" | "last"> } | null>(null);  // id null = 新增
  const [del, setDel] = useState<string | null>(null);
  useEffect(() => { api<Data>("GET", "/api/arrive-rules").then(setD).catch(() => setD({ rules: [], suggestions: [] })); }, []);

  const people = s.people || [];
  const plugName = (id: string) => s.plugs.find((p) => p.id === id)?.name || "（已移除的插座）";
  const sceneName = (id: string | null) => s.scenes.find((x) => x.id === id)?.name || "（已刪除的情境）";
  const whoName = (who: string) => (who === "any" ? "任何人" : people.find((p) => p.id === who)?.name || "（已移除的家人）");
  const whenText = (r: Omit<ArriveRule, "id" | "last">) => [
    r.only_empty ? "家裡原本沒人時" : "每次回家",
    r.when === "dark" ? "天黑後" : r.when === "range" ? `${r.start}～${r.end}` : "全天",
    r.days === "weekday" ? "平日" : r.days === "weekend" ? "週末" : "",
  ].filter(Boolean).join("・");
  const doText = (r: Omit<ArriveRule, "id" | "last">) => r.kind === "scene" ? `執行情境「${sceneName(r.scene)}」`
    : `打開 ${r.plugs.map(plugName).join("、")}${r.for_min ? `（${r.for_min >= 60 ? `${r.for_min / 60} 小時` : `${r.for_min} 分鐘`}後關）` : ""}`;
  const lastText = (t: number | null) => {
    if (!t) return null;
    const x = new Date(t * 1000);
    return `上次：${x.getMonth() + 1}/${x.getDate()} ${String(x.getHours()).padStart(2, "0")}:${String(x.getMinutes()).padStart(2, "0")}`;
  };

  const save = async () => {
    if (!edit) return;
    const r = edit.id ? await call("PUT", `/api/arrive-rules/${edit.id}`, edit.r, "已儲存") : await call("POST", "/api/arrive-rules", edit.r, "已新增");
    if (r) { setD(r); setEdit(null); }
  };
  const toggle = async (r: ArriveRule, v: boolean) => {
    const x = await call("PUT", `/api/arrive-rules/${r.id}`, { enabled: v }, v ? "已啟用" : "已暫停");
    if (x) setD(x);
  };
  const remove = async (id: string) => {
    const x = await call("DELETE", `/api/arrive-rules/${id}`, undefined, "已刪除");
    if (x) { setD(x); setDel(null); if (edit?.id === id) setEdit(null); }
  };
  const fromSuggestion = (g: Suggestion) => setEdit({ id: null, r: { ...BLANK, who: g.who, kind: "plugs", plugs: [g.plug] } });

  const form = edit && (() => {
    const r = edit.r;
    const set = (p: Partial<typeof r>) => setEdit({ ...edit, r: { ...r, ...p } });
    const ok = r.kind === "plugs" ? r.plugs.length > 0 : !!r.scene;
    return (
      <div className="space-y-3 rounded-lg border border-primary/60 bg-background p-3 ring-2 ring-primary/10">
        <div className="font-medium">{edit.id ? "修改規則" : "新增規則"}</div>
        <Field label="誰回家"><Pick label="誰回家" value={r.who} opts={[["any", "任何人"], ...people.map((p) => [p.id, p.name] as [string, string])]} onChange={(v) => set({ who: v })} /></Field>
        <Field label="什麼情況"><Pick label="什麼情況" value={r.only_empty ? "empty" : "each"} opts={[["each", r.who === "any" ? "每次有人回家" : "每次他回家"], ["empty", "家裡原本沒人時"]]} onChange={(v) => set({ only_empty: v === "empty" })} /></Field>
        <Field label="什麼時候">
          <Pick label="什麼時候" value={r.when} opts={[["all", "全天"], ["dark", "天黑後"], ["range", "自訂時段"]]} onChange={(v) => set({ when: v })} />
          {r.when === "range" && (
            <div className="flex items-center gap-2 pt-1 text-sm">
              <Input id="arrive-start" type="time" className="h-8 w-28 bg-background" value={r.start} onChange={(e) => set({ start: e.target.value })} aria-label="開始時間" />
              到
              <Input id="arrive-end" type="time" className="h-8 w-28 bg-background" value={r.end} onChange={(e) => set({ end: e.target.value })} aria-label="結束時間" />
            </div>
          )}
          {r.when === "dark" && <p className="text-xs text-muted-foreground">日落前 30 分鐘到日出</p>}
        </Field>
        <Field label="哪幾天"><Pick label="哪幾天" value={r.days} opts={[["all", "每天"], ["weekday", "平日"], ["weekend", "週末"]]} onChange={(v) => set({ days: v })} /></Field>
        <Field label="做什麼">
          <Pick label="做什麼" value={r.kind} opts={[["plugs", "打開插座"], ["scene", "執行情境"]]} onChange={(v) => set({ kind: v })} />
          {r.kind === "plugs" ? (
            <div className="flex flex-wrap gap-1.5 pt-1">
              {s.plugs.map((p) => {
                const on = r.plugs.includes(p.id);
                return (
                  <button key={p.id} type="button" aria-pressed={on} onClick={() => set({ plugs: on ? r.plugs.filter((x) => x !== p.id) : [...r.plugs, p.id] })}
                    className={cn("rounded-full border px-3 py-1 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      on ? "border-primary bg-primary/10 font-medium text-primary" : "bg-background text-muted-foreground hover:bg-muted")}>
                    {on ? "✓ " : ""}{p.name}
                  </button>
                );
              })}
            </div>
          ) : (
            <Select value={r.scene || ""} onValueChange={(v) => set({ scene: v })}>
              <SelectTrigger className="mt-1 h-9 w-full bg-background sm:w-60" aria-label="執行哪個情境"><SelectValue placeholder="選一個情境" /></SelectTrigger>
              <SelectContent>{s.scenes.map((x) => <SelectItem key={x.id} value={x.id}>{x.name}</SelectItem>)}</SelectContent>
            </Select>
          )}
        </Field>
        {r.kind === "plugs" && (
          <Field label="開多久">
            <Select value={String(r.for_min)} onValueChange={(v) => set({ for_min: +v })}>
              <SelectTrigger className="h-9 w-40 bg-background" aria-label="開多久"><SelectValue /></SelectTrigger>
              <SelectContent>{FOR_MIN.map(([m, t]) => <SelectItem key={m} value={String(m)}>{t}</SelectItem>)}</SelectContent>
            </Select>
          </Field>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={() => setEdit(null)}>取消</Button>
          <Button size="sm" disabled={!ok} onClick={save}>儲存</Button>
        </div>
      </div>
    );
  })();

  if (!d) return <div className="px-4 py-3.5 text-sm text-muted-foreground sm:px-5">讀取中…</div>;
  return (
    <div className="space-y-3 px-4 py-3.5 sm:px-5">
      <div className="flex items-center gap-3">
        <p className="min-w-0 flex-1 text-sm leading-relaxed text-muted-foreground">誰的手機連上家裡 Wi-Fi，就照這裡的規則打開插座或執行情境。已經開著的不動。</p>
        {!edit && <Button size="sm" onClick={() => setEdit({ id: null, r: { ...BLANK } })} disabled={!people.length}><Plus />新增</Button>}
      </div>
      {!people.length && <p className="text-sm text-muted-foreground">先在「網路裝置 → 誰在家」新增家人、選他的手機。</p>}
      {edit && !edit.id && form}
      {d.rules.map((r) => (
        <div key={r.id} className={cn("space-y-1.5 rounded-lg border bg-background p-3", !r.enabled && "opacity-60")}>
          {edit?.id === r.id ? form : (
            <>
              <div className="flex items-center gap-3">
                <div className="min-w-0 flex-1 text-sm">
                  <span className="font-bold">{whoName(r.who)}</span>・{whenText(r)}
                  <div className="text-muted-foreground">{doText(r)}</div>
                </div>
                <Switch checked={r.enabled} onCheckedChange={(v) => toggle(r, v)} aria-label={r.enabled ? "暫停這條規則" : "啟用這條規則"} />
              </div>
              {del === r.id ? (
                <div className="flex flex-wrap items-center gap-2 rounded-md bg-destructive/10 px-2.5 py-2 text-sm">
                  <span className="min-w-0 flex-1">確定刪除「{whoName(r.who)}回家 → {doText(r)}」？</span>
                  <Button variant="ghost" size="sm" onClick={() => setDel(null)}>取消</Button>
                  <Button variant="destructive" size="sm" onClick={() => remove(r.id)}>刪除</Button>
                </div>
              ) : (
                <div className="flex items-center gap-1">
                  <span className="min-w-0 flex-1 text-xs text-muted-foreground">{r.enabled ? lastText(r.last) || "還沒執行過" : "暫停中"}</span>
                  <Button variant="ghost" size="sm" className="h-7 px-2" onClick={() => { setDel(null); setEdit({ id: r.id, r: { ...r } }); }}>編輯</Button>
                  <Button variant="ghost" size="sm" className="h-7 px-2 text-muted-foreground hover:text-destructive" onClick={() => setDel(r.id)}>刪除</Button>
                </div>
              )}
            </>
          )}
        </div>
      ))}
      {!d.rules.length && !edit && people.length > 0 && <p className="text-sm text-muted-foreground">還沒有規則。按「新增」，例如「天黑後任何人回家 → 打開立燈」。</p>}
      {d.suggestions.map((g) => (
        <div key={g.who + g.plug} className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed border-amber-500/70 p-3 text-sm">
          <Lightbulb className="size-4 shrink-0 text-amber-600 dark:text-amber-400" />
          <span className="min-w-0 flex-1">{g.name}最近 {g.n} 次回家，有 {g.hits} 次 15 分鐘內打開了{g.plug_name}</span>
          <Button variant="outline" size="sm" onClick={() => fromSuggestion(g)}>建立規則</Button>
        </div>
      ))}
      <p className="text-xs text-muted-foreground">回家紀錄留 60 天；同一個人回家後常手動開同一個插座，這裡會出現建議。</p>
    </div>
  );
}

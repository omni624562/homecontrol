import { useEffect, useState } from "react";
import { CheckCircle2, ChevronRight, Circle, ListChecks, X } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

// ---- 設定進度：做好了但還沒設定的功能，一項一項帶著做完 ----

export interface SetupItem { id: string; title: string; hint: string; done: boolean; href: string; skipped?: boolean }

function withHttps(items: SetupItem[]): SetupItem[] {
  // 這一項看的是「現在這台裝置」，伺服器不知道，畫面自己加
  const secure = location.protocol === "https:";
  return [...items, { id: "https", title: "這台裝置改用 HTTPS", hint: secure ? "這台已經是安全連線" : "裝一次憑證，連線加密、用鏡頭的功能也才能用", done: secure, href: "#settings/s-tls" }];
}

const HTTPS_SKIP = "setup-https-skip";
function httpsSkipped(): boolean {
  try { return localStorage.getItem(HTTPS_SKIP) === "1"; } catch { return false; }
}

export function useSetup() {
  const [items, setItems] = useState<SetupItem[] | null>(null);
  const load = () => api<{ items: SetupItem[] }>("GET", "/api/setup").then((r) => setItems(withHttps(r.items).map((x) => (x.id === "https" ? { ...x, skipped: !x.done && httpsSkipped() } : x)))).catch(() => {});
  useEffect(() => { load(); }, []);
  const skip = async (id: string, v: boolean) => {
    if (id === "https") {
      try { localStorage.setItem(HTTPS_SKIP, v ? "1" : "0"); } catch { /* 無痕視窗 */ }
      setItems((xs) => xs && xs.map((x) => (x.id === "https" ? { ...x, skipped: v } : x)));
      return;
    }
    try {
      const r = await api<{ items: SetupItem[] }>("PUT", "/api/setup/skip", { id, skip: v });
      setItems(withHttps(r.items).map((x) => (x.id === "https" ? { ...x, skipped: !x.done && httpsSkipped() } : x)));
    } catch (e) {
      toast.error("沒有成功", { description: (e as Error).message });
    }
  };
  const counted = (items || []).filter((x) => !x.skipped);
  return { items, skip, done: counted.filter((x) => x.done).length, total: counted.length };
}

function go(href: string) {
  location.hash = href;
  const part = href.split("/")[1];
  if (part) setTimeout(() => document.getElementById(part)?.scrollIntoView({ behavior: "smooth", block: "start" }), 400);
}

function Bar({ done, total }: { done: number; total: number }) {
  return (
    <div className="h-2 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done} aria-label="設定進度">
      <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${total ? (done / total) * 100 : 0}%` }} />
    </div>
  );
}

export function SetupList({ s }: { s: ReturnType<typeof useSetup> }) {
  const [showSkipped, setShowSkipped] = useState(false);
  if (!s.items) return null;
  const todo = s.items.filter((x) => !x.done && !x.skipped);
  const done = s.items.filter((x) => x.done);
  const skipped = s.items.filter((x) => x.skipped);
  return (
    <div>
      <div className="space-y-2 px-4 py-3 sm:px-5">
        <div className="flex items-baseline justify-between text-sm"><span className="font-medium">{s.done === s.total ? "全部設定好了" : `還有 ${s.total - s.done} 項`}</span><span className="tabular-nums text-muted-foreground">{s.done} / {s.total}</span></div>
        <Bar done={s.done} total={s.total} />
      </div>
      <ul className="divide-y border-t">
        {todo.map((x) => (
          <li key={x.id} className="flex items-center gap-3 px-4 py-3 sm:px-5">
            <Circle className="size-5 shrink-0 text-muted-foreground/60" />
            <button className="min-w-0 flex-1 text-left" onClick={() => go(x.href)}>
              <div className="font-medium leading-snug">{x.title}</div>
              <div className="text-sm leading-relaxed text-muted-foreground">{x.hint}</div>
            </button>
            <Button size="sm" variant="ghost" className="shrink-0 text-muted-foreground" onClick={() => s.skip(x.id, true)} title="這項我不需要，不算進進度">不需要</Button>
            <Button size="sm" variant="outline" className="shrink-0" onClick={() => go(x.href)}>去設定<ChevronRight /></Button>
          </li>
        ))}
        {done.map((x) => (
          <li key={x.id} className="flex items-center gap-3 px-4 py-2.5 sm:px-5">
            <CheckCircle2 className="size-5 shrink-0 text-emerald-600 dark:text-emerald-400" />
            <button className="min-w-0 flex-1 text-left text-muted-foreground" onClick={() => go(x.href)}>{x.title}</button>
          </li>
        ))}
      </ul>
      {skipped.length > 0 && (
        <div className="border-t px-4 py-2 sm:px-5">
          <button className="flex items-center gap-1 py-1 text-sm text-muted-foreground" aria-expanded={showSkipped} onClick={() => setShowSkipped(!showSkipped)}>
            <ChevronRight className={cn("size-4 transition-transform", showSkipped && "rotate-90")} />標成不需要的 {skipped.length} 項
          </button>
          {showSkipped && (
            <ul className="pb-1">
              {skipped.map((x) => (
                <li key={x.id} className="flex items-center gap-3 py-1.5 pl-5 text-sm">
                  <span className="flex-1 text-muted-foreground">{x.title}</span>
                  <Button size="sm" variant="ghost" onClick={() => s.skip(x.id, false)}>還是要設定</Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

// 首頁：還沒設定完時的一條提示（可以先收起來 7 天）
const NUDGE_KEY = "setup-nudge-hide";
export function SetupNudge() {
  const s = useSetup();
  const [hidden, setHidden] = useState(() => {
    try { return Number(localStorage.getItem(NUDGE_KEY) || 0) > Date.now(); } catch { return false; }
  });
  if (hidden || !s.items || s.done >= s.total) return null;
  const next = s.items.find((x) => !x.done && !x.skipped);
  return (
    <Card className="mb-4 flex-row items-center gap-3 px-4 py-3">
      <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary"><ListChecks className="size-5" /></div>
      <button className="min-w-0 flex-1 space-y-1.5 text-left" onClick={() => go("#settings/s-setup")}>
        <div className="flex items-baseline gap-2 text-sm"><span className="font-semibold">設定進度 {s.done}/{s.total}</span>{next && <span className="truncate text-muted-foreground">下一步：{next.title}</span>}</div>
        <Bar done={s.done} total={s.total} />
      </button>
      <Button size="sm" variant="outline" className="shrink-0" onClick={() => go("#settings/s-setup")}>繼續<ChevronRight /></Button>
      <Button size="icon" variant="ghost" className="size-8 shrink-0 text-muted-foreground" aria-label="先收起來 7 天" title="先收起來 7 天" onClick={() => {
        try { localStorage.setItem(NUDGE_KEY, String(Date.now() + 7 * 86400000)); } catch { /* 無痕視窗 */ }
        setHidden(true);
      }}><X /></Button>
    </Card>
  );
}

// ---- 功能使用統計 ----

interface UsageRow { d7: number; d30: number; all: number; last: string }
interface UsageData { since: string; today: string; items: Record<string, UsageRow> }

// 功能 → 算進去的紀錄（頁面、操作、背景執行）
const FEATURES: [string, string[]][] = [
  ["開關插座", ["api:set_power", "api:turn_on", "api:turn_off", "api:restore"]],
  ["定時關閉", ["api:set_timer", "api:cancel_timer"]],
  ["情境", ["api:run_scene", "api:add_scene", "api:update_scene", "api:delete_scene"]],
  ["排程", ["page:schedule", "api:add_schedule", "api:update_schedule", "api:delete_schedule", "api:dismiss_habit", "auto:schedule-*"]],
  ["出門前檢查", ["page:leave"]],
  ["晚安", ["page:night"]],
  ["生活頁", ["page:life", "api:local_settings"]],
  ["天氣、垃圾車、公車、YouBike 小卡", ["page:sheet-*"]],
  ["家中地圖", ["page:map", "api:put_floorplan", "api:put_floorplan_image", "api:delete_floorplan_image"]],
  ["攝影機", ["page:cameras", "view:camera", "api:cameras_*"]],
  ["認臉", ["api:faces_*"]],
  ["使用時間", ["page:energy"]],
  ["網路裝置", ["page:net", "api:edit_net_device"]],
  ["誰在家、外出模式", ["api:add_person", "api:edit_person", "api:delete_person", "api:set_away"]],
  ["Wi-Fi 感測、動作規則", ["api:set_sensing", "api:set_motion_rules"]],
  ["Wi-Fi 房間定位", ["api:locate_*"]],
  ["問家裡（AI）", ["api:assistant_chat", "api:assistant_settings"]],
  ["Google Home", ["api:matter_report"]],
  ["插座內建規則", ["api:edit_kasa_rule", "api:delete_kasa_rule", "api:adopt_kasa_rule", "api:edit_kasa_away", "api:delete_kasa_away"]],
  ["編輯（房間、順序、插座）", ["page:edit", "api:update_plug", "api:add_room", "api:update_room", "api:delete_room", "api:set_order"]],
  ["設定", ["page:settings", "api:set_settings"]],
];

function matches(key: string, pats: string[]) {
  return pats.some((p) => (p.endsWith("*") ? key.startsWith(p.slice(0, -1)) : key === p));
}

function sum(data: UsageData, pats: string[]): UsageRow {
  const out: UsageRow = { d7: 0, d30: 0, all: 0, last: "" };
  for (const [k, r] of Object.entries(data.items)) {
    if (!matches(k, pats)) continue;
    out.d7 += r.d7; out.d30 += r.d30; out.all += r.all;
    if (r.last > out.last) out.last = r.last;
  }
  return out;
}

const md = (d: string) => (d ? `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}` : "—");

export function UsageList() {
  const [data, setData] = useState<UsageData | null>(null);
  const [showNotify, setShowNotify] = useState(false);
  useEffect(() => { api<UsageData>("GET", "/api/usage").then(setData).catch(() => {}); }, []);
  if (!data) return null;
  const days = Math.max(1, Math.round((Date.parse(data.today) - Date.parse(data.since)) / 86400000) + 1);
  const rows = FEATURES.map(([label, pats]) => ({ label, ...sum(data, pats) })).sort((a, b) => b.d30 - a.d30 || b.all - a.all);
  const notify = Object.entries(data.items).filter(([k]) => k.startsWith("notify:")).map(([k, r]) => ({ label: k.slice(7), ...r })).sort((a, b) => b.d30 - a.d30);
  const notifyTotal = notify.reduce((n, r) => n + r.d30, 0);
  const young = days < 14;
  return (
    <div>
      <p className="px-4 pt-3 text-sm leading-relaxed text-muted-foreground sm:px-5">
        從 {md(data.since)} 開始記（{days} 天）。只記次數，不記是誰、不記內容，資料只存在樹莓派上。{young && "記不到兩週，先別急著下結論。"}
      </p>
      <div className="px-4 py-3 sm:px-5">
        <div className="grid grid-cols-[1fr_auto_auto_auto] items-center gap-x-4 gap-y-2 text-sm">
          <div className="text-xs text-muted-foreground">功能</div>
          <div className="text-right text-xs text-muted-foreground">7 天</div>
          <div className="text-right text-xs text-muted-foreground">30 天</div>
          <div className="text-right text-xs text-muted-foreground">最後</div>
          {rows.map((r) => {
            const idle = r.d30 === 0;
            return [
              <div key={`${r.label}-l`} className={cn("flex min-w-0 items-center gap-2", idle && "text-muted-foreground")}>
                <span className="truncate">{r.label}</span>
                {idle && !young && <Badge variant="secondary" className="shrink-0 bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300">{r.all ? "30 天沒用" : "沒用過"}</Badge>}
              </div>,
              <div key={`${r.label}-7`} className="text-right tabular-nums">{r.d7 || "—"}</div>,
              <div key={`${r.label}-30`} className="text-right font-medium tabular-nums">{r.d30 || "—"}</div>,
              <div key={`${r.label}-d`} className="text-right tabular-nums text-muted-foreground">{md(r.last)}</div>,
            ];
          })}
        </div>
      </div>
      <div className="border-t px-4 py-2 sm:px-5">
        <button className="flex w-full items-center gap-1 py-1.5 text-left text-sm" aria-expanded={showNotify} onClick={() => setShowNotify(!showNotify)}>
          <ChevronRight className={cn("size-4 text-muted-foreground transition-transform", showNotify && "rotate-90")} />
          <span className="flex-1 font-medium">送出的通知</span><span className="tabular-nums text-muted-foreground">30 天 {notifyTotal} 則</span>
        </button>
        {showNotify && (
          notify.length ? (
            <ul className="pb-2 pl-5 text-sm">
              {notify.map((r) => (
                <li key={r.label} className="flex justify-between gap-3 py-1"><span className="truncate">{r.label}</span><span className="tabular-nums text-muted-foreground">{r.d30}</span></li>
              ))}
            </ul>
          ) : <p className="pb-2 pl-5 text-sm text-muted-foreground">還沒有</p>
        )}
      </div>
    </div>
  );
}

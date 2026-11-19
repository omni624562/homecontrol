import { useEffect, useState } from "react";
import { AlertCircle, CheckCircle2, Loader2, Lock, RotateCcw, Timer, WifiOff, X } from "lucide-react";
import { toast } from "sonner";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { DurationPicker } from "@/components/duration-picker";
import { Sheet } from "@/components/responsive-sheet";
import { Group, Row, Section, Value } from "@/components/settings-bits";
import { WattsRows } from "@/components/watts-field";
import { deviceIcon } from "@/components/icons";
import { api } from "@/lib/api";
import { fmtLeft, fmtSec, pad2 } from "@/lib/format";
import { useHub, useTick } from "@/lib/hub";
import type { KasaRule, Plug, Protect } from "@/lib/types";
import { cn } from "@/lib/utils";

const TIMER_OPTIONS = [300, 600, 1800, 3600];
const SHORT_OPTIONS = [30, 60, 120, 180, 300, 600, 900, 1800, 3600]; // 有最長開啟時間（澆水）用的
const PROTECT: [Protect, string, string][] = [
  ["", "不需要", "一般的燈、風扇"],
  ["confirm_off", "關閉前確認", "電腦、電視盒：突然斷電可能遺失資料"],
  ["confirm", "開關都確認", "電暖器、熨斗、水泵"],
  ["lock", "鎖定", "路由器、NAS、冰箱：App、Google Home、情境、排程、全部關閉都不能開關"],
];
const KEY_TYPES = ["沒有加密", "WEP", "WPA", "WPA2"];
const keyName = (k?: number | null) => (k == null ? "—" : KEY_TYPES[k] ?? (k > 3 ? "WPA2 以上" : "—"));
const fmtMin = (m: number) => (m < 60 ? `${m} 分鐘` : `${Math.floor(m / 60)} 小時${m % 60 ? ` ${m % 60} 分` : ""}`);
const clockSec = (epoch: number) => new Date(epoch * 1000).toLocaleTimeString("zh-TW", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });

function signal(rssi?: number | null) {
  if (rssi == null) return null;
  const level = rssi >= -55 ? 4 : rssi >= -67 ? 3 : rssi >= -75 ? 2 : 1;
  return { level, text: ["", "差", "普通", "良好", "很好"][level] };
}

function Bars({ level }: { level: number }) {
  return (
    <span className="inline-flex h-3.5 items-end gap-[2px]" aria-hidden>
      {[1, 2, 3, 4].map((i) => (
        <i key={i} className={cn("w-[3px] rounded-sm", i <= level ? (level <= 1 ? "bg-orange-500" : "bg-foreground/70") : "bg-muted-foreground/25")} style={{ height: `${i * 25}%` }} />
      ))}
    </span>
  );
}

// 插座內建排程的時間文字
function ruleText(r: KasaRule) {
  const days = r.wday.every(Boolean) ? "每天" : r.wday.map((v, i) => (v ? "日一二三四五六"[i] : "")).join("");
  const t = r.opt ? `${r.opt === 1 ? "日出" : "日落"}${r.val ? `${r.val < 0 ? "前" : "後"} ${Math.abs(r.val)} 分` : ""}` : `${pad2(Math.floor(r.val / 60))}:${pad2(r.val % 60)}`;
  return `${r.sact ? "開" : "關"} ${t} ${days}${r.enable ? "" : "（停用）"}`;
}

// 伺服器的值變了才更新；按下去先顯示新的值（樂觀更新）
function useLocal<T>(server: T): [T, (v: T) => void] {
  const [v, set] = useState(server);
  useEffect(() => set(server), [server]);
  return [v, set];
}

interface Usage {
  today: number;
  month: number;
  days?: { day: string; minutes: number }[];
}

export function DeviceSheet({ id, onClose }: { id: string | null; onClose: () => void }) {
  const { state } = useHub();
  const p = state?.plugs.find((x) => x.id === id);
  return (
    <Sheet
      open={!!id && !!p}
      onOpenChange={(v) => !v && onClose()}
      title={p?.name || ""}
      description={p ? <DeviceSub p={p} /> : undefined}
      icon={p ? <DeviceIcon p={p} /> : undefined}
      wide="xl"
    >
      {p && <DeviceBody key={p.id} p={p} />}
    </Sheet>
  );
}

function DeviceIcon({ p }: { p: Plug }) {
  const { isOn } = useHub();
  const I = p.online ? deviceIcon(p.name) : WifiOff;
  return <I className={cn(p.online && isOn(p) && "text-amber-600")} />;
}

function DeviceSub({ p }: { p: Plug }) {
  const { state, isOn } = useHub();
  const room = state?.rooms.find((r) => r.id === p.room)?.name || "還沒分房間";
  return (
    <>
      {room}・<span className={cn(p.online && isOn(p) && "font-medium text-amber-700 dark:text-amber-400")}>{!p.online ? "連不上" : isOn(p) ? "開著" : "關著"}</span>
      <span className="block text-xs text-muted-foreground/80">{[p.model, p.host].filter(Boolean).join("・")}</span>
    </>
  );
}

function DeviceBody({ p }: { p: Plug }) {
  const { state, isOn, now } = useHub();
  useTick(1000);
  const on = isOn(p);
  const t = now();
  const [busy, setBusy] = useState<string | null>(null);
  const [name, setName] = useState(p.name);
  useEffect(() => setName(p.name), [p.name]);
  const [custom, setCustom] = useState(false);
  const max = p.max_on_s || 86400;
  const [draft, setDraft] = useState(Math.min(600, max));
  const [maxDraft, setMaxDraft] = useState<number | null>(null);
  const [usage, setUsage] = useState<Usage | false | null>(null);
  const [keepOn, setKeepOn] = useLocal(p.keep_on);
  const [matter, setMatter] = useLocal(p.matter !== false);
  const [led, setLed] = useLocal(!!p.led);
  const [protect, setProtect] = useLocal<Protect>(p.protect);

  useEffect(() => {
    let alive = true;
    api<Usage>("GET", `/api/plugs/${encodeURIComponent(p.id)}/usage`)
      .then((u) => alive && setUsage(u))
      .catch(() => alive && setUsage(false));
    return () => {
      alive = false;
    };
  }, [p.id]);

  const patch = async (body: object, ok?: string) => {
    try {
      await api("PATCH", `/api/plugs/${encodeURIComponent(p.id)}`, body);
      if (ok) toast.success(ok);
      return true;
    } catch (err) {
      toast.error("沒有成功", { description: (err as Error).message });
      return false;
    }
  };
  const run = async (key: string, fn: () => Promise<unknown>, ok?: string) => {
    setBusy(key);
    try {
      await fn();
      if (ok) toast.success(ok);
    } catch (err) {
      toast.error("沒有成功", { description: (err as Error).message });
    } finally {
      setBusy(null);
    }
  };
  const setTimer = (seconds: number) =>
    run(`t${seconds}`, async () => {
      await api("POST", `/api/plugs/${encodeURIComponent(p.id)}/timer`, { seconds });
      setCustom(false);
    }, `${fmtSec(seconds)}後自動關閉`);
  const stopTimer = () => run("stop", () => api("DELETE", `/api/plugs/${encodeURIComponent(p.id)}/timer`), "已取消定時");

  const choices = p.max_on_s ? [...new Set([...SHORT_OPTIONS.filter((x) => x < max), max])].slice(-4) : TIMER_OPTIONS;
  const n = p.native;
  const net = p.net;
  const ssids = state?.router?.ssids || [];
  const counts: Record<string, number> = {};
  for (const x of state?.plugs || []) if (x.online && x.net?.ssid) counts[x.net.ssid] = (counts[x.net.ssid] || 0) + 1;
  const mainSsid = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0];
  const otherSsid = !!(mainSsid && net?.ssid && net.ssid !== mainSsid && ![mainSsid, net.ssid].every((x) => ssids.includes(x)));
  const onRouter = !!net?.ssid && ssids.includes(net.ssid);
  const weakKey = net?.key_type != null && net.key_type < 3 && !onRouter;
  const ups = net?.fw_updates || [];
  const fwText = net?.fw_check === "unavailable" ? "無法檢查（已斷開雲端）" : ups.length ? `有新版 ${ups[0].version || ""}` : net?.fw_check === "ok" ? "已是最新" : "檢查中…";
  const shared = (state?.plugs || []).filter((x) => x.host === p.host).length > 1;
  const sig = signal(p.rssi);
  const maxDay = usage && usage.days ? Math.max(1, ...usage.days.map((d) => d.minutes)) : 1;
  const nativeText = !n ? "等待同步…" : !n.ok ? n.msg || "同步失敗，稍後再試" : n.schedule ? `已寫入 ${n.schedule} 條，樹莓派離線時照樣執行` : "目前沒有排程要寫入";

  return (
    <div className="space-y-5">
      {/* 狀態和開關 */}
      {!p.online ? (
        <div className="flex items-center gap-3 rounded-2xl border border-destructive/30 bg-destructive/5 p-4 text-destructive">
          <WifiOff className="size-5 shrink-0" />
          <div><div className="font-semibold">連不上這個插座</div><div className="text-sm leading-relaxed opacity-90">檢查插頭有沒有插好、Wi-Fi 有沒有訊號</div></div>
        </div>
      ) : p.protect === "lock" ? (
        <div className="flex items-center gap-3 rounded-2xl border bg-muted/50 p-4">
          <Lock className="size-5 shrink-0 text-muted-foreground" />
          <div className="text-sm leading-relaxed">已鎖定：App、Google Home、情境、排程都不能開關。要開關請先把下面的「防呆」改掉。</div>
        </div>
      ) : null}

      <div className="grid gap-6 md:grid-cols-2">
        {/* 左欄：定時、名稱、設定、防呆 */}
        <div className="min-w-0 space-y-5">
          {p.online && p.protect !== "lock" && (
            <Section title={on ? "定時關閉" : "打開，並在多久後關閉"}>
              {on && p.timer && (
                <div className="flex items-center gap-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 dark:border-amber-500/30 dark:bg-amber-500/10">
                  <Timer className="size-4 shrink-0 text-amber-600" />
                  <div className="min-w-0 flex-1 text-sm leading-relaxed">
                    <span className="font-medium tabular-nums">{fmtLeft(p.timer - t)}</span>後自動關閉（{clockSec(p.timer)}）
                  </div>
                  {!p.max_on_s && (
                    <Button variant="ghost" size="sm" onClick={stopTimer} disabled={busy === "stop"}>
                      {busy === "stop" ? <Loader2 className="animate-spin" /> : <X />}取消
                    </Button>
                  )}
                </div>
              )}
              <div className="grid grid-cols-4 gap-2">
                {choices.map((s) => (
                  <Button key={s} variant="outline" className="h-11 px-1 transition-all active:scale-95" disabled={!!busy} onClick={() => setTimer(s)}>
                    {busy === `t${s}` && <Loader2 className="animate-spin" />}
                    {fmtSec(s)}
                  </Button>
                ))}
              </div>
              <Button variant="link" size="sm" className="h-auto px-0" onClick={() => setCustom((v) => !v)}>
                <Timer />{custom ? "收起" : "自訂時間…"}
              </Button>
              {custom && (
                <div className="space-y-2 rounded-xl bg-muted/40 p-3">
                  <DurationPicker value={draft} onChange={setDraft} max={max} />
                  <Button className="h-11 w-full" disabled={!draft || !!busy} onClick={() => setTimer(draft)}>
                    {busy === `t${draft}` && <Loader2 className="animate-spin" />}
                    {on ? "" : "打開，"}{fmtSec(draft)}後關閉
                  </Button>
                </div>
              )}
            </Section>
          )}

          <Section title="名稱" note={p.kasa_name && p.kasa_name !== p.name ? `插座本身的名稱：${p.kasa_name}（清空後改名就改回這個）` : undefined}>
            <form
              className="flex gap-2"
              onSubmit={async (e) => {
                e.preventDefault();
                setBusy("name");
                await patch({ name }, "已改名");
                setBusy(null);
              }}
            >
              <Input value={name} maxLength={30} onChange={(e) => setName(e.target.value)} aria-label="名稱" className="h-11" />
              <Button type="submit" variant="secondary" className="h-11" disabled={busy === "name" || name === p.name}>
                {busy === "name" && <Loader2 className="animate-spin" />}改名
              </Button>
            </form>
          </Section>

          <Section title="設定" note={p.max_on_s ? "App、Google Home、排程、情境、插座按鈕打開都算；插座本身也會倒數，樹莓派停掉照樣會關。" : undefined}>
            <Group>
              <Row label="房間">
                <Select value={p.room || "none"} onValueChange={(v) => patch({ room: v === "none" ? null : v })}>
                  <SelectTrigger className="w-40 bg-background" aria-label="房間"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">還沒分房間</SelectItem>
                    {state?.rooms.map((r) => <SelectItem key={r.id} value={r.id}>{r.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </Row>
              {p.mode !== "metered" && <WattsRows p={p} />}
              <Row label="常開" hint="全部關閉、情境、排程都不會關它（路由器、冰箱）" htmlFor="keep-on">
                <Switch id="keep-on" size="lg" checked={keepOn} onCheckedChange={(v) => { setKeepOn(v); patch({ keep_on: v }); }} />
              </Row>
              <Row label="最長開啟時間" hint={p.max_on_s ? `開了 ${fmtSec(p.max_on_s)}一定關，不能取消` : "澆水、電暖器這類開太久會出事的"} htmlFor="max-on">
                <Switch id="max-on" size="lg" checked={!!p.max_on_s} onCheckedChange={(v) => { setMaxDraft(null); patch({ max_on_s: v ? 600 : null }); }} />
              </Row>
              {!!p.max_on_s && (
                <div className="space-y-3 px-4 py-3">
                  <DurationPicker value={maxDraft ?? p.max_on_s} onChange={setMaxDraft} />
                  <div className="flex flex-wrap gap-2">
                    {[30, 60, 300, 600, 1800].map((x) => (
                      <Button key={x} size="sm" variant={(maxDraft ?? p.max_on_s) === x ? "default" : "outline"} className="rounded-full" onClick={() => { setMaxDraft(null); patch({ max_on_s: x }); }}>
                        {fmtSec(x)}
                      </Button>
                    ))}
                  </div>
                  {maxDraft != null && maxDraft !== p.max_on_s && (
                    <Button className="w-full" disabled={!maxDraft} onClick={async () => { if (await patch({ max_on_s: maxDraft }, "已儲存")) setMaxDraft(null); }}>
                      儲存：最長 {fmtSec(maxDraft)}
                    </Button>
                  )}
                </div>
              )}
            </Group>
          </Section>

          <Section title="防呆">
            <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="防呆">
              {PROTECT.map(([k, label, desc]) => (
                <button
                  key={k || "none"}
                  role="radio"
                  aria-checked={protect === k}
                  onClick={() => { setProtect(k); patch({ protect: k }); }}
                  className={cn(
                    "rounded-xl border p-3 text-left transition-all hover:border-primary/40 hover:bg-primary/5 active:scale-[.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    protect === k ? "border-primary bg-primary/10 ring-1 ring-primary" : "bg-muted/30",
                  )}
                >
                  <div className={cn("flex items-center gap-1.5 font-semibold", protect === k && "text-primary")}>
                    {k === "lock" && <Lock className="size-4" />}{label}
                  </div>
                  <div className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{desc}</div>
                </button>
              ))}
            </div>
          </Section>
        </div>

        {/* 右欄：Google Home、插座本身 */}
        <div className="min-w-0 space-y-5">
          <Section title="Google Home">
            <Group>
              <Row label="讓 Google Home 控制" hint="關掉後，語音說「全部關掉」也不會動到它" htmlFor="matter">
                <Switch id="matter" size="lg" checked={matter} onCheckedChange={(v) => { setMatter(v); patch({ matter: v }); }} />
              </Row>
            </Group>
          </Section>

          {p.online && (
            <Section title="插座本身">
              <Group>
                <Row label="指示燈" hint={shared ? "整條排插共用一個燈" : undefined} htmlFor="led">
                  <Switch id="led" size="lg" checked={led} onCheckedChange={(v) => { setLed(v); patch({ led: v }); }} />
                </Row>
                {net && (
                  <>
                    <Row label="Wi-Fi 網路" hint={otherSsid ? `和其他裝置不同（大多數在「${mainSsid}」）` : undefined} warn={otherSsid}>
                      <Value tone={otherSsid ? "warn" : undefined}>{net.ssid || "—"}</Value>
                    </Row>
                    <Row label="加密方式" hint={weakKey ? "比較容易被破解，建議改用 WPA2 以上" : undefined} warn={weakKey}>
                      <Value tone={weakKey ? "warn" : undefined}>{onRouter ? "WPA2 以上（路由器設定）" : keyName(net.key_type)}</Value>
                    </Row>
                    <Row label="韌體" hint={`${net.model || ""} 硬體 ${net.hw || ""}`}>
                      <Value tone={ups.length ? "warn" : undefined}>{net.fw}・{fwText}</Value>
                    </Row>
                  </>
                )}
                <Row label="Wi-Fi 訊號">
                  {sig ? (
                    <span className="flex items-center gap-2 text-sm tabular-nums"><Bars level={sig.level} />{sig.text}・{p.rssi} dBm</span>
                  ) : <Value tone="muted">—</Value>}
                </Row>
                <Row label="使用時間" hint="插座自己記錄的">
                  {usage === null ? <Value tone="muted">讀取中…</Value> : usage === false ? <Value tone="muted">讀不到</Value> : <Value>今天 {fmtMin(usage.today)}・本月 {fmtMin(usage.month)}</Value>}
                </Row>
                {usage && usage.days && (
                  <div className="flex h-14 items-end gap-[2px] px-4 py-2" role="img" aria-label="最近每天的使用時間">
                    {usage.days.map((d, i) => (
                      <div key={d.day} title={`${d.day}：${fmtMin(d.minutes)}`} className="group flex h-full flex-1 items-end">
                        <i className={cn("w-full rounded-t-sm transition-colors group-hover:bg-primary", i === usage.days!.length - 1 ? "bg-primary" : "bg-primary/40")} style={{ height: `${Math.max(d.minutes ? 4 : 0, (d.minutes / maxDay) * 100)}%` }} />
                      </div>
                    ))}
                  </div>
                )}
                <Row label="內建排程" hint={nativeText} warn={!!n && !n.ok}>
                  {n && !n.ok ? <AlertCircle className="size-5 text-orange-500" /> : n ? <CheckCircle2 className="size-5 text-emerald-500" /> : null}
                </Row>
                {!!n?.kasa?.length && (
                  <Row label="Kasa App 設的排程" hint="插座自己會執行；在「排程」頁可以修改">
                    <span className="text-right text-sm leading-relaxed">{n.kasa.map((r, i) => <span key={i} className="block">{ruleText(r)}</span>)}</span>
                  </Row>
                )}
                <Row label="TP-Link 雲端">
                  <Value>{net?.cloud_bound === false ? "已解除綁定" : net?.cloud_bound ? "綁著帳號" : p.cloud ? "連線中" : p.cloud === false ? "未連線" : "—"}</Value>
                </Row>
                <Row label="重新啟動插座" hint={`插座卡住時用；${shared ? "整條排插都會重開，" : ""}可能短暫斷電`}>
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button variant="outline" size="sm" disabled={busy === "reboot"}>
                        {busy === "reboot" ? <Loader2 className="animate-spin" /> : <RotateCcw />}重新啟動
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>重新啟動插座？</AlertDialogTitle>
                        <AlertDialogDescription className="leading-relaxed">
                          插座大約 30 秒後恢復，期間可能短暫斷電{shared ? "；整條排插的每個孔都會一起重開" : ""}。
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>取消</AlertDialogCancel>
                        <AlertDialogAction onClick={() => run("reboot", () => api("POST", `/api/plugs/${encodeURIComponent(p.id)}/reboot`), "插座重新啟動中，大約 30 秒後恢復")}>
                          重新啟動
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </Row>
              </Group>
            </Section>
          )}
        </div>
      </div>
    </div>
  );
}

// 設了防呆的插座：開關前先確認
export function needsConfirm(p: Plug, on: boolean) {
  return p.protect === "confirm" || (p.protect === "confirm_off" && on);
}

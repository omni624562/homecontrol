import { useEffect, useState, type ReactNode } from "react";
import { AlertCircle, CheckCircle2, ChevronDown, Loader2, Lock, RotateCcw, Timer, Trash2, WifiOff, X } from "lucide-react";
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
import { daysText, showT, sunLabel } from "@/components/schedule-bits";
import { Row, Section } from "@/components/settings-bits";
import { WattsRows } from "@/components/watts-field";
import { DEVICE_ICONS, deviceIcon, guessIcon } from "@/components/icons";
import { api } from "@/lib/api";
import { fmt, fmtDur, fmtLeft, fmtSec, pad2 } from "@/lib/format";
import { useHub, useTick } from "@/lib/hub";
import type { KasaRule, Plug, Protect } from "@/lib/types";
import { suggestShort } from "@/lib/map-model";
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

// 狀態的一格：上面小字、下面數字，置中；有連結的可以點
function Tile({ label, children, sub, href, warn }: { label: string; children: ReactNode; sub?: ReactNode; href?: string; warn?: boolean }) {
  const cls = cn(
    "flex min-w-0 flex-col items-center justify-center gap-0.5 rounded-xl border bg-card px-2 py-2.5 text-center",
    href && "transition-colors hover:bg-muted/60 active:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
    warn && "border-orange-300 dark:border-orange-500/40",
  );
  const inner = (
    <>
      <span className="max-w-full truncate text-xs text-muted-foreground">{label}</span>
      <span className={cn("max-w-full text-[15px] font-semibold whitespace-nowrap tabular-nums", warn && "text-orange-700 dark:text-orange-400")}>{children}</span>
      {sub && <span className="max-w-full truncate text-xs text-muted-foreground tabular-nums">{sub}</span>}
    </>
  );
  return href ? <a href={href} className={cls}>{inner}</a> : <div className={cls}>{inner}</div>;
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
      aside={p ? <DeviceState p={p} /> : undefined}
      wide
    >
      {p && <DeviceBody key={p.id} p={p} />}
    </Sheet>
  );
}

function DeviceIcon({ p }: { p: Plug }) {
  const { isOn } = useHub();
  const I = p.online ? deviceIcon(p) : WifiOff;
  return <I className={cn(p.online && isOn(p) && "text-amber-600")} />;
}

function DeviceSub({ p }: { p: Plug }) {
  const { state } = useHub();
  return <>{state?.rooms.find((r) => r.id === p.room)?.name || "還沒分區域"}</>;
}

// 標題列右邊的狀態：開著多久、還有多久關、關著、連不上
function DeviceState({ p }: { p: Plug }) {
  const { isOn, now } = useHub();
  useTick(1000);
  const t = now();
  const on = p.online && isOn(p);
  const text = !p.online ? "連不上" : !on ? "關著" : p.timer ? `${fmtLeft(p.timer - t)}後關閉` : p.on_since ? `開著・${t - p.on_since < 60 ? "剛打開" : `已開 ${fmtDur(t - p.on_since)}`}` : "開著";
  return (
    <span
      className={cn(
        "inline-flex h-8 items-center gap-1.5 rounded-full border bg-background px-3 text-sm font-medium whitespace-nowrap text-muted-foreground tabular-nums",
        on && "border-amber-300 bg-amber-100 text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/15 dark:text-amber-300",
        !p.online && "border-destructive/30 bg-destructive/10 text-destructive",
      )}
    >
      <i className={cn("size-2 rounded-full bg-neutral-400", on && "bg-amber-500", !p.online && "bg-destructive")} />
      {text}
    </span>
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
  const [risky, setRisky] = useLocal(!!p.risky);
  const [matter, setMatter] = useLocal(p.matter !== false);
  const [led, setLed] = useLocal(!!p.led);
  const [protect, setProtect] = useLocal<Protect>(p.protect);
  const [adv, setAdv] = useState(false);

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
  const shared = (state?.plugs || []).filter((x) => x.host === p.host).length > 1;
  const sig = signal(p.rssi);
  // 開了這麼久大約幾度（有設瓦數才算）
  const kwh = (min: number | null) => (min == null ? undefined : p.watts ? `約 ${fmt((min / 60) * (p.watts / 1000), 1)} 度` : "看用電 ›");
  // 存在插座裡的是哪幾個排程（排程頁設的、有打開備援、包含這個插座的）
  const backed = (state?.schedules || []).filter((x) => x.enabled && x.backup && x.action !== "scene" && x.plugs.includes(p.id));
  const backedText = backed.map((x) => {
    const when = x.time_mode && x.time_mode !== "clock" ? sunLabel(x.time_mode === "sunrise" ? 1 : 2, x.offset_min || 0) : showT(x.time);
    const after = x.duration_s ? `，${fmtSec(x.duration_s)}後${x.action === "on" ? "關" : "開"}` : x.restore_at ? `，${showT(x.restore_at)} ${x.action === "on" ? "關" : "開"}` : "";
    return `${daysText(x.days)} ${when} ${x.action === "on" ? "開" : "關"}${after}`;
  });
  const nativeText = !n ? "等待同步…" : !n.ok ? n.msg || "同步失敗，稍後再試" : n.schedule ? (
    <>
      這些排程也存在插座裡，樹莓派當機時照樣執行：
      {backedText.length ? backedText.map((t) => <span key={t} className="block font-medium text-foreground tabular-nums">・{t}</span>) : <span className="block">共 {n.schedule} 條開關規則</span>}
    </>
  ) : "這個插座沒有排程；有的話會自動存一份到插座裡，樹莓派當機時照樣執行";

  // 網路、韌體有沒有要注意的地方
  const issues: string[] = [];
  if (p.rssi != null && p.rssi < -70) issues.push(`訊號弱（${p.rssi} dBm），容易斷線`);
  if (otherSsid) issues.push(`連到另一個 Wi-Fi「${net?.ssid}」，其他裝置大多在「${mainSsid}」`);
  if (weakKey) issues.push(`Wi-Fi 加密是 ${keyName(net?.key_type)}，比較容易被破解，建議改用 WPA2 以上`);
  if (ups.length) issues.push(`有新韌體 ${ups[0].version || ""}`);
  const fwShort = net?.fw_check === "unavailable" ? "韌體無法檢查" : net?.fw_check === "ok" ? "韌體最新" : "韌體檢查中";
  // 「進階」收著的時候，有設定過的用小標籤顯示
  const chips: [string, "warn" | ""][] = [];
  if (p.keep_on) chips.push(["常開", ""]);
  if (p.risky) chips.push(["高風險", "warn"]);
  if (p.max_on_s) chips.push([`最長 ${fmtSec(p.max_on_s)}`, "warn"]);
  if (p.matter === false) chips.push(["Google Home 不控制", ""]);
  if (p.online && p.led === false) chips.push(["指示燈關", ""]);
  if (n && !n.ok) chips.push(["排程備援同步失敗", "warn"]);

  return (
    <div className="space-y-5">
      {!p.online ? (
        <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-destructive/30 bg-destructive/5 p-4 text-destructive">
          <WifiOff className="size-5 shrink-0" />
          <div className="min-w-0 flex-1 basis-48"><div className="font-semibold">連不上這個插座</div><div className="text-sm leading-relaxed opacity-90">檢查插頭有沒有插好、Wi-Fi 有沒有訊號。已經不用的插座可以從清單移除</div></div>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="outline" size="sm" className="bg-background text-destructive hover:text-destructive" disabled={busy === "forget"}>
                {busy === "forget" ? <Loader2 className="animate-spin" /> : <Trash2 />}從清單移除
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>從清單移除「{p.name}」？</AlertDialogTitle>
                <AlertDialogDescription className="leading-relaxed">
                  {shared ? "整條排插的每個孔都會一起移除。" : ""}名稱、區域這些設定會留著；之後它又連上家裡的網路，會自動再出現。
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>取消</AlertDialogCancel>
                <AlertDialogAction variant="destructive" onClick={() => run("forget", () => api("DELETE", `/api/plugs/${encodeURIComponent(p.id)}`), "已從清單移除")}>移除</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      ) : p.protect === "lock" ? (
        <div className="flex items-center gap-3 rounded-2xl border bg-muted/50 p-4">
          <Lock className="size-5 shrink-0 text-muted-foreground" />
          <div className="text-sm leading-relaxed">已鎖定：App、Google Home、情境、排程都不能開關。要開關請先把下面的「防呆」改掉。</div>
        </div>
      ) : null}

      {/* 定時 */}
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
          <div className="flex gap-2">
            {choices.map((s) => (
              <Button key={s} variant="outline" className="h-11 min-w-0 flex-1 px-1 transition-all active:scale-95" disabled={!!busy} onClick={() => setTimer(s)}>
                {busy === `t${s}` && <Loader2 className="animate-spin" />}
                {fmtSec(s)}
              </Button>
            ))}
            <Button variant="ghost" className="h-11 shrink-0 px-2 text-primary" aria-expanded={custom} onClick={() => setCustom((v) => !v)}>
              {custom ? "收起" : "自訂…"}
            </Button>
          </div>
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

      {/* 常用的設定：兩欄，標籤在上 */}
      <Section title="基本設定">
        <div className="grid grid-cols-2 gap-x-3 gap-y-3 rounded-xl border bg-muted/30 p-3">
          <form
            className="space-y-1"
            onSubmit={async (e) => {
              e.preventDefault();
              if (name === p.name) return;
              setBusy("name");
              await patch({ name }, "已改名");
              setBusy(null);
            }}
          >
            <label htmlFor="dev-name" className="block text-sm font-medium">名稱</label>
            <div className="flex gap-2">
              <Input id="dev-name" value={name} maxLength={30} onChange={(e) => setName(e.target.value)} className="h-9 min-w-0 bg-background" />
              {name !== p.name && (
                <Button type="submit" size="sm" className="h-9 shrink-0" disabled={busy === "name"}>{busy === "name" && <Loader2 className="animate-spin" />}改名</Button>
              )}
            </div>
          </form>
          <ShortName p={p} patch={patch} />
          <IconPick p={p} patch={patch} />
          <div className="space-y-1">
            <div className="text-sm font-medium">區域</div>
            <Select value={p.room || "none"} onValueChange={(v) => patch({ room: v === "none" ? null : v })}>
              <SelectTrigger className="w-full bg-background" aria-label="區域"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">還沒分區域</SelectItem>
                {state?.rooms.map((r) => <SelectItem key={r.id} value={r.id}>{r.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          {p.mode !== "metered" && <WattsRows p={p} compact />}
          <div className="space-y-1">
            <div className="text-sm font-medium">防呆</div>
            <Select value={protect || "none"} onValueChange={(v) => { const k = (v === "none" ? "" : v) as Protect; setProtect(k); patch({ protect: k }); }}>
              <SelectTrigger className="w-full bg-background" aria-label="防呆"><SelectValue>{PROTECT.find(([k]) => k === protect)?.[1]}</SelectValue></SelectTrigger>
              <SelectContent>
                {PROTECT.map(([k, label, desc]) => (
                  <SelectItem key={k || "none"} value={k || "none"} textValue={label}>
                    <span className="block">
                      <span className="block font-medium">{label}</span>
                      <span className="block max-w-64 text-xs leading-relaxed whitespace-normal text-muted-foreground">{desc}</span>
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {p.kasa_name && p.kasa_name !== p.name && <p className="col-span-full text-xs leading-relaxed text-muted-foreground">插座本身叫「{p.kasa_name}」；名稱清空再存就改回來</p>}
        </div>
      </Section>

      {/* 狀態：三格一樣大的數字（今天、本月、Wi-Fi 訊號）；有要注意的事才在下面列出來 */}
      {p.online && (
        <Section title="狀態">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Tile label="今天開了" href="#energy" sub={kwh(usage ? usage.today : null)}>{usage === null ? "…" : usage === false ? "—" : fmtMin(usage.today)}</Tile>
            <Tile label="本月開了" href="#energy" sub={kwh(usage ? usage.month : null)}>{usage === null ? "…" : usage === false ? "—" : usage.month >= 6000 ? `${Math.round(usage.month / 60)} 小時` : fmtMin(usage.month)}</Tile>
            <Tile label={net?.ssid ? `Wi-Fi・${net.ssid}` : "Wi-Fi 訊號"} warn={!!sig && sig.level <= 2} sub={[p.host, net ? (onRouter ? "WPA2 以上" : keyName(net.key_type)) : ""].filter(Boolean).join("・")}>
              {sig ? <span className="inline-flex items-center gap-1.5"><Bars level={sig.level} />{sig.text}</span> : "—"}
            </Tile>
            <Tile label="插座" warn={ups.length > 0} sub={[net?.hw ? `硬體 ${net.hw}` : "", net?.fw ? `韌體 ${net.fw}` : ""].filter(Boolean).join("・")}>
              {p.model || "—"}{fwShort === "韌體最新" && <span className="ml-1.5 text-xs font-normal text-emerald-700 dark:text-emerald-400">最新</span>}
            </Tile>
          </div>
          {issues.length > 0 && (
            <div className="mt-2 space-y-1.5 rounded-xl border border-orange-300 bg-orange-50 px-4 py-3 dark:border-orange-500/30 dark:bg-orange-500/10">
              {issues.map((x) => (
                <div key={x} className="flex gap-2 text-sm leading-relaxed font-medium text-orange-700 dark:text-orange-400"><AlertCircle className="mt-0.5 size-4 shrink-0" />{x}</div>
              ))}
            </div>
          )}
        </Section>
      )}

      {/* 進階：設一次就不太動的 */}
      <section>
        <button
          type="button"
          aria-expanded={adv}
          onClick={() => setAdv((v) => !v)}
          className={cn(
            "flex w-full flex-wrap items-center gap-2 border bg-background px-4 py-3 text-left font-semibold transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            adv ? "rounded-t-xl" : "rounded-xl",
          )}
        >
          進階
          <ChevronDown className={cn("size-4 text-muted-foreground transition-transform", adv && "rotate-180")} />
          <span className="ml-auto flex flex-wrap justify-end gap-1.5 font-normal">
            {chips.map(([text, tone]) => (
              <span key={text} className={cn("rounded-md bg-muted px-2 py-0.5 text-xs text-muted-foreground", tone === "warn" && "bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300")}>{text}</span>
            ))}
          </span>
        </button>
        {adv && (
          <div className="divide-y overflow-hidden rounded-b-xl border border-t-0 bg-muted/30">
            <Row label="常開" hint="全部關閉、情境、排程都不會關它（路由器、冰箱）" htmlFor="keep-on">
              <Switch id="keep-on" size="lg" checked={keepOn} onCheckedChange={(v) => { setKeepOn(v); patch({ keep_on: v }); }} />
            </Row>
            <Row label="高風險電器" hint="電暖器、熨斗這類：最後一個人出門就馬上關掉並通知（要在「網路裝置 → 誰在家」設定家人）" htmlFor="risky">
              <Switch id="risky" size="lg" checked={risky} disabled={keepOn} onCheckedChange={(v) => { setRisky(v); patch({ risky: v }); }} />
            </Row>
            <Row label="最長開啟時間" hint={p.max_on_s ? `開了 ${fmtSec(p.max_on_s)}一定關，不能取消。App、Google Home、排程、情境、插座按鈕打開都算；樹莓派停掉照樣會關` : "澆水、電暖器這類開太久會出事的"} htmlFor="max-on">
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
            <Row label="讓 Google Home 控制" hint="關掉後，語音說「全部關掉」也不會動到它" htmlFor="matter">
              <Switch id="matter" size="lg" checked={matter} onCheckedChange={(v) => { setMatter(v); patch({ matter: v }); }} />
            </Row>
            {p.online && (
              <Row label="指示燈" hint={shared ? "整條排插共用一個燈" : undefined} htmlFor="led">
                <Switch id="led" size="lg" checked={led} onCheckedChange={(v) => { setLed(v); patch({ led: v }); }} />
              </Row>
            )}
            {p.online && (
              <Row label="排程備援" hint={nativeText} warn={!!n && !n.ok}>
                {n && !n.ok ? (
                  <span className="inline-flex items-center gap-1.5 text-sm font-medium whitespace-nowrap text-orange-700 dark:text-orange-400"><AlertCircle className="size-4" />同步失敗</span>
                ) : n?.schedule ? (
                  <span className="inline-flex items-center gap-1.5 text-sm font-medium whitespace-nowrap text-emerald-700 dark:text-emerald-400"><CheckCircle2 className="size-4" />已同步</span>
                ) : n ? (
                  <span className="text-sm whitespace-nowrap text-muted-foreground">沒有</span>
                ) : null}
              </Row>
            )}
            {!!n?.kasa?.length && (
              <Row label="Kasa App 設的排程" hint="插座自己會執行；在「排程」頁可以修改">
                <span className="text-right text-sm leading-relaxed">{n.kasa.map((r, i) => <span key={i} className="block">{ruleText(r)}</span>)}</span>
              </Row>
            )}
            {p.online && (
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
            )}
          </div>
        )}
      </section>
    </div>
  );
}

// 設了防呆的插座：開關前先確認
export function needsConfirm(p: Plug, on: boolean) {
  return p.protect === "confirm" || (p.protect === "confirm_off" && on);
}

// 地圖上的名字（短一點，地圖上才不會疊字）；空白就用自動建議的
// 圖示：預設照名稱猜；按「換」展開圖庫自己選，選了馬上存
function IconPick({ p, patch }: { p: Plug; patch: (body: Record<string, unknown>, ok?: string) => Promise<unknown> }) {
  const [open, setOpen] = useState(false);
  const I = deviceIcon(p);
  const cur = DEVICE_ICONS.find((d) => d.key === (p.icon || guessIcon(p.name)));
  const pick = async (key: string | null) => {
    if (key !== (p.icon || null)) await patch({ icon: key }, key ? "圖示換好了" : "圖示改回自動");
    setOpen(false);
  };
  const cell = "flex flex-col items-center gap-0.5 rounded-lg border px-0.5 pt-2 pb-1 text-[0.7rem] text-muted-foreground transition-colors hover:bg-accent";
  const on = "border-primary bg-primary/10 font-bold text-primary";
  return (
    <div className="space-y-1">
      <div className="text-sm font-medium">圖示</div>
      <div className={cn("flex items-center gap-2.5 rounded-md border px-2.5 py-1.5", open && "border-primary ring-2 ring-primary/15")}>
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-amber-100 text-amber-600 dark:bg-amber-400/15 dark:text-amber-400"><I className="size-5" /></span>
        <span className="min-w-0 flex-1 text-sm">{cur?.label}<span className="text-muted-foreground">・{p.icon ? "自己選的" : "依名稱自動"}</span></span>
        <Button type="button" variant="outline" size="sm" className="h-8" aria-expanded={open} onClick={() => setOpen((v) => !v)}>{open ? "收起" : "換"}</Button>
      </div>
      {open && (
        <div className="space-y-1.5 pt-1">
          {(["燈", "家電", "其他"] as const).map((g) => (
            <div key={g} className="space-y-1">
              <div className="text-xs font-bold text-muted-foreground">{g}</div>
              <div className="grid grid-cols-[repeat(auto-fill,minmax(4rem,1fr))] gap-1.5">
                {g === "燈" && (
                  <button type="button" className={cn(cell, !p.icon && on)} onClick={() => pick(null)}>
                    <span className="h-5 text-[0.8rem] leading-5 font-bold">自動</span>依名稱
                  </button>
                )}
                {DEVICE_ICONS.filter((d) => d.group === g).map((d) => (
                  <button key={d.key} type="button" aria-pressed={p.icon === d.key} className={cn(cell, p.icon === d.key && on)} onClick={() => pick(d.key)}>
                    <d.icon className="size-5" />{d.label}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ShortName({ p, patch }: { p: Plug; patch: (body: Record<string, unknown>, ok?: string) => Promise<unknown> }) {
  const [v, setV] = useState(p.short || "");
  const tip = suggestShort(p.name);
  const dirty = v.trim() !== (p.short || "");
  return (
    <form className="space-y-1" onSubmit={async (e) => { e.preventDefault(); if (dirty) await patch({ short: v.trim() }, v.trim() ? "地圖上的名字改好了" : "地圖上改回自動的名字"); }}>
      <label htmlFor="dev-short" className="block text-sm font-medium">地圖上的名字</label>
      <div className="flex gap-2">
        <Input id="dev-short" value={v} maxLength={8} placeholder={tip} onChange={(e) => setV(e.target.value)} className="h-9 min-w-0 bg-background" />
        {dirty && <Button type="submit" size="sm" className="h-9 shrink-0">存</Button>}
      </div>
    </form>
  );
}

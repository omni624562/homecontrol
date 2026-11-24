import { useEffect, useState, type ReactNode } from "react";
import { AlertCircle, Archive, BarChart3, ListChecks, Bell, Cctv, Download, Lock, Plus, ShieldCheck, Trash2, CheckCircle2, CloudSun, KeyRound, MessageCircle, ChevronRight, ExternalLink, Loader2, MessageSquareText, Mic, Moon, Palette, Search, Wifi, WifiOff } from "lucide-react";
import { toast } from "sonner";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { JumpChips } from "@/components/jump-chips";
import { PageHeader, TABS } from "@/components/app-shell";
import { AskSetup, fmtUsd, useAsk } from "@/components/ask-sheet";
import { CloudSheet, cloudBound } from "@/components/cloud-sheet";
import { Sheet } from "@/components/responsive-sheet";
import { SenseSheet } from "@/components/sense-sheet";
import { WeatherKeys, WeatherSheet } from "@/components/weather-sheet";
import { LifeSheet } from "@/components/life-sheet";
import { SettingNumber } from "@/components/settings-bits";
import { RUSH_STYLES, previewTruckRush } from "@/components/truck-rush";
import { api } from "@/lib/api";
import { SetupList, UsageList, useSetup } from "@/components/setup-bits";
import { pad2 } from "@/lib/format";
import { useHub } from "@/lib/hub";
import { setLook, useLook } from "@/lib/look";
import { BAR_MAX, setBarTabs, setNavStyle, useBarTabs, useNavStyle } from "@/lib/nav";
import { previewStandby, setStandbyMin, useStandbyMin } from "@/components/standby";
import { Segmented } from "@/components/schedule-bits";
import type { HubState, PairedDevice } from "@/lib/types";
import { cn } from "@/lib/utils";

function SCard({ id, icon: I, title, badge, children }: { id?: string; icon: React.ElementType; title: string; badge?: ReactNode; children: ReactNode }) {
  return (
    <Card id={id} className="scroll-mt-28 gap-0 overflow-hidden py-0">
      <div className="flex items-center gap-3 border-b bg-muted/60 px-4 py-3 sm:px-5 dark:bg-muted/40">
        <div className="flex size-9 items-center justify-center rounded-lg border bg-background text-foreground/70"><I className="size-5" /></div>
        <h2 className="flex-1 text-lg font-bold tracking-tight">{title}</h2>
        {badge}
      </div>
      <div className="divide-y">{children}</div>
    </Card>
  );
}

// 一列設定：左邊說明，右邊控制項
function SRow({ label, hint, children, wrap }: { label: ReactNode; hint?: ReactNode; children?: ReactNode; wrap?: boolean }) {
  return (
    <div className={cn("flex items-center gap-3 px-4 py-3.5 sm:px-5", wrap && "flex-wrap")}>
      <div className={cn("min-w-0 flex-1", wrap && "basis-56")}>
        <div className="font-medium leading-snug">{label}</div>
        {hint && <div className="text-sm leading-relaxed text-muted-foreground">{hint}</div>}
      </div>
      {children}
    </div>
  );
}

// 點了會打開別的畫面的一列
function LinkRow({ label, hint, onClick, href }: { label: ReactNode; hint?: ReactNode; onClick?: () => void; href?: string }) {
  const cls = "flex w-full items-center gap-3 px-4 py-3.5 text-left transition-colors hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:outline-none active:bg-muted sm:px-5";
  const inner = (
    <>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 font-medium leading-snug">{label}</div>
        {hint && <div className="text-sm leading-relaxed text-muted-foreground">{hint}</div>}
      </div>
      <ChevronRight className="size-5 shrink-0 text-muted-foreground" />
    </>
  );
  return href ? <a href={href} className={cls}>{inner}</a> : <button onClick={onClick} className={cls}>{inner}</button>;
}

const put = async (body: object, ok?: string) => {
  try {
    await api("PUT", "/api/settings", body);
    if (ok) toast.success(ok);
  } catch (e) {
    toast.error("沒有成功", { description: (e as Error).message });
  }
};

// Wi-Fi 加密方式（插座回報的 key_type）
const keyName = (k: number) => ["沒有加密", "WEP", "WPA", "WPA2"][k] ?? (k > 3 ? "WPA2 以上" : "—");

// 每台插座（不是每個孔）的網路、韌體狀況，以及和大多數不一樣的地方
function netReport(s: HubState) {
  const devices = new Map<string, { net: NonNullable<HubState["plugs"][number]["net"]>; names: string[] }>();
  for (const p of s.plugs) {
    if (!p.net || !p.online) continue;
    const k = p.device || p.id;
    if (!devices.has(k)) devices.set(k, { net: p.net, names: [] });
    devices.get(k)!.names.push(p.name);
  }
  const count: Record<string, number> = {};
  for (const d of devices.values()) if (d.net.ssid) count[d.net.ssid] = (count[d.net.ssid] || 0) + 1;
  const main = Object.entries(count).sort((a, b) => b[1] - a[1])[0]?.[0];
  const ssids = s.router?.ssids || [];
  const issues: { label: string; text: string }[] = [];
  for (const d of devices.values()) {
    const label = d.names.length > 1 ? `${d.net.model || "排插"}（${d.names.join("、")}）` : d.names.join("、");
    const sameRouter = !!main && !!d.net.ssid && [main, d.net.ssid].every((x) => ssids.includes(x));
    if (main && d.net.ssid && d.net.ssid !== main && !sameRouter) issues.push({ label, text: `連到另一個 Wi-Fi「${d.net.ssid}」，其他裝置都在「${main}」` });
    const routerSsid = !!d.net.ssid && ssids.includes(d.net.ssid);
    if (d.net.key_type != null && d.net.key_type < 3 && !routerSsid) issues.push({ label, text: `Wi-Fi 加密是 ${keyName(d.net.key_type)}，比較容易被破解，建議改用 WPA2 以上` });
    if ((d.net.fw_updates || []).length) issues.push({ label, text: `有新韌體 ${d.net.fw_updates![0].version || ""}` });
  }
  const fwUnknown = [...devices.values()].some((d) => d.net.fw_check === "unavailable");
  return { main, devices: devices.size, issues, fwUnknown };
}

// 手機通知：LINE 官方的 Messaging API（自己的機器人；權杖只存在樹莓派上）
function LineSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { state } = useHub();
  const n = state?.notify;
  const [v, setV] = useState("");
  const [busy, setBusy] = useState<"" | "save" | "test" | "del">("");
  const [use, setUse] = useState<{ used?: number | null; limit?: number | null; error?: string } | null>(null);
  const on = !!n?.line;
  useEffect(() => {
    if (!on) return setUse(null);
    api<{ used?: number | null; limit?: number | null; error?: string }>("GET", "/api/notify/usage").then(setUse).catch(() => setUse(null));
  }, [on, n?.name]);
  const run = async (what: "save" | "test" | "del", fn: () => Promise<unknown>, ok: string) => {
    setBusy(what);
    try {
      await fn();
      toast.success(ok);
    } catch (e) {
      toast.error("沒有成功", { description: (e as Error).message });
    } finally {
      setBusy("");
    }
  };
  return (
    <Sheet
      open={open}
      onOpenChange={(v) => !v && onClose()}
      title="手機通知（LINE）"
      description={on ? n?.name || "已設定" : "還沒設定"}
      icon={<MessageCircle />}
      wide
      aside={on ? <Badge className="bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300">已設定</Badge> : undefined}
    >
    <div className="space-y-3">
      <div>
        <div className="leading-relaxed text-muted-foreground">
          {on
            ? `定時關閉、插座斷線、垃圾車快到時，會用 LINE 傳訊息給加了這個機器人好友的人。${use?.used != null ? `這個月已經傳 ${use.used} 則${use.limit ? `（免費上限 ${use.limit} 則，每個好友各算一則）` : ""}。` : ""}`
            : "不用另外裝 App：建一個自己的 LINE 機器人，通知會像一般訊息出現在 LINE。"}
        </div>
        {(n?.error || use?.error) && <div role="alert" className="mt-1 text-sm text-destructive">上次沒送出去：{n?.error || use?.error}</div>}
      </div>
      {!on && (
        <ol className="list-decimal space-y-2 rounded-xl border bg-muted/40 py-3 pr-4 pl-9 leading-relaxed">
          <li>到 <a className="font-medium text-primary underline-offset-4 hover:underline" href="https://manager.line.biz/" target="_blank" rel="noreferrer">LINE 官方帳號管理頁</a> 用自己的 LINE 登入，建立一個官方帳號（免費，名稱例如「我家」）。</li>
          <li>在那個帳號的「設定 → Messaging API」按「啟用 Messaging API」。同一頁的「回應設定」把自動回應訊息關掉。</li>
          <li>到 <a className="font-medium text-primary underline-offset-4 hover:underline" href="https://developers.line.biz/console/" target="_blank" rel="noreferrer">LINE Developers</a> 點進這個帳號，在「Messaging API」分頁最下面按 Issue，複製 Channel access token 貼到下面。</li>
          <li>用手機 LINE 掃同一頁的 QR code，加這個機器人好友。家人也加的話，他們也會收到。</li>
        </ol>
      )}
      <form
        className="flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!v.trim()) return;
          run("save", async () => { await api("PUT", "/api/notify", { line_token: v.trim() }); setV(""); }, "已儲存，按「測試」傳一則看看");
        }}
      >
        <Input
          value={v}
          onChange={(e) => setV(e.target.value)}
          placeholder={on ? "要換新的權杖才填" : "貼上 Channel access token"}
          type="password"
          autoCapitalize="off"
          autoComplete="off"
          spellCheck={false}
          aria-label="LINE Channel access token"
          className="h-12 min-w-0 flex-1 basis-full sm:basis-48"
        />
        <Button type="submit" variant="outline" className="h-11" disabled={!!busy || !v.trim()}>{busy === "save" && <Loader2 className="animate-spin" />}儲存</Button>
        {on && (
          <Button type="button" variant="outline" className="h-11" disabled={!!busy} onClick={() => run("test", () => api("POST", "/api/test-notify"), "已傳出測試訊息，看一下 LINE")}>
            {busy === "test" ? <Loader2 className="animate-spin" /> : <Bell />}測試
          </Button>
        )}
        {on && (
          <Button type="button" variant="ghost" className="h-11 text-destructive hover:bg-destructive/10 hover:text-destructive" disabled={!!busy} onClick={() => run("del", () => api("PUT", "/api/notify", { line_token: "" }), "已移除 LINE 通知")}>
            移除
          </Button>
        )}
      </form>
      <p className="text-xs leading-relaxed text-muted-foreground">權杖只存在樹莓派上，不會再傳回瀏覽器。通知的內容（例如「客廳燈 時間到，已經關閉」）會經過 LINE 的伺服器。</p>
    </div>
    </Sheet>
  );
}

function ReportPreview({ url, title, empty }: { url: string; title: string; empty: string }) {
  const [text, setText] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <Button
        variant="outline"
        size="sm"
        onClick={async () => {
          setText(null);
          setOpen(true);
          try {
            const r = await api<{ text: string }>("GET", url);
            setText(r.text || empty);
          } catch (e) {
            setText(`讀不到：${(e as Error).message}`);
          }
        }}
      >
        預覽
      </Button>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}（預覽）</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="max-h-[60vh] overflow-y-auto leading-relaxed whitespace-pre-wrap text-foreground">{text ?? <Loader2 className="mx-auto my-6 size-6 animate-spin text-muted-foreground" />}</div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter><AlertDialogAction>好</AlertDialogAction></AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function AskCard() {
  const { state } = useHub();
  const ask = useAsk();
  const st = state?.assistant;
  const [keyOpen, setKeyOpen] = useState(false);
  if (!st) return null;
  const setA = async (body: object, ok: string) => {
    try {
      await api("PUT", "/api/assistant", body);
      toast.success(ok);
    } catch (e) {
      toast.error("沒有成功", { description: (e as Error).message });
    }
  };
  return (
    <SCard id="s-ask" icon={MessageSquareText} title="問家裡（Claude）" badge={<Badge variant={st.configured ? "default" : "secondary"} className={cn(st.configured && "bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300")}>{st.configured ? "已設定" : "還沒設定"}</Badge>}>
      <SRow label="打字或說話控制家裡" hint="例如「客廳的燈都關掉」「這個月哪個最耗電」">
        <Button variant="outline" onClick={ask.open}><MessageSquareText />打開</Button>
      </SRow>
      {st.configured ? (
        <>
          <SRow wrap label="模型" hint="Opus 比較聰明；Haiku 便宜很多，簡單的開關、查詢夠用">
            <Select value={st.model} onValueChange={(v) => setA({ model: v }, "已換模型")}>
              <SelectTrigger className="w-56 bg-background" aria-label="模型"><SelectValue /></SelectTrigger>
              <SelectContent>{st.models.map((m) => <SelectItem key={m.id} value={m.id}>{m.name}</SelectItem>)}</SelectContent>
            </Select>
          </SRow>
          <SRow label="本月費用" hint={`${st.month_count} 次・估算，實際以 Anthropic 帳單為準`}>
            <span className="text-right font-semibold tabular-nums">{fmtUsd(st.month_usd)}</span>
          </SRow>
          <SRow wrap label="每月上限" hint="到了就先停用到下個月；家裡 Wi-Fi 上的人都能用，建議設上限">
            <Select value={String(+st.cap)} onValueChange={(v) => setA({ cap: +v }, "已更新上限")}>
              <SelectTrigger className="w-56 bg-background" aria-label="每月上限"><SelectValue /></SelectTrigger>
              <SelectContent>{[1, 3, 5, 10, 20, 50, 0].map((c) => <SelectItem key={c} value={String(c)}>{c ? `US$${c}（約 NT$${c * 32}）` : "不限"}</SelectItem>)}</SelectContent>
            </Select>
          </SRow>
          <SRow label="API 金鑰" hint="只存在樹莓派上">
            <AlertDialog>
              <AlertDialogTrigger asChild><Button variant="outline" className="text-destructive hover:text-destructive">刪除</Button></AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>刪除 API 金鑰？</AlertDialogTitle>
                  <AlertDialogDescription>刪除後就不能用「問家裡」，要再貼一次金鑰。</AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>取消</AlertDialogCancel>
                  <AlertDialogAction variant="destructive" onClick={() => setA({ key: "" }, "已刪除金鑰")}>刪除</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </SRow>
        </>
      ) : (
        <>
          <LinkRow label="API 金鑰" hint="還沒設定・貼上 Anthropic 的金鑰才能用" onClick={() => setKeyOpen(true)} />
          <Sheet open={keyOpen} onOpenChange={setKeyOpen} title="問家裡的 API 金鑰" description="只存在樹莓派上" icon={<KeyRound />} wide>
            <AskSetup />
          </Sheet>
        </>
      )}
    </SCard>
  );
}

function GoogleCard() {
  const { state } = useHub();
  const m = state?.matter;
  const admin = (
    <SRow wrap label="Matterbridge 管理頁" hint="進階：看紀錄、重設配對。只能從這裡點進去">
      <Button variant="outline" asChild><a href="/matterbridge" target="_blank" rel="noopener"><ExternalLink />打開</a></Button>
    </SRow>
  );
  const P = ({ children }: { children: ReactNode }) => <div className="px-4 py-3.5 leading-relaxed text-muted-foreground sm:px-5">{children}</div>;
  if (!m || !m.running)
    return (
      <SCard id="s-google" icon={Mic} title="Google Home" badge={<Badge variant="secondary">沒有在執行</Badge>}>
        <P>用 Google Home 語音或 App 控制插座（Matter，不經過 TP-Link 雲端）。要先在樹莓派上啟動串接：<code className="mt-1 block rounded bg-muted px-2 py-1 text-sm text-foreground">cd app &amp;&amp; docker compose up -d matterbridge</code></P>
      </SCard>
    );
  if (m.commissioned) {
    const names = [...new Set(m.fabrics.map((f) => f.vendor))];
    const on = state?.settings.matter_scenes !== false;
    return (
      <SCard id="s-google" icon={Mic} title="Google Home" badge={<Badge className="bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300">已連上</Badge>}>
        <P>
          {m.plugs} 個插座已加入{names.join("、") || "Google Home"}。可以說「Hey Google，關掉{state?.plugs[0]?.name || "立燈"}」。
          <details className="mt-1 text-sm">
            <summary className="cursor-pointer py-1 font-medium text-foreground">改名稱、加到 Apple 家庭或 Alexa</summary>
            名稱和房間在 Google Home App 裡設定。要再加到 Apple 家庭或 Alexa：在 Google Home 打開任一個插座 → 設定 →「連結的 Matter 應用程式與服務」。
          </details>
        </P>
        <SRow label="情境也放到 Google Home" hint={`每個情境變成一個開關，說「Hey Google，打開${state?.scenes[0]?.name || "出門"}」就執行；執行完會自己變回關`}>
          <Switch checked={on} onCheckedChange={(v) => put({ matter_scenes: v }, v ? "情境已放到 Google Home" : "情境已從 Google Home 拿掉")} aria-label="情境也放到 Google Home" />
        </SRow>
        {admin}
      </SCard>
    );
  }
  const code = m.manual_code.replace(/^(\d{4})(\d{3})(\d{4})$/, "$1-$2-$3");
  return (
    <SCard id="s-google" icon={Mic} title="Google Home" badge={<Badge className="bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300">等待配對</Badge>}>
      <div className="space-y-4 px-4 py-4 sm:px-5">
        <p className="leading-relaxed text-muted-foreground">用 Google Home 語音或 App 控制插座，不經過 TP-Link 雲端。需要家裡有 Nest 音箱、Nest Hub 或 Google TV。</p>
        <div className="flex flex-wrap items-center gap-5">
          <img src={`/api/matter/qr.svg?c=${encodeURIComponent(m.manual_code)}`} alt="配對 QR code" className="size-40 rounded-lg border bg-white p-2" />
          <div><div className="text-sm text-muted-foreground">或輸入配對碼</div><div className="text-2xl font-bold tracking-wider tabular-nums">{code}</div></div>
        </div>
        <ol className="list-decimal space-y-1 pl-5 leading-relaxed">
          <li>打開 <b>Google Home</b> App →「＋」→「裝置」→「新裝置」→ 選家庭</li>
          <li>選「<b>Matter 裝置</b>」，掃上面的 QR code（或輸入配對碼）</li>
          <li>出現「未經認證的裝置」時選「<b>仍要繼續</b>」</li>
          <li>{m.plugs} 個插座會一次加進來，再把它們分到房間</li>
        </ol>
        <p className="text-sm text-muted-foreground">配對的手機要和樹莓派在同一個 Wi-Fi。</p>
      </div>
      {admin}
    </SCard>
  );
}

function NetCheck({ s }: { s: HubState }) {
  const r = netReport(s);
  if (!r.devices) return null;
  const ok = !r.issues.length;
  const t = s.now;
  const evs = (s.net_events || []).filter((e) => (!e.kind || e.kind === "wifi") && (!e.end || t - e.end < 7 * 86400)).reverse();
  return (
    <div className="flex gap-3 px-4 py-3.5 sm:px-5">
      <div className="min-w-0 flex-1 space-y-2">
        <div>
          <div className="font-medium">網路與韌體檢查</div>
          <div className="text-sm leading-relaxed text-muted-foreground">
            {ok ? `${r.devices} 台插座都連在「${r.main || ""}」，加密 WPA2，韌體${r.fwUnknown ? "無法檢查（已斷開 TP-Link 雲端）" : "都是最新"}` : `${r.issues.length} 個地方要注意`}
          </div>
        </div>
        {r.issues.map((i, k) => (
          <div key={k} className="flex gap-2 text-sm leading-relaxed text-orange-700 dark:text-orange-400"><AlertCircle className="mt-0.5 size-4 shrink-0" /><span><b>{i.label}</b>：{i.text}</span></div>
        ))}
        {evs.map((e, k) => {
          const d = new Date(e.start * 1000);
          const at = `${d.getMonth() + 1}/${d.getDate()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
          const I = e.end ? Wifi : WifiOff;
          return (
            <div key={k} className={cn("flex gap-2 text-sm leading-relaxed", e.end ? "text-muted-foreground" : "text-orange-700 dark:text-orange-400")}>
              <I className="mt-0.5 size-4 shrink-0" />
              <span>
                <b>「{e.ssid}」</b>：
                {e.end
                  ? `${at} 斷了大約 ${Math.max(1, Math.round((e.end - e.start) / 60))} 分鐘，${e.devices} 台插座同時連不上，多半是路由器重開或當機`
                  : `從 ${at} 開始，${e.devices} 台插座同時連不上，可能是路由器的問題`}
              </span>
            </div>
          );
        })}
      </div>
      {ok && <CheckCircle2 className="size-6 shrink-0 text-emerald-600" aria-label="都正常" />}
    </div>
  );
}

const SECTIONS: [string, string][] = [["s-setup", "設定進度"], ["s-look", "外觀"], ["s-notify", "通知"], ["s-night", "晚安"], ["s-life", "天氣生活"], ["s-ask", "問家裡"], ["s-google", "Google Home"], ["s-cam", "攝影機"], ["s-dev", "裝置"], ["s-sys", "安全與備份"], ["s-tls", "HTTPS"], ["s-usage", "使用統計"]];

const ago = (t: number) => {
  const s = Date.now() / 1000 - t;
  if (s < 3600) return "剛剛";
  if (s < 86400) return `${Math.floor(s / 3600)} 小時前`;
  return `${Math.floor(s / 86400)} 天前`;
};
const when = (t: number) => {
  const d = new Date(t * 1000);
  return `${d.getMonth() + 1}/${d.getDate()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};

// 配對碼：給新裝置輸入，10 分鐘有效
function NewCode() {
  const [code, setCode] = useState<{ code: string; until: number } | null>(null);
  const [, tick] = useState(0);
  useEffect(() => {
    if (!code) return;
    const t = setInterval(() => {
      tick((x) => x + 1);
      if (Date.now() > code.until) setCode(null);
    }, 1000);
    return () => clearInterval(t);
  }, [code]);
  if (!code)
    return (
      <Button
        variant="outline"
        onClick={async () => {
          try {
            const r = await api<{ code: string; expires_in: number }>("POST", "/api/auth/code");
            setCode({ code: r.code, until: Date.now() + r.expires_in * 1000 });
          } catch (e) {
            toast.error("沒有成功", { description: (e as Error).message });
          }
        }}
      >
        <Plus />新增裝置
      </Button>
    );
  const left = Math.max(0, Math.round((code.until - Date.now()) / 1000));
  return (
    <div className="text-right">
      <div className="font-mono text-2xl font-bold tracking-[0.25em] tabular-nums" aria-label={`配對碼 ${code.code.split("").join(" ")}`}>{code.code}</div>
      <div className="text-xs text-muted-foreground">{Math.floor(left / 60)}:{pad2(left % 60)} 內在新裝置輸入</div>
    </div>
  );
}

// 安全連線（HTTPS）：樹莓派自己當憑證機構；每台要用鏡頭、麥克風的裝置裝一次根憑證
interface TlsInfo { ready: boolean; port: number; secure: boolean; fingerprint?: string; until?: string; ca_until?: string; ips?: string[]; names?: string[]; error?: string }
const TLS_STEPS: [string, string[]][] = [
  ["Windows 電腦", ["按上面的「下載憑證」", "在下載的檔案上點兩下 →「安裝憑證」→ 存放位置選「目前使用者」", "選「將所有憑證放入以下的存放區」→「瀏覽」→「受信任的根憑證授權單位」→ 完成", "關掉瀏覽器再打開，用下面的 https 網址"]],
  ["Mac", ["按「下載憑證」，點兩下下載的檔案，加到「系統」鑰匙圈", "在「鑰匙圈存取」裡找到「家庭中控 本機憑證」，點兩下 →「信任」→ 使用此憑證時選「永遠信任」", "關掉瀏覽器再打開，用下面的 https 網址"]],
  ["iPhone、iPad", ["用 Safari 打開這一頁，按「下載憑證」→「允許」", "到「設定 → 一般 → VPN 與裝置管理」安裝「家庭中控 本機憑證」", "再到「設定 → 一般 → 關於本機 → 憑證信任設定」，把它打開", "用下面的 https 網址"]],
  ["Android", ["按「下載憑證」", "到「設定 → 安全性 → 加密與憑證 → 安裝憑證 → CA 憑證」，選剛下載的檔案（各廠牌位置稍有不同）", "用下面的 https 網址"]],
];

function TlsCard() {
  const [info, setInfo] = useState<TlsInfo | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => { api<TlsInfo>("GET", "/api/tls").then(setInfo).catch(() => {}); }, []);
  if (!info) return null;
  const url = `https://${location.hostname}:${info.port}${location.pathname}${location.hash}`;
  return (
    <SCard id="s-tls" icon={Lock} title="安全連線（HTTPS）" badge={info.secure ? <Badge className="bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300">現在是 HTTPS</Badge> : undefined}>
      <p className="px-4 pt-3 text-sm leading-relaxed text-muted-foreground sm:px-5">
        瀏覽器只在 HTTPS 下讓網頁用鏡頭、麥克風（手勢遙控之類的功能）。樹莓派做了一張家裡專用的憑證，每台要用的電腦、手機裝一次就好；沒裝的照常用原本的網址，不受影響。
      </p>
      {!info.ready ? (
        <p className="px-4 py-3 text-sm text-red-600 sm:px-5 dark:text-red-400">HTTPS 還沒準備好{info.error ? `：${info.error}` : "（重新啟動後會自動產生憑證）"}</p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2 px-4 py-3 sm:px-5">
            <Button asChild><a href="/api/tls/ca.crt" download="homecontrol-ca.crt"><Download />下載憑證</a></Button>
            {!info.secure && <Button variant="outline" asChild><a href={url}><Lock />改用 HTTPS 打開</a></Button>}
          </div>
          <div className="px-4 pb-1 sm:px-5">
            {TLS_STEPS.map(([os, steps]) => (
              <div key={os} className="border-t first:border-t-0">
                <button className="flex w-full items-center justify-between py-2.5 text-left font-medium" aria-expanded={open === os} onClick={() => setOpen(open === os ? null : os)}>
                  {os}<ChevronRight className={cn("size-4 text-muted-foreground transition-transform", open === os && "rotate-90")} />
                </button>
                {open === os && <ol className="mb-3 list-decimal space-y-1 pl-5 text-sm leading-relaxed">{steps.map((x) => <li key={x}>{x}</li>)}</ol>}
              </div>
            ))}
          </div>
          <div className="space-y-1 px-4 py-3 text-sm sm:px-5">
            <div><span className="text-muted-foreground">HTTPS 網址：</span><span className="font-mono">https://{location.hostname}:{info.port}</span></div>
            <div><span className="text-muted-foreground">包含的位址：</span>{[...(info.ips || []), ...(info.names || [])].join("、")}</div>
            <div><span className="text-muted-foreground">伺服器憑證到：</span>{info.until}（到期前會自動換新，不用重裝）・根憑證到 {info.ca_until}</div>
            <div className="break-all"><span className="text-muted-foreground">根憑證指紋（SHA-256，安裝時可以對照）：</span><span className="font-mono text-xs">{info.fingerprint}</span></div>
            <p className="pt-1 text-xs text-muted-foreground">Firefox 用自己的憑證清單：到「設定 → 隱私權與安全性 → 憑證 → 檢視憑證 → 憑證機構 → 匯入」。根憑證的私鑰只在樹莓派上，不會傳出去。</p>
          </div>
        </>
      )}
    </SCard>
  );
}

function SystemCard({ s }: { s: HubState }) {
  const [devices, setDevices] = useState<PairedDevice[] | null>(null);
  const [trusted, setTrusted] = useState<{ mac: string; name: string; online: boolean; current: boolean }[]>([]);
  const [backing, setBacking] = useState(false);
  const load = () =>
    api<{ devices: PairedDevice[]; trusted?: { mac: string; name: string; online: boolean; current: boolean }[] }>("GET", "/api/auth/devices")
      .then((r) => {
        setDevices(r.devices);
        setTrusted(r.trusted || []);
      })
      .catch(() => setDevices([]));
  useEffect(() => {
    load();
  }, []);
  const b = s.backup;
  const backupHint = !b?.configured
    ? "沒有設定備份資料夾（見 app/docker-compose.yml）"
    : b.ok === false
      ? `上次失敗：${b.error}`
      : `每天 03:30 備份到 ${b.dir}・${b.latest ? `最新 ${b.latest.replace(/^plughub-|\.tar\.gz$/g, "")}` : "還沒有備份"}・共 ${b.count} 份`;
  return (
    <SCard id="s-sys" icon={ShieldCheck} title="安全與備份" badge={s.app_version ? <Badge variant="secondary" className="font-mono">{s.app_version}</Badge> : undefined}>
      <SRow
        wrap
        label="自動認得的裝置"
        hint={trusted.length
          ? `${trusted.map((t) => t.name + (t.current ? "（這台）" : "")).join("、")}・不用配對`
          : "家人的手機在「網路裝置 → 誰在家」登記後就自動認得；家裡的平板在網路裝置裡打開「不用配對」"}
      >
        <Button variant="outline" asChild><a href="#net">網路裝置</a></Button>
      </SRow>
      <SRow wrap label="用配對碼的裝置" hint="客人或不在上面的裝置，按「新增裝置」拿配對碼（10 分鐘有效）">
        <NewCode />
      </SRow>
      {devices?.map((d) => (
        <SRow
          key={d.id}
          label={<span className="flex items-center gap-2">{d.name}{d.current && <Badge variant="secondary">這台</Badge>}</span>}
          hint={`配對於 ${when(d.created)}・上次使用 ${ago(d.last_seen)}`}
        >
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="ghost" size="icon" aria-label={`移除 ${d.name}`}><Trash2 /></Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>移除「{d.name}」？</AlertDialogTitle>
                <AlertDialogDescription>{d.current ? "這是你現在用的裝置，移除後要重新輸入配對碼。" : "那台裝置就不能再控制插座，要重新配對才行。"}</AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>取消</AlertDialogCancel>
                <AlertDialogAction
                  onClick={async () => {
                    try {
                      await api("DELETE", `/api/auth/devices/${d.id}`);
                      toast.success(`已移除 ${d.name}`);
                      load();
                    } catch (e) {
                      toast.error("沒有成功", { description: (e as Error).message });
                    }
                  }}
                >
                  移除
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </SRow>
      ))}
      <SRow
        wrap
        label={<span className="flex items-center gap-2">自動備份{b?.ok === false && <Badge className="bg-orange-100 text-orange-800 dark:bg-orange-500/15 dark:text-orange-300">失敗</Badge>}</span>}
        hint={backupHint}
      >
        <Button
          variant="outline"
          disabled={backing || !b?.configured || b?.busy}
          onClick={async () => {
            setBacking(true);
            try {
              await api("POST", "/api/backup");
              toast.success("備份好了");
            } catch (e) {
              toast.error("備份失敗", { description: (e as Error).message });
            } finally {
              setBacking(false);
            }
          }}
        >
          {backing ? <Loader2 className="animate-spin" /> : <Archive />}現在備份
        </Button>
      </SRow>
      {b?.ok && b.at && <SRow label="上次備份" hint={`${when(b.at)}・${b.file}・${Math.round((b.size || 0) / 1024)} KB${b.verified ? "・已確認能還原" : ""}`} />}
    </SCard>
  );
}

// 設定進度：還沒設定完的功能
function SetupCard() {
  const s = useSetup();
  if (!s.items) return null;
  return (
    <SCard id="s-setup" icon={ListChecks} title="設定進度" badge={<Badge variant="secondary" className="tabular-nums">{s.done}/{s.total}</Badge>}>
      <SetupList s={s} />
    </SCard>
  );
}

// 攝影機：搬到主選單的「攝影機」頁
function CameraLinkCard() {
  return (
    <SCard id="s-cam" icon={Cctv} title="攝影機">
      <LinkRow label="攝影機和認臉" hint="即時畫面、這台要幫我做什麼、誰可以看畫面、紀錄，都在「攝影機」頁" href="#cameras" />
      <RecordingRows />
    </SCard>
  );
}

// 錄影（另一台主機全天錄）：全部留幾天、有事的片段留幾天、硬碟用了多少
interface RecInfo {
  configured: boolean; ok?: boolean; error?: string | null; keep?: { all: number; event: number };
  disk?: { free_gb: number; total_gb: number; rec_gb?: number; event_gb?: number }; cams?: Record<string, { recording: boolean }>;
}
function RecordingRows() {
  const [r, setR] = useState<RecInfo | null>(null);
  useEffect(() => { api<RecInfo>("GET", "/api/recorder").then(setR).catch(() => setR(null)); }, []);
  if (!r?.configured || !r.keep) return null;
  const keep = r.keep;
  const put = async (body: object) => {
    try {
      setR(await api<RecInfo>("PUT", "/api/recorder", body));
      toast.success("已更新", { description: "超過的錄影會在 5 分鐘內清掉" });
    } catch (e) {
      toast.error("沒有成功", { description: (e as Error).message });
    }
  };
  const d = r.disk;
  const camsOn = Object.values(r.cams || {}).filter((c) => c.recording).length;
  const pct = (gb: number) => `${Math.min(100, (gb / Math.max(1, d?.total_gb || 1)) * 100)}%`;
  return (
    <>
      <SRow label="錄影" hint={r.ok ? `${camsOn} 台正在錄（Jetson）` : `錄影機連不上${r.error ? `：${r.error}` : ""}`}>
        <span className={cn("size-2.5 rounded-full", r.ok && camsOn ? "bg-red-500" : "bg-muted-foreground")} aria-hidden />
      </SRow>
      <SRow label="全部錄影留" hint="這幾天內任何時間都能回放">
        <Select value={String(keep.all)} onValueChange={(v) => put({ keep_all: Number(v) })}>
          <SelectTrigger className="w-28 bg-background" aria-label="全部錄影留幾天"><SelectValue /></SelectTrigger>
          <SelectContent>{[1, 2, 3, 5, 7, 14].map((n) => <SelectItem key={n} value={String(n)}>{n} 天</SelectItem>)}</SelectContent>
        </Select>
      </SRow>
      <SRow label="有事的片段留" hint="有人來、門開了、包裹…前後各 1 分鐘；找錄影也能找這麼久">
        <Select value={String(keep.event)} onValueChange={(v) => put({ keep_event: Number(v) })}>
          <SelectTrigger className="w-28 bg-background" aria-label="有事的片段留幾天"><SelectValue /></SelectTrigger>
          <SelectContent>{[7, 14, 30, 60, 90].filter((n) => n >= keep.all).map((n) => <SelectItem key={n} value={String(n)}>{n} 天</SelectItem>)}</SelectContent>
        </Select>
      </SRow>
      {d && d.rec_gb !== undefined && (
        <div className="space-y-1.5 border-t px-4 py-3.5 sm:px-5">
          <div className="flex h-3 overflow-hidden rounded bg-muted" role="img" aria-label={`錄影用了 ${d.rec_gb} GB，硬碟剩 ${d.free_gb} GB`}>
            <i className="h-full bg-primary" style={{ width: pct((d.rec_gb || 0) - (d.event_gb || 0)) }} />
            <i className="h-full bg-amber-500" style={{ width: pct(d.event_gb || 0) }} />
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground tabular-nums">
            <span><i className="mr-1 inline-block size-2 rounded-sm bg-primary align-middle" />最近 {keep.all} 天全部 {Math.round((d.rec_gb || 0) - (d.event_gb || 0))} GB</span>
            <span><i className="mr-1 inline-block size-2 rounded-sm bg-amber-500 align-middle" />更早的有事片段 {Math.round(d.event_gb || 0)} GB</span>
            <span>硬碟剩 {Math.round(d.free_gb)} GB／{Math.round(d.total_gb)} GB</span>
          </div>
        </div>
      )}
    </>
  );
}

// 下方分頁放哪幾頁：點一下加入／拿掉，最多 4 個，其他在「更多」
function BarTabsPicker() {
  const chosen = useBarTabs();
  const toggle = (key: string) => {
    if (chosen.includes(key)) {
      if (chosen.length <= 1) return toast("至少要放一頁");
      setBarTabs(chosen.filter((k) => k !== key));
    } else {
      if (chosen.length >= BAR_MAX) return toast(`最多放 ${BAR_MAX} 頁`, { description: "先點一個已選的拿掉" });
      setBarTabs(TABS.map((t) => t.key).filter((k) => k === key || chosen.includes(k)));
    }
  };
  return (
    <div className="border-t px-4 py-3.5 sm:px-5">
      <div className="font-medium leading-snug">下方放哪幾頁</div>
      <div className="mb-2.5 text-sm leading-relaxed text-muted-foreground">最多 {BAR_MAX} 頁，沒選的放在「更多」裡；只換這台裝置</div>
      <div className="flex flex-wrap gap-2">
        {TABS.map((t) => {
          const on = chosen.includes(t.key);
          return (
            <button key={t.key} aria-pressed={on} onClick={() => toggle(t.key)}
              className={cn("flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", on ? "border-primary bg-primary/10 font-medium text-primary" : "bg-background text-muted-foreground hover:bg-muted")}>
              <t.icon className="size-4" />{t.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// 晚安檢查：幾點檢查、通知還是直接關、哪些電器晚上本來就開著
function GoodnightCard({ s }: { s: HubState }) {
  const gn = (s.settings.goodnight || {}) as { at?: string; mode?: "notify" | "off" | "none"; keep?: string[] };
  const mode = gn.mode || "notify";
  const keep = new Set(gn.keep || []);
  const times = ["21:30", "22:00", "22:30", "23:00", "23:30", "00:00", "00:30", "01:00"];
  const at = gn.at || "23:30";
  const cands = s.plugs.filter((p) => !p.keep_on);
  return (
    <SCard id="s-night" icon={Moon} title="晚安檢查">
      <SRow wrap label="睡前還開著的電器" hint="到了這個時間、有人在家，還有電器開著就通知或直接關掉（沒人在家時交給「出門」的檢查）；首頁晚上也有「晚安」按鈕可以自己檢查">
        <div className="flex flex-wrap items-center gap-2">
          <Select value={mode} onValueChange={(v) => put({ goodnight: { mode: v } }, v === "none" ? "不做晚安檢查" : v === "off" ? "晚安時會自動關掉" : "晚安時會通知")}>
            <SelectTrigger className="w-28 bg-background" aria-label="晚安檢查要做什麼"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="notify">通知</SelectItem>
              <SelectItem value="off">自動關掉</SelectItem>
              <SelectItem value="none">不檢查</SelectItem>
            </SelectContent>
          </Select>
          {mode !== "none" && (
            <Select value={at} onValueChange={(v) => put({ goodnight: { at: v } }, `每天 ${v} 檢查`)}>
              <SelectTrigger className="w-24 bg-background" aria-label="晚安檢查時間"><SelectValue /></SelectTrigger>
              <SelectContent>
                {(times.includes(at) ? times : [at, ...times]).map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}
              </SelectContent>
            </Select>
          )}
        </div>
      </SRow>
      {mode !== "none" && cands.length > 0 && (
        <div className="px-4 py-3.5 sm:px-5">
          <div className="font-medium leading-snug">晚上本來就開著的</div>
          <div className="mb-2.5 text-sm leading-relaxed text-muted-foreground">點一下選起來，晚安檢查就不會管它（例如電扇、除濕機）；設成「常開」的本來就不算</div>
          <div className="flex flex-wrap gap-2">
            {cands.map((p) => {
              const on = keep.has(p.id);
              return (
                <button key={p.id} aria-pressed={on}
                  onClick={() => { const next = new Set(keep); if (on) next.delete(p.id); else next.add(p.id); put({ goodnight: { keep: [...next] } }); }}
                  className={cn("rounded-full border px-3 py-1.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", on ? "border-primary bg-primary/10 font-medium text-primary" : "bg-background text-muted-foreground hover:bg-muted")}>
                  {p.name}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </SCard>
  );
}

export function SettingsPage() {
  const look = useLook();
  const { state: hubState } = useHub();
  useEffect(() => {
    const part = location.hash.split("/")[1];
    if (!part || !hubState) return;
    const t = setTimeout(() => document.getElementById(part)?.scrollIntoView({ behavior: "smooth", block: "start" }), 300);
    return () => clearTimeout(t);
  }, [!!hubState]); // eslint-disable-line react-hooks/exhaustive-deps
  const navStyle = useNavStyle();
  const standby = useStandbyMin();
  const { state, connected } = useHub();
  const [sheet, setSheet] = useState<"sense" | "cloud" | "weather" | "life" | "line" | "keys" | null>(null);
  const [finding, setFinding] = useState(false);
  if (!state)
    return (
      <>
        <PageHeader title="設定" />
        <div className="mx-auto grid max-w-[112rem] gap-4 px-4 py-4 sm:px-6 lg:grid-cols-2 lg:px-8" aria-busy="true" aria-label="載入中">
          {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-64 rounded-xl" />)}
        </div>
      </>
    );
  const set = state.settings;
  const metered = state.plugs.some((p) => p.mode === "metered");
  const bound = cloudBound(state.plugs).length;
  const weekly = set.weekly !== false;
  const remind = (set.remind || {}) as { long_on?: boolean; rain?: boolean; outage_eve?: boolean; dayoff?: boolean; warn?: boolean; quake?: boolean; power?: boolean; air?: boolean; anomaly?: boolean; tier?: boolean };
  const putRemind = (k: keyof typeof remind, v: boolean, label: string) => put({ remind: { [k]: v } }, `${label}${v ? "已打開" : "已關閉"}`);

  return (
    <>
      <PageHeader title="設定" chips={<JumpChips sections={SECTIONS} />} chipsClassName="lg:hidden" />
      <div className="mx-auto grid max-w-[112rem] items-start gap-4 px-4 py-4 sm:px-6 lg:grid-cols-2 lg:px-8">
        <div className="min-w-0 space-y-4">
          <SetupCard />
          <SCard id="s-notify" icon={Bell} title="提醒與通知">
            <SRow wrap label="開太久提醒" hint="插座開超過這麼久，名稱下方會變橘色（常開的不算）">
              <SettingNumber k="long_on_hours" step={1} unit="小時" label="開太久提醒" />
            </SRow>
            <SRow label="開太久也通知手機" hint="每次開著只講一次；常開的、「出門」情境裡設成不動的不算">
              <Switch checked={remind.long_on !== false} onCheckedChange={(v) => putRemind("long_on", v, "開太久通知")} aria-label="開太久也通知手機" />
            </SRow>
            <SRow label="早上下雨提醒" hint="今天白天降雨機率 60% 以上，早上 7 點通知帶傘">
              <Switch checked={remind.rain !== false} onCheckedChange={(v) => putRemind("rain", v, "下雨提醒")} aria-label="早上下雨提醒" />
            </SRow>
            <SRow label="停水停電前一晚提醒" hint="明天你家附近要停水停電，前一天晚上 8 點再通知一次">
              <Switch checked={remind.outage_eve !== false} onCheckedChange={(v) => putRemind("outage_eve", v, "前一晚提醒")} aria-label="停水停電前一晚提醒" />
            </SRow>
            <SRow label="停班停課" hint="人事行政總處發布你家縣市（或你家的區）今天、明天停班停課就通知；停止上班的那天，「國定假日不執行」的排程也會跳過">
              <Switch checked={remind.dayoff !== false} onCheckedChange={(v) => putRemind("dayoff", v, "停班停課通知")} aria-label="停班停課通知" />
            </SRow>
            <SRow label="天氣特報" hint="氣象署對你家縣市發布豪雨、颱風、低溫、強風等特報時通知（每一則講一次）">
              <Switch checked={remind.warn !== false} onCheckedChange={(v) => putRemind("warn", v, "天氣特報通知")} aria-label="天氣特報通知" />
            </SRow>
            <SRow label="地震" hint="你家附近震度 3 級以上就通知，順便列出當時開著的電器">
              <Switch checked={remind.quake !== false} onCheckedChange={(v) => putRemind("quake", v, "地震通知")} aria-label="地震通知" />
            </SRow>
            <SRow label="供電吃緊" hint="台電預估今天備轉容量率掉到橘燈（6% 以下）就通知">
              <Switch checked={remind.power !== false} onCheckedChange={(v) => putRemind("power", v, "供電吃緊通知")} aria-label="供電吃緊通知" />
            </SRow>
            <SRow label="明天空氣品質不好" hint="明天你家空品區預報 AQI 超過 100，前一晚 8 點通知">
              <Switch checked={remind.air !== false} onCheckedChange={(v) => putRemind("air", v, "空品通知")} aria-label="明天空氣品質不好通知" />
            </SRow>
            <SRow label="用電和平常不一樣" hint="某個電器最近 3 天比它自己平常用得多（冰箱變耗電、開得比平常久），或待機功率變高；每天早上 9 點檢查">
              <Switch checked={remind.anomaly !== false} onCheckedChange={(v) => putRemind("anomaly", v, "用電異常通知")} aria-label="用電異常通知" />
            </SRow>
            <SRow label="電費可能跳級" hint={`插座這個月用得比上個月多，照這個速度電費單會超過下一級電價的度數就通知（一個月一次；用「用電」頁的每月度數 ${set.household_monthly_kwh ?? 300} 度估算）`}>
              <Switch checked={remind.tier !== false} onCheckedChange={(v) => putRemind("tier", v, "電費跳級提醒")} aria-label="電費可能跳級" />
            </SRow>
            {metered && (
              <SRow wrap label="功率過高通知" hint="有計量的插座超過這個瓦數 1 分鐘就通知">
                <SettingNumber k="overload_watts" step={50} unit="W" label="功率過高通知" />
              </SRow>
            )}
            {metered && (
              <SRow wrap label="待機門檻" hint="有計量的插座開著但低於這個瓦數，就當作待機">
                <SettingNumber k="standby_watts" step={0.5} unit="W" label="待機門檻" />
              </SRow>
            )}
            <LinkRow
              label={<>手機通知（LINE）{state.notify?.error && <Badge className="bg-orange-100 text-orange-800 dark:bg-orange-500/15 dark:text-orange-300">沒送出去</Badge>}</>}
              hint={state.notify?.line ? `已設定${state.notify.name ? `・${state.notify.name}` : ""}` : "還沒設定・不用另外裝 App"}
              onClick={() => setSheet("line")}
            />
            <SRow wrap label="每週摘要" hint="每週日晚上 8 點，用通知傳這週的電費、用電和網路狀況">
              <div className="flex items-center gap-3">
                <ReportPreview url="/api/weekly" title="這週的家" empty="這週還沒有資料" />
                <Switch checked={weekly} onCheckedChange={(v) => put({ weekly: v }, v ? "每週摘要已打開" : "每週摘要已關閉")} aria-label="每週摘要" />
              </div>
            </SRow>
            <SRow wrap label="每月報告" hint="每月 1 號早上 9 點，傳上個月的電費、用最多的電器、網路斷線和常斷線的插座">
              <div className="flex items-center gap-3">
                <ReportPreview url="/api/report/monthly" title="上個月的家" empty="上個月還沒有資料" />
                <Switch checked={set.monthly !== false} onCheckedChange={(v) => put({ monthly: v }, v ? "每月報告已打開" : "每月報告已關閉")} aria-label="每月報告" />
              </div>
            </SRow>
          </SCard>
          <GoodnightCard s={state} />
          <SCard id="s-life" icon={CloudSun} title="天氣與生活資訊">
            <LinkRow
              label="天氣"
              hint={state.calendar.weather ? `${state.calendar.weather.place || "中央氣象署"}・現在、24 小時、一週預報` : "還沒有氣象署授權碼"}
              onClick={() => setSheet("weather")}
            />
            <LinkRow label="生活資訊" hint="垃圾車、公車、YouBike、停水停電；選清運點、路線、你家的路名，在「生活」頁" href="#life" />
            {state.calendar.local?.garbage_supported && (
              <SRow wrap label="垃圾車快到時衝出來" hint="剩 2 站以內時，一台大垃圾車衝出來（一天一次）">
                <div className="flex flex-wrap items-center justify-end gap-2">
                  <Select
                    value={state.calendar.local.truck_rush === false ? "off" : state.calendar.local.truck_rush_style || "random"}
                    onValueChange={async (v) => {
                      try {
                        await api("PUT", "/api/local", v === "off" ? { truck_rush: false } : { truck_rush: true, truck_rush_style: v });
                        if (v === "off") toast.success("不會再衝出來了");
                        else previewTruckRush(v);
                      } catch (e) {
                        toast.error("沒有成功", { description: (e as Error).message });
                      }
                    }}
                  >
                    <SelectTrigger className="w-56 bg-background" aria-label="垃圾車衝出來的樣式"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="random">隨機</SelectItem>
                      {RUSH_STYLES.map(([k, l]) => <SelectItem key={k} value={k}>{l}</SelectItem>)}
                      <SelectItem value="off">關閉</SelectItem>
                    </SelectContent>
                  </Select>
                  <Button variant="outline" size="sm" disabled={state.calendar.local.truck_rush === false} onClick={() => previewTruckRush(state.calendar.local.truck_rush_style)}>預覽</Button>
                </div>
              </SRow>
            )}
            <SRow label="趣味小動畫" hint="全部關閉時畫面暗一下、有人回家小人走進門、電費變少噴彩帶…">
              <Switch
                checked={state.calendar.local?.fun !== false}
                aria-label="趣味小動畫"
                onCheckedChange={async (v) => {
                  try {
                    await api("PUT", "/api/local", { fun: v });
                    toast.success(v ? "小動畫已打開" : "小動畫已關閉");
                  } catch (e) {
                    toast.error("沒有成功", { description: (e as Error).message });
                  }
                }}
              />
            </SRow>
            <WeatherKeys part="show" />
            <LinkRow
              label="天氣資料的授權碼"
              hint={`氣象署${state.calendar.weather ? "已設定" : "還沒設定"}・環境部（空氣品質）${state.calendar.weather?.air_key ? "已設定" : "還沒設定"}`}
              onClick={() => setSheet("keys")}
            />
          </SCard>
          <AskCard />
        </div>

        <div className="min-w-0 space-y-4">
          <SCard id="s-look" icon={Palette} title="外觀">
            <SRow wrap label="畫面風格" hint="只換這台裝置的樣子；功能和資料都一樣，隨時可以換回來">
              <div className="w-56"><Segmented label="畫面風格" value={look} onChange={setLook} options={[["classic", "原本"], ["tech", "科技感"]]} /></div>
            </SRow>
            <div className="lg:hidden">
              <SRow wrap label="手機選單" hint="左上角「☰」打開全部頁面，或放在畫面下方（排程、網路裝置、設定在「更多」裡）；只換這台裝置">
                <div className="w-56"><Segmented label="手機選單" value={navStyle} onChange={setNavStyle} options={[["menu", "左上角 ☰"], ["tabs", "下方分頁"]]} /></div>
              </SRow>
              {navStyle === "tabs" && <BarTabsPicker />}
            </div>
            <SRow wrap label="待機畫面" hint="這台裝置沒人碰這麼久，就換成大時鐘和公車、垃圾車這些當下有用的事；碰一下回來。適合牆上的平板">
              <Select value={String(standby)} onValueChange={(v) => setStandbyMin(Number(v))}>
                <SelectTrigger className="w-32 bg-background" aria-label="待機畫面"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="0">不用</SelectItem>
                  {[1, 2, 5, 10, 30].map((n) => <SelectItem key={n} value={String(n)}>{n} 分鐘後</SelectItem>)}
                </SelectContent>
              </Select>
              <Button variant="outline" size="sm" onClick={previewStandby}>預覽</Button>
            </SRow>
            <SRow label="深色、淺色" hint="跟著手機或電腦的系統設定自動切換，兩種風格都有深淺兩套" />
          </SCard>
          <GoogleCard />
          <CameraLinkCard />
          <SCard id="s-dev" icon={Search} title="裝置">
            <NetCheck s={state} />
            <SRow label="停電後恢復插座" hint="停電回來，插座開關跟停電前不一樣就改回來（6 小時內）；高風險電器不會自動打開">
              <Switch checked={state.settings.power_restore !== false} onCheckedChange={(v) => put({ power_restore: v }, v ? "停電後會恢復插座" : "停電後不自動恢復")} aria-label="停電後恢復插座" />
            </SRow>
            <LinkRow label={<>Wi-Fi 感測 <Badge variant="secondary">實驗</Badge></>} hint="用插座的訊號擾動，猜哪裡有人在走動" onClick={() => setSheet("sense")} />
            <LinkRow label="TP-Link 雲端" hint={`${bound ? `${bound} 個插座綁著 TP-Link 帳號` : "已和 TP-Link 帳號解除綁定"}・家庭中控和 Google Home 都不需要它`} onClick={() => setSheet("cloud")} />
            <SRow label="找新插座" hint="每分鐘會自動找一次；剛插上的插座可以按這裡馬上找">
              <Button
                variant="outline"
                disabled={finding}
                onClick={async () => {
                  setFinding(true);
                  try {
                    await api("POST", "/api/discover");
                    toast.success("找好了");
                  } catch (e) {
                    toast.error("沒有成功", { description: (e as Error).message });
                  } finally {
                    setFinding(false);
                  }
                }}
              >
                {finding ? <Loader2 className="animate-spin" /> : <Search />}現在找
              </Button>
            </SRow>
            <SRow label="連線" hint={connected ? "和樹莓派連線正常" : "連不上樹莓派，重新連線中"}>
              <span className={cn("size-3 rounded-full", connected ? "bg-emerald-500" : "animate-pulse bg-amber-500")} aria-hidden />
            </SRow>
          </SCard>
          <SystemCard s={state} />
          <TlsCard />
          <SCard id="s-usage" icon={BarChart3} title="功能使用統計"><UsageList /></SCard>
        </div>
      </div>
      <SenseSheet open={sheet === "sense"} onClose={() => setSheet(null)} />
      <CloudSheet open={sheet === "cloud"} onClose={() => setSheet(null)} />
      <WeatherSheet open={sheet === "weather"} onClose={() => setSheet(null)} />
      <LifeSheet open={sheet === "life"} onClose={() => setSheet(null)} />
      <LineSheet open={sheet === "line"} onClose={() => setSheet(null)} />
      <Sheet open={sheet === "keys"} onOpenChange={(v) => !v && setSheet(null)} title="天氣資料的授權碼" description="只存在樹莓派上，不會再傳回瀏覽器" icon={<KeyRound />} wide>
        <div className="divide-y overflow-hidden rounded-xl border"><WeatherKeys part="keys" /></div>
      </Sheet>
    </>
  );
}

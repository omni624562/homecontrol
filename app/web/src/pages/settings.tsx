import { useEffect, useState, type ReactNode } from "react";
import { AlertCircle, Bell, CheckCircle2, CloudSun, ChevronRight, ExternalLink, Loader2, MessageSquareText, Mic, Search, Wifi, WifiOff } from "lucide-react";
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
import { PageHeader } from "@/components/app-shell";
import { AskSetup, fmtUsd, useAsk } from "@/components/ask-sheet";
import { CloudSheet, cloudBound } from "@/components/cloud-sheet";
import { SenseSheet } from "@/components/sense-sheet";
import { WeatherKeys, WeatherSheet } from "@/components/weather-sheet";
import { LifeSheet } from "@/components/life-sheet";
import { SettingNumber } from "@/components/settings-bits";
import { previewTruckRush } from "@/components/truck-rush";
import { api } from "@/lib/api";
import { pad2 } from "@/lib/format";
import { useHub } from "@/lib/hub";
import type { HubState } from "@/lib/types";
import { cn } from "@/lib/utils";

function SCard({ icon: I, title, badge, children }: { icon: React.ElementType; title: string; badge?: ReactNode; children: ReactNode }) {
  return (
    <Card className="gap-0 overflow-hidden py-0">
      <div className="flex items-center gap-3 border-b bg-muted/60 px-4 py-3 sm:px-5 dark:bg-muted/40">
        <div className="flex size-9 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-sm"><I className="size-5" /></div>
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

function routerLine(s: HubState) {
  const r = s.router;
  if (!r?.configured) return "還沒連到路由器";
  if (!r.ok) return `連不上路由器${r.error ? `：${r.error}` : ""}`;
  const people = s.people || [];
  const home = people.filter((x) => x.home).length;
  return `${(r.nodes || []).map((n) => n.model).join(" + ")}${people.length ? `・${home ? `${home} 人在家` : "大家都出門了"}` : "・看誰在家、陌生裝置通知"}`;
}

function Ntfy() {
  const { state } = useHub();
  const server = String(state?.settings.ntfy_topic || "");
  const [v, setV] = useState(server);
  const [busy, setBusy] = useState(false);
  useEffect(() => setV(server), [server]);
  return (
    <div className="space-y-2 px-4 py-3.5 sm:px-5">
      <div>
        <div className="font-medium">手機通知</div>
        <div className="text-sm leading-relaxed text-muted-foreground">手機裝 ntfy App，訂閱一個只有你知道的名稱（例如 home-plugs-8f3k），再填到下面。定時關閉、插座斷線時會通知你。</div>
      </div>
      <div className="flex gap-2">
        <Input
          value={v}
          onChange={(e) => setV(e.target.value)}
          onBlur={() => v !== server && put({ ntfy_topic: v.trim() }, "已儲存通知主題")}
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
          placeholder="ntfy 主題名稱"
          autoCapitalize="off"
          autoComplete="off"
          spellCheck={false}
          aria-label="ntfy 主題名稱"
          className="h-11"
        />
        <Button
          variant="outline"
          className="h-11"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await api("PUT", "/api/settings", { ntfy_topic: v.trim() });
              await api("POST", "/api/test-notify");
              toast.success("已送出測試通知");
            } catch (e) {
              toast.error("沒有成功", { description: (e as Error).message });
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? <Loader2 className="animate-spin" /> : <Bell />}測試
        </Button>
      </div>
    </div>
  );
}

function WeeklyPreview() {
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
            const r = await api<{ text: string }>("GET", "/api/weekly");
            setText(r.text || "這週還沒有資料");
          } catch (e) {
            setText(`讀不到：${(e as Error).message}`);
          }
        }}
      >
        預覽
      </Button>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>這週的家（預覽）</AlertDialogTitle>
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
    <SCard icon={MessageSquareText} title="問家裡（Claude）" badge={<Badge variant={st.configured ? "default" : "secondary"} className={cn(st.configured && "bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300")}>{st.configured ? "已設定" : "還沒設定"}</Badge>}>
      <SRow wrap label="打字或說話控制家裡" hint="「客廳的燈都關掉」「這個月哪個最耗電」「平日天黑開玄關燈」；建立排程、關閉有防呆的插座都會先問你">
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
        <div className="px-4 py-4 sm:px-5"><AskSetup /></div>
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
      <SCard icon={Mic} title="Google Home" badge={<Badge variant="secondary">沒有在執行</Badge>}>
        <P>用 Google Home 語音或 App 控制插座（Matter，不經過 TP-Link 雲端）。要先在樹莓派上啟動串接：<code className="mt-1 block rounded bg-muted px-2 py-1 text-sm text-foreground">cd app &amp;&amp; docker compose up -d matterbridge</code></P>
      </SCard>
    );
  if (m.commissioned) {
    const names = [...new Set(m.fabrics.map((f) => f.vendor))];
    const on = state?.settings.matter_scenes !== false;
    return (
      <SCard icon={Mic} title="Google Home" badge={<Badge className="bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300">已連上</Badge>}>
        <P>
          {m.plugs} 個插座已加入{names.join("、") || "Google Home"}。可以說「Hey Google，關掉{state?.plugs[0]?.name || "立燈"}」。
          <br />名稱和房間在 Google Home App 裡設定。要再加到 Apple 家庭或 Alexa：在 Google Home 打開任一個插座 → 設定 →「連結的 Matter 應用程式與服務」。
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
    <SCard icon={Mic} title="Google Home" badge={<Badge className="bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300">等待配對</Badge>}>
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
  const evs = (s.net_events || []).filter((e) => !e.end || t - e.end < 7 * 86400).reverse();
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

export function SettingsPage() {
  const { state, connected } = useHub();
  const [sheet, setSheet] = useState<"sense" | "cloud" | "weather" | "life" | null>(null);
  const [finding, setFinding] = useState(false);
  if (!state)
    return (
      <>
        <PageHeader title="設定" />
        <div className="mx-auto grid max-w-7xl gap-4 px-4 py-4 sm:px-6 lg:grid-cols-2 lg:px-8" aria-busy="true" aria-label="載入中">
          {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-64 rounded-xl" />)}
        </div>
      </>
    );
  const set = state.settings;
  const metered = state.plugs.some((p) => p.mode === "metered");
  const bound = cloudBound(state.plugs).length;
  const weekly = set.weekly !== false;

  return (
    <>
      <PageHeader title="設定" />
      <div className="mx-auto grid max-w-7xl items-start gap-4 px-4 py-4 sm:px-6 lg:grid-cols-2 lg:px-8">
        <div className="min-w-0 space-y-4">
          <SCard icon={Bell} title="提醒與通知">
            <SRow wrap label="開太久提醒" hint="插座開超過這麼久，名稱下方會變橘色（常開的不算）">
              <SettingNumber k="long_on_hours" step={1} unit="小時" label="開太久提醒" />
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
            <Ntfy />
            <SRow wrap label="每週摘要" hint="每週日晚上 8 點推播：這週的電費、開最久的電器、新連上網路的裝置、Wi-Fi 斷線次數、用最多網路的裝置">
              <div className="flex items-center gap-3">
                <WeeklyPreview />
                <Switch checked={weekly} onCheckedChange={(v) => put({ weekly: v }, v ? "每週摘要已打開" : "每週摘要已關閉")} aria-label="每週摘要" />
              </div>
            </SRow>
          </SCard>
          <SCard icon={CloudSun} title="天氣與生活資訊">
            <LinkRow
              label="天氣"
              hint={state.calendar.weather ? `${state.calendar.weather.place || "中央氣象署"}・現在、24 小時、一週預報` : "還沒有氣象署授權碼，在下面貼上"}
              onClick={() => setSheet("weather")}
            />
            <LinkRow label="生活資訊" hint="垃圾車、停水停電；選清運點、填你家的路名、通知開關" onClick={() => setSheet("life")} />
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
                    <SelectTrigger className="w-44 bg-background" aria-label="垃圾車衝出來的樣式"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="random">隨機</SelectItem>
                      <SelectItem value="side">從旁邊衝過去</SelectItem>
                      <SelectItem value="front">從正面衝出來（螢幕裂開）</SelectItem>
                      <SelectItem value="off">關閉</SelectItem>
                    </SelectContent>
                  </Select>
                  <Button variant="outline" size="sm" disabled={state.calendar.local.truck_rush === false} onClick={() => previewTruckRush(state.calendar.local.truck_rush_style)}>預覽</Button>
                </div>
              </SRow>
            )}
            <WeatherKeys />
          </SCard>
          <AskCard />
        </div>

        <div className="min-w-0 space-y-4">
          <GoogleCard />
          <SCard icon={Search} title="裝置">
            <NetCheck s={state} />
            <LinkRow label="訊號地圖" hint="在平面圖上看每個裝置的 Wi-Fi 訊號、哪裡有動靜" href="#map" />
            <LinkRow label="網路裝置與在家的人" hint={routerLine(state)} href="#net" />
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
        </div>
      </div>
      <SenseSheet open={sheet === "sense"} onClose={() => setSheet(null)} />
      <CloudSheet open={sheet === "cloud"} onClose={() => setSheet(null)} />
      <WeatherSheet open={sheet === "weather"} onClose={() => setSheet(null)} />
      <LifeSheet open={sheet === "life"} onClose={() => setSheet(null)} />
    </>
  );
}

import { useState } from "react";
import { CloudSun, Droplets, Gauge, KeyRound, Loader2, Thermometer, Umbrella, Wind, Sun } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Sheet } from "@/components/responsive-sheet";
import { RainLines } from "@/components/schedule-sheet";
import { api } from "@/lib/api";
import { weatherIcon } from "@/components/icons";
import { dayLabel, fmt, hhmm } from "@/lib/format";
import { useHub } from "@/lib/hub";
import { cn } from "@/lib/utils";

function KeyRow({ k, label, has, hint, ph }: { k: "cwa" | "moenv"; label: string; has: boolean; hint: string; ph: string }) {
  const [v, setV] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="space-y-2 px-4 py-3.5 sm:px-5"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!v.trim()) return;
        setBusy(true);
        try {
          await api("PUT", "/api/weather/keys", { [k]: v.trim() });
          setV("");
          toast.success(k === "cwa" ? "已儲存氣象署授權碼，幾秒內會查一次" : "已儲存環境部金鑰");
        } catch (x) {
          toast.error("沒有成功", { description: (x as Error).message });
        } finally {
          setBusy(false);
        }
      }}
    >
      <div>
        <div className="flex items-center gap-2 font-medium">{label}{has && <Badge className="bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300">已設定</Badge>}</div>
        <div className="text-sm leading-relaxed text-muted-foreground">{hint}</div>
      </div>
      <div className="flex gap-2">
        <Input type="password" value={v} onChange={(e) => setV(e.target.value)} placeholder={has ? "要換新的才填" : ph} autoCapitalize="off" autoComplete="off" spellCheck={false} aria-label={label} className="h-11 bg-background" />
        <Button type="submit" variant="outline" className="h-11" disabled={busy || !v.trim()}>{busy && <Loader2 className="animate-spin" />}儲存</Button>
      </div>
    </form>
  );
}

// 授權碼、首頁顯示天氣（只存在樹莓派上，不會再傳回瀏覽器）
export function WeatherKeys({ part }: { part: "keys" | "show" }) {
  const { state } = useHub();
  const c = state?.calendar;
  const w = c?.weather;
  const on = c?.weather_show !== false;
  if (part === "keys")
    return (
      <>
        <KeyRow k="cwa" label="中央氣象署授權碼" has={!!w} hint="到 opendata.cwa.gov.tw 註冊、登入，右上角「取得授權碼」" ph="CWA- 開頭" />
        <KeyRow k="moenv" label="環境部 API 金鑰（空氣品質）" has={!!w?.air_key} hint="到 data.moenv.gov.tw 註冊、登入，會員專區「API 金鑰」申請" ph="選填" />
        <p className="px-4 py-3 text-sm leading-relaxed text-muted-foreground sm:px-5">每 10 分鐘查一次附近的測站。最近的測站在樹莓派上算，家裡的位置不會送出去，氣象署只會知道查哪個測站和鄉鎮。</p>
      </>
    );
  return (
    <div className="flex items-center gap-3 px-4 py-3.5 sm:px-5">
      <div className="min-w-0 flex-1">
        <div className="font-medium">首頁顯示天氣</div>
        <div className="text-sm leading-relaxed text-muted-foreground">家裡的位置不會送出去</div>
      </div>
      <Switch
        checked={on}
        aria-label="首頁顯示天氣"
        onCheckedChange={async (v) => {
          try {
            await api("PUT", "/api/settings", { weather: v });
            toast.success(v ? "首頁會顯示天氣" : "首頁不顯示天氣");
          } catch (x) {
            toast.error("沒有成功", { description: (x as Error).message });
          }
        }}
      />
    </div>
  );
}

export function WeatherSheet({ open, onClose, inline }: { open: boolean; onClose: () => void; inline?: boolean }) {
  const { state } = useHub();
  const w = state?.calendar.weather;
  if (!w || w.temp == null)
    return (
      <Sheet inline={inline} open={open} onOpenChange={(v) => !v && onClose()} title="天氣" description="中央氣象署、環境部的開放資料" icon={<CloudSun />} wide>
        <div className="space-y-4">
          {!w ? (
            <div className="flex gap-3 rounded-xl border bg-muted/50 p-4">
              <KeyRound className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
              <div className="leading-relaxed"><div className="font-semibold">還沒有氣象署授權碼</div><div className="text-sm text-muted-foreground">到「設定 → 天氣與生活資訊」貼上授權碼就會開始查</div></div>
            </div>
          ) : (
            <p className="py-6 text-center text-muted-foreground">{w.error ? `查不到天氣：${w.error}` : "查詢中，等幾秒…"}</p>
          )}
          <Button asChild className="w-full" onClick={onClose}><a href="#settings">到設定貼上授權碼</a></Button>
        </div>
      </Sheet>
    );
  const rainSched = (state?.schedules || []).some((x) => x.skip_rain && x.enabled);
  const Now = weatherIcon(w.code, w.obs_text || w.text, w.day);
  const today = w.daily[0];
  const a = w.air;
  const facts = [
    { icon: Thermometer, k: "體感", v: w.feels != null ? `${fmt(w.feels)}°` : "—" },
    { icon: Droplets, k: "濕度", v: w.humidity != null ? `${fmt(w.humidity)}%` : "—" },
    { icon: Umbrella, k: "降雨機率", v: w.hourly[0]?.pop != null ? `${fmt(w.hourly[0].pop)}%` : "—" },
    { icon: Droplets, k: "今天雨量", v: w.rain ? `${fmt(w.rain.today, 1)} mm` : "—" },
    { icon: Wind, k: "風速", v: w.wind != null ? `${fmt(w.wind, 1)} m/s` : "—" },
    { icon: Sun, k: "紫外線", v: today?.uv != null ? `${fmt(today.uv)}${today.uv >= 8 ? " 過量" : today.uv >= 6 ? " 高" : ""}` : "—" },
    ...(a ? [{ icon: Gauge, k: "空氣品質 AQI", v: `${fmt(a.aqi)}・${a.status || ""}`, tone: a.aqi != null && a.aqi <= 50 ? "ok" : a.aqi != null && a.aqi > 100 ? "warn" : "" }] : []),
    ...(a?.pm25 != null ? [{ icon: Gauge, k: "PM2.5", v: `${fmt(a.pm25)} µg/m³` }] : []),
  ];
  const days = w.daily.filter((d) => d.max != null && d.min != null);
  const lo = Math.min(...days.map((d) => d.min!));
  const hi = Math.max(...days.map((d) => d.max!));
  const span = Math.max(1, hi - lo);
  const obs = w.obs_at ? new Date(w.obs_at) : null;
  return (
    <Sheet inline={inline} open={open} onOpenChange={(v) => !v && onClose()} title="天氣"
      description={w.place ? `${w.place}・中央氣象署` : "中央氣象署"}
      icon={<Now />}
      wide
      aside={
        <div className="text-right leading-tight">
          <div className="text-3xl font-bold tracking-tight tabular-nums">{fmt(w.temp, 1)}°</div>
          <div className="text-sm text-muted-foreground">{w.obs_text || w.text}・{fmt(today?.min)}°～{fmt(today?.max)}°</div>
        </div>
      }
    >
      <div className="space-y-5">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {facts.map((f) => (
            <div key={f.k} className="rounded-xl bg-muted/60 px-3 py-2.5">
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <f.icon className="size-3.5" />
                {f.k}
              </div>
              <div className={cn("mt-0.5 font-semibold tabular-nums", "tone" in f && f.tone === "ok" && "text-emerald-600 dark:text-emerald-400", "tone" in f && f.tone === "warn" && "text-orange-600")}>{f.v}</div>
            </div>
          ))}
        </div>
        {w.hourly.length > 0 && (
          <section className="rounded-2xl border p-3">
            <h3 className="mb-2 px-1 text-sm font-semibold">接下來 24 小時</h3>
            <div className="scroll-area -mx-1 flex gap-1 overflow-x-auto pb-1 [scrollbar-gutter:auto]">
              {w.hourly.map((h, i) => {
                const I = weatherIcon(h.code, h.text, h.day);
                return (
                  <div key={h.t} title={h.text || ""} className={cn("flex w-14 shrink-0 flex-col items-center gap-1 rounded-xl py-2 text-xs text-muted-foreground", i === 0 && "bg-primary/10 text-primary")}>
                    <span>{i === 0 ? "現在" : `${h.t.slice(0, 2)} 時`}</span>
                    <I className="size-5 text-foreground/80" />
                    <b className="text-sm font-semibold text-foreground tabular-nums">{fmt(h.temp)}°</b>
                    <span className="min-h-4 text-sky-600 dark:text-sky-400 tabular-nums">{h.pop != null && h.pop >= 20 ? `${h.pop}%` : ""}</span>
                  </div>
                );
              })}
            </div>
          </section>
        )}
        {days.length > 0 && (
          <section className="rounded-2xl border p-3">
            <h3 className="mb-1 px-1 text-sm font-semibold">這一週</h3>
            <ul className="divide-y">
              {days.map((d) => {
                const I = weatherIcon(d.code, d.text);
                return (
                  <li key={d.date} className="grid grid-cols-[3rem_1.5rem_minmax(0,1fr)_3.25rem_2.25rem_minmax(3rem,7rem)_2.25rem] items-center gap-2 px-1 py-2.5 text-sm max-sm:grid-cols-[2.75rem_1.5rem_minmax(0,1fr)_3rem_2rem_2rem]">
                    <span className="font-medium">{dayLabel(d.date)}</span>
                    <I className="size-5 text-foreground/80" />
                    <span className="truncate text-muted-foreground" title={d.text || ""}>{d.text}</span>
                    <span className="text-right text-xs text-sky-600 tabular-nums dark:text-sky-400">{d.pop != null && d.pop >= 10 ? `${d.pop}%` : ""}</span>
                    <span className="text-right text-muted-foreground tabular-nums">{fmt(d.min)}°</span>
                    <span className="relative h-1.5 rounded-full bg-muted max-sm:hidden">
                      <i className="absolute inset-y-0 rounded-full bg-gradient-to-r from-sky-400 to-amber-400" style={{ left: `${((d.min! - lo) / span) * 100}%`, right: `${((hi - d.max!) / span) * 100}%` }} />
                    </span>
                    <span className="font-semibold tabular-nums">{fmt(d.max)}°</span>
                  </li>
                );
              })}
            </ul>
          </section>
        )}
        {rainSched && <div className="space-y-1.5 rounded-xl border p-4"><div className="mb-1 text-sm font-semibold">下雨不執行的排程</div><RainLines /></div>}
        <p className="text-xs leading-relaxed text-muted-foreground">
          資料來源：中央氣象署{a ? "、環境部" : ""}開放資料
          {w.station && <><br />現在：{w.station}測站（{fmt(w.station_km, 1)} 公里）{obs && ` ${hhmm(obs)} 觀測`}</>}
          {w.rain && <><br />雨量：{w.rain.station}雨量站（{fmt(w.rain.km, 1)} 公里）</>}
          {w.place && <><br />預報：{w.place}鄉鎮預報</>}
          {a ? <><br />空氣：{a.site}測站（{fmt(a.km, 1)} 公里）</> : w.air_key && w.air_error ? <><br />空氣：查不到（{w.air_error}）</> : null}
          {w.error && <><br />最近一次查詢失敗：{w.error}</>}
        </p>
      </div>
    </Sheet>
  );
}

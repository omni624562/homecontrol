import { Droplets, Gauge, Thermometer, Umbrella, Wind, Sun } from "lucide-react";
import { Sheet } from "@/components/responsive-sheet";
import { weatherIcon } from "@/components/icons";
import { dayLabel, fmt, hhmm } from "@/lib/format";
import { useHub } from "@/lib/hub";
import { cn } from "@/lib/utils";

export function WeatherSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { state } = useHub();
  const w = state?.calendar.weather;
  if (!w) return null;
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
    <Sheet open={open} onOpenChange={(v) => !v && onClose()} title="天氣" description={w.place ? `${w.place}・中央氣象署` : "中央氣象署"} icon={<Now />} wide>
      <div className="space-y-5 pt-2">
        <div className="flex items-center gap-4">
          <Now className="size-14 text-primary" strokeWidth={1.5} />
          <div>
            <div className="text-5xl font-semibold tracking-tight tabular-nums">{fmt(w.temp, 1)}°</div>
            <div className="mt-1 text-sm text-muted-foreground">
              {w.obs_text || w.text}・今天 {fmt(today?.min)}°～{fmt(today?.max)}°
            </div>
          </div>
        </div>
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
            <div className="-mx-1 flex gap-1 overflow-x-auto pb-1 [scrollbar-width:thin]">
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
        <p className="text-xs leading-relaxed text-muted-foreground">
          資料來源：中央氣象署{a ? "、環境部" : ""}開放資料
          {w.station && <><br />現在：{w.station}測站（{fmt(w.station_km, 1)} 公里）{obs && ` ${hhmm(obs)} 觀測`}</>}
          {w.rain && <><br />雨量：{w.rain.station}雨量站（{fmt(w.rain.km, 1)} 公里）</>}
          {a && <><br />空氣：{a.site}測站（{fmt(a.km, 1)} 公里）</>}
          <br />授權碼和「首頁顯示天氣」開關目前在舊版首頁的天氣面板
        </p>
      </div>
    </Sheet>
  );
}

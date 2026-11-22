// 斷線紀錄：外網斷、基地台卡住、整個 Wi-Fi 斷、單一插座斷線、停電後恢復插座（最近 30 天）
import { useEffect, useState } from "react";
import { Globe, Plug, Power, RadioTower, Wifi } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

export interface NetEvent {
  kind: "wan" | "ap" | "wifi" | "plug" | "power";
  start: number;
  end: number | null;
  name?: string;
  ssid?: string;
  devices?: number;
  on?: string[];
  off?: string[];
  failed?: string[];
}
interface Resp { now: number; days: number; events: NetEvent[]; wan_ok: boolean }

const ICON = { wan: Globe, ap: RadioTower, wifi: Wifi, plug: Plug, power: Power };
const pad2 = (n: number) => String(n).padStart(2, "0");
const at = (t: number) => {
  const d = new Date(t * 1000);
  return `${d.getMonth() + 1}/${d.getDate()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};
const fmtDur = (s: number) => {
  const m = Math.max(1, Math.round(s / 60));
  if (m < 60) return `${m} 分鐘`;
  const h = Math.floor(m / 60);
  return `${h} 小時${m % 60 ? ` ${m % 60} 分` : ""}`;
};

function text(e: NetEvent, now: number): string {
  const dur = fmtDur((e.end ?? now) - e.start);
  const going = e.end == null;
  switch (e.kind) {
    case "wan":
      return going ? `外網連不到，已經 ${dur}` : `外網斷了 ${dur}`;
    case "ap":
      return going ? `${e.name} 卡住了：${dur}沒有任何裝置連著，重開它試試` : `${e.name} 卡住 ${dur}（沒有裝置連，網路上還找得到它）`;
    case "wifi":
      return going ? `「${e.ssid}」${e.devices} 台插座同時連不上，已經 ${dur}` : `「${e.ssid}」${e.devices} 台插座同時斷了 ${dur}，多半是路由器重開或當機`;
    case "plug":
      return going ? `${e.name} 連不上，已經 ${dur}` : `${e.name} 斷線 ${dur}`;
    case "power": {
      const p = [e.on?.length ? `開回 ${e.on.join("、")}` : "", e.off?.length ? `關掉 ${e.off.join("、")}` : "", e.failed?.length ? `${e.failed.join("、")} 沒有成功` : ""].filter(Boolean);
      return `停電後恢復插座：${p.join("；")}`;
    }
  }
}

export function NetLog() {
  const [data, setData] = useState<Resp | null>(null);
  const [all, setAll] = useState(false);
  useEffect(() => {
    let alive = true;
    const load = () => api<Resp>("GET", "/api/net/events?days=30").then((d) => alive && setData(d)).catch(() => {});
    load();
    const t = setInterval(load, 30000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);
  if (!data) return null;
  // 還沒恢復的排最前面，其他新的在前
  const evs = [...data.events].sort((a, b) => (b.end == null ? 1 : 0) - (a.end == null ? 1 : 0) || b.start - a.start);
  const wan = data.events.filter((e) => e.kind === "wan");
  const ap = data.events.filter((e) => e.kind === "ap");
  const wanSec = wan.reduce((s, e) => s + ((e.end ?? data.now) - e.start), 0);
  const shown = all ? evs : evs.slice(0, 8);
  return (
    <div className="space-y-2 px-4 py-3 sm:px-5">
      <p className="text-sm text-muted-foreground">
        最近 {data.days} 天：
        {wan.length ? `外網斷了 ${wan.length} 次、共 ${fmtDur(wanSec)}` : "外網都正常"}
        {ap.length ? `；基地台卡住 ${ap.length} 次` : ""}
        {evs.length ? "" : "，基地台和插座也都沒有斷過"}。
      </p>
      {shown.length > 0 && (
        <ul className="space-y-1.5">
          {shown.map((e, i) => {
            const I = ICON[e.kind] || Wifi;
            const going = e.end == null && e.kind !== "power";
            return (
              <li key={i} className={cn("flex gap-2 text-sm leading-relaxed", going ? "text-orange-700 dark:text-orange-400" : "text-muted-foreground")}>
                <I className="mt-0.5 size-4 shrink-0" />
                <span><span className="mr-1.5 tabular-nums">{at(e.start)}</span>{" "}{text(e, data.now)}</span>
              </li>
            );
          })}
        </ul>
      )}
      {evs.length > 8 && (
        <Button type="button" variant="ghost" size="sm" className="-ml-2" onClick={() => setAll((v) => !v)}>{all ? "收起" : `看全部 ${evs.length} 筆`}</Button>
      )}
      <p className="text-xs text-muted-foreground">外網每 30 秒試連一次公用位址；基地台超過 10 分鐘沒有裝置連、外網恢復時都會用 LINE 通知你。</p>
    </div>
  );
}

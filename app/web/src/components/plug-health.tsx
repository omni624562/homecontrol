// 插座連線健檢：最近 30 天每個插座自己斷了幾次（整個 Wi-Fi 斷、停電不算）、訊號強度、建議怎麼做
import { useEffect, useState } from "react";
import { CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

interface Health {
  id: string;
  name: string;
  rssi: number | null;
  online: boolean;
  ssid: string | null;
  drops: number;
  offline_sec: number;
  last: number | null;
  level: "bad" | "warn" | "ok";
  tip: string;
}

const signal = (r: number | null) => (r == null ? "訊號不明" : r >= -55 ? `訊號很好（${r} dBm）` : r >= -65 ? `訊號普通（${r} dBm）` : r > -70 ? `訊號偏弱（${r} dBm）` : `訊號弱（${r} dBm）`);
const dur = (s: number) => {
  const m = Math.max(1, Math.round(s / 60));
  return m < 60 ? `${m} 分鐘` : `${Math.floor(m / 60)} 小時${m % 60 ? ` ${m % 60} 分` : ""}`;
};

export function PlugHealth() {
  const [rows, setRows] = useState<Health[] | null>(null);
  const [all, setAll] = useState(false);
  useEffect(() => {
    let alive = true;
    const load = () => api<{ plugs: Health[] }>("GET", "/api/net/plug-health").then((r) => alive && setRows(r.plugs)).catch(() => {});
    load();
    const t = setInterval(load, 60000);
    return () => { alive = false; clearInterval(t); };
  }, []);
  if (!rows) return <p className="px-4 py-3 text-sm text-muted-foreground sm:px-5">讀取中…</p>;
  if (!rows.length) return <p className="px-4 py-3 text-sm text-muted-foreground sm:px-5">還沒有插座。</p>;
  const issues = rows.filter((r) => r.level !== "ok" || r.drops > 0);
  const shown = all ? rows : issues;
  return (
    <div>
      <div className="flex items-center gap-2 px-4 pt-3 pb-3 text-sm sm:px-5">
        {issues.some((r) => r.level !== "ok") ? (
          <span className="text-muted-foreground">最近 30 天，{rows.filter((r) => r.level === "bad").length} 個常斷線、{rows.filter((r) => r.level === "warn").length} 個訊號偏弱（整個 Wi-Fi 斷或停電不算）</span>
        ) : (
          <span className="flex items-center gap-1.5 text-emerald-700 dark:text-emerald-400"><CheckCircle2 className="size-4" />最近 30 天插座連線都很穩</span>
        )}
      </div>
      {shown.length > 0 && (
        <ul className="divide-y border-t">
          {shown.map((r) => (
            <li key={r.id} className="flex items-start gap-3 px-4 py-3 sm:px-5">
              <span className={cn("mt-1.5 size-2.5 shrink-0 rounded-full", r.level === "bad" ? "bg-red-500" : r.level === "warn" ? "bg-amber-500" : "bg-emerald-500")} aria-hidden />
              <div className="min-w-0 flex-1">
                <div className="font-medium">{r.name}{!r.online && <span className="ml-2 text-sm font-normal text-red-600 dark:text-red-400">現在連不上</span>}</div>
                <div className="text-sm text-muted-foreground">
                  {signal(r.rssi)}・{r.drops ? `斷了 ${r.drops} 次，共 ${dur(r.offline_sec)}` : "沒有斷過"}{r.ssid ? `・${r.ssid}` : ""}
                </div>
                {r.tip && <div className="mt-0.5 text-sm">{r.tip}</div>}
              </div>
            </li>
          ))}
        </ul>
      )}
      {issues.length < rows.length && (
        <div className="border-t px-4 py-2 sm:px-5">
          <Button variant="ghost" size="sm" className="-ml-2" onClick={() => setAll(!all)}>{all ? "只看有問題的" : `看全部 ${rows.length} 個插座`}</Button>
        </div>
      )}
    </div>
  );
}

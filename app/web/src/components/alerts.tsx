// 出事時的資訊：停班停課、天氣特報、地震、供電、空品預報
import { Activity, AlertTriangle, CheckCircle2, School, Wind, Zap } from "lucide-react";
import { Sheet } from "@/components/responsive-sheet";
import { dayLabel, pad2 } from "@/lib/format";
import type { Alerts, HubState } from "@/lib/types";
import { cn } from "@/lib/utils";

export interface AlertItem { key: string; icon: React.ElementType; label: string; sub?: string; warn: boolean; title: string }

const quakeAgeH = (t?: string) => (t ? (Date.now() - new Date(t).getTime()) / 3600000 : Infinity);
const offWord = (o: { work: boolean; school: boolean; part: string | null }) =>
  `${o.part || ""}${o.work && o.school ? "停班停課" : o.work ? "停班" : "停課"}`;

// 首頁小標籤、早安卡用：只列「現在要注意的」，平常什麼都沒有
export function alertItems(state: HubState): AlertItem[] {
  const A = state.calendar.alerts;
  if (!A) return [];
  const out: AlertItem[] = [];
  const { today, tomorrow } = A.dayoff;
  if (today) out.push({ key: "off0", icon: School, label: `今天${offWord(today)}`, warn: true, title: today.text });
  if (tomorrow) out.push({ key: "off1", icon: School, label: `明天${offWord(tomorrow)}`, warn: true, title: tomorrow.text });
  if (A.warnings.length)
    out.push({ key: "warn", icon: AlertTriangle, label: A.warnings[0].name, sub: A.warnings.length > 1 ? `等 ${A.warnings.length} 項` : undefined, warn: true,
      title: A.warnings.map((w) => w.name).join("、") });
  const q = A.quake;
  if (q && q.rank >= 2 && quakeAgeH(q.time) < 6)
    out.push({ key: "eq", icon: Activity, label: `地震 ${q.here}`, sub: q.mag != null ? `規模 ${q.mag}` : undefined, warn: q.rank >= 3, title: q.text });
  const p = A.power;
  if (p && p.light && p.light !== "G")
    out.push({ key: "pw", icon: Zap, label: `供電${p.light_name}`, sub: p.rate != null ? `備轉 ${p.rate}%` : undefined, warn: p.light !== "Y", title: `台電預估今天尖峰備轉容量率 ${p.rate}%` });
  const tmr = new Date(Date.now() + 86400000);
  const tmrIso = `${tmr.getFullYear()}-${pad2(tmr.getMonth() + 1)}-${pad2(tmr.getDate())}`;
  const bad = A.air.find((x) => x.aqi > 100 && x.date <= tmrIso);
  if (bad) out.push({ key: "air", icon: Wind, label: `${bad.date === tmrIso ? "明天" : "今天"}空品不好`, sub: `AQI ${bad.aqi}`, warn: true, title: `${bad.zone}空品區預報 AQI ${bad.aqi}（${bad.status}）` });
  return out;
}

function Row({ icon: I, warn, ok, title, children }: { icon: React.ElementType; warn?: boolean; ok?: boolean; title: React.ReactNode; children?: React.ReactNode }) {
  return (
    <li className="flex gap-3 py-3">
      <I className={cn("mt-0.5 size-5 shrink-0", warn ? "text-red-600 dark:text-red-400" : ok ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground")} />
      <div className="min-w-0 flex-1">
        <div className={cn("font-semibold", warn && "text-red-700 dark:text-red-300")}>{title}</div>
        {children && <div className="mt-0.5 text-sm leading-relaxed text-muted-foreground">{children}</div>}
      </div>
    </li>
  );
}

const hm = (t?: string | null) => (t ? t.slice(5, 16).replace("-", "/").replace("T", " ") : "");

// 生活頁的卡片：每一項都列出來（沒事就寫「沒有」），讓人知道有在看
export function AlertsCard({ A }: { A: Alerts | undefined }) {
  if (!A) return null;
  const q = A.quake;
  const qAge = quakeAgeH(q?.time);
  const p = A.power;
  const where = `${A.county || ""}${A.town || ""}`;
  return (
    <Sheet inline open onOpenChange={() => {}} title="停班停課與警報" description={where ? `${where}・政府開放資料` : "政府開放資料"} icon={<AlertTriangle />}>
      <ul className="-my-3 divide-y">
        <Row icon={School} warn={!!(A.dayoff.today || A.dayoff.tomorrow)} ok={!A.dayoff.today && !A.dayoff.tomorrow}
          title={A.dayoff.today ? `今天${offWord(A.dayoff.today)}` : A.dayoff.tomorrow ? `明天${offWord(A.dayoff.tomorrow)}` : "沒有停班停課"}>
          {A.dayoff.today?.text || A.dayoff.tomorrow?.text || (A.dgpa_any ? "其他縣市有發布" : "人事行政總處目前沒有發布")}
          {(A.dayoff.today?.full || A.dayoff.tomorrow?.full) && "。「國定假日不執行」的排程那天會跳過"}
        </Row>
        {A.cwa_key && (
          <Row icon={AlertTriangle} warn={A.warnings.length > 0} ok={!A.warnings.length} title={A.warnings.length ? A.warnings.map((w) => w.name).join("、") : "沒有天氣特報"}>
            {A.warnings.length ? A.warnings.map((w) => `${w.name}：到 ${hm(w.end)}`).join("；") : `氣象署目前沒有對${A.county || "你家縣市"}發布`}
          </Row>
        )}
        {A.cwa_key && q && (
          <Row icon={Activity} warn={q.rank >= 3 && qAge < 24} title={`最近一次地震：${q.here ? `你家附近 ${q.here}` : "你家這裡沒感覺"}`}>
            {hm(q.time)}・{q.where}・規模 {q.mag}・深度 {q.depth} 公里
          </Row>
        )}
        {p && (
          <Row icon={Zap} warn={!!p.light && !["G", "Y"].includes(p.light)} ok={p.light === "G"} title={`今天供電：${p.light_name || "—"}`}>
            預估尖峰備轉容量率 {p.rate ?? "—"}%{p.peak && `（${p.peak}）`}・現在用電 {p.util ?? "—"}%
          </Row>
        )}
        {A.air_key && A.air.length > 0 && (
          <li className="py-3">
            <div className="mb-2 flex items-center gap-3">
              <Wind className="size-5 shrink-0 text-muted-foreground" />
              <span className="font-semibold">空品預報・{A.air[0].zone}空品區</span>
            </div>
            <div className="grid grid-cols-4 gap-2 pl-8">
              {A.air.map((x) => (
                <div key={x.date} className={cn("rounded-lg bg-muted/60 px-2 py-1.5 text-center", x.aqi > 100 && "bg-red-500/10")}>
                  <div className="text-xs text-muted-foreground">{dayLabel(x.date)}</div>
                  <div className={cn("font-semibold tabular-nums", x.aqi > 100 ? "text-red-600 dark:text-red-400" : x.aqi <= 50 && "text-emerald-600 dark:text-emerald-400")}>{x.aqi}</div>
                  <div className="truncate text-[11px] text-muted-foreground">{x.status}</div>
                </div>
              ))}
            </div>
          </li>
        )}
      </ul>
      {Object.keys(A.errors).length > 0 && <p className="mt-3 text-xs text-orange-600">有些資料暫時讀不到，稍後會自動再試</p>}
      <p className="mt-3 flex items-start gap-1.5 text-xs leading-relaxed text-muted-foreground">
        <CheckCircle2 className="mt-0.5 size-3.5 shrink-0" />
        有事會用 LINE 通知（可以在「設定 → 提醒與通知」關掉）。資料來源：人事行政總處、中央氣象署、台電、環境部；整份下載到樹莓派上比對，不會送出家裡的位置。
      </p>
    </Sheet>
  );
}

// 一週動靜：每間房「星期幾 × 幾點」有動靜的比例（最近 4 週），看得出家人的作息
import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { FpRoom } from "@/lib/map-model";

interface Week { rooms: Record<string, (number | null)[][]>; days: number; since: number | null }
const DAYS = ["一", "二", "三", "四", "五", "六", "日"];
const ALL = "__all";

export function WeekHeat({ rooms }: { rooms: FpRoom[] }) {
  const [data, setData] = useState<Week | null>(null);
  const [room, setRoom] = useState(ALL);
  useEffect(() => {
    let alive = true;
    const load = () => api<Week>("GET", "/api/sensing/week?days=28").then((d) => alive && setData(d)).catch(() => {});
    load();
    const t = setInterval(load, 600000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);
  const list = useMemo(() => rooms.filter((r) => data?.rooms[r.id]), [rooms, data]);
  // 全家：每格取最熱鬧的那間
  const grid = useMemo(() => {
    if (!data) return null;
    if (room !== ALL) return data.rooms[room] || null;
    const gs = list.map((r) => data.rooms[r.id]);
    if (!gs.length) return null;
    return DAYS.map((_, d) => Array.from({ length: 24 }, (_, h) => {
      const v = gs.map((g) => g[d][h]).filter((x): x is number => x != null);
      return v.length ? Math.max(...v) : null;
    }));
  }, [data, room, list]);
  if (!data || !list.length || !grid) return null;
  const days = data.since ? Math.max(1, Math.round((Date.now() / 1000 - data.since) / 86400)) : 0;
  let peak = { d: 0, h: 0, v: -1 };
  grid.forEach((row, d) => row.forEach((v, h) => { if (v != null && v > peak.v) peak = { d, h, v }; }));
  const cell = (v: number | null) => (v == null ? "transparent" : `rgba(249,115,22,${(0.06 + Math.min(1, v / 0.6) * 0.84).toFixed(2)})`);
  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-sm font-medium">一週動靜</span>
        <span className="text-xs text-muted-foreground">{days < 28 ? `目前有 ${days} 天的資料` : "最近 4 週"}</span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {[{ id: ALL, name: "全家" }, ...list].map((r) => (
          <button key={r.id} type="button" onClick={() => setRoom(r.id)}
            className={cn("rounded-full border px-2.5 py-0.5 text-xs transition-colors", room === r.id ? "border-primary bg-primary text-primary-foreground" : "hover:bg-muted")}>{r.name}</button>
        ))}
      </div>
      <div className="grid grid-cols-[1.25rem_repeat(24,minmax(0,1fr))] gap-px text-[10px] text-muted-foreground" role="img"
        aria-label={`一週動靜：${peak.v > 0 ? `最常有動靜是週${DAYS[peak.d]} ${peak.h} 點` : "還沒有動靜紀錄"}`}>
        <span />
        {Array.from({ length: 24 }, (_, h) => <span key={h} className="text-center">{h % 6 === 0 ? h : ""}</span>)}
        {grid.map((row, d) => [
          <span key={`l${d}`} className="leading-4">{DAYS[d]}</span>,
          ...row.map((v, h) => (
            <span key={`${d}-${h}`} className={cn("h-4 rounded-[2px]", v == null && "bg-muted/40")} style={{ background: v == null ? undefined : cell(v) }}
              title={`週${DAYS[d]} ${h}:00～${h + 1}:00：${v == null ? "沒有資料" : `${Math.round(v * 100)}% 的時間有動靜`}`} />
          )),
        ])}
      </div>
      <p className="text-xs text-muted-foreground">
        顏色越深，那個時段越常有人走動{peak.v > 0 ? `；最常是週${DAYS[peak.d]} ${peak.h} 點` : ""}。可以拿來決定動靜自動開關的時段。
      </p>
    </div>
  );
}

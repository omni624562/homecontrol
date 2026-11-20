import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import type { BikeStation } from "@/lib/types";
import { cn } from "@/lib/utils";

interface Road { k: string; n: string; p: [number, number][] }
interface MapData { r: number; roads: Road[]; error?: string | null }

// 路的粗細（公尺）：大路粗、巷子細
const WIDTH: Record<string, number> = { motorway: 20, trunk: 18, primary: 16, secondary: 14, tertiary: 11, unclassified: 7, residential: 7, living_street: 5, pedestrian: 5, service: 3.5 };
const MAJOR = new Set(["motorway", "trunk", "primary", "secondary", "tertiary"]);

// 家附近的 YouBike 小地圖：街道是樹莓派上存的 OpenStreetMap 資料，座標是「離家幾公尺」
export function BikeMap({ stations, main, onPick }: { stations: BikeStation[]; main: string | null; onPick: (sno: string) => void }) {
  const [data, setData] = useState<MapData | null>(null);
  useEffect(() => {
    let alive = true;
    api<MapData>("GET", "/api/local/map").then((d) => alive && setData(d)).catch(() => alive && setData({ r: 700, roads: [], error: "讀不到地圖" }));
    return () => { alive = false; };
  }, []);

  const pts = stations.filter((s) => s.x != null && s.y != null);
  // 畫多大：包住所有站，再留一點邊
  const RATIO = 0.72; // 橫的長方形
  const R = Math.min(700, Math.max(260, ...pts.map((s) => Math.max(Math.abs(s.x!) + 90, (Math.abs(s.y!) + 110) / RATIO))));
  const H = R * RATIO;

  const { paths, labels } = useMemo(() => {
    const roads = (data?.roads || []).slice().sort((a, b) => (WIDTH[a.k] || 4) - (WIDTH[b.k] || 4));
    const inside = (x: number, y: number) => Math.abs(x) < R * 0.92 && Math.abs(y) < H * 0.9;
    const best = new Map<string, { len: number; x: number; y: number; a: number; major: boolean }>();
    for (const r of roads) {
      if (!r.n) continue;
      for (let i = 1; i < r.p.length; i++) {
        const [x0, y0] = r.p[i - 1];
        const [x1, y1] = r.p[i];
        const mx = (x0 + x1) / 2;
        const my = (y0 + y1) / 2;
        if (!inside(mx, my)) continue;
        const len = Math.hypot(x1 - x0, y1 - y0);
        const cur = best.get(r.n);
        if (!cur || len > cur.len) {
          let a = (Math.atan2(-(y1 - y0), x1 - x0) * 180) / Math.PI; // 畫面的 y 往下
          if (a > 90) a -= 180;
          if (a < -90) a += 180;
          best.set(r.n, { len, x: mx, y: my, a, major: MAJOR.has(r.k) });
        }
      }
    }
    // 大路都標；巷子只標夠長的，免得擠成一團
    const all = [...best].map(([n, v]) => ({ n, ...v }));
    const minor = all.filter((l) => !l.major && !l.n.includes("弄") && l.len > 80).sort((a, b) => b.len - a.len).slice(0, 6);
    const labels = [...all.filter((l) => l.major && l.len > 25), ...minor];
    return { paths: roads, labels };
  }, [data, R, H]);

  const fs = R / 17; // 字的大小跟著範圍縮放
  return (
    <div className="overflow-hidden rounded-xl border bg-muted/40">
      <svg viewBox={`${-R} ${-H} ${2 * R} ${2 * H}`} className="block w-full" role="img" aria-label="家附近的 YouBike 站地圖">
        {/* 路 */}
        <g fill="none" strokeLinecap="round" strokeLinejoin="round" className="text-neutral-300 dark:text-neutral-700">
          {paths.map((r, i) => (
            <polyline key={i} points={r.p.map(([x, y]) => `${x},${-y}`).join(" ")} stroke="currentColor" strokeWidth={WIDTH[r.k] || 4}
              className={MAJOR.has(r.k) ? "text-neutral-400/80 dark:text-neutral-600" : undefined} />
          ))}
        </g>
        {/* 距離圈 */}
        {[200, 400].filter((d) => d < R).map((d) => (
          <g key={d} className="text-primary/40">
            <circle r={d} fill="none" stroke="currentColor" strokeWidth={R / 300} strokeDasharray={`${R / 60} ${R / 60}`} />
            <text x={0} y={-d - fs * 0.25} textAnchor="middle" fontSize={fs * 0.7} fill="currentColor">{d} 公尺</text>
          </g>
        ))}
        {/* 路名 */}
        <g className="fill-muted-foreground" fontSize={fs * 0.8} textAnchor="middle" paintOrder="stroke" strokeWidth={fs * 0.25} strokeLinejoin="round">
          {labels.map((l) => (
            <text key={l.n} x={l.x} y={-l.y} dy={fs * 0.28} transform={`rotate(${l.a} ${l.x} ${-l.y})`} className="stroke-background/80" opacity={l.major ? 1 : 0.75}>{l.n}</text>
          ))}
        </g>
        {/* 家 */}
        <circle r={fs * 0.55} className="fill-primary stroke-background" strokeWidth={fs * 0.18} />
        <text y={fs * 1.55} textAnchor="middle" fontSize={fs * 0.85} fontWeight={600} className="fill-primary stroke-background/90" paintOrder="stroke" strokeWidth={fs * 0.3}>家</text>
        {/* 站 */}
        {pts.map((s) => {
          const on = s.sno === main;
          const empty = !s.ok || !s.bikes;
          const w = fs * (String(s.bikes).length > 1 ? 2.3 : 1.9);
          return (
            <g key={s.sno} transform={`translate(${s.x} ${-s.y!})`} className="cursor-pointer" role="button" tabIndex={0} aria-label={`${s.name}，${s.ok ? `${s.bikes} 台` : "暫停"}，${s.m} 公尺`}
              onClick={() => onPick(s.sno)} onKeyDown={(e) => e.key === "Enter" && onPick(s.sno)}>
              <rect x={-w / 2} y={-fs * 0.85} width={w} height={fs * 1.7} rx={fs * 0.85} strokeWidth={fs * 0.14}
                className={cn(on ? "fill-primary stroke-background" : empty ? "fill-background stroke-neutral-400" : "fill-background stroke-primary")} />
              <text textAnchor="middle" dy={fs * 0.36} fontSize={fs} fontWeight={700}
                className={cn("tabular-nums", on ? "fill-primary-foreground" : empty ? "fill-muted-foreground" : "fill-foreground")}>{s.ok ? s.bikes : "×"}</text>
              <text y={fs * 1.9} textAnchor="middle" fontSize={fs * 0.82} fontWeight={on ? 700 : 500} paintOrder="stroke" strokeWidth={fs * 0.3} strokeLinejoin="round"
                className="fill-foreground stroke-background/90">{s.name}</text>
            </g>
          );
        })}
      </svg>
      <div className="flex justify-between gap-3 border-t px-3 py-1.5 text-[11px] text-muted-foreground">
        <span>{data?.error && !data.roads.length ? `街道還沒下載到（${data.error}）` : "數字是可借的車；點一站把它放到首頁。上方是北。"}</span>
        <span className="shrink-0">© OpenStreetMap</span>
      </div>
    </div>
  );
}

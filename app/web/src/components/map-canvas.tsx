import { useEffect, useRef, useState } from "react";
import { fmt } from "@/lib/format";
import { sigQ, shortName, type Floorplan, type MapDev, type MapLink } from "@/lib/map-model";
import { cn } from "@/lib/utils";

export type MapSel = { kind: "room" | "ap" | "dev"; id: string } | null;
// 地圖上的人：猜到在哪個區域（sure=false 是把握不夠，只是最可能的那間）
export type MapPerson = { id: string; name: string; room: string; sure: boolean; p: number };
type Drag = { kind: "item" | "room" | "resize"; id: string };

const STROKE: Record<string, string> = { good: "var(--primary)", mid: "color-mix(in srgb, var(--primary) 45%, var(--card))", weak: "var(--color-orange-500, #f97316)" };
const WARN = "var(--color-orange-500, #f97316)";

// 地圖本體：區域、訊號光暈、連線、基地台、裝置；編輯時可以拖曳
export function MapCanvas({
  fp, devs, links, layer, edit, sel, motion, people = [], onChange, onDragEnd, onPick, onTip,
}: {
  fp: Floorplan;
  devs: MapDev[];
  links: MapLink[];
  layer: "signal" | "motion";
  edit: boolean;
  sel: MapSel;
  motion: Record<string, number | null>;
  people?: MapPerson[];
  onChange: (fp: Floorplan) => void;
  onDragEnd: () => void;
  onPick: (s: MapSel) => void;
  onTip: (t: string | null) => void;
}) {
  const svg = useRef<SVGSVGElement>(null);
  const [px, setPx] = useState(900);
  const fpRef = useRef(fp);
  fpRef.current = fp;

  // 標記大小跟著畫面寬度：手機上地圖縮得很小，標記要放大才看得到
  useEffect(() => {
    const el = svg.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setPx(el.clientWidth || 900));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const W = fp.w;
  const H = fp.h;
  // 標記的字在畫面上大約 12px：k = 地圖單位／畫面像素 × 1.1
  const k = Math.max(1, Math.min(2.6, (W / px) * 1.1));
  const showNames = k < 2.3;
  const rooms = fp.rooms || [];
  const placed = devs.filter((d) => fp.items[d.key]);

  // 看的時候（不是編輯）：疊在一起的裝置稍微推開，數字才看得清楚；Wi-Fi 基地台不動。實際位置不變
  const pos: Record<string, { x: number; y: number }> = {};
  for (const d of placed) pos[d.key] = { x: fp.items[d.key].x, y: fp.items[d.key].y };
  if (!edit) {
    // 每個裝置連同下面的名字當成一個方框（中心在圓圈下方一點），重疊就往重疊比較少的方向推開
    const bw = (showNames ? 66 : 34) * k, bh = (showNames ? 48 : 34) * k, cy = (showNames ? 9 : 0) * k;
    const fixed = fp.aps.map((a) => fp.items[`ap:${a.id}`]).filter(Boolean);
    const keys = Object.keys(pos);
    for (let it = 0; it < 200; it++) {
      let moved = false;
      for (let i = 0; i < keys.length; i++) {
        const a = pos[keys[i]];
        for (let j = i + 1; j < keys.length; j++) {
          const b = pos[keys[j]];
          const dx = b.x - a.x, dy = b.y - a.y;
          const ox = bw - Math.abs(dx), oy = bh - Math.abs(dy);
          if (ox <= 0 || oy <= 0) continue;
          // 沿著兩個裝置的連線方向推開（一直線排隊的會散開成一圈，比較不會卡住）
          let ux = dx, uy = dy;
          const len = Math.hypot(ux, uy);
          if (len < 0.01) { ux = j % 2 ? 1 : -1; uy = 0.6; } else { ux /= len; uy /= len; }
          const p = Math.min(ox, oy) / 2 + 0.5;
          a.x -= ux * p; a.y -= uy * p; b.x += ux * p; b.y += uy * p;
          moved = true;
        }
        for (const f of fixed) {
          const dx = a.x - f.x, dy = (a.y + cy) - (f.y + 8 * k);
          const ox = (bw + 80 * k) / 2 - Math.abs(dx), oy = (bh + 54 * k) / 2 - Math.abs(dy);
          if (ox <= 0 || oy <= 0) continue;
          if (ox < oy) a.x += (ox + 0.5) * (dx >= 0 ? 1 : -1);
          else a.y += (oy + 0.5) * (dy >= 0 ? 1 : -1);
          moved = true;
        }
        a.x = Math.max(bw / 2, Math.min(W - bw / 2, a.x));
        a.y = Math.max(16 * k, Math.min(H - bh + 16 * k, a.y));
      }
      if (!moved) break;
    }
  }
  const glowR = Math.max(60, Math.min(220, 2.2 / ((fp.meters || 12) / W)));

  const point = (e: { clientX: number; clientY: number }) => {
    const el = svg.current!;
    const pt = el.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    return pt.matrixTransform(el.getScreenCTM()!.inverse());
  };

  const startDrag = (e: React.PointerEvent, d: Drag) => {
    if (!edit) return;
    e.preventDefault();
    e.stopPropagation();
    const f0 = fpRef.current;
    const start = point(e);
    const orig = d.kind === "item" ? { ...f0.items[d.id] } : { ...f0.rooms!.find((r) => r.id === d.id)! };
    onPick(d.kind === "item" ? (d.id.startsWith("ap:") ? { kind: "ap", id: d.id.slice(3) } : { kind: "dev", id: d.id }) : { kind: "room", id: d.id });
    const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
    const move = (ev: PointerEvent) => {
      const pt = point(ev);
      const dx = pt.x - start.x;
      const dy = pt.y - start.y;
      const f = fpRef.current;
      if (d.kind === "item") {
        const o = orig as { x: number; y: number; z?: number | null };
        onChange({ ...f, items: { ...f.items, [d.id]: { ...f.items[d.id], x: clamp(o.x + dx, 0, f.w), y: clamp(o.y + dy, 0, f.h) } } });
      } else {
        const o = orig as { x: number; y: number; w: number; h: number };
        onChange({
          ...f,
          rooms: f.rooms!.map((r) =>
            r.id !== d.id ? r : d.kind === "room"
              ? { ...r, x: clamp(o.x + dx, 0, f.w - r.w), y: clamp(o.y + dy, 0, f.h - r.h) }
              : { ...r, w: clamp(o.w + dx, 40, f.w - r.x), h: clamp(o.h + dy, 40, f.h - r.y) },
          ),
        });
      }
    };
    const end = () => {
      removeEventListener("pointermove", move);
      removeEventListener("pointerup", end);
      removeEventListener("pointercancel", end);
      onDragEnd();
    };
    addEventListener("pointermove", move);
    addEventListener("pointerup", end);
    addEventListener("pointercancel", end);
  };

  const showLinks = edit || layer === "motion";

  return (
    <svg
      ref={svg}
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label="訊號地圖"
      className={cn("block h-auto w-full min-w-[600px] rounded-xl bg-muted select-none sm:min-w-0", edit && "touch-none")}
      onClick={(e) => e.target === e.currentTarget && !edit && onPick(null)}
    >
      <defs>
        <clipPath id="map-rooms">{rooms.map((r) => <rect key={r.id} x={r.x} y={r.y} width={r.w} height={r.h} rx={10} />)}</clipPath>
        {(["good", "mid", "weak"] as const).map((q) => (
          <radialGradient key={q} id={`map-g-${q}`}>
            <stop offset="0" stopColor={STROKE[q]} stopOpacity={0.22} />
            <stop offset="1" stopColor={STROKE[q]} stopOpacity={0} />
          </radialGradient>
        ))}
      </defs>
      {fp.image && <image href={`/api/floorplan/image?v=${encodeURIComponent(fp.image)}`} x={0} y={0} width={W} height={H} preserveAspectRatio="xMidYMid meet" opacity={0.55} />}
      <g>{rooms.map((r) => <rect key={r.id} x={r.x} y={r.y} width={r.w} height={r.h} rx={10} className="fill-card" />)}</g>
      {layer === "signal" && (
        <g clipPath="url(#map-rooms)">
          {placed.filter((d) => d.online && d.rssi != null).map((d) => (
            <circle key={d.key} cx={fp.items[d.key].x} cy={fp.items[d.key].y} r={glowR.toFixed(0)} fill={`url(#map-g-${sigQ(d.rssi!)})`} />
          ))}
        </g>
      )}
      {rooms.map((r) => {
        const isSel = edit && sel?.kind === "room" && sel.id === r.id;
        return (
          <g key={r.id}>
            <rect
              x={r.x} y={r.y} width={r.w} height={r.h} rx={10}
              fill="transparent"
              className={cn(isSel ? "stroke-primary" : "stroke-border", edit && "cursor-move")}
              strokeWidth={isSel ? 3 : 1.5}
              onPointerDown={(e) => startDrag(e, { kind: "room", id: r.id })}
            />
            <text x={r.x + 12 * k} y={r.y + 24 * k} className="pointer-events-none fill-muted-foreground font-semibold" style={{ fontSize: 15 * k }}>{r.name}</text>
            {edit && (
              <rect
                x={r.x + r.w - 20 * k} y={r.y + r.h - 20 * k} width={18 * k} height={18 * k} rx={4 * k}
                className="cursor-nwse-resize fill-primary"
                onPointerDown={(e) => startDrag(e, { kind: "resize", id: r.id })}
              >
                <title>拉這裡改大小</title>
              </rect>
            )}
          </g>
        );
      })}
      {!edit && rooms.map((r) => {
        // 人：區域右上角的名牌，同一間有好幾個人就往左排
        const here = people.filter((p) => p.room === r.id);
        let right = r.x + r.w - 8 * k;
        return here.map((p) => {
          const label = p.sure ? p.name : `${p.name}?`;
          const tw = [...label].reduce((a, c) => a + (c.charCodeAt(0) < 256 ? 7.2 : 12.5), 0);
          const w = (tw + 24) * k, h = 22 * k;
          right -= w;
          const x = right;
          right -= 6 * k;
          const tip = p.sure ? `${p.name} 大概在${r.name}（${Math.round(p.p * 100)}% 把握）` : `${p.name} 可能在${r.name}（${Math.round(p.p * 100)}%，不確定）`;
          return (
            <g key={p.id} opacity={p.sure ? 1 : 0.6} onMouseEnter={() => onTip(tip)} onMouseLeave={() => onTip(null)}>
              <title>{tip}</title>
              <rect x={x} y={r.y + 8 * k} width={w} height={h} rx={h / 2} className={p.sure ? "fill-foreground" : "fill-card stroke-foreground"}
                strokeWidth={1.5 * k} strokeDasharray={p.sure ? undefined : `${3 * k} ${3 * k}`} />
              <circle cx={x + 11 * k} cy={r.y + 8 * k + h / 2} r={3.5 * k} className="fill-emerald-500" />
              <text x={x + 18 * k} y={r.y + 8 * k + h / 2 + 4.3 * k} className={cn("font-semibold", p.sure ? "fill-background" : "fill-foreground")} style={{ fontSize: 12 * k }}>{label}</text>
            </g>
          );
        });
      })}
      {showLinks && (
        <g>
          {links.map((l) => {
            const m = motion[l.dev.key];
            const hot = layer === "motion" && !edit && m != null && m > 0.15;
            return (
              <line
                key={l.dev.key}
                x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2}
                strokeLinecap="round"
                stroke={hot ? WARN : "var(--muted-foreground)"}
                strokeWidth={((hot ? 3 + Math.min(m!, 3) * 1.5 : 2.5) * k).toFixed(1)}
                strokeDasharray={hot ? undefined : l.q === "ok" ? "10 8" : l.q === "poor" ? "3 9" : undefined}
                opacity={hot ? Math.min(1, 0.35 + m! / 3) : l.q === "good" ? 0.6 : l.q === "ok" ? 0.45 : 0.3}
              />
            );
          })}
        </g>
      )}
      {fp.aps.filter((a) => fp.items[`ap:${a.id}`]).map((a) => {
        const it = fp.items[`ap:${a.id}`];
        const isSel = sel?.kind === "ap" && sel.id === a.id;
        return (
          <g
            key={a.id}
            transform={`translate(${it.x} ${it.y}) scale(${k.toFixed(2)})`}
            className={edit ? "cursor-grab" : "cursor-pointer"}
            onPointerDown={(e) => startDrag(e, { kind: "item", id: `ap:${a.id}` })}
            onClick={() => !edit && onPick({ kind: "ap", id: a.id })}
            onMouseEnter={() => onTip(a.name)}
            onMouseLeave={() => onTip(null)}
          >
            <circle r={18} className="fill-primary stroke-card" strokeWidth={isSel ? 6 : 3} style={{ filter: "drop-shadow(0 2px 4px rgb(37 99 235 / .35))" }} />
            <path d="M-9,-1 Q0,-10 9,-1 M-5,3 Q0,-2 5,3" fill="none" className="stroke-card" strokeWidth={2.2} strokeLinecap="round" />
            <circle cy={7} r={2.3} className="fill-card" />
            {(showNames || isSel) && (
              <text y={34} textAnchor="middle" className="fill-primary font-semibold" style={{ fontSize: 11.5, paintOrder: "stroke", stroke: "var(--card)", strokeWidth: 3, strokeLinejoin: "round" }}>{shortName(a.name, 9)}</text>
            )}
          </g>
        );
      })}
      {placed.map((d) => {
        const it = pos[d.key];
        const m = motion[d.key];
        const q = d.online && d.rssi != null ? sigQ(d.rssi) : null;
        const isSel = sel?.kind === "dev" && sel.id === d.key;
        const hot = layer === "motion" && m != null && m > 0.15;
        const tip = `${d.full}：${d.online ? `訊號 ${d.rssi ?? "—"} dBm` : "離線"}${m != null ? `・擾動 ${fmt(m, 1)}` : ""}`;
        return (
          <g
            key={d.key}
            transform={`translate(${it.x} ${it.y}) scale(${k.toFixed(2)})`}
            className={edit ? "cursor-grab" : "cursor-pointer"}
            onPointerDown={(e) => startDrag(e, { kind: "item", id: d.key })}
            onClick={() => !edit && onPick({ kind: "dev", id: d.key })}
            onMouseEnter={() => onTip(tip)}
            onMouseLeave={() => onTip(null)}
          >
            <title>{tip}</title>
            {hot && <circle r={20 + Math.min(m!, 3) * 12} fill={WARN} fillOpacity={Math.min(1, m! / 3) * 0.45 + 0.1} />}
            <circle
              r={15}
              className="fill-card"
              stroke={!d.online ? "var(--muted-foreground)" : q ? STROKE[q] : "var(--primary)"}
              strokeDasharray={d.online ? undefined : "3 3"}
              strokeWidth={isSel || hot ? 4 : 2.5}
              style={{ filter: "drop-shadow(0 1px 2px rgb(15 23 42 / .18))" }}
            />
            <text y={5} textAnchor="middle" className={cn("font-bold tabular-nums", q === "weak" ? "fill-orange-600" : "fill-foreground")} style={{ fontSize: 11 }}>
              {layer === "motion" ? (m == null ? "·" : fmt(m, 1)) : d.rssi ?? "—"}
            </text>
            {(showNames || isSel) && (
              <text y={31} textAnchor="middle" className="fill-muted-foreground font-medium" style={{ fontSize: 11.5, paintOrder: "stroke", stroke: "var(--card)", strokeWidth: 3, strokeLinejoin: "round" }}>{shortName(d.name, 6)}</text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

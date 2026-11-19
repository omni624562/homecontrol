import { useEffect, useRef, useState } from "react";
import { fmt } from "@/lib/format";
import { sigQ, shortName, type Floorplan, type MapDev, type MapLink } from "@/lib/map-model";
import { cn } from "@/lib/utils";

export type MapSel = { kind: "room" | "ap" | "dev"; id: string } | null;
type Drag = { kind: "item" | "room" | "resize"; id: string };

const STROKE: Record<string, string> = { good: "var(--primary)", mid: "color-mix(in srgb, var(--primary) 45%, var(--card))", weak: "var(--color-orange-500, #f97316)" };
const WARN = "var(--color-orange-500, #f97316)";

// 地圖本體：區域、訊號光暈、連線、基地台、裝置；編輯時可以拖曳
export function MapCanvas({
  fp, devs, links, layer, edit, sel, motion, onChange, onDragEnd, onPick, onTip,
}: {
  fp: Floorplan;
  devs: MapDev[];
  links: MapLink[];
  layer: "signal" | "motion";
  edit: boolean;
  sel: MapSel;
  motion: Record<string, number | null>;
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
  const k = Math.max(1, Math.min(2.1, (W / px) * 0.85));
  const showNames = k < 1.9;
  const rooms = fp.rooms || [];
  const placed = devs.filter((d) => fp.items[d.key]);
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
      className="block h-auto w-full touch-none rounded-xl bg-muted select-none"
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
        const it = fp.items[d.key];
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

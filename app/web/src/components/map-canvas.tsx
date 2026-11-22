import { useEffect, useRef, useState } from "react";
import { fmt } from "@/lib/format";
import { roomPath, roomPts, sigQ, shortName, tidyPts, topEdge, withPts, type Floorplan, type FpRoom, type MapDev, type MapLink, type Pt } from "@/lib/map-model";
import { cn } from "@/lib/utils";

export type MapSel = { kind: "room" | "ap" | "dev"; id: string } | null;
// 地圖上的人：猜到在哪個區域（sure=false 是把握不夠，只是最可能的那間）
export type MapPerson = { id: string; name: string; room: string; roomName: string; sure: boolean; p: number };
// corner／edge：拖區域的第 i 個轉角、第 i 道牆（轉角 i 到 i+1）
type Drag = { kind: "item" | "room" | "corner" | "edge"; id: string; i?: number };

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

  // 對齊：靠近別的轉角的 x／y 就吸過去（牆才對得齊），不然取 5 的倍數
  const snapper = (f: Floorplan, skip: string) => {
    const xs: number[] = [], ys: number[] = [];
    for (const r of f.rooms || []) if (r.id !== skip) for (const [x, y] of roomPts(r)) { xs.push(x); ys.push(y); }
    const near = (v: number, list: number[]) => {
      let best = Math.round(v / 5) * 5, gap = 8 * k;
      for (const c of list) if (Math.abs(c - v) < gap) { gap = Math.abs(c - v); best = c; }
      return best;
    };
    return { x: (v: number) => near(v, xs), y: (v: number) => near(v, ys) };
  };

  const startDrag = (e: React.PointerEvent, d: Drag) => {
    if (!edit) return;
    e.preventDefault();
    e.stopPropagation();
    const f0 = fpRef.current;
    const start = point(e);
    const origItem = d.kind === "item" ? { ...f0.items[d.id] } : null;
    const origRoom = d.kind === "item" ? null : f0.rooms!.find((r) => r.id === d.id)!;
    const P = origRoom ? roomPts(origRoom) : [];
    const snap = snapper(f0, d.id);
    onPick(d.kind === "item" ? (d.id.startsWith("ap:") ? { kind: "ap", id: d.id.slice(3) } : { kind: "dev", id: d.id }) : { kind: "room", id: d.id });
    const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
    const setRoom = (f: Floorplan, fn: (r: FpRoom) => FpRoom) => onChange({ ...f, rooms: f.rooms!.map((r) => (r.id === d.id ? fn(r) : r)) });
    const move = (ev: PointerEvent) => {
      const pt = point(ev);
      const dx = pt.x - start.x;
      const dy = pt.y - start.y;
      const f = fpRef.current;
      if (origItem) {
        onChange({ ...f, items: { ...f.items, [d.id]: { ...f.items[d.id], x: clamp(origItem.x + dx, 0, f.w), y: clamp(origItem.y + dy, 0, f.h) } } });
        return;
      }
      const o = origRoom!;
      if (d.kind === "room") {
        const mx = clamp(dx, -o.x, f.w - o.x - o.w), my = clamp(dy, -o.y, f.h - o.y - o.h);
        setRoom(f, (r) => ({ ...r, x: o.x + mx, y: o.y + my, w: o.w, h: o.h, pts: o.pts ? o.pts.map(([x, y]) => [x + mx, y + my] as Pt) : null }));
        return;
      }
      const n = P.length, i = d.i!;
      const Q = P.map((q) => [...q] as Pt);
      if (d.kind === "corner") {
        // 拖轉角：相鄰的兩道牆跟著移，牆保持水平、垂直（長方形就是改大小）
        const nx = clamp(snap.x(P[i][0] + dx), 0, f.w), ny = clamp(snap.y(P[i][1] + dy), 0, f.h);
        for (const j of [(i + n - 1) % n, (i + 1) % n]) {
          if (P[j][0] === P[i][0]) Q[j][0] = nx;
          else if (P[j][1] === P[i][1]) Q[j][1] = ny;
        }
        Q[i] = [nx, ny];
      } else {
        // 拖牆：整道牆往垂直方向推、拉
        const j = (i + 1) % n;
        if (P[i][0] === P[j][0]) Q[i][0] = Q[j][0] = clamp(snap.x(P[i][0] + dx), 0, f.w);
        else Q[i][1] = Q[j][1] = clamp(snap.y(P[i][1] + dy), 0, f.h);
      }
      setRoom(f, (r) => withPts(r, Q));
    };
    const end = () => {
      removeEventListener("pointermove", move);
      removeEventListener("pointerup", end);
      removeEventListener("pointercancel", end);
      if (d.kind === "corner" || d.kind === "edge") {
        const f = fpRef.current;
        const r = f.rooms!.find((x) => x.id === d.id);
        if (r) setRoom(f, (x) => withPts(x, tidyPts(roomPts(r))));
      }
      onDragEnd();
    };
    addEventListener("pointermove", move);
    addEventListener("pointerup", end);
    addEventListener("pointercancel", end);
  };

  // 在牆的中點按兩下：這道牆多兩個轉角，中間那段就能拉出凹口、凸出去（做成 L 形、凹字形）
  const splitEdge = (id: string, i: number) => {
    const f = fpRef.current;
    const r = f.rooms!.find((x) => x.id === id);
    if (!r) return;
    const P = roomPts(r);
    if (P.length >= 24) return;
    const a = P[i], b = P[(i + 1) % P.length];
    const at = (t: number): Pt => [Math.round(a[0] + (b[0] - a[0]) * t), Math.round(a[1] + (b[1] - a[1]) * t)];
    const Q = [...P.slice(0, i + 1), at(1 / 3), at(2 / 3), ...P.slice(i + 1)];
    onChange({ ...f, rooms: f.rooms!.map((x) => (x.id === id ? { ...withPts(x, Q), pts: Q } : x)) });
    onDragEnd();
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
        <clipPath id="map-rooms">{rooms.map((r) => <path key={r.id} d={roomPath(r)} />)}</clipPath>
        {(["good", "mid", "weak"] as const).map((q) => (
          <radialGradient key={q} id={`map-g-${q}`}>
            <stop offset="0" stopColor={STROKE[q]} stopOpacity={0.22} />
            <stop offset="1" stopColor={STROKE[q]} stopOpacity={0} />
          </radialGradient>
        ))}
      </defs>
      {fp.image && <image href={`/api/floorplan/image?v=${encodeURIComponent(fp.image)}`} x={0} y={0} width={W} height={H} preserveAspectRatio="xMidYMid meet" opacity={0.55} />}
      <g>{rooms.map((r) => <path key={r.id} d={roomPath(r)} className="fill-card" />)}</g>
      {layer === "signal" && (
        <g clipPath="url(#map-rooms)">
          {placed.filter((d) => d.online && d.rssi != null).map((d) => (
            <circle key={d.key} cx={fp.items[d.key].x} cy={fp.items[d.key].y} r={glowR.toFixed(0)} fill={`url(#map-g-${sigQ(d.rssi!)})`} />
          ))}
        </g>
      )}
      {rooms.map((r) => {
        const isSel = edit && sel?.kind === "room" && sel.id === r.id;
        const top = topEdge(r);
        return (
          <g key={r.id}>
            <path
              d={roomPath(r)}
              fill="transparent"
              className={cn(isSel ? "stroke-primary" : "stroke-border", edit && "cursor-move")}
              strokeWidth={isSel ? 3 : 1.5}
              onPointerDown={(e) => startDrag(e, { kind: "room", id: r.id })}
            />
            <text x={top.left + 12 * k} y={top.y + 24 * k} className="pointer-events-none fill-muted-foreground font-semibold" style={{ fontSize: 15 * k }}>{r.name}</text>
          </g>
        );
      })}
      {!edit && rooms.map((r) => {
        // 人：區域右上角的名牌，同一間有好幾個人就往左排
        const here = people.filter((p) => p.room === r.id);
        const top = topEdge(r);
        let right = top.right - 8 * k;
        return here.map((p) => {
          const label = p.sure ? p.name : `${p.name}?`;
          const tw = [...label].reduce((a, c) => a + (c.charCodeAt(0) < 256 ? 7.2 : 12.5), 0);
          const w = (tw + 24) * k, h = 22 * k;
          right -= w;
          const x = right;
          right -= 6 * k;
          const tip = p.sure ? `${p.name} 大概在${p.roomName}（${Math.round(p.p * 100)}% 把握）` : `${p.name} 可能在${p.roomName}（${Math.round(p.p * 100)}%，不確定）`;
          return (
            <g key={p.id} opacity={p.sure ? 1 : 0.6} onMouseEnter={() => onTip(tip)} onMouseLeave={() => onTip(null)}>
              <title>{tip}</title>
              <rect x={x} y={top.y + 8 * k} width={w} height={h} rx={h / 2} className={p.sure ? "fill-foreground" : "fill-card stroke-foreground"}
                strokeWidth={1.5 * k} strokeDasharray={p.sure ? undefined : `${3 * k} ${3 * k}`} />
              <circle cx={x + 11 * k} cy={top.y + 8 * k + h / 2} r={3.5 * k} className="fill-emerald-500" />
              <text x={x + 18 * k} y={top.y + 8 * k + h / 2 + 4.3 * k} className={cn("font-semibold", p.sure ? "fill-background" : "fill-foreground")} style={{ fontSize: 12 * k }}>{label}</text>
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
      {edit && sel?.kind === "room" && (() => {
        // 選取的區域：轉角（圓點）和每道牆的中點（短條）可以拖
        const r = rooms.find((x) => x.id === sel.id);
        if (!r) return null;
        const P = roomPts(r);
        return (
          <g>
            {P.map((a, i) => {
              const b = P[(i + 1) % P.length];
              const vert = a[0] === b[0];
              const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
              if (len < 24 * k) return null;
              const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
              const lw = 22 * k, th = 8 * k;
              return (
                <rect key={`e${i}`} x={mx - (vert ? th : lw) / 2} y={my - (vert ? lw : th) / 2} width={vert ? th : lw} height={vert ? lw : th} rx={th / 2}
                  className={cn("fill-card stroke-primary", vert ? "cursor-ew-resize" : "cursor-ns-resize")} strokeWidth={2 * k}
                  onPointerDown={(e) => startDrag(e, { kind: "edge", id: r.id, i })} onDoubleClick={() => splitEdge(r.id, i)}>
                  <title>拖這道牆推、拉；按兩下多兩個轉角（做 L 形）</title>
                </rect>
              );
            })}
            {P.map(([x, y], i) => (
              <circle key={`c${i}`} cx={x} cy={y} r={7 * k} className="cursor-move fill-primary stroke-card" strokeWidth={2.5 * k}
                onPointerDown={(e) => startDrag(e, { kind: "corner", id: r.id, i })}>
                <title>拖轉角改形狀、大小</title>
              </circle>
            ))}
          </g>
        );
      })()}
    </svg>
  );
}

import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  DndContext, DragOverlay, KeyboardSensor, PointerSensor, closestCenter, pointerWithin, useDroppable, useSensor, useSensors,
  type CollisionDetection, type DragEndEvent, type DragOverEvent, type DragStartEvent, type UniqueIdentifier,
} from "@dnd-kit/core";
import { SortableContext, arrayMove, rectSortingStrategy, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Check, GripVertical, HelpCircle, Home, Pencil, Plus, Star } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/app-shell";
import { DeviceSheet } from "@/components/device-sheet";
import { deviceIcon, mdiIcon } from "@/components/icons";
import { RoomSheet } from "@/components/room-sheet";
import { SceneSheet, sceneSummary } from "@/components/scene-sheet";
import { api } from "@/lib/api";
import { fmtSec } from "@/lib/format";
import { useHub } from "@/lib/hub";
import type { Plug } from "@/lib/types";
import { cn } from "@/lib/utils";

const NONE = "_none";
const k = (kind: string, id: string) => `${kind}:${id}`;
const parse = (x: UniqueIdentifier) => {
  const s = String(x);
  const i = s.indexOf(":");
  return { kind: s.slice(0, i), id: s.slice(i + 1) };
};

// 拖插座時只看插座和區域的空白處；拖區域時只看區域
const collide: CollisionDetection = (args) => {
  const kind = parse(args.active.id).kind;
  const ok = kind === "plug" ? ["plug", "drop"] : [kind];
  const droppableContainers = args.droppableContainers.filter((c) => ok.includes(parse(c.id).kind));
  const a = { ...args, droppableContainers };
  if (kind === "plug") {
    const within = pointerWithin(a);
    // 在某一列上就用那一列；只在區域的空白處就用區域
    const row = within.find((c) => parse(c.id).kind === "plug");
    if (row) return [row];
    if (within.length) return closestCenter({ ...a, droppableContainers: droppableContainers.filter((c) => within.some((w) => w.id === c.id) || parse(c.id).kind === "plug") });
  }
  return closestCenter(a);
};

async function save(fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch (e) {
    toast.error("沒有成功", { description: (e as Error).message });
  }
}

// 拖拉把手：滑鼠、手指按住拖；鍵盤按空白鍵拿起、↑↓ 移動、再按空白鍵放下
function Grip({ label, attrs, listeners, setRef }: { label: string; attrs: object; listeners?: object; setRef: (el: HTMLElement | null) => void }) {
  return (
    <button
      ref={setRef}
      type="button"
      aria-label={`拖拉調整「${label}」的順序（或按空白鍵後用 ↑ ↓）`}
      className="flex size-10 shrink-0 cursor-grab touch-none items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing"
      {...attrs}
      {...listeners}
    >
      <GripVertical className="size-5" />
    </button>
  );
}

function SortRow({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id });
  return (
    <div ref={setNodeRef} style={{ transform: CSS.Translate.toString(transform), transition }} className={cn("flex items-center gap-3 bg-card px-3 py-2.5 sm:px-4", isDragging && "opacity-30")}>
      {children}
      <Grip label={label} attrs={attributes} listeners={listeners} setRef={setActivatorNodeRef} />
    </div>
  );
}

function PlugBody({ p, onOpen }: { p: Plug; onOpen: () => void }) {
  const I = deviceIcon(p.name);
  return (
    <>
      <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground"><I className="size-5" /></span>
      <button onClick={onOpen} className="flex min-w-0 flex-1 flex-wrap items-center gap-2 text-left focus-visible:outline-none focus-visible:underline">
        <span className="truncate font-medium hover:text-primary">{p.name}</span>
        {p.keep_on && <span className="rounded-md bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">常開</span>}
        {!!p.max_on_s && <span className="rounded-md bg-amber-100 px-1.5 py-0.5 text-xs text-amber-800 dark:bg-amber-500/15 dark:text-amber-300">最長 {fmtSec(p.max_on_s)}</span>}
      </button>
    </>
  );
}

// 一個區域：卡片本身可以拖（換區域順序），裡面的插座也可以拖
function RoomBox({ id, name, icon, plugs, onOpen, onEdit, sortable }: { id: string; name: string; icon?: string; plugs: Plug[]; onOpen: (p: Plug) => void; onEdit?: () => void; sortable: boolean }) {
  const s = useSortable({ id: k("room", id), disabled: !sortable });
  const drop = useDroppable({ id: k("drop", id) });
  const I = id === NONE ? HelpCircle : mdiIcon(icon, Home);
  return (
    <div ref={s.setNodeRef} style={{ transform: CSS.Translate.toString(s.transform), transition: s.transition }} className={cn(s.isDragging && "opacity-30")}>
      <Card className={cn("gap-0 overflow-hidden py-0 transition-shadow", drop.isOver && "ring-2 ring-primary")}>
        <div className="flex items-center gap-3 border-b bg-muted/60 px-4 py-2.5 dark:bg-muted/40">
          <div className={cn("flex size-9 items-center justify-center rounded-lg shadow-sm", id === NONE ? "bg-muted-foreground/20 text-muted-foreground" : "border bg-background text-foreground/70")}><I className="size-5" /></div>
          <h2 className="flex-1 truncate text-lg font-bold tracking-tight">{name}</h2>
          {onEdit && <Button variant="outline" size="sm" className="bg-background" onClick={onEdit}><Pencil />改名</Button>}
          {sortable && <Grip label={name} attrs={s.attributes} listeners={s.listeners} setRef={s.setActivatorNodeRef} />}
        </div>
        <div ref={drop.setNodeRef} className="min-h-14 divide-y">
          <SortableContext items={plugs.map((p) => k("plug", p.id))} strategy={verticalListSortingStrategy}>
            {plugs.map((p) => (
              <SortRow key={p.id} id={k("plug", p.id)} label={p.name}>
                <PlugBody p={p} onOpen={() => onOpen(p)} />
              </SortRow>
            ))}
          </SortableContext>
          {!plugs.length && <p className="px-4 py-4 text-sm leading-relaxed text-muted-foreground">還沒有插座。按住插座右邊的 ⠿ 拖到這裡。</p>}
        </div>
      </Card>
    </div>
  );
}

export function EditPage() {
  const { state } = useHub();
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  const [device, setDevice] = useState<string | null>(null);
  const [room, setRoom] = useState<string | null>(null);
  const [scene, setScene] = useState<string | null>(null);
  const [active, setActive] = useState<string | null>(null);

  // 拖拉時用本地的順序（畫面立刻跟著動）；放開後存到伺服器
  const server = useMemo(() => {
    if (!state) return { rooms: [] as string[], boxes: {} as Record<string, string[]>, scenes: [] as string[] };
    const ids = new Set(state.rooms.map((r) => r.id));
    const boxes: Record<string, string[]> = { [NONE]: [] };
    for (const r of state.rooms) boxes[r.id] = [];
    for (const p of state.plugs) boxes[p.room && ids.has(p.room) ? p.room : NONE].push(p.id);
    return { rooms: state.rooms.map((r) => r.id), boxes, scenes: state.scenes.map((s) => s.id) };
  }, [state]);
  const [rooms, setRooms] = useState(server.rooms);
  const [boxes, setBoxes] = useState(server.boxes);
  const [scenes, setScenes] = useState(server.scenes);
  const [startBox, setStartBox] = useState<string | null>(null);
  useEffect(() => {
    if (active) return;
    setRooms(server.rooms);
    setBoxes(server.boxes);
    setScenes(server.scenes);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server]);

  if (!state) return <PageHeader title="編輯" />;
  const plug = (id: string) => state.plugs.find((p) => p.id === id);
  const boxOf = (plugId: string) => Object.keys(boxes).find((b) => boxes[b].includes(plugId));

  const onStart = (e: DragStartEvent) => {
    setActive(String(e.active.id));
    const a = parse(e.active.id);
    if (a.kind === "plug") setStartBox(boxOf(a.id) || null);
    navigator.vibrate?.(10);
  };
  // 插座拖到別的區域：先在畫面上搬過去
  const onOver = (e: DragOverEvent) => {
    const a = parse(e.active.id);
    if (a.kind !== "plug" || !e.over) return;
    const o = parse(e.over.id);
    const from = boxOf(a.id);
    const to = o.kind === "plug" ? boxOf(o.id) : o.kind === "drop" || o.kind === "room" ? o.id : undefined;
    if (!from || !to || from === to) return;
    setBoxes((b) => {
      const src = b[from].filter((x) => x !== a.id);
      const dst = [...b[to]];
      const at = o.kind === "plug" ? dst.indexOf(o.id) : dst.length;
      dst.splice(at < 0 ? dst.length : at, 0, a.id);
      return { ...b, [from]: src, [to]: dst };
    });
  };
  const onEnd = (e: DragEndEvent) => {
    const a = parse(e.active.id);
    setActive(null);
    if (!e.over) return;
    const o = parse(e.over.id);
    if (a.kind === "scene" && o.kind === "scene" && a.id !== o.id) {
      const next = arrayMove(scenes, scenes.indexOf(a.id), scenes.indexOf(o.id));
      setScenes(next);
      save(() => api("POST", "/api/order", { scenes: next }));
    } else if (a.kind === "room" && o.kind === "room" && a.id !== o.id && o.id !== NONE) {
      const next = arrayMove(rooms, rooms.indexOf(a.id), rooms.indexOf(o.id));
      setRooms(next);
      save(() => api("POST", "/api/order", { rooms: next }));
    } else if (a.kind === "plug") {
      const box = boxOf(a.id)!;
      let list = boxes[box];
      if (o.kind === "plug" && list.includes(o.id) && a.id !== o.id) list = arrayMove(list, list.indexOf(a.id), list.indexOf(o.id));
      const next = { ...boxes, [box]: list };
      setBoxes(next);
      const order = [NONE, ...rooms].flatMap((r) => next[r] || []);
      const moved = box !== startBox;
      const before = [NONE, ...rooms].flatMap((r) => server.boxes[r] || []);
      const changed = order.join() !== before.join();
      save(async () => {
        if (moved) await api("PATCH", `/api/plugs/${encodeURIComponent(a.id)}`, { room: box === NONE ? null : box });
        if (changed) await api("POST", "/api/order", { plugs: order });
        if (moved) toast.success(`已移到「${box === NONE ? "還沒分區域" : state.rooms.find((r) => r.id === box)?.name}」`);
      });
    }
  };

  const act = active ? parse(active) : null;
  const overlay = !act ? null : act.kind === "plug" ? plug(act.id)?.name : act.kind === "room" ? state.rooms.find((r) => r.id === act.id)?.name : state.scenes.find((s) => s.id === act.id)?.name;

  return (
    <>
      <PageHeader
        title="編輯"
        sub="改名稱、換區域、拖拉調順序"
        actions={<Button asChild className="h-10"><a href="#plugs"><Check />完成</a></Button>}
      />
      <div className="mx-auto max-w-[112rem] space-y-4 px-4 py-4 sm:px-6 lg:px-8">
        <p className="rounded-xl border border-primary/20 bg-primary/5 px-4 py-3 text-sm leading-relaxed">
          按住右邊的 <GripVertical className="inline size-4 align-text-bottom" /> 拖拉排順序，也可以把裝置拖到別的區域；用鍵盤的話，在把手上按空白鍵拿起、↑↓ 移動、再按空白鍵放下。點名稱修改設定。
          <span className="mt-1 block text-muted-foreground">
            首頁的卡片也可以直接抓標題列拖拉換位置。
            {(state.settings.home_layout || state.settings.home_side) ? (
              <button className="ml-1 font-medium text-primary underline-offset-4 hover:underline focus-visible:underline focus-visible:outline-none"
                onClick={() => api("PUT", "/api/settings", { home_layout: null, home_side: null }).then(() => toast.success("首頁已恢復預設排列"), (err) => toast.error("沒有成功", { description: (err as Error).message }))}>
                首頁恢復預設排列
              </button>
            ) : null}
          </span>
        </p>

        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragStart={onStart} onDragEnd={onEnd} onDragCancel={() => setActive(null)}>
          <Card className="gap-0 overflow-hidden py-0">
            <div className="flex items-center gap-3 border-b bg-muted/60 px-4 py-2.5 dark:bg-muted/40">
              <div className="flex size-9 items-center justify-center rounded-lg border bg-background text-foreground/70"><Star className="size-5" /></div>
              <h2 className="flex-1 text-lg font-bold tracking-tight">情境</h2>
            </div>
            <div className="divide-y">
              <SortableContext items={scenes.map((id) => k("scene", id))} strategy={verticalListSortingStrategy}>
                {scenes.map((id) => {
                  const sc = state.scenes.find((s) => s.id === id);
                  if (!sc) return null;
                  const I = mdiIcon(sc.icon, Star);
                  return (
                    <SortRow key={id} id={k("scene", id)} label={sc.name}>
                      <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted text-foreground/70"><I className="size-5" /></span>
                      <button onClick={() => setScene(id)} className="min-w-0 flex-1 text-left focus-visible:outline-none focus-visible:underline">
                        <span className="block truncate font-medium hover:text-primary">{sc.name}</span>
                        <span className="block text-sm text-muted-foreground">{sceneSummary(sc.actions)}</span>
                      </button>
                    </SortRow>
                  );
                })}
              </SortableContext>
              <button onClick={() => setScene("")} className="flex w-full items-center gap-2 px-4 py-3 font-medium text-primary transition-colors hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:outline-none">
                <Plus className="size-5" />新增情境
              </button>
            </div>
          </Card>
          <DragOverlay>{overlay && act?.kind === "scene" ? <div className="rounded-xl border bg-card px-4 py-3 font-medium shadow-xl">{overlay}</div> : null}</DragOverlay>
        </DndContext>

        <DndContext sensors={sensors} collisionDetection={collide} onDragStart={onStart} onDragOver={onOver} onDragEnd={onEnd} onDragCancel={() => { setActive(null); setBoxes(server.boxes); }}>
          <div className="grid items-start gap-4 md:grid-cols-2 2xl:grid-cols-3">
            {boxes[NONE]?.length > 0 && (
              <RoomBox id={NONE} name="還沒分區域" plugs={boxes[NONE].map(plug).filter(Boolean) as Plug[]} onOpen={(p) => setDevice(p.id)} sortable={false} />
            )}
            <SortableContext items={rooms.map((id) => k("room", id))} strategy={rectSortingStrategy}>
              {rooms.map((id) => {
                const r = state.rooms.find((x) => x.id === id);
                if (!r) return null;
                return <RoomBox key={id} id={id} name={r.name} icon={r.icon} plugs={(boxes[id] || []).map(plug).filter(Boolean) as Plug[]} onOpen={(p) => setDevice(p.id)} onEdit={() => setRoom(id)} sortable />;
              })}
            </SortableContext>
            <button onClick={() => setRoom("")} className="flex min-h-24 items-center justify-center gap-2 rounded-xl border-2 border-dashed font-medium text-primary transition-colors hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <Plus className="size-5" />新增區域
            </button>
          </div>
          <DragOverlay>
            {overlay && act?.kind !== "scene" ? (
              <div className={cn("flex items-center gap-3 rounded-xl border bg-card px-4 py-3 font-medium shadow-xl", act?.kind === "room" && "text-lg font-bold")}>
                <GripVertical className="size-5 text-muted-foreground" />{overlay}
              </div>
            ) : null}
          </DragOverlay>
        </DndContext>
      </div>

      <DeviceSheet id={device} onClose={() => setDevice(null)} />
      <RoomSheet open={room} onClose={() => setRoom(null)} />
      <SceneSheet open={scene} onClose={() => setScene(null)} />
    </>
  );
}

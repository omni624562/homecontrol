// 錄影：播放視窗（紀錄、摘要、找錄影都用這個）、首頁「昨天門口」卡片、攝影機頁「回放」（找錄影＋時間軸）
// 影片都在 Jetson（錄影機）上，經過樹莓派檢查權限才拿得到；只有「可以看攝影機」的裝置看得到
import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Film, Images, Loader2, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

const pad2 = (n: number) => String(n).padStart(2, "0");
const hms = (t: number) => { const d = new Date(t * 1000); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`; };
const hm = (t: number) => hms(t).slice(0, 5);
const dayLabel = (t: number) => {
  const d = new Date(t * 1000), now = new Date();
  const days = Math.round((new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() - new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()) / 864e5);
  return days === 0 ? "今天" : days === 1 ? "昨天" : `${d.getMonth() + 1}/${d.getDate()}`;
};

export interface ClipTarget {
  cam: string;
  t: number; // 發生的那一刻（回放：從這裡開始）
  title: string;
  replay?: boolean; // 回放：一次 2 分鐘，播完接下一段
  photos?: { id: string; frames: number }; // 紀錄裡偵測到時存的照片
}

const EVENT_BEFORE = 10, EVENT_AFTER = 20, REPLAY_LEN = 120;

// ---- 播放視窗 ----
export function ClipPlayer({ target, onClose }: { target: ClipTarget | null; onClose: () => void }) {
  const [t, setT] = useState(0);
  const [tab, setTab] = useState<"video" | "photo">("video");
  const [photo, setPhoto] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const [pos, setPos] = useState(0);
  const vid = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (!target) return;
    setT(target.t);
    setPhoto(0);
    setErr(null);
    const fresh = target.t + (target.replay ? REPLAY_LEN : EVENT_AFTER) > Date.now() / 1000 - 5;
    setTab(fresh && target.photos ? "photo" : "video"); // 剛發生：錄影還沒寫好，先看照片
  }, [target]);
  if (!target) return null;
  const before = target.replay ? 0 : EVENT_BEFORE, after = target.replay ? REPLAY_LEN : EVENT_AFTER;
  const src = `/api/cameras/${target.cam}/clip.mp4?t=${Math.round(t)}&before=${before}&after=${after}`;
  const later = t + after > Date.now() / 1000 - 5;
  const n = (target.photos?.frames || 0) + 1;
  const shift = (d: number) => { setErr(null); setT((x) => Math.min(x + d, Date.now() / 1000 - after - 5)); };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-3xl gap-3 p-3 sm:p-4">
        <DialogTitle className="pr-8 text-base">{target.title}<span className="ml-2 text-sm font-normal text-muted-foreground">{dayLabel(target.t)} {hms(target.t)}</span></DialogTitle>
        {target.photos && (
          <div className="flex w-fit gap-1 rounded-full border p-1" role="tablist">
            {([["video", "影片", Film], ["photo", `照片 ${n} 張`, Images]] as const).map(([k, label, I]) => (
              <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}
                className={cn("flex items-center gap-1.5 rounded-full px-3 py-1 text-sm", tab === k ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted")}><I className="size-4" />{label}</button>
            ))}
          </div>
        )}
        {tab === "video" ? (
          <>
            {later ? (
              <div className="flex aspect-video items-center justify-center rounded-md bg-muted px-6 text-center text-sm text-muted-foreground">影片還在錄，大約 {Math.ceil(t + after + 5 - Date.now() / 1000)} 秒後就能看{target.photos ? "；先看照片" : ""}。</div>
            ) : err ? (
              <div className="flex aspect-video items-center justify-center rounded-md bg-muted px-6 text-center text-sm text-muted-foreground">{err}</div>
            ) : (
              <video key={src} ref={vid} src={src} controls autoPlay muted playsInline className="aspect-video w-full rounded-md bg-black"
                onTimeUpdate={(e) => setPos(e.currentTarget.currentTime / Math.max(1, e.currentTarget.duration || before + after))}
                onError={() => setErr("這段時間沒有錄到（沒事的錄影只留幾天，有事的片段留比較久）")}
                onEnded={() => { if (target.replay && t + 2 * REPLAY_LEN < Date.now() / 1000) setT(t + REPLAY_LEN); }} />
            )}
            <div className="flex items-center gap-2 text-xs tabular-nums text-muted-foreground">
              <span>{hms(t - before)}</span>
              <div className="relative h-1.5 flex-1 rounded-full bg-muted">
                <i className="absolute inset-y-0 left-0 rounded-full bg-primary" style={{ width: `${Math.min(100, pos * 100)}%` }} />
                {!target.replay && t === target.t && <b className="absolute -top-1 h-3.5 w-0.5 bg-red-500" style={{ left: `${(before / (before + after)) * 100}%` }} title="發生的那一刻" />}
              </div>
              <span>{hms(t + after)}</span>
            </div>
            <div className="flex flex-wrap gap-2">
              {target.replay && <Button variant="outline" size="sm" onClick={() => shift(-300)}>－5 分鐘</Button>}
              <Button variant="outline" size="sm" onClick={() => shift(-30)}><ChevronLeft />往前 30 秒</Button>
              <Button variant="outline" size="sm" onClick={() => shift(30)}>往後 30 秒<ChevronRight /></Button>
              {target.replay && <Button variant="outline" size="sm" onClick={() => shift(300)}>＋5 分鐘</Button>}
            </div>
            {!target.replay && <p className="text-xs text-muted-foreground">播發生前 {EVENT_BEFORE} 秒到後 {EVENT_AFTER} 秒，紅線是發生的那一刻。沒有聲音。</p>}
          </>
        ) : target.photos && (
          <>
            <img src={`/api/faces/log/${target.photos.id}${photo ? `_${photo}` : ""}.jpg`} alt={`第 ${photo + 1} 張`} className="w-full rounded-md bg-muted" />
            {n > 1 && (
              <div className="flex items-center gap-2">
                <Button variant="outline" size="icon" aria-label="上一張" disabled={photo === 0} onClick={() => setPhoto(photo - 1)}><ChevronLeft /></Button>
                <span className="flex-1 text-center text-sm text-muted-foreground">第 {photo + 1}／{n} 張（{photo === 0 ? "偵測到時" : `${photo * 2} 秒後`}）</span>
                <Button variant="outline" size="icon" aria-label="下一張" disabled={photo === n - 1} onClick={() => setPhoto(photo + 1)}><ChevronRight /></Button>
              </div>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ---- 摘要 ----
interface Highlight { t: number; kind: "object" | "stranger" | "fall" | "night" | "linger"; text: string; id?: string; thumb?: boolean; end?: number }
interface CamSummary { id: string; name: string; role?: string; counts: Record<string, number>; hours: number[]; highlights: Highlight[]; more: number; indexed: boolean }
interface Summary { day: string; cams: CamSummary[]; indexed: boolean }
const TONE: Record<Highlight["kind"], string> = { object: "bg-amber-500", stranger: "bg-red-500", fall: "bg-red-500", night: "bg-red-500", linger: "bg-primary" };

function tiles(c: CamSummary): [string, number][] {
  const out: [string, number][] = [];
  const zone = Object.entries(c.counts).filter(([k]) => !["有人來", "陌生人"].includes(k) && !k.startsWith("認出")).sort((a, b) => b[1] - a[1]);
  if (zone[0]) out.push(zone[0]);
  if ("有人來" in c.counts) out.push(["有人來", c.counts["有人來"]]);
  out.push(["陌生人", c.counts["陌生人"] || 0]);
  for (const z of zone.slice(1)) if (out.length < 4) out.push(z);
  return out.slice(0, 4);
}

const short = (label: string, cam: string) => label.replace(new RegExp(`^${cam}`), "").replace(/^：/, "") || label;

/** 首頁：昨天門口（門口的攝影機；有看攝影機權限才看得到） */
export function SummaryCard() {
  const [s, setS] = useState<Summary | null>(null);
  const [play, setPlay] = useState<ClipTarget | null>(null);
  useEffect(() => { api<Summary>("GET", "/api/summary").then(setS).catch(() => setS(null)); }, []);
  const cams = (s?.cams || []).filter((c) => c.role === "entry" && Object.keys(c.counts).length);
  if (!cams.length) return null;
  return (
    <>
      {cams.map((c) => (
        <Card key={c.id} className="mb-4 gap-3 p-4">
          <div className="flex items-baseline justify-between gap-2">
            <span className="font-semibold">昨天{c.name}</span>
            <span className="text-xs text-muted-foreground">{c.indexed ? "全天錄影分析" : "依偵測紀錄（錄影還沒分析）"}</span>
          </div>
          <div className="grid grid-cols-4 gap-2">
            {tiles(c).map(([k, v]) => (
              <div key={k} className="rounded-lg border bg-muted/40 px-1 py-1.5 text-center">
                <div className="text-lg font-bold tabular-nums">{v}</div>
                <div className="truncate text-[11px] text-muted-foreground">{short(k, c.name)}</div>
              </div>
            ))}
          </div>
          {c.highlights.length ? (
            <ul className="divide-y">
              {c.highlights.map((h) => (
                <li key={`${h.kind}${h.t}`}>
                  <button type="button" onClick={() => setPlay({ cam: c.id, t: h.t, title: `${c.name}：${short(h.text, c.name)}`, photos: h.id && h.thumb ? { id: h.id, frames: 3 } : undefined })}
                    className="flex w-full items-center gap-3 py-2 text-left hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                    <span className="w-11 shrink-0 text-sm tabular-nums text-muted-foreground">{hm(h.t)}</span>
                    <span className={cn("size-2.5 shrink-0 rounded-full", TONE[h.kind])} aria-hidden />
                    <span className="min-w-0 flex-1 text-sm">{short(h.text, c.name)}</span>
                    <img src={`/api/cameras/${c.id}/frame.jpg?t=${Math.round(h.t)}&w=320`} alt="" loading="lazy" className="h-9 w-16 shrink-0 rounded object-cover bg-muted" />
                  </button>
                </li>
              ))}
            </ul>
          ) : <p className="text-sm text-muted-foreground">昨天{c.name}沒什麼特別的事。</p>}
          {c.more > 0 && <p className="text-xs text-muted-foreground">還有 {c.more} 件，到攝影機頁的「回放」看。</p>}
        </Card>
      ))}
      <ClipPlayer target={play} onClose={() => setPlay(null)} />
    </>
  );
}

// ---- 攝影機頁：回放（找錄影＋時間軸）----
interface Hit { cam: string; name: string; t: number; cls: string; box: number[]; score: number }
const SUGGEST = ["穿紅衣服的人", "背包", "狗", "腳踏車"];

export function ReplayCard({ cam, camName }: { cam: string; camName: string }) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [day, setDay] = useState(0); // 0 = 今天
  const [hours, setHours] = useState<number[] | null>(null);
  const [play, setPlay] = useState<ClipTarget | null>(null);
  const [rec, setRec] = useState<boolean | null>(null);
  useEffect(() => { api<{ configured: boolean }>("GET", "/api/recorder").then((r) => setRec(r.configured)).catch(() => setRec(false)); }, []);
  const dayStart = useCallback((d: number) => { const x = new Date(); x.setHours(0, 0, 0, 0); x.setDate(x.getDate() - d); return x; }, []);
  useEffect(() => {
    const d = dayStart(day);
    const iso = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
    setHours(null);
    api<Summary>("GET", `/api/summary?day=${iso}`).then((s) => setHours(s.cams.find((c) => c.id === cam)?.hours || Array(24).fill(0))).catch(() => setHours(Array(24).fill(0)));
  }, [cam, day, dayStart]);
  const search = async (text: string) => {
    const v = text.trim();
    if (!v) return;
    setQ(v);
    setBusy(true);
    setErr(null);
    try {
      const r = await api<{ hits: Hit[] }>("GET", `/api/recordings/search?q=${encodeURIComponent(v)}&cam=${encodeURIComponent(cam)}&days=30`);
      setHits(r.hits);
    } catch (e) {
      setErr((e as Error).message);
      setHits(null);
    } finally {
      setBusy(false);
    }
  };
  const nowH = new Date().getHours();
  const max = Math.max(1, ...(hours || [0]));
  if (!rec) return null; // 沒有錄影機：不顯示
  return (
    <Card className="gap-3 p-4">
      <div className="font-semibold">回放</div>
      <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); search(q); }}>
        <Input id="replay-q" value={q} onChange={(e) => setQ(e.target.value)} placeholder="打字找錄影，例如：穿紅衣服的人" className="bg-background" aria-label="找錄影" />
        <Button type="submit" disabled={busy || !q.trim()}>{busy ? <Loader2 className="animate-spin" /> : <Search />}找</Button>
      </form>
      <div className="flex flex-wrap gap-1.5">
        {SUGGEST.map((s) => <button key={s} type="button" onClick={() => search(s)} className="rounded-full border border-dashed px-2.5 py-0.5 text-xs text-muted-foreground hover:bg-muted">{s}</button>)}
      </div>
      {err && <p className="text-sm text-destructive">{err}</p>}
      {hits && (hits.length ? (
        <div className="grid grid-cols-3 gap-1.5">
          {hits.map((h) => (
            <button key={`${h.cam}${h.t}`} type="button" onClick={() => setPlay({ cam: h.cam, t: h.t, title: `${h.name}：「${q}」` })}
              className="relative aspect-video overflow-hidden rounded-md bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label={`${dayLabel(h.t)} ${hm(h.t)}`}>
              <img src={`/api/cameras/${h.cam}/frame.jpg?t=${Math.round(h.t)}&w=320`} alt="" loading="lazy" className="size-full object-cover" />
              <i className="absolute rounded-sm border-2 border-amber-400" style={{ left: `${h.box[0] * 100}%`, top: `${h.box[1] * 100}%`, width: `${h.box[2] * 100}%`, height: `${h.box[3] * 100}%` }} />
              <span className="absolute bottom-0.5 left-0.5 rounded bg-black/60 px-1 text-[10px] tabular-nums text-white">{dayLabel(h.t)} {hm(h.t)}</span>
            </button>
          ))}
        </div>
      ) : <p className="text-sm text-muted-foreground">最近 30 天沒找到。</p>)}
      <p className="text-xs text-muted-foreground">可以找人（穿著、顏色）、動物、包包、車；門、電梯這種固定的東西找不到。當天的錄影要等半夜 2 點分析完才找得到。</p>

      <div className="space-y-2 border-t pt-3">
        <div className="flex flex-wrap gap-1.5">
          {Array.from({ length: 7 }, (_, i) => (
            <button key={i} type="button" onClick={() => setDay(i)} aria-pressed={day === i}
              className={cn("rounded-full border px-2.5 py-0.5 text-xs", day === i ? "border-primary bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted")}>
              {i === 0 ? "今天" : i === 1 ? "昨天" : `${dayStart(i).getMonth() + 1}/${dayStart(i).getDate()}`}
            </button>
          ))}
        </div>
        <div className="flex h-12 items-end gap-0.5" role="group" aria-label={`${camName} 每小時的時間軸`}>
          {Array.from({ length: 24 }, (_, h) => {
            const future = day === 0 && h > nowH;
            const v = hours?.[h] || 0;
            return (
              <button key={h} type="button" disabled={future || !hours} title={`${pad2(h)}:00${v ? `・${v} 次` : ""}`} aria-label={`${pad2(h)} 點${v ? `，${v} 次` : ""}`}
                onClick={() => setPlay({ cam, t: dayStart(day).getTime() / 1000 + h * 3600, title: `${camName} 回放`, replay: true })}
                className={cn("flex-1 rounded-sm transition-colors", future ? "bg-muted/40" : v ? "bg-primary hover:bg-primary/80" : "bg-primary/15 hover:bg-primary/30", day === 0 && h === nowH && "bg-red-500/70")}
                style={{ height: `${future ? 15 : 15 + (v / max) * 85}%` }} />
            );
          })}
        </div>
        <div className="flex justify-between text-[11px] tabular-nums text-muted-foreground"><span>00</span><span>06</span><span>12</span><span>18</span><span>24</span></div>
        <p className="text-xs text-muted-foreground">柱子越高，那個小時事件越多。點一下從那個小時開始播，一次 2 分鐘，播完接下一段。</p>
      </div>
      <ClipPlayer target={play} onClose={() => setPlay(null)} />
    </Card>
  );
}

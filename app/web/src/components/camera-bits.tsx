// 攝影機頁和設定頁共用的小元件：權限、即時畫面、開門偵測，以及攝影機、認臉的資料型別
import { useEffect, useRef, useState } from "react";
import { Eye, EyeOff, KeyRound, Loader2, Lock } from "lucide-react";
import { toast } from "sonner";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { pad2 } from "@/lib/format";
import { cn } from "@/lib/utils";

// 網路攝影機：樹莓派每秒看一張快照認人；看到人 → 那間算有動靜（動靜自動開關、地圖），沒人在家時看到人就通知
export interface CamAccess { can_view: boolean; me: string | null; count: number; viewers?: { id: string; name: string }[]; candidates?: { id: string; name: string; kind: string }[] }
export interface Act { notify: "off" | "away" | "always"; scene: string | null; dark: boolean }
export interface Zone { id: string; name: string; kind: "area" | "object" | "door"; poly: number[][]; linger: number; act: Act; refs?: number; day?: number; night?: number; busy?: boolean; open?: boolean; score?: number | null }
export interface Line { id: string; name: string; a: number[]; b: number[]; in: Act; out: Act; last?: { way: "in" | "out"; t: number } | null }
export interface Cam { id: string; name: string; host: string; port: number; room: string | null; enabled: boolean; alert: boolean; model?: string; faces?: boolean; role?: "entry" | "room"; light?: string | null; pets?: boolean; fall?: boolean; pet_notify?: boolean; pets_here?: string[]; ignore?: number[][][]; zones?: Zone[]; lines?: Line[];
  night?: boolean | null; person: boolean; score: number | null; ok: boolean | null; error: string | null }

// 誰可以看攝影機畫面：沒權限的裝置用手機通知的驗證碼開通；有權限的人勾選其他裝置
export function CamAccessBox({ acc, onChange }: { acc: CamAccess; onChange: (a: CamAccess) => void }) {
  const [sent, setSent] = useState(false);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  if (!acc.can_view) {
    const send = async () => {
      try {
        await api("POST", "/api/cameras/access/send-code");
        setSent(true);
        toast.success("驗證碼已經傳到手機通知");
      } catch (e) {
        toast.error("沒有送出", { description: (e as Error).message });
      }
    };
    const claim = async () => {
      setBusy(true);
      try {
        const r = await api<{ access: CamAccess }>("POST", "/api/cameras/access/claim", { code });
        onChange(r.access);
        toast.success("這台裝置可以看攝影機了");
      } catch (e) {
        toast.error("沒有開通", { description: (e as Error).message });
      } finally {
        setBusy(false);
      }
    };
    return (
      <div className="mx-4 mt-3 space-y-2.5 rounded-lg border border-amber-300/60 bg-amber-50 p-3 text-sm sm:mx-5 dark:border-amber-500/30 dark:bg-amber-500/10">
        <div className="flex items-start gap-2"><Lock className="mt-0.5 size-4 shrink-0 text-amber-700 dark:text-amber-300" />
          <span>這台裝置沒有看攝影機畫面的權限，也不能改攝影機設定。{acc.count ? "請有權限的人到這裡把它勾起來，或" : ""}用手機通知收到的驗證碼開通。</span>
        </div>
        {sent ? (
          <form className="flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); claim(); }}>
            <Input id="cam-code" inputMode="numeric" autoComplete="one-time-code" placeholder="6 位數驗證碼" className="w-36 bg-background" value={code} onChange={(e) => setCode(e.target.value)} aria-label="驗證碼" />
            <Button type="submit" disabled={busy || code.replace(/\D/g, "").length !== 6}>{busy && <Loader2 className="animate-spin" />}開通這台</Button>
            <Button type="button" variant="ghost" onClick={send}>再傳一次</Button>
          </form>
        ) : (
          <Button variant="outline" size="sm" className="bg-background" onClick={send}><KeyRound />傳驗證碼到手機</Button>
        )}
      </div>
    );
  }
  const on = new Set((acc.viewers || []).map((v) => v.id));
  const toggle = async (id: string, name: string) => {
    const next = on.has(id) ? [...on].filter((x) => x !== id) : [...on, id];
    try {
      const r = await api<{ access: CamAccess }>("PUT", "/api/cameras/access", { viewers: next });
      onChange(r.access);
      toast.success(on.has(id) ? `${name} 不能再看攝影機` : `${name} 可以看攝影機了`);
    } catch (e) {
      toast.error("沒有成功", { description: (e as Error).message });
    }
  };
  const cands = acc.candidates || [];
  const gone = (acc.viewers || []).filter((v) => !cands.some((c) => c.id === v.id));
  return (
    <div className="px-4 pt-3 sm:px-5">
      <div className="font-medium leading-snug">誰可以看畫面</div>
      <div className="mb-2.5 text-sm leading-relaxed text-muted-foreground">只有選起來的裝置能看畫面、改攝影機設定；認人和通知照常運作，跟這裡無關</div>
      <div className="flex flex-wrap gap-2">
        {[...cands, ...gone.map((g) => ({ ...g, kind: "gone" }))].map((c) => {
          const sel = on.has(c.id);
          const me = c.id === acc.me;
          return (
            <AlertDialog key={c.id}>
              {me && sel ? (
                <AlertDialogTrigger asChild>
                  <button aria-pressed className="flex items-center gap-1.5 rounded-full border border-primary bg-primary/10 px-3 py-1.5 text-sm font-medium text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                    <Eye className="size-4" />{c.name}（這台）
                  </button>
                </AlertDialogTrigger>
              ) : (
                <button aria-pressed={sel} onClick={() => toggle(c.id, c.name)}
                  className={cn("flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", sel ? "border-primary bg-primary/10 font-medium text-primary" : "bg-background text-muted-foreground hover:bg-muted")}>
                  {sel ? <Eye className="size-4" /> : <EyeOff className="size-4" />}{c.name}{me ? "（這台）" : ""}
                </button>
              )}
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>拿掉這台自己的權限？</AlertDialogTitle>
                  <AlertDialogDescription>拿掉之後這台就看不到畫面了，要再用驗證碼開通，或請其他有權限的人勾回來。</AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>取消</AlertDialogCancel>
                  <AlertDialogAction variant="destructive" onClick={() => toggle(c.id, c.name)}>拿掉</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          );
        })}
      </div>
    </div>
  );
}

// 攝影機現在的畫面：上一張載完再過 1 秒拿下一張（不會越積越多）；看不到就顯示原因
export function CamLive({ id, name }: { id: string; name: string }) {
  const [t, setT] = useState(() => Date.now());
  const [err, setErr] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const next = (bad: boolean) => {
    setErr(bad);
    timer.current = window.setTimeout(() => setT(Date.now()), bad ? 5000 : 1000);
  };
  return (
    <div className="relative aspect-video w-full max-w-xl overflow-hidden rounded-lg border bg-muted">
      <img src={`/api/cameras/${id}/snapshot.jpg?t=${t}`} alt={`${name} 現在的畫面`} className="size-full object-contain"
        onLoad={() => next(false)} onError={() => next(true)} />
      {err && <div className="absolute inset-0 flex items-center justify-center bg-muted/90 text-sm text-muted-foreground">讀不到畫面，5 秒後再試</div>}
    </div>
  );
}


// 認臉：登記家人和訪客、認出家人時做什麼、最近的紀錄（只有「可以看攝影機」的裝置看得到）
export interface FacePerson { id: string; name: string; kind: "family" | "guest"; samples: number; at: number | null; notify?: boolean }
export interface FaceLogItem { id: string; t: number; camera: string; kind: "family" | "guest" | "stranger" | "pet" | "fall" | "door"; name?: string; sim: number | null; thumb: boolean }
export interface FaceAct { day?: string | null; night?: string | null; late?: string | null; notify?: boolean }
export interface FaceRep {
  family: FacePerson[]; guests: FacePerson[]; actions: Record<string, FaceAct>; slot: "day" | "night" | "late";
  enroll: { pid: string; name: string; cam: string; count: number; need: number; left: number } | null;
  result: { pid: string; ok: boolean; msg: string } | null; error: string | null; log: FaceLogItem[];
}
export const SLOT: [keyof FaceAct & ("day" | "night" | "late"), string][] = [["day", "白天"], ["night", "天黑後"], ["late", "半夜 0～6 點"]];
export const hhmm = (t: number) => { const d = new Date(t * 1000); return `${d.getMonth() + 1}/${d.getDate()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };

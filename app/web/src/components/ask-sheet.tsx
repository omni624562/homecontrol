import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Activity, CalendarClock, Check, Eye, House, Loader2, MessageSquareText, Mic, Power, Send, Star } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet } from "@/components/responsive-sheet";
import { api } from "@/lib/api";
import { useHub } from "@/lib/hub";
import type { AskAction } from "@/lib/types";
import { cn } from "@/lib/utils";

export const fmtUsd = (v: number) => `US$${(v || 0).toFixed(v >= 10 ? 1 : 2)}（約 NT$${Math.round((v || 0) * 32)}）`;

interface Msg {
  role: "user" | "assistant";
  content: string;
  actions?: AskAction[];
  error?: boolean;
}

const Ctx = createContext<{ open: (ask?: unknown) => void } | null>(null); // open("問題")：打開並直接問這一句
export const useAsk = () => useContext(Ctx)!;

// 「問家裡」：整個 App 共用一份對話，關掉面板再打開還在
export function AskProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [seed, setSeed] = useState<string | null>(null);
  return (
    <Ctx.Provider value={{ open: (ask) => { setSeed(typeof ask === "string" && ask ? ask : null); setOpen(true); } }}>
      {children}
      <AskSheet open={open} onClose={() => setOpen(false)} msgs={msgs} setMsgs={setMsgs} seed={seed} clearSeed={() => setSeed(null)} />
    </Ctx.Provider>
  );
}

// 還沒設定：貼 API 金鑰
export function AskSetup() {
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  return (
    <div className="space-y-3">
      <p className="leading-relaxed">要先貼上 Anthropic 的 API 金鑰（只存在樹莓派上，不會再顯示出來）。</p>
      <ol className="list-decimal space-y-1 pl-5 text-sm leading-relaxed text-muted-foreground">
        <li>到 <b className="text-foreground">console.anthropic.com</b> 登入，在「Billing」加一點額度（例如 5 美元）</li>
        <li>到「API Keys」按「Create Key」，複製 <code className="rounded bg-muted px-1">sk-ant-</code> 開頭的金鑰</li>
        <li>貼到下面，按「儲存」</li>
      </ol>
      <form
        className="flex gap-2"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!key.trim()) return setErr("請貼上金鑰");
          setBusy(true);
          try {
            await api("PUT", "/api/assistant", { key: key.trim() });
            toast.success("已儲存金鑰，可以開始問了");
            setKey("");
          } catch (x) {
            setErr((x as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <Input type="password" value={key} onChange={(e) => { setKey(e.target.value); setErr(""); }} placeholder="sk-ant-…" autoComplete="off" aria-label="API 金鑰" className="h-11" />
        <Button type="submit" className="h-11" disabled={busy}>{busy && <Loader2 className="animate-spin" />}儲存</Button>
      </form>
      {err && <p role="alert" className="text-sm text-destructive">{err}</p>}
      <p className="text-sm leading-relaxed text-muted-foreground">費用照用量計：預設用 Claude Opus 5.5，一次大約 NT$0.5；可以在「設定 → 問家裡」改成 Claude Haiku 5.5，便宜約 40 倍。</p>
    </div>
  );
}

const SUGG = ["客廳的燈都關掉", "還有哪些東西開著？", "這個月哪個最耗電？", "昨天誰最晚回家？", "平日天黑開客廳立燈、11 點關", "訊號地圖哪裡訊號最弱？", "昨晚哪裡有動靜？"];

type SR = { lang: string; interimResults: boolean; onresult: (e: { results: ArrayLike<{ isFinal: boolean } & ArrayLike<{ transcript: string }>> }) => void; onend: () => void; onerror: (e: { error: string }) => void; start: () => void; stop: () => void };

function AskSheet({ open, onClose, msgs, setMsgs, seed, clearSeed }: { open: boolean; onClose: () => void; msgs: Msg[]; setMsgs: React.Dispatch<React.SetStateAction<Msg[]>>; seed: string | null; clearSeed: () => void }) {
  const { state } = useHub();
  const st = state?.assistant;
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [listening, setListening] = useState(false);
  const rec = useRef<SR | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const W = window as unknown as { SpeechRecognition?: new () => SR; webkitSpeechRecognition?: new () => SR };
  const SRC = window.isSecureContext ? W.SpeechRecognition || W.webkitSpeechRecognition : undefined;
  const model = st?.models.find((m) => m.id === st.model)?.name || "Claude";

  useEffect(() => {
    end.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [msgs, busy]);

  const send = async (text?: string) => {
    const t = (text ?? draft).trim();
    if (!t || busy) return;
    const next = [...msgs, { role: "user" as const, content: t }];
    setMsgs(next);
    setDraft("");
    setBusy(true);
    try {
      const hist = next.filter((m) => !m.error).map((m) => ({ role: m.role, content: m.content }));
      const r = await api<{ reply: string; actions: AskAction[] }>("POST", "/api/assistant/chat", { messages: hist });
      setMsgs((m) => [...m, { role: "assistant", content: r.reply, actions: r.actions }]);
    } catch (err) {
      setMsgs((m) => [...m, { role: "assistant", content: `沒有成功：${(err as Error).message}`, error: true }]);
    } finally {
      setBusy(false);
      setTimeout(() => input.current?.focus(), 50);
    }
  };

  // 從首頁帶著問題打開：直接送出那一句
  const sendRef = useRef(send);
  sendRef.current = send;
  useEffect(() => {
    if (!open || !seed || !st?.configured) return;
    clearSeed();
    sendRef.current(seed);
  }, [open, seed, st?.configured, clearSeed]);

  // 卡片上的動作：使用者按了才真的做
  const act = async (mi: number, x: AskAction, skip: boolean) => {
    const set = (patch: Partial<AskAction>) =>
      setMsgs((ms) => ms.map((m, i) => (i !== mi ? m : { ...m, actions: m.actions?.map((a) => (a.id === x.id ? { ...a, ...patch } : a)) })));
    if (skip) return set({ state: "skip" });
    try {
      if (x.kind === "power") await api("POST", `/api/plugs/${encodeURIComponent(x.plug!)}/power`, { on: x.on });
      else if (x.kind === "all_off") await api("POST", "/api/off", {});
      else if (x.kind === "schedule") await api("POST", "/api/schedules", x.body);
      else if (x.kind === "scene") await api("POST", "/api/scenes", x.body);
      else if (x.kind === "vision_on") await api("PUT", "/api/claude-vision", { on: true });
      else if (x.kind === "arrive") await (x.rule_id ? api("PUT", `/api/arrive-rules/${encodeURIComponent(x.rule_id)}`, x.body) : api("POST", "/api/arrive-rules", x.body));
      else if (x.kind === "motion") {
        const cur = await api<{ rules: unknown[] }>("GET", "/api/motion-rules");
        await api("PUT", "/api/motion-rules", { rules: [...cur.rules, x.body] });
      }
      set({ state: "done" });
    } catch (err) {
      set({ state: "err", err: (err as Error).message });
    }
  };

  const mic = () => {
    if (!SRC) return;
    if (listening) return rec.current?.stop();
    const r = new SRC();
    r.lang = "zh-TW";
    r.interimResults = true;
    r.onresult = (e) => {
      const text = Array.from(e.results).map((x) => x[0].transcript).join("");
      setDraft(text);
      if (e.results[e.results.length - 1].isFinal) {
        r.stop();
        send(text);
      }
    };
    r.onend = () => setListening(false);
    r.onerror = (e) => toast.error(e.error === "not-allowed" ? "瀏覽器不允許用麥克風（要用 https 或在瀏覽器設定裡允許）" : `語音辨識沒有成功：${e.error}`);
    rec.current = r;
    setListening(true);
    r.start();
  };

  const ActIcon = (k: AskAction["kind"]) =>
    k === "schedule" ? CalendarClock : k === "scene" ? Star : k === "vision_on" ? Eye : k === "arrive" ? House : k === "motion" ? Activity : Power;
  const creates = (x: AskAction) => ["schedule", "scene", "arrive", "motion"].includes(x.kind);

  return (
    <Sheet
      open={open}
      onOpenChange={(v) => !v && onClose()}
      title="問家裡"
      description={st?.configured ? `${model}・打字或按麥克風說話` : "用 Claude 打字或說話控制家裡"}
      icon={<MessageSquareText />}
      wide
    >
      {!st?.configured ? (
        <AskSetup />
      ) : (
        <div className="flex min-h-[50vh] flex-col gap-3">
          <div className="flex-1 space-y-3" aria-live="polite">
            {msgs.length === 0 && (
              <div className="space-y-2">
                <p className="text-muted-foreground">可以這樣問：</p>
                <div className="flex flex-wrap gap-2">
                  {SUGG.map((t) => (
                    <Button key={t} variant="outline" className="h-auto rounded-full py-2 whitespace-normal" onClick={() => send(t)}>{t}</Button>
                  ))}
                </div>
              </div>
            )}
            {msgs.map((m, i) => (
              <div key={i} className={cn("flex flex-col gap-2", m.role === "user" ? "items-end" : "items-start")}>
                <div
                  className={cn(
                    "max-w-[85%] rounded-2xl px-4 py-2.5 leading-relaxed whitespace-pre-wrap",
                    m.role === "user" ? "rounded-br-md bg-primary text-primary-foreground" : "rounded-bl-md bg-muted",
                    m.error && "bg-destructive/10 text-destructive",
                  )}
                >
                  {m.content}
                </div>
                {m.actions?.filter((x) => x.kind === "look").map((x, k) => (
                  <span key={`look${k}`} className="flex items-center gap-1.5 text-xs text-muted-foreground"><Eye className="size-3.5" />{x.label}</span>
                ))}
                {m.actions?.filter((x) => x.kind !== "look").map((x) => {
                  const I = ActIcon(x.kind);
                  const btn = x.rule_id ? "修改" : creates(x) ? "建立" : x.kind === "vision_on" ? "打開" : "確認";
                  return (
                    <div key={x.id} className="flex w-full max-w-[85%] flex-wrap items-center gap-3 rounded-xl border bg-background p-3">
                      <I className="size-5 shrink-0 text-primary" />
                      <span className="min-w-0 flex-1 leading-relaxed">{x.label}</span>
                      {x.state === "done" ? (
                        <span className="inline-flex items-center gap-1 text-sm font-medium text-emerald-600"><Check className="size-4" />{x.rule_id ? "已修改" : creates(x) ? "已建立" : x.kind === "vision_on" ? "已打開，再問一次" : "已執行"}</span>
                      ) : x.state === "skip" ? (
                        <span className="text-sm text-muted-foreground">不用了</span>
                      ) : x.state === "err" ? (
                        <span className="text-sm text-destructive">{x.err || "失敗"}</span>
                      ) : (
                        <div className="flex gap-2">
                          <Button variant="ghost" size="sm" onClick={() => act(i, x, true)}>不要</Button>
                          <Button size="sm" onClick={() => act(i, x, false)}>{btn}</Button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ))}
            {busy && (
              <div className="flex w-16 items-center justify-center gap-1 rounded-2xl rounded-bl-md bg-muted px-4 py-3.5" aria-label="思考中">
                {[0, 150, 300].map((d) => <i key={d} className="size-1.5 animate-bounce rounded-full bg-muted-foreground" style={{ animationDelay: `${d}ms` }} />)}
              </div>
            )}
            <div ref={end} />
          </div>

          <div className="sticky -bottom-6 -mx-6 -mb-6 space-y-2 border-t bg-background/95 px-6 py-3 backdrop-blur max-md:-mx-4 max-md:px-4">
            <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); send(); }}>
              {SRC && (
                <Button type="button" size="icon" variant={listening ? "destructive" : "outline"} className={cn("size-11 shrink-0", listening && "animate-pulse")} onClick={mic} aria-label={listening ? "停止" : "用說的"}>
                  <Mic />
                </Button>
              )}
              <Input
                ref={input}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder={listening ? "請說…" : "想做什麼、想知道什麼？"}
                autoComplete="off"
                aria-label="問題"
                disabled={busy}
                className="h-11"
              />
              <Button type="submit" className="h-11" disabled={busy || !draft.trim()} aria-label="送出">
                {busy ? <Loader2 className="animate-spin" /> : <Send />}<span className="max-sm:hidden">送出</span>
              </Button>
            </form>
            <p className="text-xs leading-relaxed text-muted-foreground">
              {msgs.length > 0 && <><button className="text-primary hover:underline" onClick={() => setMsgs([])}>重新開始</button>・</>}
              每次提問會把需要的家裡資料（裝置名稱、開關狀態、誰在家）送到 Anthropic 處理{SRC ? "；用說的會經過瀏覽器的語音辨識（Google）" : ""}。本月用了約 {fmtUsd(st.month_usd)}。
            </p>
          </div>
        </div>
      )}
    </Sheet>
  );
}

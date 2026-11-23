import { useEffect, useState, type ReactNode } from "react";
import { KeyRound, Loader2, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";

// 配對：區網裡的裝置要先輸入一次 6 位數配對碼，才能控制插座。
// 配對碼從已經配對的裝置（設定 → 已配對的裝置）或手機通知拿。

interface AuthStatus {
  paired: boolean;
  can_send: boolean;
  locked_for: number;
}

export function PairGate({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [error, setError] = useState(false);
  const load = () =>
    fetch("/api/auth")
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((s: AuthStatus) => {
        setStatus(s);
        setError(false);
      })
      .catch(() => setError(true));
  useEffect(() => {
    load();
    const on = () => setStatus((s) => (s ? { ...s, paired: false } : s));
    addEventListener("plughub:unpaired", on);
    return () => removeEventListener("plughub:unpaired", on);
  }, []);
  if (error && !status)
    return (
      <Center>
        <p className="text-muted-foreground">連不上樹莓派</p>
        <Button variant="outline" onClick={load}>再試一次</Button>
      </Center>
    );
  if (!status) return null;
  if (status.paired) return <>{children}</>;
  return <PairScreen canSend={status.can_send} onDone={() => location.reload()} />;
}

function Center({ children }: { children: ReactNode }) {
  return <main className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-background p-4">{children}</main>;
}

function PairScreen({ canSend, onDone }: { canSend: boolean; onDone: () => void }) {
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; bad?: boolean } | null>(null);

  const pair = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      await api("POST", "/api/auth/pair", { code, name });
      onDone();
    } catch (err) {
      setMsg({ text: (err as Error).message, bad: true });
      setBusy(false);
    }
  };
  const send = async () => {
    try {
      await api("POST", "/api/auth/send-code");
      setMsg({ text: "配對碼已經送到手機通知（LINE），10 分鐘內有效" });
    } catch (err) {
      setMsg({ text: (err as Error).message, bad: true });
    }
  };

  return (
    <Center>
      <Card className="w-full max-w-sm gap-5 p-6">
        <div className="flex items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-lg border bg-muted/60"><KeyRound className="size-5" /></div>
          <div>
            <h1 className="text-xl font-bold tracking-tight">配對這台裝置</h1>
            <p className="text-sm text-muted-foreground">輸入一次，之後就記住了</p>
          </div>
        </div>
        <form onSubmit={pair} className="space-y-3">
          <label className="block space-y-1.5">
            <span className="text-sm font-medium">6 位數配對碼</span>
            <Input
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9 ]*"
              maxLength={7}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              className="h-12 text-center text-2xl tracking-[0.4em] tabular-nums"
              autoFocus
              required
            />
          </label>
          <label className="block space-y-1.5">
            <span className="text-sm font-medium">這台裝置的名字 <span className="text-muted-foreground">（選填）</span></span>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：媽媽的手機" maxLength={40} />
          </label>
          {msg && <p role="status" className={msg.bad ? "text-sm text-destructive" : "text-sm text-emerald-700 dark:text-emerald-400"}>{msg.text}</p>}
          <Button type="submit" className="h-11 w-full" disabled={busy || code.replace(/\D/g, "").length !== 6}>
            {busy && <Loader2 className="animate-spin" />}配對
          </Button>
        </form>
        <div className="space-y-2 border-t pt-4 text-sm leading-relaxed text-muted-foreground">
          <p>家人的手機在「網路裝置 → 誰在家」登記後會自動認得，不用配對碼；家裡的平板可以在網路裝置裡打開「不用配對」。</p>
          <p className="font-medium text-foreground">配對碼在哪裡？</p>
          <p>在已經能用的手機或電腦：設定 → 已配對的裝置 →「新增裝置」。</p>
          {canSend && (
            <Button variant="outline" size="sm" onClick={send}><Send />傳配對碼到手機通知</Button>
          )}
          <p>
            或在樹莓派上執行 <code className="rounded bg-muted px-1 py-0.5 text-xs">docker exec plughub python -m plughub.auth</code>
          </p>
        </div>
      </Card>
    </Center>
  );
}

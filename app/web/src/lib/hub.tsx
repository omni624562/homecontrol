import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { api } from "./api";
import type { HubState, Plug } from "./types";

// 全站共用的狀態：先拿 /api/state，之後伺服器有變動就從 /api/events 推過來。
// 開關按下去畫面先變（pending），伺服器確認後以伺服器為準；失敗就跳回去並提示。

interface HubCtx {
  state: HubState | null;
  connected: boolean;
  failed: boolean;
  isOn: (p: Plug) => boolean;
  isPending: (id: string) => boolean;
  setPower: (p: Plug, on: boolean) => Promise<void>;
  now: () => number;
}

const Ctx = createContext<HubCtx | null>(null);

export function HubProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<HubState | null>(null);
  const [connected, setConnected] = useState(false);
  const [failed, setFailed] = useState(false);
  const [pending, setPending] = useState<Map<string, boolean>>(new Map());
  const skew = useRef(0); // 伺服器時間 − 這台裝置的時間

  const apply = useCallback((s: HubState) => {
    skew.current = s.now - Date.now() / 1000;
    setState(s);
    // 伺服器的狀態已經是我們要的：清掉 pending
    setPending((old) => {
      if (!old.size) return old;
      const next = new Map(old);
      for (const [id, want] of old) {
        const p = s.plugs.find((x) => x.id === id);
        if (!p || p.is_on === want) next.delete(id);
      }
      return next.size === old.size ? old : next;
    });
  }, []);

  useEffect(() => {
    let es: EventSource | null = null;
    let closed = false;
    api<HubState>("GET", "/api/state")
      .then(apply)
      .catch(() => setFailed(true));
    const listen = () => {
      es?.close();
      es = new EventSource("/api/events");
      es.onmessage = (ev) => apply(JSON.parse(ev.data));
      es.onopen = () => {
        setConnected(true);
        setFailed(false);
      };
      es.onerror = () => setConnected(false);
    };
    listen();
    // 手機從背景回來：連線斷了就重連
    const onVis = () => {
      if (!closed && document.visibilityState === "visible" && es?.readyState === EventSource.CLOSED) listen();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      closed = true;
      es?.close();
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [apply]);

  const isOn = useCallback((p: Plug) => (pending.has(p.id) ? !!pending.get(p.id) : p.is_on), [pending]);
  const isPending = useCallback((id: string) => pending.has(id), [pending]);

  const setPower = useCallback(async (p: Plug, on: boolean) => {
    setPending((m) => new Map(m).set(p.id, on));
    try {
      await api("POST", `/api/plugs/${encodeURIComponent(p.id)}/power`, { on });
    } catch (err) {
      setPending((m) => {
        const n = new Map(m);
        n.delete(p.id);
        return n;
      });
      toast.error(`${p.name}沒有回應`, { description: (err as Error).message });
      return;
    }
    // 萬一伺服器沒推新狀態，5 秒後也清掉
    setTimeout(() => {
      setPending((m) => {
        if (m.get(p.id) !== on) return m;
        const n = new Map(m);
        n.delete(p.id);
        return n;
      });
    }, 5000);
  }, []);

  const now = useCallback(() => Date.now() / 1000 + skew.current, []);

  const value = useMemo(() => ({ state, connected, failed, isOn, isPending, setPower, now }), [state, connected, failed, isOn, isPending, setPower, now]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useHub() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useHub 要放在 HubProvider 裡");
  return v;
}

// 每隔一段時間重畫（「開了多久」「還有幾分鐘」）
export function useTick(ms = 30000) {
  const [, set] = useState(0);
  useEffect(() => {
    const t = setInterval(() => set((x) => x + 1), ms);
    return () => clearInterval(t);
  }, [ms]);
}

export function useMedia(q: string) {
  const [m, setM] = useState(() => matchMedia(q).matches);
  useEffect(() => {
    const mq = matchMedia(q);
    const on = () => setM(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [q]);
  return m;
}

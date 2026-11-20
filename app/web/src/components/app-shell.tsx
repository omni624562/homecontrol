import { useSyncExternalStore, type ReactNode } from "react";
import { BarChart3, Clock, Home, MessageSquareText, PanelLeftClose, PanelLeftOpen, Settings } from "lucide-react";
import { useLook } from "@/lib/look";
import { useAsk } from "@/components/ask-sheet";
import { useHub } from "@/lib/hub";
import { cn } from "@/lib/utils";

// 主選單
export const TABS = [
  { key: "plugs", label: "首頁", icon: Home },
  { key: "schedule", label: "排程", icon: Clock },
  { key: "energy", label: "用電", icon: BarChart3 },
  { key: "settings", label: "設定", icon: Settings },
] as const;

const href = (t: (typeof TABS)[number]) => `#${t.key}`;

// 左側選單收合成只有圖示（存在這台裝置上）；沒選過的話，科技感預設收合、原本的外觀預設展開
const RAIL = "rail";
const railListeners = new Set<() => void>();
function readRail(): "1" | "0" | null {
  try {
    const v = localStorage.getItem(RAIL);
    return v === "1" || v === "0" ? v : null;
  } catch {
    return null;
  }
}
let railMem: "1" | "0" | null = null; // 存不了的時候記在這裡
function setRail(v: boolean) {
  railMem = v ? "1" : "0";
  try {
    localStorage.setItem(RAIL, railMem);
  } catch {
    // 無痕視窗之類：這次開著的期間有效
  }
  railListeners.forEach((f) => f());
}
function useRail(): boolean {
  const look = useLook();
  const v = useSyncExternalStore((f) => { railListeners.add(f); return () => { railListeners.delete(f); }; }, () => readRail() ?? railMem, () => null);
  return v === null ? look === "tech" : v === "1";
}

export function AppShell({ tab: raw, children }: { tab: string; children: ReactNode }) {
  const tab = raw === "edit" ? "plugs" : ["map", "net"].includes(raw) ? "settings" : raw;
  const { connected, state } = useHub();
  const ask = useAsk();
  const mini = useRail();
  const connText = connected ? "已連線" : state ? "重新連線中…" : "連線中…";
  const status = (
    <div className={cn("flex items-center gap-2 text-sm text-muted-foreground", mini && "justify-center")} role="status" title={mini ? connText : undefined}>
      <span className={cn("size-2 shrink-0 rounded-full", connected ? "bg-emerald-500" : "bg-amber-500 animate-pulse")} />
      <span className={cn(mini && "sr-only")}>{connText}</span>
    </div>
  );
  return (
    <div className="shell-root min-h-dvh bg-neutral-50 dark:bg-background">
      {/* 電腦：左側選單（可以收合成只有圖示） */}
      <aside className={cn("fixed inset-y-0 left-0 z-30 hidden flex-col border-r bg-background py-5 transition-[width] duration-200 lg:flex", mini ? "w-16 px-2" : "w-60 px-3")}>
        <div className={cn("mb-6 flex items-center gap-3", mini ? "justify-center" : "px-2")}>
          <div className="logo-mark flex size-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-amber-400 to-orange-500 text-white shadow-sm">
            <Home className="size-5" />
          </div>
          {!mini && (
            <div className="leading-tight whitespace-nowrap">
              <div className="font-semibold">家庭中控</div>
              <div className="text-xs text-muted-foreground">Home Hub</div>
            </div>
          )}
        </div>
        <nav className="flex flex-col gap-1" aria-label="主選單">
          {TABS.map((t) => (
            <a
              key={t.key}
              href={href(t)}
              aria-current={tab === t.key ? "page" : undefined}
              aria-label={mini ? t.label : undefined}
              title={mini ? t.label : undefined}
              className={cn(
                "relative flex items-center gap-3 rounded-lg py-2.5 text-[15px] font-medium text-muted-foreground transition-colors",
                "hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                mini ? "justify-center px-0" : "px-3",
                tab === t.key && "nav-on bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary",
              )}
            >
              <t.icon className="size-5 shrink-0" />
              {!mini && t.label}
            </a>
          ))}
        </nav>
        <div className={cn("mt-auto space-y-3 border-t pt-3", !mini && "px-2")}>
          <button
            onClick={() => setRail(!mini)}
            aria-label={mini ? "展開選單" : "收合選單"}
            title={mini ? "展開選單" : "收合選單"}
            aria-expanded={!mini}
            className={cn(
              "flex w-full items-center gap-2 rounded-lg py-2 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              mini ? "justify-center" : "px-1",
            )}
          >
            {mini ? <PanelLeftOpen className="size-5" /> : <><PanelLeftClose className="size-5" />收合選單</>}
          </button>
          {status}
        </div>
      </aside>

      <main className={cn("pb-[calc(9rem+env(safe-area-inset-bottom))] transition-[padding] duration-200 lg:pb-28", mini ? "lg:pl-16" : "lg:pl-60")}>{children}</main>

      {/* 問家裡：每一頁右下角都有 */}
      {state?.assistant && (
        <button
          onClick={ask.open}
          aria-label="問家裡"
          className="ask-fab fixed right-4 bottom-[calc(5rem+env(safe-area-inset-bottom))] z-30 inline-flex size-14 items-center justify-center gap-2 rounded-full bg-primary sm:h-12 sm:w-auto sm:px-5 font-medium text-primary-foreground shadow-lg transition-all hover:bg-primary/90 hover:shadow-xl focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring/40 active:scale-95 lg:right-8 lg:bottom-8"
        >
          <MessageSquareText className="size-6 sm:size-5" />
          <span className="max-sm:hidden">問家裡</span>
        </button>
      )}

      {/* 手機、平板：下方分頁 */}
      <nav
        className="fixed inset-x-0 bottom-0 z-30 flex border-t bg-background/90 pb-[env(safe-area-inset-bottom)] backdrop-blur-md lg:hidden"
        aria-label="主選單"
      >
        {TABS.map((t) => (
          <a
            key={t.key}
            href={href(t)}
            aria-current={tab === t.key ? "page" : undefined}
            className={cn(
              "flex h-16 flex-1 flex-col items-center justify-center gap-1 text-xs font-medium text-muted-foreground transition-colors active:bg-muted",
              tab === t.key && "text-primary",
            )}
          >
            <t.icon className="size-6" />
            {t.label}
          </a>
        ))}
      </nav>
    </div>
  );
}

// 每一頁的標題列：捲動時固定在上面
export function PageHeader({ title, sub, actions, chips, chipsClassName }: { title: ReactNode; sub?: ReactNode; actions?: ReactNode; chips?: ReactNode; chipsClassName?: string }) {
  return (
    <header className="page-header sticky top-0 z-20 bg-neutral-50/85 backdrop-blur-md dark:bg-background/85">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-4 gap-y-2 px-4 pt-[max(0.75rem,env(safe-area-inset-top))] pb-3 sm:px-6 lg:px-8 lg:py-4">
        <div className="min-w-0 flex-1 xl:max-w-full xl:flex-none">
          <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
          {sub && <div className="text-sm leading-relaxed text-muted-foreground">{sub}</div>}
        </div>
        {/* 手機、平板：標題右邊，小標籤在下一列（放不下就左右滑）；寬螢幕：全部同一列 */}
        {actions && <div className="ml-auto flex shrink-0 items-center gap-2 self-start xl:order-last xl:self-center">{actions}</div>}
        {chips && <div className={cn("-mx-4 flex w-[calc(100%+2rem)] items-center gap-2 overflow-x-auto px-4 pb-0.5 [scrollbar-width:none] xl:mx-0 xl:w-auto xl:min-w-0 xl:flex-1 xl:justify-end xl:px-0", chipsClassName)}>{chips}</div>}
      </div>
    </header>
  );
}

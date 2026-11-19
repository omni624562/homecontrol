import type { ReactNode } from "react";
import { BarChart3, Clock, Home, MessageSquareText, Settings } from "lucide-react";
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

export function AppShell({ tab: raw, children }: { tab: string; children: ReactNode }) {
  const tab = raw === "edit" ? "plugs" : ["map", "net"].includes(raw) ? "settings" : raw;
  const { connected, state } = useHub();
  const ask = useAsk();
  const status = (
    <div className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
      <span className={cn("size-2 rounded-full", connected ? "bg-emerald-500" : "bg-amber-500 animate-pulse")} />
      {connected ? "已連線" : state ? "重新連線中…" : "連線中…"}
    </div>
  );
  return (
    <div className="min-h-dvh bg-neutral-50 dark:bg-background">
      {/* 電腦：左側選單 */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 flex-col border-r bg-background px-3 py-5 lg:flex">
        <div className="mb-6 flex items-center gap-3 px-2">
          <div className="flex size-9 items-center justify-center rounded-xl bg-gradient-to-br from-amber-400 to-orange-500 text-white shadow-sm">
            <Home className="size-5" />
          </div>
          <div className="leading-tight">
            <div className="font-semibold">家庭中控</div>
            <div className="text-xs text-muted-foreground">Home Hub</div>
          </div>
        </div>
        <nav className="flex flex-col gap-1" aria-label="主選單">
          {TABS.map((t) => (
            <a
              key={t.key}
              href={href(t)}
              aria-current={tab === t.key ? "page" : undefined}
              className={cn(
                "flex items-center gap-3 rounded-lg px-3 py-2.5 text-[15px] font-medium text-muted-foreground transition-colors",
                "hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                tab === t.key && "bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary",
              )}
            >
              <t.icon className="size-5" />
              {t.label}
            </a>
          ))}
        </nav>
        <div className="mt-auto border-t px-2 pt-4">{status}</div>
      </aside>

      <main className="pb-[calc(9rem+env(safe-area-inset-bottom))] lg:pb-28 lg:pl-60">{children}</main>

      {/* 問家裡：每一頁右下角都有 */}
      {state?.assistant && (
        <button
          onClick={ask.open}
          aria-label="問家裡"
          className="fixed right-4 bottom-[calc(5rem+env(safe-area-inset-bottom))] z-30 inline-flex size-14 items-center justify-center gap-2 rounded-full bg-primary sm:h-12 sm:w-auto sm:px-5 font-medium text-primary-foreground shadow-lg transition-all hover:bg-primary/90 hover:shadow-xl focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring/40 active:scale-95 lg:right-8 lg:bottom-8"
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
export function PageHeader({ title, sub, actions, chips }: { title: ReactNode; sub?: ReactNode; actions?: ReactNode; chips?: ReactNode }) {
  return (
    <header className="sticky top-0 z-20 bg-neutral-50/85 backdrop-blur-md dark:bg-background/85">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-4 gap-y-2 px-4 pt-[max(0.75rem,env(safe-area-inset-top))] pb-3 sm:px-6 lg:px-8 lg:py-4">
        <div className="min-w-0 flex-1 md:max-w-full md:flex-none">
          <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
          {sub && <div className="text-sm leading-relaxed text-muted-foreground">{sub}</div>}
        </div>
        {/* 手機：標題右邊；電腦：整列最右邊（小標籤後面） */}
        {actions && <div className="ml-auto flex shrink-0 items-center gap-2 self-start md:order-last md:self-center">{actions}</div>}
        {chips && <div className="-mx-4 flex w-[calc(100%+2rem)] items-center gap-2 overflow-x-auto px-4 pb-0.5 [scrollbar-width:none] md:mx-0 md:w-auto md:min-w-0 md:flex-1 md:flex-wrap md:justify-end md:overflow-visible md:px-0">{chips}</div>}
      </div>
    </header>
  );
}

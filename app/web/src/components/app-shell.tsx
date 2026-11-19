import type { ReactNode } from "react";
import { BarChart3, Clock, Home, Settings } from "lucide-react";
import { useHub } from "@/lib/hub";
import { cn } from "@/lib/utils";

// 新版目前做好的頁面；還沒做好的連回舊版
export const TABS = [
  { key: "plugs", label: "首頁", icon: Home, ready: true },
  { key: "schedule", label: "排程", icon: Clock, ready: true },
  { key: "energy", label: "用電", icon: BarChart3, ready: true },
  { key: "settings", label: "設定", icon: Settings, ready: false },
] as const;

function href(t: (typeof TABS)[number]) {
  return t.ready ? `#${t.key}` : `/#${t.key}`;
}

export function AppShell({ tab, children }: { tab: string; children: ReactNode }) {
  const { connected, state } = useHub();
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
              {!t.ready && <span className="ml-auto text-[11px] font-normal text-muted-foreground/80">舊版</span>}
            </a>
          ))}
        </nav>
        <div className="mt-auto border-t px-2 pt-4">{status}</div>
      </aside>

      <main className="pb-[calc(5rem+env(safe-area-inset-bottom))] lg:pb-10 lg:pl-60">{children}</main>

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
        <div className="flex min-w-0 flex-1 items-start gap-2">
          <div className="min-w-0 flex-1">
            <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
            {sub && <div className="text-sm leading-relaxed text-muted-foreground">{sub}</div>}
          </div>
          {actions && <div className="flex items-center gap-1 md:order-last">{actions}</div>}
        </div>
        {chips && <div className="-mx-4 flex w-[calc(100%+2rem)] items-center gap-2 overflow-x-auto px-4 pb-0.5 [scrollbar-width:none] md:mx-0 md:w-auto md:flex-wrap md:overflow-visible md:px-0">{chips}</div>}
      </div>
    </header>
  );
}

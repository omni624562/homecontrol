import { useEffect, useSyncExternalStore, type ReactNode } from "react";
import { BarChart3, Cctv, Clock, Home, Map as MapIcon, Menu, MoreHorizontal, MessageSquareText, PanelLeftClose, PanelLeftOpen, Settings, Sun, Wifi } from "lucide-react";
import { Drawer, DrawerContent, DrawerDescription, DrawerTitle } from "@/components/ui/drawer";
import { useLook } from "@/lib/look";
import { useAsk } from "@/components/ask-sheet";
import { useHub } from "@/lib/hub";
import { useBarTabs, useNavStyle } from "@/lib/nav";
import { cn } from "@/lib/utils";

// 主選單
// 電腦：左側選單；手機、平板：標題列左上角「☰」打開的側邊選單，或下方分頁（設定裡選）
export const TABS = [
  { key: "plugs", label: "首頁", icon: Home },
  { key: "life", label: "生活", icon: Sun },
  { key: "map", label: "家中地圖", icon: MapIcon },
  { key: "cameras", label: "攝影機", icon: Cctv },
  { key: "schedule", label: "排程", icon: Clock },
  { key: "energy", label: "用電", icon: BarChart3 },
  { key: "net", label: "網路裝置", icon: Wifi },
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

// 手機的側邊選單（標題列左上角「☰」打開）
let menuOpen = false;
const menuListeners = new Set<() => void>();
function setMenu(v: boolean) {
  if (menuOpen === v) return;
  menuOpen = v;
  menuListeners.forEach((f) => f());
}
function useMenu(): boolean {
  return useSyncExternalStore((f) => { menuListeners.add(f); return () => { menuListeners.delete(f); }; }, () => menuOpen, () => false);
}

// 標誌用「家」字（不用房子圖示：跟選單的「首頁」太像會按錯）；點了一樣回首頁
function Logo() {
  return (
    <a
      href="#plugs"
      onClick={() => setMenu(false)}
      aria-label="回首頁"
      title="回首頁"
      className="logo-mark flex size-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-amber-400 to-orange-500 text-[1.05rem] font-bold text-white shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      家
    </a>
  );
}

function MobileMenu({ tab, status }: { tab: string; status: ReactNode }) {
  const open = useMenu();
  useEffect(() => {
    const close = () => setMenu(false);
    addEventListener("hashchange", close);
    // 轉成電腦的寬度時關掉（電腦有左側選單）
    const mq = matchMedia("(min-width: 1024px)");
    mq.addEventListener("change", close);
    return () => { removeEventListener("hashchange", close); mq.removeEventListener("change", close); };
  }, []);
  return (
    <Drawer direction="left" open={open} onOpenChange={setMenu}>
      <DrawerContent className="w-[17rem] max-w-[85vw] py-[max(1.25rem,env(safe-area-inset-top))] pr-3 pl-[max(0.75rem,env(safe-area-inset-left))] pb-[max(1.25rem,env(safe-area-inset-bottom))] lg:hidden">
        <div className="mb-5 flex items-center gap-3 px-2">
          <Logo />
          <div className="leading-tight">
            <DrawerTitle className="font-semibold">家庭中控</DrawerTitle>
            <DrawerDescription className="text-xs text-muted-foreground">Home Hub</DrawerDescription>
          </div>
        </div>
        <nav className="flex flex-col gap-1 overflow-y-auto" aria-label="全部頁面">
          {TABS.map((t) => (
            <a
              key={t.key}
              href={href(t)}
              onClick={() => setMenu(false)}
              aria-current={tab === t.key ? "page" : undefined}
              className={cn(
                "flex items-center gap-3 rounded-lg px-3 py-3 text-base font-medium text-muted-foreground transition-colors active:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                tab === t.key && "bg-primary/10 text-primary",
              )}
            >
              <t.icon className="size-5 shrink-0" />
              {t.label}
            </a>
          ))}
        </nav>
        <div className="mt-auto border-t px-2 pt-3">{status}</div>
      </DrawerContent>
    </Drawer>
  );
}

// 下方分頁：4 格常用頁＋「更多」（從下方滑出其他頁面）
function BottomTabs({ tab }: { tab: string }) {
  const open = useMenu();
  const chosen = useBarTabs();
  const bar = TABS.filter((t) => chosen.includes(t.key));
  const more = TABS.filter((t) => !chosen.includes(t.key));
  const inMore = more.some((t) => t.key === tab);
  const item = "flex h-16 flex-1 flex-col items-center justify-center gap-1 text-xs font-medium text-muted-foreground transition-colors active:bg-muted";
  return (
    <>
      <nav className="fixed inset-x-0 bottom-0 z-30 flex border-t bg-background/90 pb-[env(safe-area-inset-bottom)] backdrop-blur-md lg:hidden" aria-label="主選單">
        {bar.map((t) => (
          <a key={t.key} href={href(t)} aria-current={tab === t.key ? "page" : undefined} className={cn(item, tab === t.key && "text-primary")}>
            <t.icon className="size-6" />
            {t.label}
          </a>
        ))}
        <button onClick={() => setMenu(true)} aria-expanded={open} className={cn(item, inMore && "text-primary")}>
          <MoreHorizontal className="size-6" />
          更多
        </button>
      </nav>
      <Drawer open={open} onOpenChange={setMenu}>
        <DrawerContent className="pb-[max(1rem,env(safe-area-inset-bottom))] lg:hidden">
          <DrawerTitle className="sr-only">更多頁面</DrawerTitle>
          <DrawerDescription className="sr-only">下方分頁放不下的頁面</DrawerDescription>
          <nav className="flex flex-col gap-1 px-3 pt-3" aria-label="更多頁面">
            {more.map((t) => (
              <a
                key={t.key}
                href={href(t)}
                onClick={() => setMenu(false)}
                aria-current={tab === t.key ? "page" : undefined}
                className={cn("flex items-center gap-3 rounded-lg px-3 py-3.5 text-base font-medium text-muted-foreground transition-colors active:bg-muted", tab === t.key && "bg-primary/10 text-primary")}
              >
                <t.icon className="size-5 shrink-0" />
                {t.label}
              </a>
            ))}
          </nav>
        </DrawerContent>
      </Drawer>
    </>
  );
}

export function AppShell({ tab: raw, children }: { tab: string; children: ReactNode }) {
  const tab = raw === "edit" ? "plugs" : raw;
  const { connected, state } = useHub();
  const mini = useRail();
  const nav = useNavStyle();
  const connText = connected ? "已連線" : state ? "重新連線中…" : "連線中…";
  const statusEl = (small: boolean) => (
    <div className={cn("flex items-center gap-2 text-sm text-muted-foreground", small && "justify-center")} role="status" title={small ? connText : undefined}>
      <span className={cn("size-2 shrink-0 rounded-full", connected ? "bg-emerald-500" : "bg-amber-500 animate-pulse")} />
      <span className={cn(small && "sr-only")}>{connText}</span>
    </div>
  );
  const status = statusEl(mini);
  return (
    <div className="shell-root min-h-dvh bg-neutral-50 dark:bg-background">
      {/* 電腦：左側選單（可以收合成只有圖示） */}
      <aside className={cn("fixed inset-y-0 left-0 z-30 hidden flex-col border-r bg-background py-5 transition-[width] duration-200 lg:flex", mini ? "w-16 px-2" : "w-60 px-3")}>
        <div className={cn("mb-6 flex items-center gap-3", mini ? "justify-center" : "px-2")}>
          <Logo />
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

      <main className={cn(nav === "tabs" ? "pb-[calc(5.5rem+env(safe-area-inset-bottom))]" : "pb-[max(2rem,env(safe-area-inset-bottom))]", "transition-[padding] duration-200 lg:pb-10", mini ? "lg:pl-16" : "lg:pl-60")}>{children}</main>


      {nav === "tabs" ? <BottomTabs tab={tab} /> : <MobileMenu tab={tab} status={statusEl(false)} />}

    </div>
  );
}

// 每一頁的標題列：捲動時固定在上面
export function PageHeader({ title, sub, actions, chips, chipsClassName, hideTitle, lead }: { title: ReactNode; sub?: ReactNode; actions?: ReactNode; chips?: ReactNode; chipsClassName?: string; hideTitle?: boolean; lead?: ReactNode }) {
  const { state } = useHub();
  const ask = useAsk();
  const nav = useNavStyle();
  // 「問家裡」放在標題列（右下角浮動圓鈕會壓到開關）：手機首頁用 lead 放一條，其他情況在右邊放一顆
  const askBtn = state?.assistant ? (
    <button onClick={ask.open} aria-label="問家裡" title="問家裡"
      className={cn("ask-head inline-flex size-9 shrink-0 items-center justify-center gap-1.5 rounded-full border bg-background text-sm font-medium text-primary transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring lg:w-auto lg:px-3.5", lead && "max-lg:hidden")}>
      <MessageSquareText className="size-[18px]" /><span className="max-lg:hidden">問家裡</span>
    </button>
  ) : null;
  return (
    <header className="page-header sticky top-0 z-20 bg-neutral-50/85 backdrop-blur-md dark:bg-background/85">
      <div className="mx-auto flex max-w-[112rem] flex-wrap items-center gap-x-4 gap-y-2 px-4 pt-[max(0.75rem,env(safe-area-inset-top))] pb-3 sm:px-6 lg:px-8 lg:py-4">
        {/* 手機、平板：左上角打開全部頁面的選單 */}
        {nav === "menu" && <button onClick={() => setMenu(true)} aria-label="全部頁面" title="全部頁面"
          className="-ml-1.5 inline-flex size-9 shrink-0 items-center justify-center rounded-full text-foreground transition-colors hover:bg-muted active:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring lg:hidden">
          <Menu className="size-[22px]" />
        </button>}
        {/* hideTitle：標題只給螢幕閱讀器（首頁：左邊選單已經標出在哪一頁） */}
        {hideTitle && lead && <div className="min-w-0 flex-1 lg:hidden">{lead}</div>}
        {hideTitle ? <h1 className="sr-only">{title}</h1> : (
          <div data-ph="title" className="min-w-0 flex-1 xl:max-w-full xl:flex-none">
            <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
            {sub && <div className="text-sm leading-relaxed text-muted-foreground">{sub}</div>}
          </div>
        )}
        {/* 手機、平板：標題右邊，小標籤在下一列（放不下就左右滑）；寬螢幕：全部同一列 */}
        {(actions || askBtn) && <div data-ph="actions" className="ml-auto flex shrink-0 items-center gap-2 self-start xl:order-last xl:self-center">{askBtn}{actions}</div>}
        {chips && <div data-ph="chips" className={cn("-mx-4 flex w-[calc(100%+2rem)] items-center gap-2 overflow-x-auto px-4 pb-0.5 [scrollbar-width:none] xl:mx-0 xl:w-auto xl:min-w-0 xl:flex-1 xl:justify-end xl:px-0", chipsClassName)}>{chips}</div>}
      </div>
    </header>
  );
}

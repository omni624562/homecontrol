import { useEffect, useState } from "react";
import { DropdownMenu } from "radix-ui";
import { ArrowLeft, BarChart3, ChevronRight, Clock, Copy, Info, LayoutGrid, Lock, MessageSquareText, Moon, Power, RotateCw, Sun, Timer, TimerOff, type LucideIcon } from "lucide-react";
import { toast } from "sonner";
import { TABS } from "@/components/app-shell";
import { useAsk } from "@/components/ask-sheet";
import { api } from "@/lib/api";
import { useHub } from "@/lib/hub";
import { isDark, toggleTheme } from "@/lib/theme";
import type { Plug } from "@/lib/types";

// 電腦上按右鍵：換成家庭中控自己的選單（在裝置上按 → 那台的動作；別的地方 → 整個 App 的動作）
// 照舊出現 Chrome 選單：輸入框裡、選了文字、圖片影片、外部連結、Shift＋右鍵、手機長按

type Item = { label: string; icon?: LucideIcon; hint?: string; onSelect?: () => void; href?: string; sub?: Item[]; disabled?: boolean } | "sep";
type Menu = { title?: string; items: Item[] };

// 裝置那一列在 onContextMenu 先登記它的選單，事件冒到 document 時這裡拿來用
let claim: Menu | null = null;
export const claimMenu = (m: Menu) => { claim = m; };

const NATIVE = 'input, textarea, select, [contenteditable=""], [contenteditable="true"], img, video, canvas, a[href^="http"]';

export function PageMenu() {
  const [at, setAt] = useState<{ x: number; y: number; menu: Menu | null } | null>(null);
  const { state } = useHub();
  const ask = useAsk();

  useEffect(() => {
    const on = (e: MouseEvent) => {
      const mine = claim;
      claim = null;
      if (e.defaultPrevented || e.shiftKey) return;
      if ((e as PointerEvent).pointerType === "touch" || !matchMedia("(any-pointer: fine)").matches) return;
      const t = e.target instanceof Element ? e.target : null;
      if (t?.closest(NATIVE) || String(getSelection() ?? "").trim()) return;
      e.preventDefault();
      let { clientX: x, clientY: y } = e;
      if (!x && !y && t) {
        // 鍵盤叫出來的（選單鍵、Shift+F10）：放在那個東西旁邊
        const r = t.getBoundingClientRect();
        x = r.left + 8;
        y = r.bottom;
      }
      setAt({ x, y, menu: mine });
    };
    document.addEventListener("contextmenu", on);
    return () => document.removeEventListener("contextmenu", on);
  }, []);

  if (!at) return null;
  const tab = location.hash.slice(1).split("/")[0] || "plugs";
  const dark = isDark();
  const menu: Menu = at.menu ?? {
    items: [
      { label: "上一頁", icon: ArrowLeft, hint: "Alt+←", onSelect: () => history.back(), disabled: history.length <= 1 },
      { label: "重新整理資料", icon: RotateCw, onSelect: () => location.reload() },
      "sep",
      ...(state?.assistant ? [{ label: "問家裡…", icon: MessageSquareText, onSelect: () => ask.open() }] : []),
      { label: "到別頁", icon: LayoutGrid, sub: TABS.map((x) => ({ label: x.key === tab ? `${x.label}（這頁）` : x.label, icon: x.icon, href: `#${x.key}`, disabled: x.key === tab })) },
      "sep",
      { label: dark ? "換成淺色" : "換成深色", icon: dark ? Sun : Moon, onSelect: toggleTheme },
      { label: "複製這頁的網址", icon: Copy, onSelect: () => navigator.clipboard.writeText(location.href).then(() => toast.success("已複製網址"), () => toast.error("沒辦法複製")) },
    ],
  };

  return (
    <DropdownMenu.Root key={`${at.x},${at.y}`} open onOpenChange={(v) => !v && setAt(null)}>
      <DropdownMenu.Trigger asChild>
        <span aria-hidden style={{ position: "fixed", left: at.x, top: at.y, width: 0, height: 0 }} />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="start" side="bottom" sideOffset={2} collisionPadding={8} className={CONTENT} aria-label={menu.title || "家庭中控"} onCloseAutoFocus={(e) => e.preventDefault()}>
          {menu.title && <DropdownMenu.Label className="truncate px-2.5 pt-1 pb-1.5 text-xs text-muted-foreground">{menu.title}</DropdownMenu.Label>}
          <Items items={menu.items} />
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

const CONTENT = "z-50 min-w-56 max-w-72 overflow-hidden rounded-xl border bg-popover p-1.5 text-sm text-popover-foreground shadow-lg data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95";
const ITEM = "flex min-h-9 cursor-default select-none items-center gap-2.5 rounded-lg px-2.5 py-1.5 outline-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground";

function Items({ items }: { items: Item[] }) {
  return items.map((it, i) => {
    if (it === "sep") return <DropdownMenu.Separator key={i} className="-mx-1.5 my-1.5 h-px bg-border" />;
    const Icon = it.icon;
    const body = (
      <>
        {Icon && <Icon />}
        <span className="min-w-0 flex-1 truncate">{it.label}</span>
        {it.hint && <span className="text-xs text-muted-foreground">{it.hint}</span>}
      </>
    );
    if (it.sub)
      return (
        <DropdownMenu.Sub key={i}>
          <DropdownMenu.SubTrigger className={ITEM} disabled={it.disabled}>{body}<ChevronRight /></DropdownMenu.SubTrigger>
          <DropdownMenu.Portal>
            <DropdownMenu.SubContent sideOffset={4} collisionPadding={8} className={CONTENT}><Items items={it.sub} /></DropdownMenu.SubContent>
          </DropdownMenu.Portal>
        </DropdownMenu.Sub>
      );
    return (
      <DropdownMenu.Item key={i} className={ITEM} disabled={it.disabled}
        onSelect={() => { if (it.href) location.hash = it.href; else it.onSelect?.(); }}>
        {body}
      </DropdownMenu.Item>
    );
  });
}

// 一個插座的右鍵選單
export function plugMenu(p: Plug, on: boolean, onOpen: () => void, onToggle: () => void): Menu {
  const id = encodeURIComponent(p.id);
  const run = (f: () => Promise<unknown>, ok: string) => f().then(() => toast.success(ok), (err) => toast.error("沒有成功", { description: (err as Error).message }));
  const can = p.online && p.protect !== "lock";
  const timer = (min: number, label: string) => ({ label, onSelect: () => run(() => api("POST", `/api/plugs/${id}/timer`, { minutes: min }), `${p.name}打開，${label}後關`) });
  return {
    title: p.name,
    items: [
      ...(can
        ? [
            { label: on ? "關掉" : "打開", icon: Power, onSelect: onToggle },
            { label: "打開，一段時間後關", icon: Timer, sub: [timer(15, "15 分鐘"), timer(30, "30 分鐘"), timer(60, "1 小時"), timer(120, "2 小時"), "sep" as const, { label: "自己設定…", onSelect: onOpen }] },
            ...(on && p.timer ? [{ label: "取消定時", icon: TimerOff, onSelect: () => run(() => api("DELETE", `/api/plugs/${id}/timer`), "已取消定時") }] : []),
            "sep" as const,
          ]
        : []),
      { label: "詳細資料", icon: Info, onSelect: onOpen },
      { label: "排程", icon: Clock, href: "#schedule" },
      { label: "使用時間", icon: BarChart3, href: "#energy" },
      ...(p.protect !== "lock"
        ? ["sep" as const, {
            label: "鎖定（不讓別人按）", icon: Lock,
            onSelect: () => api("PATCH", `/api/plugs/${id}`, { protect: "lock" }).then(
              () => toast.success(`已鎖定${p.name}`, { description: "要解除到詳細資料 → 防呆", action: { label: "復原", onClick: () => void api("PATCH", `/api/plugs/${id}`, { protect: p.protect || "" }) } }),
              (err) => toast.error("沒有成功", { description: (err as Error).message })),
          }]
        : []),
    ],
  };
}

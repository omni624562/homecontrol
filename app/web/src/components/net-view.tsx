import { List, Map as MapIcon } from "lucide-react";
import { cn } from "@/lib/utils";

// 網路裝置頁標題：「清單／地圖」切換（訊號地圖是同一群裝置的另一種看法）
export function NetTitle({ view }: { view: "list" | "map" }) {
  const opt = (v: "list" | "map", href: string, I: React.ElementType, label: string) => (
    <a href={href} aria-current={view === v ? "page" : undefined}
      className={cn("inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        view === v && "bg-background text-foreground shadow-xs")}>
      <I className="size-4" />{label}
    </a>
  );
  return (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
      網路裝置
      <span className="inline-flex rounded-lg bg-muted p-0.5 align-middle text-base font-normal tracking-normal" role="tablist" aria-label="看法">
        {opt("list", "#net", List, "清單")}
        {opt("map", "#map", MapIcon, "訊號地圖")}
      </span>
    </span>
  );
}

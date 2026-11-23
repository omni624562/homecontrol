import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

// 卡片標題列右邊的收合按鈕（拖拉排列時不要觸發拖曳）
export function CollapseBtn({ shut, onToggle, label }: { shut: boolean; onToggle: () => void; label: string }) {
  return (
    <button onClick={onToggle} onPointerDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}
      aria-expanded={!shut} aria-label={`${shut ? "展開" : "收起"}${label}`} title={shut ? "展開" : "收起"}
      className="-mr-1.5 inline-flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-background hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      <ChevronDown className={cn("size-4.5 transition-transform", shut && "-rotate-90")} />
    </button>
  );
}

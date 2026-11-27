import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

// 橫向捲動的一排：電腦上兩邊有箭頭按鈕、滑鼠滾輪也能左右捲；手機照樣用手指滑
export function HScroll({ children, className, label }: { children: ReactNode; className?: string; label: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [edge, setEdge] = useState({ left: false, right: false });
  const update = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    setEdge({ left: el.scrollLeft > 4, right: el.scrollLeft + el.clientWidth < el.scrollWidth - 4 });
  }, []);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    // 滾輪（上下）改成左右捲；捲到底了就讓外面的畫面照常捲
    const wheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      const max = el.scrollWidth - el.clientWidth;
      if ((e.deltaY < 0 && el.scrollLeft <= 0) || (e.deltaY > 0 && el.scrollLeft >= max - 1)) return;
      e.preventDefault();
      el.scrollLeft += e.deltaY;
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => {
      ro.disconnect();
      el.removeEventListener("wheel", wheel);
    };
  }, [update]);
  const go = (dir: number) => {
    const el = ref.current;
    if (el) el.scrollBy({ left: dir * el.clientWidth * 0.8, behavior: "smooth" });
  };
  const btn = "absolute top-1/2 z-10 grid size-9 -translate-y-1/2 place-items-center rounded-full border bg-background/95 text-foreground shadow-sm hover:bg-accent max-sm:hidden";
  return (
    <div className="relative">
      <div ref={ref} onScroll={update} className={cn("overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden", className)}>
        {children}
      </div>
      {edge.left && <button type="button" className={cn(btn, "-left-2")} onClick={() => go(-1)} aria-label={`${label}：往前`}><ChevronLeft className="size-5" /></button>}
      {edge.right && <button type="button" className={cn(btn, "-right-2")} onClick={() => go(1)} aria-label={`${label}：往後`}><ChevronRight className="size-5" /></button>}
    </div>
  );
}

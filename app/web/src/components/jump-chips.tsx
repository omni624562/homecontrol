import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

// 手機：標題下面的快速跳轉；滑動時跟著標出現在看的那一段
export function JumpChips({ sections: SECTIONS }: { sections: [string, string][] }) {
  const [active, setActive] = useState(SECTIONS[0][0]);
  const row = useRef<HTMLDivElement>(null);
  const lock = useRef(0); // 點了之後捲動的這段時間，不要跟著跳來跳去
  useEffect(() => {
    let raf = 0;
    const pick = () => {
      raf = 0;
      if (Date.now() < lock.current) return;
      const line = (row.current?.getBoundingClientRect().bottom ?? 120) + 24;
      let cur = SECTIONS[0][0];
      for (const [id] of SECTIONS) {
        const el = document.getElementById(id);
        if (el && el.getBoundingClientRect().top <= line) cur = id;
      }
      const last = document.getElementById(SECTIONS[SECTIONS.length - 1][0]);
      if (last && last.getBoundingClientRect().bottom <= window.innerHeight) cur = SECTIONS[SECTIONS.length - 1][0];
      setActive(cur);
    };
    const on = () => { if (!raf) raf = requestAnimationFrame(pick); };
    window.addEventListener("scroll", on, { passive: true, capture: true });
    window.addEventListener("resize", on);
    pick();
    return () => {
      window.removeEventListener("scroll", on, { capture: true });
      window.removeEventListener("resize", on);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [SECTIONS]);
  // 選到的那顆捲進看得到的地方（只動這一排，不動頁面）
  useEffect(() => {
    const btn = row.current?.querySelector<HTMLElement>(`[data-id="${active}"]`);
    const box = row.current?.parentElement;
    if (!btn || !box) return;
    const b = btn.getBoundingClientRect();
    const c = box.getBoundingClientRect();
    box.scrollBy({ left: b.left + b.width / 2 - (c.left + c.width / 2), behavior: "smooth" });
  }, [active]);
  return (
    <div ref={row} className="flex gap-2">
      {SECTIONS.map(([id, t]) => (
        <button
          key={id}
          type="button"
          data-id={id}
          aria-current={active === id ? "true" : undefined}
          onClick={() => {
            setActive(id);
            lock.current = Date.now() + 900;
            document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
          }}
          className={cn(
            "h-9 shrink-0 rounded-full border bg-background px-3.5 text-sm font-medium whitespace-nowrap transition-colors hover:bg-muted active:bg-muted",
            active === id && "border-primary bg-primary text-primary-foreground hover:bg-primary active:bg-primary",
          )}
        >
          {t}
        </button>
      ))}
    </div>
  );
}


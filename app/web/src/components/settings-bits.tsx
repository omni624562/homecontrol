import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

// 左右兩欄裡的一個區塊
export function Section({ title, children, note }: { title: string; children: ReactNode; note?: ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="text-sm font-medium text-muted-foreground">{title}</h3>
      {children}
      {note && <p className="text-xs leading-relaxed text-muted-foreground">{note}</p>}
    </section>
  );
}

export function Group({ children }: { children: ReactNode }) {
  return <div className="divide-y overflow-hidden rounded-xl border bg-muted/30">{children}</div>;
}

export function Row({ label, hint, children, warn, htmlFor }: { label: ReactNode; hint?: ReactNode; children?: ReactNode; warn?: boolean; htmlFor?: string }) {
  return (
    <div className="flex min-h-14 items-center gap-3 px-4 py-2.5">
      <div className="min-w-0 flex-1">
        <label htmlFor={htmlFor} className="block text-[15px] font-medium leading-snug">{label}</label>
        {hint && <div className={cn("text-xs leading-relaxed text-muted-foreground", warn && "text-orange-600 dark:text-orange-400")}>{hint}</div>}
      </div>
      {children}
    </div>
  );
}

export const Value = ({ children, tone }: { children: ReactNode; tone?: "warn" | "ok" | "muted" }) => (
  <span className={cn("text-right text-sm tabular-nums", tone === "warn" && "text-orange-600 dark:text-orange-400", tone === "ok" && "text-emerald-600 dark:text-emerald-400", tone === "muted" && "text-muted-foreground")}>
    {children}
  </span>
);


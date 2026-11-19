import { Lock, WifiOff } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { deviceIcon } from "@/components/icons";
import { fmtDur, fmtLeft, fmtSec, fmtWatts } from "@/lib/format";
import { useHub } from "@/lib/hub";
import type { Plug } from "@/lib/types";
import { cn } from "@/lib/utils";

// 一個插座：點整列看詳細，右邊的開關直接開關
export function PlugRow({ plug: p, onOpen, onToggle }: { plug: Plug; onOpen: () => void; onToggle: () => void }) {
  const { isOn, isPending, now, state } = useHub();
  const Icon = p.online ? deviceIcon(p.name) : WifiOff;
  const on = p.online && isOn(p);
  const pending = isPending(p.id);
  const t = now();

  let sub = p.max_on_s ? `最長開 ${fmtSec(p.max_on_s)}` : "";
  let tone: "timer" | "warn" | "bad" | "" = "";
  if (!p.online) {
    sub = "連不上";
    tone = "bad";
  } else if (on && p.timer) {
    sub = `${fmtLeft(p.timer - t)}後自動關閉`;
    tone = "timer";
  } else if (on) {
    const since = p.on_since ? t - p.on_since : null;
    const long = !!since && !p.keep_on && since > (state?.settings.long_on_hours || 6) * 3600;
    sub =
      (since === null ? "開著" : since < 60 ? "剛打開" : `開了 ${fmtDur(since)}${long ? "・很久沒關了" : ""}`) +
      (p.power != null ? `・${fmtWatts(p.power)}` : "") +
      (p.keep_on ? "・常開" : "");
    if (long) tone = "warn";
  }

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter") onOpen();
      }}
      aria-label={`${p.name}的詳細資料`}
      className={cn(
        "group flex min-h-16 cursor-pointer items-center gap-3 px-4 py-2.5 transition-colors outline-none",
        "hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset active:bg-muted",
      )}
    >
      <div
        className={cn(
          "flex size-10 shrink-0 items-center justify-center rounded-xl transition-colors duration-300",
          on ? "bg-amber-100 text-amber-600 dark:bg-amber-500/15 dark:text-amber-400" : "bg-muted text-muted-foreground",
          !p.online && "bg-destructive/10 text-destructive",
        )}
      >
        <Icon className="size-5" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[15px] font-medium leading-snug">{p.name}</div>
        {sub && (
          <div
            className={cn(
              "truncate text-[13px] leading-relaxed text-muted-foreground",
              tone === "warn" && "text-orange-600 dark:text-orange-400",
              tone === "timer" && "text-violet-600 dark:text-violet-400",
              tone === "bad" && "text-destructive",
            )}
          >
            {sub}
          </div>
        )}
      </div>
      {p.protect === "lock" ? (
        <Lock className="size-5 text-muted-foreground" aria-label="已鎖定" />
      ) : p.online ? (
        <Switch
          checked={on}
          aria-label={p.name}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
          onCheckedChange={() => onToggle()}
          size="lg"
          className={cn("data-[state=checked]:bg-amber-500 data-[state=unchecked]:bg-neutral-300 dark:data-[state=unchecked]:bg-neutral-600", pending && "animate-pulse")}
        />
      ) : null}
    </div>
  );
}

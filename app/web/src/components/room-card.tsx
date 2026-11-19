import { useState } from "react";
import { Loader2, Power } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { mdiIcon } from "@/components/icons";
import { PlugRow } from "@/components/plug-row";
import { api } from "@/lib/api";
import { useHub } from "@/lib/hub";
import type { Plug, Room } from "@/lib/types";
import { cn } from "@/lib/utils";

export interface Group extends Room {
  plugs: Plug[];
}

export function RoomCard({ g, onOpen, onToggle }: { g: Group; onOpen: (p: Plug) => void; onToggle: (p: Plug) => void }) {
  const { isOn } = useHub();
  const [busy, setBusy] = useState(false);
  const Icon = mdiIcon(g.icon);
  const on = g.plugs.filter((p) => p.online && isOn(p));
  const canOff = on.some((p) => !p.keep_on);
  const canOn = g.plugs.some((p) => p.online && !isOn(p));

  const all = async (turnOn: boolean) => {
    setBusy(true);
    try {
      const res = await api<{ count: number }>("POST", turnOn ? "/api/on" : "/api/off", { room: g.id });
      if (!res.count) toast(turnOn ? "沒有可以打開的插座" : "沒有開著的插座");
    } catch (err) {
      toast.error("沒有成功", { description: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="mb-4 gap-0 overflow-hidden py-0 break-inside-avoid">
      <div className="flex items-center gap-3 border-b bg-muted/60 px-4 py-3 dark:bg-muted/40">
        <div className="flex size-9 items-center justify-center rounded-lg border bg-background text-foreground/70">
          <Icon className="size-5" />
        </div>
        <h2 className="text-lg font-bold tracking-tight">{g.name}</h2>
        <span className={cn("rounded-full px-2 py-0.5 text-xs font-medium tabular-nums", on.length ? "bg-background text-foreground" : "bg-background text-muted-foreground")}>
          {on.length}／{g.plugs.length} 開著
        </span>
        {g.id && (canOff || canOn) && (
          <Button variant="outline" size="sm" className="ml-auto bg-background" disabled={busy} onClick={() => all(!canOff)}>
            {busy ? <Loader2 className="animate-spin" /> : <Power />}
            {canOff ? "全關" : "全開"}
          </Button>
        )}
      </div>
      <div className="divide-y">
        {g.plugs.map((p) => (
          <PlugRow key={p.id} plug={p} onOpen={() => onOpen(p)} onToggle={() => onToggle(p)} />
        ))}
      </div>
    </Card>
  );
}

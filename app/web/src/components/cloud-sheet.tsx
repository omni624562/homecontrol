import { useState } from "react";
import { Cloud, CloudOff, Loader2 } from "lucide-react";
import { toast } from "sonner";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/responsive-sheet";
import { api } from "@/lib/api";
import { useHub } from "@/lib/hub";
import type { Plug } from "@/lib/types";

// 還綁著 TP-Link 帳號的插座（排插算一台）；還沒讀到的當作綁著
export function cloudBound(plugs: Plug[]) {
  const devs = new Map<string, Plug>();
  for (const p of plugs) if (p.online) devs.set(p.device || p.id, p);
  return [...devs.values()].filter((p) => p.net?.cloud_bound !== false);
}

const Bullets = ({ items }: { items: string[] }) => (
  <ul className="list-disc space-y-1.5 pl-5 leading-relaxed text-muted-foreground">{items.map((t) => <li key={t}>{t}</li>)}</ul>
);

export function CloudSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { state } = useHub();
  const [busy, setBusy] = useState(false);
  const plugs = state?.plugs || [];
  const devs = new Set(plugs.filter((p) => p.online).map((p) => p.device || p.id)).size;
  const on = cloudBound(plugs).length;
  const unbind = async () => {
    setBusy(true);
    try {
      const r = await api<{ ok: number; failed: number }>("POST", "/api/cloud/unbind", { confirm: "斷開" });
      toast.success(r.failed ? `斷開 ${r.ok} 台，${r.failed} 台沒有回應` : `已斷開 ${r.ok} 台插座的 TP-Link 雲端`);
      onClose();
    } catch (e) {
      toast.error("沒有成功", { description: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet
      open={open}
      onOpenChange={(v) => !v && onClose()}
      title="TP-Link 雲端"
      description={on ? `${on}／${devs} 台插座綁著 TP-Link 帳號` : `${devs} 台插座都已解除綁定`}
      icon={on ? <Cloud /> : <CloudOff />}
    >
      {!on ? (
        <div className="space-y-4">
          <p className="leading-relaxed">所有插座都已經和你的 TP-Link 帳號<b>解除綁定</b>。</p>
          <Bullets items={["家庭中控、Google Home、排程、插座內建的排程照常運作", "Kasa App 只能在家裡同一個 Wi-Fi 下控制，在外面不行", "插座還是會連到 TP-Link 的伺服器（主要是查韌體更新），但已經不屬於任何帳號", "想恢復的話，要用 Kasa App 重新設定插座"]} />
          <Button className="w-full" onClick={onClose}>好</Button>
        </div>
      ) : (
        <div className="space-y-4">
          <p className="leading-relaxed">家庭中控和 Google Home（Matter）都在家裡直接控制插座，<b>不需要</b> TP-Link 雲端。斷開後：</p>
          <Bullets items={["插座不再和 TP-Link 的伺服器連線，隱私比較好", "Kasa App 在外面不能控制，家裡同一個 Wi-Fi 還可以", "家庭中控、Google Home、排程、插座內建的排程都不受影響", "想恢復的話，要用 Kasa App 重新設定插座"]} />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>先不要</Button>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="destructive" disabled={busy}>{busy && <Loader2 className="animate-spin" />}斷開所有插座</Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>斷開所有插座的 TP-Link 雲端？</AlertDialogTitle>
                  <AlertDialogDescription>之後 Kasa App 只能在家裡的 Wi-Fi 使用；要恢復得用 Kasa App 重新設定插座。家庭中控和 Google Home 不受影響。</AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>取消</AlertDialogCancel>
                  <AlertDialogAction variant="destructive" onClick={unbind}>斷開</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </div>
      )}
    </Sheet>
  );
}

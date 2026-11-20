import { useEffect, useState } from "react";
import { Home, Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { mdiIcon } from "@/components/icons";
import { Sheet } from "@/components/responsive-sheet";
import { api } from "@/lib/api";
import { useHub } from "@/lib/hub";

// 新增／改名／刪除區域；open = 區域 id，"" 是新增
export function RoomSheet({ open, onClose }: { open: string | null; onClose: () => void }) {
  const { state } = useHub();
  const isNew = open === "";
  const room = open ? state?.rooms.find((r) => r.id === open) : undefined;
  const count = room ? (state?.plugs || []).filter((p) => p.room === room.id).length : 0;
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  useEffect(() => {
    setName(room?.name || "");
    setErr("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const I = room ? mdiIcon(room.icon, Home) : Home;
  const save = async () => {
    const n = name.trim();
    if (!n) return setErr("請輸入區域名稱");
    setBusy(true);
    try {
      if (room) await api("PATCH", `/api/rooms/${room.id}`, { name: n });
      else await api("POST", "/api/rooms", { name: n });
      toast.success(room ? "已改名" : `已建立「${n}」，按住插座右邊的 ⠿ 拖進來`);
      onClose();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!room) return;
    try {
      await api("DELETE", `/api/rooms/${room.id}`);
      toast.success(`已刪除「${room.name}」`);
      onClose();
    } catch (e) {
      toast.error("沒有成功", { description: (e as Error).message });
    }
  };
  return (
    <Sheet open={open !== null && (isNew || !!room)} onOpenChange={(v) => !v && onClose()} title={isNew ? "新增區域" : room?.name || ""} description={isNew ? undefined : `${count} 個插座`} icon={<I />}>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); save(); }}>
        <label className="block text-sm font-medium text-muted-foreground" htmlFor="room-name">區域名稱</label>
        <Input id="room-name" autoFocus value={name} maxLength={20} placeholder="例如：客廳、書房" onChange={(e) => { setName(e.target.value); setErr(""); }} className="h-11" />
        <p className="text-sm leading-relaxed text-muted-foreground">圖示會依名稱自動選，例如「客廳」是沙發、「廚房」是爐子。</p>
        {err && <p role="alert" className="text-sm text-destructive">{err}</p>}
        <div className="flex items-center gap-2 pt-2">
          {room ? (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button type="button" variant="ghost" className="text-destructive hover:bg-destructive/10 hover:text-destructive"><Trash2 />刪除區域</Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>刪除這個區域？</AlertDialogTitle>
                  <AlertDialogDescription>區域裡的裝置會移到「還沒分區域」，裝置本身不受影響。</AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>取消</AlertDialogCancel>
                  <AlertDialogAction variant="destructive" onClick={remove}>刪除</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          ) : (
            <Button type="button" variant="ghost" onClick={onClose}>取消</Button>
          )}
          <Button type="submit" className="ml-auto h-11 min-w-24" disabled={busy}>{busy && <Loader2 className="animate-spin" />}{room ? "儲存" : "建立"}</Button>
        </div>
      </form>
    </Sheet>
  );
}

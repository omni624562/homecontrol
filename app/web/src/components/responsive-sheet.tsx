import type { ReactNode } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Drawer, DrawerContent, DrawerDescription, DrawerHeader, DrawerTitle } from "@/components/ui/drawer";
import { useMedia } from "@/lib/hub";
import { cn } from "@/lib/utils";

// 面板：電腦是置中的對話框，手機是從下面滑上來的抽屜（可以往下拖關掉）
export function Sheet({
  open, onOpenChange, title, description, icon, children, wide,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  children: ReactNode;
  wide?: boolean;
}) {
  const desktop = useMedia("(min-width: 768px)");
  const head = (
    <div className="flex items-center gap-3 text-left">
      {icon && <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground [&_svg]:size-5">{icon}</div>}
      <div className="min-w-0">
        {desktop ? <DialogTitle className="text-lg">{title}</DialogTitle> : <DrawerTitle className="text-lg">{title}</DrawerTitle>}
        {description &&
          (desktop ? (
            <DialogDescription className="leading-relaxed">{description}</DialogDescription>
          ) : (
            <DrawerDescription className="leading-relaxed">{description}</DrawerDescription>
          ))}
      </div>
    </div>
  );
  if (desktop)
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className={cn("max-h-[88vh] grid-cols-[minmax(0,1fr)] overflow-y-auto", wide ? "sm:max-w-2xl" : "sm:max-w-md")}>
          <DialogHeader>{head}</DialogHeader>
          <div className="min-w-0">{children}</div>
        </DialogContent>
      </Dialog>
    );
  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent className="max-h-[92vh]">
        <DrawerHeader className="pb-2">{head}</DrawerHeader>
        <div className="overflow-y-auto px-4 pb-[max(1.5rem,env(safe-area-inset-bottom))]">{children}</div>
      </DrawerContent>
    </Drawer>
  );
}

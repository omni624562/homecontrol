import type { ReactNode } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Drawer, DrawerContent, DrawerDescription, DrawerHeader, DrawerTitle } from "@/components/ui/drawer";
import { useMedia } from "@/lib/hub";
import { cn } from "@/lib/utils";

// 面板：電腦是置中的對話框，手機是從下面滑上來的抽屜（可以往下拖關掉）
export function Sheet({
  open, onOpenChange, title, description, icon, children, wide, aside,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  children: ReactNode;
  wide?: boolean | "xl";
  // 標題列右邊：這個面板最重要的一項（狀態、數字、開關）
  aside?: ReactNode;
}) {
  const desktop = useMedia("(min-width: 768px)");
  const head = (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-left">
      {icon && <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-background text-foreground/70 [&_svg]:size-5">{icon}</div>}
      <div className="min-w-0 flex-1">
        {desktop ? <DialogTitle className="text-lg">{title}</DialogTitle> : <DrawerTitle className="text-lg">{title}</DrawerTitle>}
        {description &&
          (desktop ? (
            <DialogDescription className="leading-relaxed">{description}</DialogDescription>
          ) : (
            <DrawerDescription className="leading-relaxed">{description}</DrawerDescription>
          ))}
      </div>
      {aside && <div className="ml-auto flex shrink-0 items-center gap-3">{aside}</div>}
    </div>
  );
  if (desktop)
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent
          className={cn(
            "flex max-h-[88vh] flex-col gap-0 overflow-hidden rounded-2xl p-0",
            wide === "xl" ? "sm:max-w-5xl" : wide ? "sm:max-w-2xl" : "sm:max-w-md",
          )}
        >
          <DialogHeader className="shrink-0 border-b bg-muted/60 px-6 py-3.5 pr-14 dark:bg-muted/40">{head}</DialogHeader>
          <div className="scroll-area min-h-0 min-w-0 flex-1 overflow-y-auto px-6 pt-4 pb-6">{children}</div>
        </DialogContent>
      </Dialog>
    );
  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent className="max-h-[92vh]">
        <DrawerHeader className="border-b pt-2 pb-3">{head}</DrawerHeader>
        <div className="scroll-area min-h-0 overflow-y-auto px-4 pt-3 pb-[max(1.5rem,env(safe-area-inset-bottom))]">{children}</div>
      </DrawerContent>
    </Drawer>
  );
}

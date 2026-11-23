import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { useHub } from "@/lib/hub";

// 樹莓派更新了（版本號變了）：畫面也換成新版。
// App 在背景時，回到前景就直接重新載入；正在用的話跳提示，讓使用者自己按（不打斷正在畫、正在填的東西）
export function useAutoUpdate() {
  const { state } = useHub();
  const first = useRef<string | null>(null);
  const shown = useRef(false);
  const ver = state?.app_version;
  useEffect(() => {
    if (!ver) return;
    if (first.current === null) { first.current = ver; return; }
    if (ver === first.current || shown.current) return;
    shown.current = true;
    if (document.hidden) { location.reload(); return; }
    toast("家庭中控更新了", {
      description: "重新整理就會用新版",
      duration: Infinity,
      action: { label: "重新整理", onClick: () => location.reload() },
    });
    // 沒按就切到背景：回來時直接換新版
    let away = false;
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) away = true;
      else if (away) location.reload();
    });
  }, [ver]);
}

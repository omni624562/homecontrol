import { useEffect, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { HomePage } from "@/pages/home";

// 新版目前只有首頁；其他分頁會連回舊版
export default function App() {
  const [tab, setTab] = useState(() => location.hash.slice(1) || "plugs");
  useEffect(() => {
    const on = () => setTab(location.hash.slice(1) || "plugs");
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);
  return (
    <AppShell tab={tab}>
      <HomePage />
    </AppShell>
  );
}

import { Suspense, lazy, useEffect, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { HomePage } from "@/pages/home";
import { AskProvider } from "@/components/ask-sheet";
import { TruckRush } from "@/components/truck-rush";
import { FxLayer } from "@/components/fx";
import { Standby } from "@/components/standby";
import { useLook } from "@/lib/look";
import { track } from "@/lib/usage";

// 首頁以外的頁面用到才載入（首頁比較快出現）；首頁出來後趁空檔先載好，切換時就不用等
const load = {
  schedule: () => import("@/pages/schedule").then((m) => ({ default: m.SchedulePage })),
  energy: () => import("@/pages/energy").then((m) => ({ default: m.EnergyPage })),
  settings: () => import("@/pages/settings").then((m) => ({ default: m.SettingsPage })),
  edit: () => import("@/pages/edit").then((m) => ({ default: m.EditPage })),
  net: () => import("@/pages/net").then((m) => ({ default: m.NetPage })),
  map: () => import("@/pages/map").then((m) => ({ default: m.MapPage })),
  cameras: () => import("@/pages/cameras").then((m) => ({ default: m.CamerasPage })),
  life: () => import("@/pages/life").then((m) => ({ default: m.LifePage })),
};
const PAGES = Object.fromEntries(Object.entries(load).map(([k, f]) => [k, lazy(f)])) as Record<keyof typeof load, React.LazyExoticComponent<() => React.JSX.Element>>;

export default function App() {
  // 網址 #頁名 或 #頁名/段落（例如 #settings/s-notify：打開設定頁並捲到通知）
  const [tab, setTab] = useState(() => location.hash.slice(1).split("/")[0] || "plugs");
  useEffect(() => {
    const on = () => setTab(location.hash.slice(1).split("/")[0] || "plugs");
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);
  useEffect(() => {
    const t = setTimeout(() => Object.values(load).forEach((f) => f().catch(() => {})), 2500);
    return () => clearTimeout(t);
  }, []);
  // 手機上方狀態列（和加到主畫面時的系統列）的顏色跟著畫面底色：換外觀、深淺色時一起換
  const look = useLook();
  useEffect(() => {
    const sync = () => {
      const bg = getComputedStyle(document.body).backgroundColor;
      document.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.setAttribute("content", bg));
    };
    sync();
    const mq = matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, [look]);
  useEffect(() => { track(tab); }, [tab]);
  const Page = tab in PAGES ? PAGES[tab as keyof typeof load] : null;
  return (
    <AskProvider>
      <AppShell tab={tab}>
        {Page ? <Suspense fallback={<div className="min-h-[60vh]" />}><Page /></Suspense> : <HomePage />}
      </AppShell>
      <TruckRush />
      <FxLayer />
      <Standby />
    </AskProvider>
  );
}

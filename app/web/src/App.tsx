import { Suspense, lazy, useEffect, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { HomePage } from "@/pages/home";
import { AskProvider } from "@/components/ask-sheet";
import { TruckRush } from "@/components/truck-rush";
import { FxLayer } from "@/components/fx";
import { Standby } from "@/components/standby";

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
  const [tab, setTab] = useState(() => location.hash.slice(1) || "plugs");
  useEffect(() => {
    const on = () => setTab(location.hash.slice(1) || "plugs");
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);
  useEffect(() => {
    const t = setTimeout(() => Object.values(load).forEach((f) => f().catch(() => {})), 2500);
    return () => clearTimeout(t);
  }, []);
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

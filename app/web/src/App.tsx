import { useEffect, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { HomePage } from "@/pages/home";
import { SchedulePage } from "@/pages/schedule";
import { EnergyPage } from "@/pages/energy";
import { SettingsPage } from "@/pages/settings";
import { EditPage } from "@/pages/edit";
import { NetPage } from "@/pages/net";
import { MapPage } from "@/pages/map";
import { AskProvider } from "@/components/ask-sheet";

export default function App() {
  const [tab, setTab] = useState(() => location.hash.slice(1) || "plugs");
  useEffect(() => {
    const on = () => setTab(location.hash.slice(1) || "plugs");
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);
  return (
    <AskProvider>
      <AppShell tab={tab}>
        {tab === "schedule" ? <SchedulePage /> : tab === "energy" ? <EnergyPage /> : tab === "settings" ? <SettingsPage /> : tab === "edit" ? <EditPage /> : tab === "net" ? <NetPage /> : tab === "map" ? <MapPage /> : <HomePage />}
      </AppShell>
    </AskProvider>
  );
}

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { HubProvider } from "@/lib/hub";
import { PairGate } from "@/components/pair-screen";
import { applyLook } from "@/lib/look";
import { watchTheme } from "@/lib/theme";
import App from "./App";
import "./index.css";

watchTheme(); // 深色模式跟著系統（右鍵選單可以在這台切換）
applyLook(); // 外觀：原本／科技感（設定頁可以換）

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <PairGate>
      <HubProvider>
        <TooltipProvider>
          <App />
          <Toaster position="top-center" richColors closeButton />
        </TooltipProvider>
      </HubProvider>
    </PairGate>
  </StrictMode>,
);

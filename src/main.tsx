import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { TooltipProvider } from "@/components/ui/tooltip";
import "./index.css";

// Theme before first paint: saved choice, else the system setting.
let theme: string | null = null;
try {
  theme = localStorage.getItem("fledge:theme");
} catch {}
const dark = theme ? theme === "dark" : window.matchMedia("(prefers-color-scheme: dark)").matches;
document.documentElement.classList.toggle("dark", dark);

// Installable as an app (see public/sw.js: it caches nothing, it only explains when fledge isn't running).
if ("serviceWorker" in navigator && !import.meta.env.DEV) void navigator.serviceWorker.register("/sw.js").catch(() => {});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TooltipProvider delayDuration={300}>
      <App />
    </TooltipProvider>
  </StrictMode>,
);

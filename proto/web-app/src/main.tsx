import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { simulateNextListError } from "@lia496/shared";
import "./theme.css";
import App from "./App";

// Code-review fix (LIA-496 REVISE round) — exposed ONLY so
// `captures/verify-s3.mjs` (the real headless verification driver) can
// force a genuine `list()` failure to prove the Sidebar's error state is
// real, not scripted UI. Never called by any in-app code path; this is a
// test hook, the same spirit as `resetFixtureThreads`/`knownThreadIds`
// already being exported from shared/src for verification purposes.
declare global {
  interface Window {
    __lia496_simulateNextListError?: () => void;
  }
}
window.__lia496_simulateNextListError = simulateNextListError;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

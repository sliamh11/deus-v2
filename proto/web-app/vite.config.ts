import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// LIA-496 — "Reading Room" (web target). Same minimal config shape as
// LIA-495's proven web-first-demo/vite.config.ts.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5190,
  },
});

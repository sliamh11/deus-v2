// LIA-495 — Ink entry point, mirroring web-first-demo's main.tsx/App.tsx
// split (App.tsx exports the component, main.tsx mounts it) rather than
// full-shell.tsx's single-file `render(<App />)` at module scope. No
// StrictMode/createRoot equivalent exists for Ink — `render()` (from
// "ink") is the terminal target's own mount call, used exactly as
// full-shell.tsx used it.
import { render } from "ink";
import App from "./App";

render(<App />);

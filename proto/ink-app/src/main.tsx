// LIA-496 — Ink entry point. `render()` (from "ink") is the terminal
// target's own mount call, same split as LIA-495's main.tsx/App.tsx
// (App.tsx exports the component, main.tsx mounts it).
import { render } from "ink";
import App from "./App";

render(<App />);

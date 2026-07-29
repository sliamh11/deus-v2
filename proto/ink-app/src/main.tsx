// LIA-496 — Ink entry point. `render()` (from "ink") is the terminal
// target's own mount call, same split as LIA-495's main.tsx/App.tsx
// (App.tsx exports the component, main.tsx mounts it).
//
// LIA-496 IB4 (I14, D1's esc/ctrl+c-deny requirement) — `exitOnCtrlC:
// false`, verified necessary by reading `ink/build/hooks/use-input.js`
// directly (not assumed): its own `handleData` gates delivery to EVERY
// `useInput` consumer with `if (!(input === 'c' && key.ctrl) ||
// !internal_exitOnCtrlC)` — i.e. with the default `exitOnCtrlC: true`, a
// ctrl+c keypress is swallowed before it ever reaches ANY component's
// `useInput` callback (App.js's own separate top-level `handleInput`
// exits the process directly instead). `PermissionPrompt.tsx`'s ctrl+c
// handler is therefore unreachable unless this flag is flipped here.
// Disabling it removes Ink's own automatic ctrl+c-exits-the-app behavior
// globally, so `App.tsx`'s `useThreadNavigation` now owns a manual
// `useApp().exit()` call on ctrl+c for the "no approval pending" case —
// see that hook's own header comment for why the two guards (deny vs.
// exit) can never both fire for the same keypress.
import { render } from "ink";
import App from "./App";

render(<App />, { exitOnCtrlC: false });

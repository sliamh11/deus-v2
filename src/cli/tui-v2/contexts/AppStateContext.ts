/**
 * The ONE thin Context provider for `deus tui`'s v2 (Gemini-chrome fork) UI,
 * per the plan's resolved design decision #2
 * (`~/.claude/plans/deus-tui-gemini-fork.md`): "If ported Gemini
 * presentational components expect Context rather than props/reducer state,
 * wrap `tuiReduce`'s output in ONE thin Context provider exposing that
 * state — not nine." Gemini's real `AppContainer.tsx` nests NINE providers
 * (`UIStateContext`, `QuotaContext`, `InputContext`, `UIActionsContext`,
 * `ConfigContext`, `AppContext`, `ToolActionsContext`, `ShellFocusContext`,
 * `MouseContext`/`ScrollProvider`) — confirmed directly by fetching and
 * reading the real file (`packages/cli/src/ui/AppContainer.tsx`, lines
 * 2833-2865 of the `main`-branch source at fetch time). Deus has no quota
 * system, no IDE companion, no client-side tool-execution tracker (see the
 * plan's "Critical reconciled finding"), no mouse/scroll subsystem yet, and
 * exactly one place tools actually execute (the daemon) — so eight of those
 * nine have no Deus equivalent. This file is the single replacement: one
 * value object, one provider, one consumer hook.
 *
 * `AppStateValue` is deliberately NOT `TuiState` reexported as-is — it also
 * carries the three action entry points (`submitTurn`, `respondPermission`,
 * `onExit`) so consumers never need to reach past this context back into
 * `AppContainer.tsx`'s internals (the bridge instance, the transport) to act
 * on what they render. `state`/`busy` are read-only from a consumer's
 * perspective; `AppContainer.tsx` is the only writer.
 */

import { createContext, useContext } from 'react';
import type { TuiState } from '../deus-tui-state.js';
import type { PermissionListKeypress } from '../deus-tui-permission-decision-v2.js';

export interface AppStateValue {
  /** Current `tuiReduce` state — transcript, input, permission modal, command palette, status. */
  state: TuiState;
  /** True while a turn submitted via `submitTurn` has not yet resolved (mirrors `ChatStreamBridge.isBusy()`). */
  busy: boolean;
  /**
   * Update the live (not-yet-submitted) input buffer — `state.input`,
   * dispatched through `tuiReduce`'s `input_change` action so the composer
   * stays a controlled view onto the single source of truth rather than
   * component-local state.
   */
  setInput: (value: string) => void;
  /**
   * Submit one user turn. Fire-and-forget from a consumer's perspective —
   * `deus-chat-stream-bridge.ts`'s `submitTurn` streams the result into
   * `state` via `AppContainer.tsx`'s `setState`; nothing here needs to be
   * awaited by the UI layer. No-ops while `busy` is already true.
   */
  submitTurn: (prompt: string) => void;
  /**
   * Forward one permission-modal keystroke, per
   * `deus-tui-permission-decision-v2.ts`'s arrow-key list-select contract
   * (build-sequence step 8, design decision #3): Up/Down move
   * `state.permission.cursorIndex`, Enter resolves the highlighted option.
   * The cursor index itself lives in `TuiState`, not here — this is just the
   * one action entry point every keystroke funnels through.
   */
  respondPermission: (key: PermissionListKeypress) => void;
  /** Requests app shutdown (mirrors `deus-tui-app.tsx`'s `onExit` prop). */
  onExit: () => void;
  /**
   * Real cwd-relative, one-level directory listing for `Composer.tsx`'s
   * `@`-mention autocomplete (LIA-475): given a directory portion of a
   * typed path (relative to `AppContainer.tsx`'s `cwd`, `""` meaning `cwd`
   * itself), resolves to that directory's entry names with a trailing `/`
   * already appended to any subdirectory name. Never rejects — resolves to
   * `[]` on any real `fs.readdir` failure (missing/unreadable path, not a
   * directory, etc.) so a bad path never crashes the composer, only
   * produces an empty suggestion list. Threaded through this context
   * (rather than a prop `App.tsx` would otherwise have no way to receive,
   * since it renders `<App />` with no props of its own — see that file's
   * header) specifically because it needs `AppContainer.tsx`'s real `cwd`
   * and real `fs`, unlike the static `commands/index.ts` `ALL_COMMANDS`
   * list `App.tsx` imports directly for the sibling `/`-autocomplete case.
   */
  listMentionDirectory: (dirPart: string) => Promise<string[]>;
}

export const AppStateContext = createContext<AppStateValue | undefined>(
  undefined,
);

/**
 * Throws (rather than returning `undefined`) if called outside
 * `AppContainer.tsx`'s provider — every `tui-v2` presentational component is
 * expected to render under `<App>`, so a missing provider is a wiring bug,
 * not a valid runtime state to render around.
 */
export function useAppState(): AppStateValue {
  const value = useContext(AppStateContext);
  if (value === undefined) {
    throw new Error(
      'useAppState() called outside <AppStateContext.Provider> — render this component under tui-v2/AppContainer.tsx.',
    );
  }
  return value;
}

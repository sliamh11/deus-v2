/**
 * Ctrl+R reverse-history search — pure state module (same "no Ink/React
 * import, safe to build without touching in-flight UI files" rationale as
 * `transcript-search.ts`'s header).
 *
 * Ported from `~/deus/tui/src/app.rs`'s `reverse_search_mode` /
 * `reverse_search_query` / `reverse_search_match_index` /
 * `reverse_search_saved_input` fields + `find_reverse_match`/
 * `exit_reverse_search` (read directly, lines 436-528) and `main.rs`'s key
 * router for that mode (read directly, lines 168-227) — a real, working
 * bash-style reverse-i-search design from the v1 ratatui TUI, ported
 * faithfully including its "freeze on no match" behavior (typing a
 * character that matches nothing leaves the previewed input exactly as it
 * was, rather than clearing it — this is standard reverse-i-search UX, not
 * a bug, unlike the Ctrl+F 'n'/'N' collision noted in
 * `transcript-search.ts`'s header).
 *
 * Design note on why this is a pure function set instead of a stateful
 * class (unlike `app.rs`'s `&mut self` methods): every function here takes
 * `history` and the current `HistorySearchState` and returns a new state (or
 * a derived preview string) — no method mutates in place. This matches
 * `deus-tui-state.ts`'s `tuiReduce` convention (pure reducer, `TuiState` in,
 * `TuiState` out) rather than the class-based Rust original, so a future
 * Composer.tsx wiring step can drive it the same way it already drives
 * `tuiReduce`.
 */

export interface HistorySearchState {
  active: boolean;
  query: string;
  matchIndex: number;
  savedInput: string;
}

export function createHistorySearchState(): HistorySearchState {
  return { active: false, query: '', matchIndex: 0, savedInput: '' };
}

/** Ctrl+R: saves `currentInput` (restored on Esc) and opens search — mirrors the real `main.rs` Ctrl+R handler (lines 337-340). */
export function startHistorySearch(currentInput: string): HistorySearchState {
  return { active: true, query: '', matchIndex: 0, savedInput: currentInput };
}

/**
 * Finds the `state.matchIndex`-th most-recent history entry containing
 * `state.query` (0 = most recent), or `undefined` if none exists — mirrors
 * `find_reverse_match` exactly: `history` is assumed oldest-first (matching
 * append order), searched newest-first.
 */
export function findHistoryMatch(
  history: readonly string[],
  state: HistorySearchState,
): string | undefined {
  if (state.query === '') return undefined;
  let seen = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].includes(state.query)) {
      if (seen === state.matchIndex) return history[i];
      seen++;
    }
  }
  return undefined;
}

/**
 * What the composer's input buffer should show right now for `state` — the
 * "freeze on no match" rule from the module doc: an empty query previews
 * the original saved input; a non-empty query with no match returns
 * `undefined`, meaning "leave the input exactly as it currently is".
 */
export function previewForHistorySearch(
  history: readonly string[],
  state: HistorySearchState,
): string | undefined {
  if (state.query === '') return state.savedInput;
  return findHistoryMatch(history, state);
}

/** One typed character: extends the query and resets back to the most recent match. */
export function typeHistorySearchChar(
  state: HistorySearchState,
  char: string,
): HistorySearchState {
  return { ...state, query: state.query + char, matchIndex: 0 };
}

/** Backspace: shortens the query and resets back to the most recent match. */
export function backspaceHistorySearch(
  state: HistorySearchState,
): HistorySearchState {
  return { ...state, query: state.query.slice(0, -1), matchIndex: 0 };
}

/**
 * Ctrl+R pressed again while already searching: steps to the next-older
 * match. If none exists, `matchIndex` rolls back to the last index that DID
 * have a match (mirrors `saturating_sub(1)` in the real source) rather than
 * advancing past the end of history.
 */
export function cycleHistorySearch(
  history: readonly string[],
  state: HistorySearchState,
): HistorySearchState {
  const advanced = { ...state, matchIndex: state.matchIndex + 1 };
  if (findHistoryMatch(history, advanced) !== undefined) return advanced;
  return { ...state, matchIndex: Math.max(0, state.matchIndex) };
}

/**
 * Enter (or any key that isn't Ctrl+R/char/backspace/Esc): resolves to the
 * final input text search should leave behind, using the same
 * freeze-on-no-match rule as `previewForHistorySearch` — callers combine
 * this with whatever input value was already on screen when it's
 * `undefined`. Always call `exitHistorySearch` alongside this to close the
 * mode.
 */
export function commitHistorySearch(
  history: readonly string[],
  state: HistorySearchState,
): string | undefined {
  return findHistoryMatch(history, state);
}

/** Esc: always restores exactly what was in the composer before search started. */
export function cancelHistorySearch(state: HistorySearchState): string {
  return state.savedInput;
}

export function exitHistorySearch(): HistorySearchState {
  return createHistorySearchState();
}

/**
 * Ctrl+F transcript search — pure state module, no Ink/React import (same
 * convention as `deus-tui-state.ts`/`commands/registry.ts`), so it's
 * independently testable and safe to build without touching any of the
 * currently in-flight `tui-v2` UI files (`App.tsx`/`AppContainer.tsx`/
 * `Composer.tsx` were all under active concurrent edit by another
 * build-sequence step while this module was written — see this step's final
 * report for the full note). Wiring a real Ink key-handler and a visible
 * match-count indicator onto this state is the follow-up once those files
 * settle; this module is what that wiring will call.
 *
 * Ported from `~/deus/tui/src/app.rs`'s `output_search_mode` /
 * `output_search_query` / `output_search_matches` / `output_search_current`
 * fields and their `enter_output_search`/`exit_output_search`/
 * `update_output_search`/`next_search_match`/`prev_search_match` methods
 * (read directly, lines 530-588) — the real, working Ctrl+F design from the
 * v1 ratatui TUI this plan names as the interaction reference for this
 * addition. One deliberate correction versus that source, not a
 * reinterpretation: the real `main.rs` key-router (lines 143-166) special-
 * cases `'n'`/`'N'` as next/prev-match shortcuts ahead of the generic
 * "append this character to the query" arm — meaning typing a literal `n`
 * into a search query is impossible there (a real usability bug, not an
 * intentional design choice). This module has no such collision: typed
 * characters always extend `query` via `updateTranscriptSearchQuery`;
 * `nextTranscriptMatch`/`prevTranscriptMatch` are separate entry points a
 * key-handler binds to distinct keys (e.g. Down/Up, or Ctrl+F again /
 * Ctrl+Shift+F) instead of overloading a letter that's also valid query
 * text.
 */

export interface TranscriptSearchEntry {
  id: number;
  text: string;
}

export interface TranscriptMatch {
  entryId: number;
  /** Character offset of the match within that entry's `text`, lowercased comparison. */
  offset: number;
}

export interface TranscriptSearchState {
  active: boolean;
  query: string;
  matches: readonly TranscriptMatch[];
  currentIndex: number;
}

export function createTranscriptSearchState(): TranscriptSearchState {
  return { active: false, query: '', matches: [], currentIndex: 0 };
}

/** Ctrl+F: opens search with an empty query and no matches yet — mirrors `enter_output_search`. */
export function startTranscriptSearch(): TranscriptSearchState {
  return { active: true, query: '', matches: [], currentIndex: 0 };
}

/** Esc (or Enter, per the ratatui reference — search-and-dismiss, not search-and-apply): mirrors `exit_output_search`. */
export function exitTranscriptSearch(): TranscriptSearchState {
  return createTranscriptSearchState();
}

function findMatches(
  entries: readonly TranscriptSearchEntry[],
  query: string,
): TranscriptMatch[] {
  if (query === '') return [];
  const lowerQuery = query.toLowerCase();
  const matches: TranscriptMatch[] = [];
  for (const entry of entries) {
    const lowerText = entry.text.toLowerCase();
    let fromIndex = 0;
    let offset = lowerText.indexOf(lowerQuery, fromIndex);
    while (offset !== -1) {
      matches.push({ entryId: entry.id, offset });
      fromIndex = offset + 1;
      offset = lowerText.indexOf(lowerQuery, fromIndex);
    }
  }
  return matches;
}

/** Recomputes `matches`/resets `currentIndex` to 0 for a new query — mirrors `update_output_search`. */
export function updateTranscriptSearchQuery(
  state: TranscriptSearchState,
  entries: readonly TranscriptSearchEntry[],
  query: string,
): TranscriptSearchState {
  return {
    ...state,
    query,
    matches: findMatches(entries, query),
    currentIndex: 0,
  };
}

/** Mirrors `next_search_match`: wraps around, no-ops with zero matches. */
export function nextTranscriptMatch(
  state: TranscriptSearchState,
): TranscriptSearchState {
  if (state.matches.length === 0) return state;
  return {
    ...state,
    currentIndex: (state.currentIndex + 1) % state.matches.length,
  };
}

/** Mirrors `prev_search_match`: wraps around, no-ops with zero matches. */
export function prevTranscriptMatch(
  state: TranscriptSearchState,
): TranscriptSearchState {
  if (state.matches.length === 0) return state;
  const total = state.matches.length;
  return { ...state, currentIndex: (state.currentIndex + total - 1) % total };
}

export function currentTranscriptMatch(
  state: TranscriptSearchState,
): TranscriptMatch | undefined {
  return state.matches[state.currentIndex];
}

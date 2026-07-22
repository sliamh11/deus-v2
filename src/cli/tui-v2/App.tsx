/**
 * Presentational root for `tui-v2`, mirroring Gemini's real split (fetched
 * and read directly from `packages/cli/src/ui/App.tsx`): Gemini's `App.tsx`
 * is a genuinely thin 38-line component that owns no state itself — it
 * reads `useUIState()` and picks a layout. This file plays the same role:
 * all state and wiring live in `AppContainer.tsx`; this component only
 * reads `useAppState()` (the ONE thin context, per the plan's resolved
 * design decision #2 — see `contexts/AppStateContext.ts`'s header for why
 * Gemini's real nine-provider tree does not get ported) and composes the
 * mounting points this build-sequence step exists to wire up:
 *
 * - Message list (`components/messages/MessageList.tsx`) — the scrolling
 *   transcript, itself split into a message seam and a tool-call seam (see
 *   that file's header).
 * - Permission modal (`components/PermissionModal.tsx`) — arrow-key
 *   `RadioButtonSelect`-style chrome (build-sequence step 8, design
 *   decision #3), driving Deus's real 3-way decision contract via
 *   `deus-tui-permission-decision-v2.ts`.
 * - Transcript search bar (`components/TranscriptSearchBar.tsx`, build-
 *   sequence step 9's Ctrl+F addition) — a local (not `AppStateContext`)
 *   `useState<TranscriptSearchState>` lives here specifically because
 *   search is a pure view-layer concern over `state.transcript` that no
 *   other component needs to read or mutate; putting it in the shared
 *   context would widen that context's surface for zero real benefit.
 * - Composer (`components/Composer.tsx`) — text input; now also owns
 *   Ctrl+R reverse-history search (see its own header) and receives
 *   `submitTurn` as-is — slash-command interpretation and `@path` mention
 *   expansion both happen inside `AppContainer.tsx`'s `submitTurn`, not
 *   here (see that file's header).
 *
 * Exactly one of PermissionModal / search bar / Composer renders at a time
 * (mirroring `tui/deus-tui-app.tsx`'s mutual-exclusion invariant for
 * InputLine / PermissionModal / CommandPalette) — a permission request
 * always wins over search, and search always wins over the composer, so
 * typed characters are never ambiguous about which one consumes them.
 */

import type React from 'react';
import { useCallback, useMemo, useState } from 'react';
import { Box, useInput, type Key } from 'ink';

import { useAppState } from './contexts/AppStateContext.js';
import { StatusHeader } from './components/StatusHeader.js';
import { MessageList } from './components/messages/MessageList.js';
import { PermissionModal } from './components/PermissionModal.js';
import { Composer } from './components/Composer.js';
import { TranscriptSearchBar } from './components/TranscriptSearchBar.js';
import {
  createTranscriptSearchState,
  currentTranscriptMatch,
  exitTranscriptSearch,
  startTranscriptSearch,
  type TranscriptSearchState,
} from './search/transcript-search.js';

export function App(): React.ReactNode {
  const { state, busy, submitTurn, setInput, respondPermission } =
    useAppState();
  const [search, setSearch] = useState<TranscriptSearchState>(
    createTranscriptSearchState,
  );

  const searchToggleActive = !state.permission && !busy && !search.active;
  const handleGlobalInput = useCallback((input: string, key: Key) => {
    if (key.ctrl && input === 'f') setSearch(startTranscriptSearch());
  }, []);
  useInput(handleGlobalInput, { isActive: searchToggleActive });

  const history = useMemo(
    () => state.transcript.filter((e) => e.kind === 'user').map((e) => e.text),
    [state.transcript],
  );

  const activeMatch = currentTranscriptMatch(search);
  const inputActive = !state.permission && !busy && !search.active;

  return (
    <Box flexDirection="column">
      <StatusHeader status={state.status} />
      <MessageList entries={state.transcript} activeMatchEntryId={activeMatch?.entryId} />
      {state.permission ? (
        <PermissionModal
          key={state.permission.requestId}
          toolName={state.permission.toolName}
          toolInputPreview={state.permission.toolInputPreview}
          cursorIndex={state.permission.cursorIndex}
          onKeypress={respondPermission}
        />
      ) : search.active ? (
        <TranscriptSearchBar
          state={search}
          entries={state.transcript}
          isActive={!busy}
          onChange={setSearch}
          onExit={() => setSearch(exitTranscriptSearch())}
        />
      ) : (
        <Composer
          value={state.input}
          isActive={inputActive}
          history={history}
          onChange={setInput}
          onSubmit={submitTurn}
        />
      )}
    </Box>
  );
}

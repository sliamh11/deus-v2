/**
 * Presentational root for `tui-v2`, mirroring Gemini's real split (fetched
 * and read directly from `packages/cli/src/ui/App.tsx`): Gemini's `App.tsx`
 * is a genuinely thin 38-line component that owns no state itself — it
 * reads `useUIState()` and picks a layout. This file plays the same role:
 * all state and wiring live in `AppContainer.tsx`; this component only
 * reads `useAppState()` (the ONE thin context, per the plan's resolved
 * design decision #2 — see `contexts/AppStateContext.ts`'s header for why
 * Gemini's real nine-provider tree does not get ported) and composes the
 * three mounting points this build-sequence step exists to wire up:
 *
 * - Message list (`components/messages/MessageList.tsx`) — the scrolling
 *   transcript, itself split into a message seam and a tool-call seam (see
 *   that file's header).
 * - Permission modal (`components/PermissionModal.tsx`) — arrow-key
 *   `RadioButtonSelect`-style chrome (build-sequence step 8, design
 *   decision #3), driving Deus's real 3-way decision contract via
 *   `deus-tui-permission-decision-v2.ts`.
 * - Composer (`components/Composer.tsx`) — minimal text input; command
 *   palette / local-command interpretation intentionally NOT wired here,
 *   deferred to build-sequence step 9's command framework.
 *
 * Exactly one of PermissionModal / Composer renders at a time (mirroring
 * `tui/deus-tui-app.tsx`'s mutual-exclusion invariant for InputLine /
 * PermissionModal / CommandPalette) — a permission request always takes
 * over input capture from the composer.
 */

import type React from 'react';
import { Box } from 'ink';

import { useAppState } from './contexts/AppStateContext.js';
import { StatusHeader } from './components/StatusHeader.js';
import { MessageList } from './components/messages/MessageList.js';
import { PermissionModal } from './components/PermissionModal.js';
import { Composer } from './components/Composer.js';

export function App(): React.ReactNode {
  const { state, busy, submitTurn, setInput, respondPermission } =
    useAppState();

  const inputActive = !state.permission && !busy;

  return (
    <Box flexDirection="column">
      <StatusHeader status={state.status} />
      <MessageList entries={state.transcript} />
      {state.permission ? (
        <PermissionModal
          key={state.permission.requestId}
          toolName={state.permission.toolName}
          toolInputPreview={state.permission.toolInputPreview}
          cursorIndex={state.permission.cursorIndex}
          onKeypress={respondPermission}
        />
      ) : (
        <Composer
          value={state.input}
          isActive={inputActive}
          onChange={setInput}
          onSubmit={submitTurn}
        />
      )}
    </Box>
  );
}

/**
 * Ctrl+F transcript-search input bar. Renders in place of `Composer.tsx`
 * while search is active (three-way mutual exclusion with `App.tsx`'s
 * existing PermissionModal/Composer split: PermissionModal > search bar >
 * Composer — a permission request always wins, matching the invariant
 * `App.tsx`'s own header already documents). Owns no search logic itself —
 * every keystroke maps onto `search/transcript-search.ts`'s pure functions,
 * this component is purely the Ink rendering + key-routing shell around
 * them (same split as `PermissionModal.tsx`/`deus-tui-permission-decision-v2.ts`).
 */

import type React from 'react';
import { useCallback, useRef } from 'react';
import { Box, Text, useInput, type Key } from 'ink';

import { themeManager } from '../themes/theme-manager.js';
import {
  nextTranscriptMatch,
  prevTranscriptMatch,
  updateTranscriptSearchQuery,
  type TranscriptSearchEntry,
  type TranscriptSearchState,
} from '../search/transcript-search.js';

export interface TranscriptSearchBarProps {
  state: TranscriptSearchState;
  entries: readonly TranscriptSearchEntry[];
  isActive: boolean;
  onChange: (next: TranscriptSearchState) => void;
  /** Esc or Enter — either dismisses the bar; search never mutates the composer's input (unlike Ctrl+R), so there is nothing to "commit". */
  onExit: () => void;
}

export function TranscriptSearchBar({
  state,
  entries,
  isActive,
  onChange,
  onExit,
}: TranscriptSearchBarProps): React.ReactNode {
  const semanticColors = themeManager.getSemanticColors();
  const latest = useRef({ state, entries, onChange, onExit });
  latest.current = { state, entries, onChange, onExit };

  const handleInput = useCallback((input: string, key: Key) => {
    const { state, entries, onChange, onExit } = latest.current;
    if (key.escape || key.return) {
      onExit();
      return;
    }
    if (key.downArrow) {
      onChange(nextTranscriptMatch(state));
      return;
    }
    if (key.upArrow) {
      onChange(prevTranscriptMatch(state));
      return;
    }
    if (key.backspace || key.delete) {
      if (state.query.length > 0) {
        onChange(updateTranscriptSearchQuery(state, entries, state.query.slice(0, -1)));
      }
      return;
    }
    if (input && !key.ctrl && !key.meta) {
      onChange(updateTranscriptSearchQuery(state, entries, state.query + input));
    }
  }, []);

  useInput(handleInput, { isActive });

  const countLabel =
    state.matches.length === 0
      ? state.query === ''
        ? ''
        : 'no matches'
      : `${state.currentIndex + 1}/${state.matches.length}`;

  return (
    <Box>
      <Text color={semanticColors.ui.active}>{'/ '}</Text>
      <Text color={semanticColors.text.primary}>{state.query}</Text>
      {isActive ? <Text inverse> </Text> : null}
      {countLabel ? (
        <Text color={semanticColors.text.secondary}>{`  ${countLabel}`}</Text>
      ) : null}
      <Text color={semanticColors.ui.comment}>
        {'  (↑/↓ next/prev match · Esc/Enter close)'}
      </Text>
    </Box>
  );
}

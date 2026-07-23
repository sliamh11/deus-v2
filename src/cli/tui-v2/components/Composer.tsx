/**
 * Minimal single-line text composer for `tui-v2`'s `App.tsx`. Named after
 * Gemini's own `Composer.tsx` (the component `DefaultAppLayout.tsx` mounts
 * in place of `DialogManager` when no dialog is open — confirmed by reading
 * the real file), but scoped down to exactly what this step needs: capture
 * raw keystrokes into a controlled buffer and call `submitTurn` on Enter.
 *
 * Deliberately does NOT reimplement `tui/components/InputLine.tsx`'s
 * `/`-opens-palette (the fuzzy command palette is design decision #4,
 * explicitly deferred past this PR's MVP), and does not tokenize/highlight
 * slash-commands or @-mentions while typing (that's `utils/highlight.ts`'s
 * job in Gemini, never ported here — tracked in LIA-475). Composer DOES
 * now own local-command
 * (`/status`/`/plan`/`/exit`) submission and Ctrl+R reverse-history search,
 * both added by build-sequence step 9:
 *
 * - Slash-command *interpretation* (parsing `/name args`, dispatching to a
 *   `SlashCommand`) lives in `commands/registry.ts` and is NOT this file's
 *   job — `onSubmit` still just hands the raw submitted line up to
 *   `AppContainer.tsx`'s `submitTurn`, which is what now runs it through
 *   `executeSlashCommand` before ever reaching the chat transport. This
 *   file only needs to know that submitted lines get INTO `inputHistory`
 *   (both prompts and `/commands` — bash's own reverse-i-search recalls
 *   typed commands, not just its output, and `/plan on` is exactly as
 *   worth recalling as any other line).
 * - Ctrl+R reverse-history search IS this file's job: `search/history-search.ts`
 *   (ported from `~/deus/tui/src/app.rs`'s real reverse-i-search — see that
 *   module's header) is pure state; this component is the Ink
 *   key-routing/rendering shell around it, same split as
 *   `TranscriptSearchBar.tsx`/`search/transcript-search.ts`. While active,
 *   typed characters extend the search query (not the composer's `value`
 *   directly) and the live-matched history entry previews into `value` via
 *   `onChange`, exactly mirroring bash's `(reverse-i-search)` UX.
 *
 * Carries forward the same stable-handler fix as `InputLine.tsx`
 * (`useCallback` with an empty dependency array, reading current props off a
 * ref) — see that file's header comment for why an inline handler would
 * silently drop keystrokes typed in the same tick.
 */

import type React from 'react';
import { useCallback, useRef, useState } from 'react';
import { Box, Text, useInput, type Key } from 'ink';

import { themeManager } from '../themes/theme-manager.js';
import {
  backspaceHistorySearch,
  cancelHistorySearch,
  commitHistorySearch,
  createHistorySearchState,
  cycleHistorySearch,
  previewForHistorySearch,
  startHistorySearch,
  typeHistorySearchChar,
  type HistorySearchState,
} from '../search/history-search.js';

export interface ComposerProps {
  value: string;
  isActive: boolean;
  /** Prior submitted lines, oldest-first (both chat prompts and `/commands`) — the reverse-search corpus. */
  history: readonly string[];
  onChange: (value: string) => void;
  onSubmit: (line: string) => void;
}

export function Composer({
  value,
  isActive,
  history,
  onChange,
  onSubmit,
}: ComposerProps): React.ReactNode {
  const semanticColors = themeManager.getSemanticColors();
  const [search, setSearch] = useState<HistorySearchState>(createHistorySearchState);
  const latest = useRef({ value, history, search, onChange, onSubmit });
  latest.current = { value, history, search, onChange, onSubmit };

  const handleInput = useCallback((input: string, key: Key) => {
    const { value, history, search, onChange, onSubmit } = latest.current;

    if (search.active) {
      if (key.ctrl && input === 'r') {
        const next = cycleHistorySearch(history, search);
        setSearch(next);
        const preview = previewForHistorySearch(history, next);
        if (preview !== undefined) onChange(preview);
        return;
      }
      if (key.return) {
        const committed = commitHistorySearch(history, search) ?? value;
        onChange(committed);
        setSearch(createHistorySearchState());
        return;
      }
      if (key.escape) {
        onChange(cancelHistorySearch(search));
        setSearch(createHistorySearchState());
        return;
      }
      if (key.backspace || key.delete) {
        const next = backspaceHistorySearch(search);
        setSearch(next);
        const preview = previewForHistorySearch(history, next);
        if (preview !== undefined) onChange(preview);
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        const next = typeHistorySearchChar(search, input);
        setSearch(next);
        const preview = previewForHistorySearch(history, next);
        if (preview !== undefined) onChange(preview);
        return;
      }
      // Any other key (e.g. an arrow) commits the current match and exits
      // search, then falls through to normal handling below — mirrors
      // ~/deus/tui/src/main.rs's `consumed = false` fallthrough case.
      onChange(commitHistorySearch(history, search) ?? value);
      setSearch(createHistorySearchState());
    }

    if (key.ctrl && input === 'r') {
      setSearch(startHistorySearch(value));
      return;
    }
    if (key.return) {
      onSubmit(value);
      return;
    }
    if (key.backspace || key.delete) {
      if (value.length > 0) onChange(value.slice(0, -1));
      return;
    }
    if (
      key.upArrow ||
      key.downArrow ||
      key.leftArrow ||
      key.rightArrow ||
      key.pageUp ||
      key.pageDown ||
      key.tab ||
      key.escape ||
      key.meta
    ) {
      // No cursor movement / non-history palette trigger yet — see module doc.
      return;
    }
    if (input && !key.ctrl) onChange(value + input);
  }, []);

  useInput(handleInput, { isActive });

  if (search.active) {
    return (
      <Box>
        <Text color={semanticColors.ui.comment}>{"(reverse-i-search)'"}</Text>
        <Text color={semanticColors.text.accent}>{search.query}</Text>
        <Text color={semanticColors.ui.comment}>{"': "}</Text>
        <Text color={semanticColors.text.primary}>{value}</Text>
        {isActive ? <Text inverse> </Text> : null}
      </Box>
    );
  }

  return (
    <Box>
      <Text color={semanticColors.ui.active}>{'> '}</Text>
      <Text color={semanticColors.text.primary}>{value}</Text>
      {isActive ? <Text inverse> </Text> : null}
    </Box>
  );
}

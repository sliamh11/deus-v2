/**
 * Minimal single-line text composer for `tui-v2`'s `App.tsx`. Named after
 * Gemini's own `Composer.tsx` (the component `DefaultAppLayout.tsx` mounts
 * in place of `DialogManager` when no dialog is open — confirmed by reading
 * the real file), but scoped down to exactly what this step needs: capture
 * raw keystrokes into a controlled buffer and call `submitTurn` on Enter.
 *
 * Deliberately does NOT reimplement `tui/components/InputLine.tsx`'s
 * `/`-opens-palette (the fuzzy command palette is design decision #4,
 * explicitly deferred past this PR's MVP). Composer DOES now own:
 *
 * - Local-command (`/status`/`/plan`/`/exit`) submission and Ctrl+R
 *   reverse-history search, both added by build-sequence step 9 (see
 *   below).
 * - Tokenized rendering (LIA-475): `utils/highlight.ts`'s
 *   `tokenizeComposerValue` splits `value` into colorable runs
 *   (`slash`/`mention`/`paste`/`plain`), rendered as adjacent `<Text>`
 *   children inside the same row `<Box>` in place of the old single flat
 *   `<Text>{value}</Text>`.
 * - Slash-command / `@`-mention autocomplete (LIA-475): `utils/
 *   autocomplete.ts`'s pure `extractAutocompleteTarget`/`filter*
 *   Suggestions`/`applyAutocompleteAcceptance` derive what to show and what
 *   accepting a suggestion does to `value`; `AutocompleteDropdown.tsx` is
 *   the passive view. This component is the ONLY `useInput` owner for both
 *   — the dropdown never listens for keys itself (see its own header) — so
 *   Up/Down/Enter/Escape are unambiguous about which mode consumes them.
 *   Keyboard precedence, checked in this order every keystroke: (1) an
 *   active reverse-history search, (2) Ctrl+R (always starts/continues
 *   history search, even while a dropdown is open — history search fully
 *   replaces this component's render, per `App.tsx`'s mutual-exclusion
 *   invariant, so there is nothing left for the dropdown to contend with
 *   once it takes over), (3) an open autocomplete dropdown, (4) normal
 *   composer editing. `Escape` while a dropdown is open dismisses it for
 *   the CURRENT buffer only (`dismissedForValue`) — the next keystroke that
 *   changes `value` re-evaluates the trigger fresh, so dismissal is a
 *   transient hide, not a sticky flag that can go stale.
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
 * silently drop keystrokes typed in the same tick. The autocomplete-derived
 * values below (`target`/`suggestions`/`autocompleteKey`) are recomputed
 * every render from `value`/`commands`/`dirCache` — cheap, pure functions,
 * no memoization needed — but the LATEST copies still have to flow into
 * `latest.current` each render for `handleInput`'s stable closure to read,
 * same as every other prop/state value here.
 */

import type React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
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
import { tokenizeComposerValue } from '../utils/highlight.js';
import {
  applyAutocompleteAcceptance,
  autocompleteTargetKey,
  extractAutocompleteTarget,
  filterCommandSuggestions,
  filterMentionSuggestions,
  type AutocompleteSuggestion,
  type CommandLike,
} from '../utils/autocomplete.js';
import { AutocompleteDropdown } from './AutocompleteDropdown.js';

export interface ComposerProps {
  value: string;
  isActive: boolean;
  /** Prior submitted lines, oldest-first (both chat prompts and `/commands`) — the reverse-search corpus. */
  history: readonly string[];
  onChange: (value: string) => void;
  onSubmit: (line: string) => void;
  /** Registered slash commands for `/`-autocomplete (LIA-475) — `commands/index.ts`'s `ALL_COMMANDS` satisfies this structurally. */
  commands: readonly CommandLike[];
  /**
   * Injected async one-level directory listing adapter for `@`-mention
   * autocomplete (LIA-475): given a directory portion of a typed path
   * (relative to `cwd`, `""` meaning `cwd` itself), resolves to that
   * directory's entry names — directories MUST already carry a trailing
   * `/` (so a directory suggestion's insertion text needs no extra
   * `fs.stat` here to decide whether to append one). Never rejects;
   * resolves to `[]` on any read failure. The real implementation lives in
   * `AppContainer.tsx` (real `fs.readdir`); tests inject a fake.
   */
  listDirectory: (dirPart: string) => Promise<string[]>;
}

export function Composer({
  value,
  isActive,
  history,
  onChange,
  onSubmit,
  commands,
  listDirectory,
}: ComposerProps): React.ReactNode {
  const semanticColors = themeManager.getSemanticColors();
  const [search, setSearch] = useState<HistorySearchState>(createHistorySearchState);

  const target = extractAutocompleteTarget(value);
  const autocompleteKey = autocompleteTargetKey(target);

  const [dirCache, setDirCache] = useState<
    { dirPart: string; entries: string[] } | undefined
  >(undefined);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [dismissedForValue, setDismissedForValue] = useState<string | undefined>(
    undefined,
  );

  const mentionDirPart = target?.kind === 'mention' ? target.dirPart : undefined;
  useEffect(() => {
    if (mentionDirPart === undefined) return;
    if (dirCache && dirCache.dirPart === mentionDirPart) return;
    let cancelled = false;
    void listDirectory(mentionDirPart).then(
      (entries) => {
        if (!cancelled) setDirCache({ dirPart: mentionDirPart, entries });
      },
      () => {
        if (!cancelled) setDirCache({ dirPart: mentionDirPart, entries: [] });
      },
    );
    return () => {
      cancelled = true;
    };
    // `dirCache` is deliberately NOT in this array: it's read only to skip a
    // redundant fetch when a cached listing already covers `mentionDirPart`,
    // not a value that should itself re-trigger the fetch. This repo's
    // eslint config has no `react-hooks` plugin (confirmed: no rule of that
    // name configured), so there is no lint directive to suppress here —
    // just a plain note for a human reader.
  }, [mentionDirPart, listDirectory]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [autocompleteKey]);

  const suggestions: AutocompleteSuggestion[] = !target
    ? []
    : target.kind === 'slash'
      ? filterCommandSuggestions(commands, target.query)
      : dirCache && dirCache.dirPart === target.dirPart
        ? filterMentionSuggestions(dirCache.entries, target.segmentPrefix)
        : [];

  const autocompleteOpen =
    target !== undefined && suggestions.length > 0 && dismissedForValue !== value;
  const boundedSelectedIndex = Math.min(
    selectedIndex,
    Math.max(0, suggestions.length - 1),
  );

  const latest = useRef({
    value,
    history,
    search,
    onChange,
    onSubmit,
    target,
    suggestions,
    autocompleteOpen,
    boundedSelectedIndex,
  });
  latest.current = {
    value,
    history,
    search,
    onChange,
    onSubmit,
    target,
    suggestions,
    autocompleteOpen,
    boundedSelectedIndex,
  };

  const handleInput = useCallback((input: string, key: Key) => {
    const {
      value,
      history,
      search,
      onChange,
      onSubmit,
      target,
      suggestions,
      autocompleteOpen,
      boundedSelectedIndex,
    } = latest.current;

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
      // Ctrl+R always wins over an open autocomplete dropdown (module doc's
      // keyboard-precedence note): history search's own render fully
      // replaces this component's output below, so once it takes over
      // there is nothing left for the dropdown to contend with.
      setSearch(startHistorySearch(value));
      return;
    }

    if (autocompleteOpen && target) {
      if (key.downArrow) {
        setSelectedIndex((current) =>
          Math.min(suggestions.length - 1, current + 1),
        );
        return;
      }
      if (key.upArrow) {
        setSelectedIndex((current) => Math.max(0, current - 1));
        return;
      }
      if (key.escape) {
        setDismissedForValue(value);
        return;
      }
      if (key.return) {
        const chosen = suggestions[boundedSelectedIndex];
        if (chosen) {
          onChange(applyAutocompleteAcceptance(value, target, chosen));
          return;
        }
      }
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

  const tokens = tokenizeComposerValue(value);

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={semanticColors.ui.active}>{'> '}</Text>
        {tokens.map((token, index) => (
          <Text
            key={index}
            color={
              token.kind === 'slash'
                ? semanticColors.text.accent
                : token.kind === 'mention'
                  ? semanticColors.text.link
                  : token.kind === 'paste'
                    ? semanticColors.ui.comment
                    : semanticColors.text.primary
            }
            bold={token.kind === 'slash' || token.kind === 'mention'}
            italic={token.kind === 'paste'}
          >
            {token.text}
          </Text>
        ))}
        {isActive ? <Text inverse> </Text> : null}
      </Box>
      {autocompleteOpen ? (
        <AutocompleteDropdown
          suggestions={suggestions}
          selectedIndex={boundedSelectedIndex}
          semanticColors={semanticColors}
        />
      ) : null}
    </Box>
  );
}

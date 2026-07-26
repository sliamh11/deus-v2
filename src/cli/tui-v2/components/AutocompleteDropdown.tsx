/**
 * Passive Ink view for `Composer.tsx`'s slash-command / `@`-mention
 * autocomplete (LIA-475). Deliberately owns NO `useInput` of its own —
 * `Composer.tsx`'s single `useInput` handler owns every keystroke (Up/Down
 * to move `selectedIndex`, Enter to accept, Escape to dismiss) and passes
 * the result down as plain props, exactly mirroring
 * `PermissionModal.tsx`/`TranscriptSearchBar.tsx`'s split there (this
 * repo's established convention: exactly one `useInput` owner per mutually-
 * exclusive input mode, so two listeners never race for the same
 * keystroke — see `Composer.tsx`'s own module doc for why that ambiguity is
 * a real Ink risk, not just a style preference).
 */

import type React from 'react';
import { Box, Text } from 'ink';

import type { SemanticColors } from '../themes/semantic-tokens.js';
import type { AutocompleteSuggestion } from '../utils/autocomplete.js';

export interface AutocompleteDropdownProps {
  suggestions: readonly AutocompleteSuggestion[];
  selectedIndex: number;
  semanticColors: SemanticColors;
}

/** Caps how many rows render at once — a long directory listing or command set still fits one screen, matching `at-mention-processor.ts`'s own `MAX_DIR_ENTRIES` bounding-render-size spirit. */
const MAX_VISIBLE_SUGGESTIONS = 8;

export function AutocompleteDropdown({
  suggestions,
  selectedIndex,
  semanticColors,
}: AutocompleteDropdownProps): React.ReactNode {
  if (suggestions.length === 0) return null;

  const visible = suggestions.slice(0, MAX_VISIBLE_SUGGESTIONS);
  const hiddenCount = suggestions.length - visible.length;

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={semanticColors.border.default}
      paddingX={1}
    >
      {visible.map((suggestion, index) => (
        <Text
          key={`${suggestion.insertText}-${index}`}
          color={
            index === selectedIndex
              ? semanticColors.ui.active
              : semanticColors.text.secondary
          }
          inverse={index === selectedIndex}
        >
          {suggestion.label}
        </Text>
      ))}
      {hiddenCount > 0 ? (
        <Text color={semanticColors.ui.comment}>… {hiddenCount} more</Text>
      ) : null}
    </Box>
  );
}

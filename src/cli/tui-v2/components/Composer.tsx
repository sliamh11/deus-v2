/**
 * Minimal single-line text composer for `tui-v2`'s `App.tsx`. Named after
 * Gemini's own `Composer.tsx` (the component `DefaultAppLayout.tsx` mounts
 * in place of `DialogManager` when no dialog is open — confirmed by reading
 * the real file), but scoped down to exactly what this step needs: capture
 * raw keystrokes into a controlled buffer and call `submitTurn` on Enter.
 *
 * Deliberately does NOT reimplement `tui/components/InputLine.tsx`'s
 * `/`-opens-palette or local-command interpretation
 * (`/status`/`/plan`/`/exit`) — the command framework (build-sequence
 * step 9) owns that, and Gemini's own real `commands/` framework this ports
 * from doesn't exist in `tui-v2` yet either. Ctrl+C already exits via Ink's
 * own `exitOnCtrlC` default (see `AppContainer.tsx`'s `launchTuiApp` doc),
 * so this step has a real exit path without inventing local-command
 * handling ahead of its own step.
 *
 * Carries forward the same stable-handler fix as `InputLine.tsx`
 * (`useCallback` with an empty dependency array, reading current props off a
 * ref) — see that file's header comment for why an inline handler would
 * silently drop keystrokes typed in the same tick.
 */

import type React from 'react';
import { useCallback, useRef } from 'react';
import { Box, Text, useInput, type Key } from 'ink';

import { themeManager } from '../themes/theme-manager.js';

export interface ComposerProps {
  value: string;
  isActive: boolean;
  onChange: (value: string) => void;
  onSubmit: (line: string) => void;
}

export function Composer({
  value,
  isActive,
  onChange,
  onSubmit,
}: ComposerProps): React.ReactNode {
  const semanticColors = themeManager.getSemanticColors();
  const latest = useRef({ value, onChange, onSubmit });
  latest.current = { value, onChange, onSubmit };

  const handleInput = useCallback((input: string, key: Key) => {
    const { value, onChange, onSubmit } = latest.current;
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
      // No cursor movement / history navigation / palette trigger yet — see
      // module doc.
      return;
    }
    if (input && !key.ctrl) onChange(value + input);
  }, []);

  useInput(handleInput, { isActive });

  return (
    <Box>
      <Text color={semanticColors.ui.active}>{'> '}</Text>
      <Text color={semanticColors.text.primary}>{value}</Text>
      {isActive ? <Text inverse> </Text> : null}
    </Box>
  );
}

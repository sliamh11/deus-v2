/**
 * Controlled single-line text input for `deus tui` (Track B step 5 of
 * /Users/liam10play/.claude/plans/expressive-foraging-reef.md). Deliberately
 * "dumb": it captures raw keystrokes into a controlled `value` and reports
 * Enter (`onSubmit`) or `/` on an empty line (`onOpenPalette`) upward — it
 * does NOT itself interpret `/plan on|off`, `/status`, `/exit`, `/quit`.
 * `deus-tui-app.tsx` owns that dispatch (mirroring
 * `deus-native-chat-client.ts`'s single `handleLine` switch at lines
 * 408-447) so both this component and `CommandPalette.tsx` (whose Enter
 * also "runs" a command) funnel through the exact same interpreter instead
 * of duplicating the local-command list in two places.
 *
 * `isActive` gates Ink's `useInput` (see the `Options.isActive` flag) so
 * only one of InputLine / PermissionModal / CommandPalette ever captures
 * keystrokes at a time — the caller is responsible for making that
 * mutually exclusive (deus-tui-app.tsx renders exactly one of the three).
 *
 * Stable-handler fix (found via `deus-tui-app.test.tsx`, not just a test
 * artifact — a real correctness bug): `useInput`'s effect re-subscribes its
 * listener on the internal event emitter whenever the handler FUNCTION
 * IDENTITY changes (see ink's `hooks/use-input.js` effect deps). A handler
 * defined inline in the component body is a new closure every render, and
 * because that re-subscription runs as a passive effect (scheduled after
 * commit, not synchronous with it), two keystrokes typed in the same tick
 * can both be delivered to the SAME stale listener (closed over the
 * pre-first-keystroke `value`) before the effect for the first keystroke's
 * state update has re-run — silently dropping characters. This component
 * instead keeps the latest props in a ref and passes `useInput` a
 * `useCallback` with an EMPTY dependency array, so the listener's identity
 * never changes and no re-subscription (and no race) ever happens.
 */

import { useCallback, useRef } from 'react';
import { Box, Text, useInput, type Key } from 'ink';

export interface InputLineProps {
  value: string;
  isActive: boolean;
  onChange: (value: string) => void;
  onSubmit: (line: string) => void;
  onOpenPalette: () => void;
}

export function InputLine({
  value,
  isActive,
  onChange,
  onSubmit,
  onOpenPalette,
}: InputLineProps): JSX.Element {
  const latest = useRef({ value, onChange, onSubmit, onOpenPalette });
  latest.current = { value, onChange, onSubmit, onOpenPalette };

  const handleInput = useCallback((input: string, key: Key) => {
    const { value, onChange, onSubmit, onOpenPalette } = latest.current;
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
      // No cursor movement / history navigation in this v1 input line —
      // not part of the local-command surface being ported from
      // deus-native-chat-client.ts.
      return;
    }
    if (value === '' && input === '/') {
      onOpenPalette();
      return;
    }
    if (input && !key.ctrl) onChange(value + input);
  }, []);

  useInput(handleInput, { isActive });

  return (
    <Box>
      <Text color="green">{'> '}</Text>
      <Text>{value}</Text>
      {isActive ? <Text inverse> </Text> : null}
    </Box>
  );
}

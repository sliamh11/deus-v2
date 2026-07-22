/**
 * Permission-request modal for `deus tui` (Track B step 5 of
 * /Users/liam10play/.claude/plans/expressive-foraging-reef.md). Renders the
 * same `toolName`/`toolInputPreview` fields the readline client prints
 * (`deus-native-chat-client.ts:334-335`), plus a LIVE `DENY_TIMEOUT_MS`
 * countdown (the readline client only prints this once, statically; this
 * component ticks it down every 250ms since a rich TUI can afford to).
 *
 * Keystroke handling: this component owns the typed-answer buffer (Ink's
 * `useInput` delivers one keystroke at a time, not an accumulated line —
 * `keyToPermissionDecision` expects the FULL buffer, per its own contract
 * and `deus-tui-state.test.ts`'s `permission_keypress` cases), and forwards
 * `(buffer, key)` upward on every keystroke via `onKeypress`. The handler
 * passed to `useInput` is wrapped in `useCallback` with an EMPTY dependency
 * array, reading current values off a ref (see `InputLine.tsx`'s doc
 * comment for why: a handler whose identity changes every render causes
 * `useInput` to re-subscribe on a delayed passive effect, and two
 * keystrokes typed in the same tick can both hit the same stale closure —
 * a real dropped-input bug, not just a test-timing artifact).
 *
 * Deliberate design choice (logged per this repo's `Deviation:` convention):
 * this component does NOT itself call `transport.respondPermission` or
 * decide the final `PermissionDecision` — `deus-tui-app.tsx`'s
 * `handlePermissionKeypress` is the single place that resolves the decision
 * (via `tuiReduce`, which already imports and calls this exact
 * `keyToPermissionDecision`) and posts it to the transport exactly once.
 * Resolving AND posting here as well would duplicate that logic and risk a
 * double-POST of the same decision if both call sites raced. This component
 * still imports `keyToPermissionDecision` directly (matching the build
 * plan's literal file spec) for a correctness-neutral live preview — which
 * of the three choices the current buffer would resolve to — never to
 * trigger I/O.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Box, Text, useInput, type Key } from 'ink';

import { DENY_TIMEOUT_MS } from '../../../agent-runtimes/permission-registry.js';
import type { PermissionDecision } from '../../../agent-runtimes/types.js';
import {
  keyToPermissionDecision,
  type PermissionKeypress,
} from '../deus-tui-permission-decision.js';

export interface PermissionModalProps {
  toolName: string;
  toolInputPreview: string;
  /** Forwards the accumulated answer buffer and the triggering key upward on every keystroke. */
  onKeypress: (input: string, key: PermissionKeypress) => void;
}

const PREVIEW_LABEL: Record<PermissionDecision, string> = {
  allow_once: 'Allow once',
  allow_always: 'Always allow',
  deny: 'Deny',
};

const TICK_MS = 250;

export function PermissionModal({
  toolName,
  toolInputPreview,
  onKeypress,
}: PermissionModalProps): JSX.Element {
  const [answer, setAnswer] = useState('');
  const [deadline] = useState(() => Date.now() + DENY_TIMEOUT_MS);
  const [remainingMs, setRemainingMs] = useState(DENY_TIMEOUT_MS);
  const latest = useRef({ answer, onKeypress });
  latest.current = { answer, onKeypress };

  useEffect(() => {
    const timer = setInterval(() => {
      setRemainingMs(Math.max(0, deadline - Date.now()));
    }, TICK_MS);
    return () => clearInterval(timer);
  }, [deadline]);

  const handleInput = useCallback((input: string, key: Key) => {
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
      return; // Not part of the y/a/n keymap this modal exposes.
    }

    const { answer, onKeypress } = latest.current;
    let next = answer;
    if (key.backspace || key.delete) {
      next = answer.slice(0, -1);
    } else if (input && !key.ctrl) {
      next = answer + input;
    }
    if (next !== answer) setAnswer(next);
    onKeypress(next, { return: Boolean(key.return) });
  }, []);

  useInput(handleInput);

  const preview = keyToPermissionDecision(answer, { return: false });

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="yellow"
      paddingX={1}
    >
      <Text bold color="yellow">
        Permission requested
      </Text>
      <Text>
        Tool: <Text bold>{toolName}</Text>
      </Text>
      <Text>Input: {toolInputPreview}</Text>
      <Text dimColor>(auto-denies in {Math.ceil(remainingMs / 1_000)}s)</Text>
      <Text>
        [y]es once / [a]lways / [N]o {answer ? `— ${answer}` : ''}
        {preview ? `  → ${PREVIEW_LABEL[preview]}` : ''}
      </Text>
    </Box>
  );
}

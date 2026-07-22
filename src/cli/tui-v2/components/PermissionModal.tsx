/**
 * TODO(build-sequence step 8): permission-modal mounting point, TEMPORARY
 * typed-letter chrome.
 *
 * Copied from `tui/components/PermissionModal.tsx` (not imported — see
 * `deus-chat-stream-bridge.ts`'s report for the copy-vs-import rationale)
 * and restyled to pull colors from the ported theme system instead of Ink's
 * hardcoded `yellow`/`red`, but the INTERACTION MODEL is unchanged
 * (typed y/a/n buffer via `deus-tui-permission-decision.ts`'s
 * `keyToPermissionDecision`). Per the plan's resolved design decision #3,
 * this is explicitly temporary: step 8 restyles this to Gemini's arrow-key
 * `RadioButtonSelect` + Enter pattern against a FRESH oracle-authored
 * decision mapping (`deus-tui-permission-decision-v2.ts`, oracle-author pass
 * already run per build-sequence step 1) — not this file's
 * `deus-tui-permission-decision.ts`. This component exists now, ahead of
 * that restyle, purely so `AppContainer.tsx`'s wiring to
 * `deus-chat-stream-bridge.ts`'s `respondPermission` is real and testable in
 * this step rather than stubbed to a no-op — the underlying Deus 3-way
 * contract (`allow_once`/`allow_always`/`deny`, live `DENY_TIMEOUT_MS`
 * countdown, `allow_always` visually distinct via `PREVIEW_LABEL`) it
 * exercises is the SAME contract step 8 keeps, only the keystroke chrome
 * changes.
 */

import type React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Box, Text, useInput, type Key } from 'ink';

import { DENY_TIMEOUT_MS } from '../../../agent-runtimes/permission-registry.js';
import type { PermissionDecision } from '../../../agent-runtimes/types.js';
import {
  keyToPermissionDecision,
  type PermissionKeypress,
} from '../deus-tui-permission-decision.js';
import { themeManager } from '../themes/theme-manager.js';

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
}: PermissionModalProps): React.ReactNode {
  const semanticColors = themeManager.getSemanticColors();
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
      return; // Not part of the y/a/n keymap this (temporary) modal exposes.
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
      borderColor={semanticColors.status.warning}
      paddingX={1}
    >
      <Text bold color={semanticColors.status.warning}>
        Permission requested
      </Text>
      <Text color={semanticColors.text.primary}>
        Tool: <Text bold>{toolName}</Text>
      </Text>
      <Text color={semanticColors.text.primary}>
        Input: {toolInputPreview}
      </Text>
      <Text color={semanticColors.text.secondary}>
        (auto-denies in {Math.ceil(remainingMs / 1_000)}s)
      </Text>
      <Text color={semanticColors.text.primary}>
        [y]es once / [a]lways / [N]o {answer ? `— ${answer}` : ''}
        {preview ? `  → ${PREVIEW_LABEL[preview]}` : ''}
      </Text>
    </Box>
  );
}

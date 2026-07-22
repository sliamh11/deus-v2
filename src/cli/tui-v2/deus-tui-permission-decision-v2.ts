/**
 * Isolated, security-adjacent keymap for `tui-v2`'s permission modal —
 * build-sequence step 8, per the plan's resolved design decision #3
 * (`~/.claude/plans/deus-tui-gemini-fork.md`): restyle the interaction
 * surface to Gemini's arrow-key `RadioButtonSelect` + Enter pattern while
 * keeping Deus's real 3-way `allow_once`/`allow_always`/`deny` decision
 * contract unchanged. A wrong mapping here could silently turn an intended
 * deny into `allow_always`, so — same discipline as the retired typed-letter
 * mapping this supersedes (`tui/deus-tui-permission-decision.ts`) — this
 * stays a small, standalone pure function with no Ink/React dependency,
 * independently oracle-tested FIRST, blind, before this file existed (see
 * the fresh, independent `@oracle`-tagged
 * `deus-tui-permission-decision-v2.oracle.test.ts` this function was built
 * to satisfy — originally authored under `src/cli/tui/` per its own brief's
 * "package doesn't exist yet" note, relocated here alongside this
 * implementation now that `tui-v2` exists, per that same brief's explicitly
 * anticipated follow-up relocation; no assertion in it was touched).
 *
 * This is a genuinely NEW mapping, not an extension of the retired
 * typed-letter one — do not reintroduce a typed buffer, case-insensitive
 * word matching, or the old y/a/n shortcuts here; none of that belongs to
 * this interaction model.
 *
 * Boundary policy (the oracle's own resolved choice, pinned exactly by its
 * test cases): HARD-CLAMP at both ends. Pressing Up at index 0, or Down at
 * the last index, is a no-op — it neither moves the cursor nor resolves a
 * decision. (The alternative, wrap-around, was explicitly left to this
 * oracle's discretion by its brief; hard-clamp is what the test file pins.)
 */

import type { PermissionDecision } from '../../agent-runtimes/types.js';

/** One row of the fixed-order permission option list. */
export interface PermissionListOption {
  decision: PermissionDecision;
  label: string;
}

/**
 * The exact three choices, in fixed cursor order, with the display labels
 * carried forward unchanged from the retired modal's `PREVIEW_LABEL` map
 * (`tui/components/PermissionModal.tsx`) — never Gemini's own richer
 * `ToolConfirmationOutcome` set, which has no Deus equivalent.
 */
export const PERMISSION_LIST_OPTIONS: readonly PermissionListOption[] = [
  { decision: 'allow_once', label: 'Allow once' },
  { decision: 'allow_always', label: 'Always allow' },
  { decision: 'deny', label: 'Deny' },
];

/** Minimal shape of Ink's `useInput` key object this function inspects. */
export interface PermissionListKeypress {
  upArrow?: boolean;
  downArrow?: boolean;
  return?: boolean;
}

export type PermissionSelectResult =
  | { type: 'move'; index: number }
  | { type: 'resolve'; decision: PermissionDecision }
  | { type: 'noop' };

/**
 * Maps one keystroke plus the current cursor index to a
 * `PermissionSelectResult`:
 * - Enter resolves the option currently at `currentIndex` — the ONLY way to
 *   produce a decision; checked first so a stray simultaneous arrow flag
 *   never overrides an explicit confirm.
 * - Down/Up move the cursor by exactly one, hard-clamped at the list's
 *   bounds (see module doc) — a clamped move is a `noop`, not a `move` to
 *   the same index, so a caller can distinguish "nothing happened" from "we
 *   re-rendered the same index".
 * - Any other key (Left/Right/Tab/Escape/plain text/backspace/an
 *   unrecognized shape) is inert.
 */
export function permissionListKeyToResult(
  currentIndex: number,
  key: PermissionListKeypress,
): PermissionSelectResult {
  if (key.return) {
    const option = PERMISSION_LIST_OPTIONS[currentIndex];
    if (!option) return { type: 'noop' };
    return { type: 'resolve', decision: option.decision };
  }
  if (key.downArrow) {
    const next = currentIndex + 1;
    if (next >= PERMISSION_LIST_OPTIONS.length) return { type: 'noop' };
    return { type: 'move', index: next };
  }
  if (key.upArrow) {
    const next = currentIndex - 1;
    if (next < 0) return { type: 'noop' };
    return { type: 'move', index: next };
  }
  return { type: 'noop' };
}

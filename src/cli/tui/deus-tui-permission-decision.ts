/**
 * Isolated, security-adjacent keymap for the `deus tui` permission modal
 * (Track B of LIA-471's spec).
 * A wrong mapping here could silently turn an intended
 * deny into `allow_always`, so this stays a small, standalone pure function
 * with no Ink/React dependency — independently oracle-tested (see the
 * `@oracle`-tagged `deus-tui-permission-decision.oracle.test.ts` this
 * function was built to satisfy, blind, per the plan's Track B step 1).
 */

import type { PermissionDecision } from '../../agent-runtimes/types.js';

/** Minimal shape of Ink's `useInput` key object this function inspects. */
export interface PermissionKeypress {
  return?: boolean;
}

const ALLOW_ONCE_WORDS = new Set(['y', 'yes']);
const ALLOW_ALWAYS_WORDS = new Set(['a', 'always']);
const DENY_WORDS = new Set(['n', 'no']);

/**
 * Maps one line of typed input (plus whether Enter was pressed) to a
 * `PermissionDecision`, or `undefined` when the input doesn't yet resolve to
 * one — the caller must keep re-prompting rather than guess.
 *
 * Rules (see the oracle spec):
 * - Case-insensitive, trimmed comparison throughout.
 * - Single-letter shortcuts (`y`/`a`/`n`) and full words (`yes`/`always`/
 *   `no`) both resolve, with or without Enter — except a bare empty string,
 *   which only resolves (to `deny`, fail-closed) when Enter was pressed;
 *   an empty string with no Enter yet is simply "nothing typed", not deny.
 * - Partial words (`ye`, `al`) and anything else unrecognized stay
 *   unresolved rather than being guessed by prefix.
 */
export function keyToPermissionDecision(
  input: string,
  key: PermissionKeypress,
): PermissionDecision | undefined {
  const normalized = input.trim().toLowerCase();

  if (normalized === '') {
    return key.return ? 'deny' : undefined;
  }
  if (ALLOW_ONCE_WORDS.has(normalized)) return 'allow_once';
  if (ALLOW_ALWAYS_WORDS.has(normalized)) return 'allow_always';
  if (DENY_WORDS.has(normalized)) return 'deny';
  return undefined;
}

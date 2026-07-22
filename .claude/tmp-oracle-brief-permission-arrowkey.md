# Oracle-author brief: arrow-key permission-decision mapping (fresh pass)

## Context

`deus tui` (v2, `src/cli/tui-v2/` — not yet built) is getting a restyled
permission modal that swaps its interaction model from typed-letter input
(`y`/`a`/`n` + Enter) to an arrow-key list-select, matching the visual/
interaction chrome of the Gemini CLI fork this rebuild is based on (Ink's
`RadioButtonSelect`-style pattern: Up/Down arrow moves a highlighted cursor
over a fixed list of options, Enter confirms whichever option is currently
highlighted).

This is a **fresh, independent oracle-author pass**, not an extension of the
existing oracle. The OLD typed-letter mapping and its oracle
(`src/cli/tui/deus-tui-permission-decision.ts` +
`src/cli/tui/deus-tui-permission-decision.oracle.test.ts`) are being
**retired**, not reused or extended — do not treat their test cases,
function signature, or behavior as a spec to preserve. They are provided
below purely as background on the surrounding module's style and on the
decision type that must NOT change. The new mapping is a different function
with a different interaction contract; only the underlying 3-way decision
values are shared.

## The decision set (unchanged, do not alter)

`PermissionDecision` (from `src/agent-runtimes/types.ts`) is exactly:

```ts
export type PermissionDecision = 'allow_once' | 'allow_always' | 'deny';
export const PERMISSION_DECISIONS: readonly PermissionDecision[] = [
  'allow_once',
  'allow_always',
  'deny',
];
```

The new permission modal presents exactly these three choices as a
list, in this fixed order, each with a display label carried forward
from the current `PermissionModal.tsx`'s `PREVIEW_LABEL` map:

1. `allow_once` — label "Allow once"
2. `allow_always` — label "Always allow"
3. `deny` — label "Deny"

There is no 4th option, no "edit" variant, no sandbox/trust-level options —
Deus's real protocol is exactly this 3-way contract (see
`src/agent-runtimes/permission-registry.ts` and
`docs/decisions/deus-v2-permission-rules.md`), never Gemini's own richer
`ToolConfirmationOutcome` set (which has no Deus equivalent and must not
leak into this contract).

## The interaction model to design an oracle for

Arrow-key list-select, not typed text:

- The modal holds a **cursor index** into the 3-item option list above
  (initial index is index 0, i.e. "Allow once", matching a fresh render
  with nothing yet highlighted-by-the-user — same "nothing chosen yet"
  posture the old typed-letter model had before any keystroke).
- **Down arrow** moves the cursor to the next option, **Up arrow** moves it
  to the previous option.
- The list does not have externally-imposed wrap behavior specified by any
  existing doc — you (the oracle author) must pick and assert one consistent
  policy (wrap-around clamp vs hard-clamp-at-ends) and state which you chose
  and why in your contract writeup; whichever you choose, the oracle must
  pin it precisely (e.g. pressing Up at index 0 either wraps to index 2 or
  stays at index 0 — assert exactly one behavior, not "either is fine").
- **Enter** confirms the option currently at the cursor and resolves to that
  option's `PermissionDecision` — this is the ONLY way to produce a final
  decision; arrow movement alone never resolves a decision.
- Keys that are neither Up/Down/Enter (e.g. Left/Right/Tab/Escape/plain
  character input/backspace) must not move the cursor and must not resolve
  a decision — they are inert from this function's point of view (the
  surrounding component may handle Escape separately, but that is out of
  scope for this pure mapping function).
- No typed buffer, no case-insensitive word matching, no partial-word
  logic — none of that belongs in the new model at all. Do not port those
  old test cases forward as-is; they test a keymap that no longer exists.

## Suggested (not mandatory) function shape

You are authoring the oracle, which means you are also implicitly designing
the contract/signature this test compiles against — no implementation
exists yet, so you choose reasonable types. A reducer/handler shape that
fits Ink's `useInput(input, key)` callback and a list-select UI is
appropriate, for example (illustrative only, adjust as you see fit as long
as it is pure, synchronous, and dependency-free of Ink/React):

```ts
export interface PermissionListKeypress {
  upArrow?: boolean;
  downArrow?: boolean;
  return?: boolean;
}

export type PermissionSelectResult =
  | { type: 'move'; index: number }
  | { type: 'resolve'; decision: PermissionDecision }
  | { type: 'noop' };

export function permissionListKeyToResult(
  currentIndex: number,
  key: PermissionListKeypress,
): PermissionSelectResult;
```

Pick whatever exact shape you think is most natural for a pure,
independently-testable function — the above is a hint, not a mandate. State
your chosen signature explicitly in your contract writeup since the
implementer (a separate, later, blind pass) must build against exactly what
you asserted.

## Live countdown context (informational only — not this function's job)

The real modal (see current `src/cli/tui/components/PermissionModal.tsx`,
lines ~1-33 and ~60-76) also renders a LIVE `DENY_TIMEOUT_MS` countdown
(120_000ms, from `src/agent-runtimes/permission-registry.ts`) that
auto-resolves to `deny` server-side via `PendingPermissionRegistry`'s
timeout if nobody answers in time. That auto-deny-on-timeout behavior is
owned by the registry/server side, not by this keypress-mapping function —
do not add a "timeout" branch to the pure function's contract; it has no way
to observe elapsed time and shouldn't be made to. Mentioned here only so the
oracle's contract writeup can correctly note this function is scoped to
per-keystroke cursor/resolution logic only, with the countdown/timeout as
surrounding-but-separate behavior.

## Output file paths

Place the new oracle test at:

`src/cli/tui/deus-tui-permission-decision-v2.oracle.test.ts`

(Package placement note: the plan's `tui-v2` UI package does not exist yet
as of this pass — build sequence step 1 runs before step 2's dependency
bump. Land the oracle under the existing `src/cli/tui/` directory for now,
alongside the file it is meant to eventually supersede; a later
implementation pass may relocate it into `src/cli/tui-v2/` once that package
exists, but do not block your output on that not-yet-created path.)

Import the function under test from a NOT-YET-EXISTING module at:

`./deus-tui-permission-decision-v2.js`

(i.e. `src/cli/tui/deus-tui-permission-decision-v2.ts`, matching this
repo's existing `.js`-suffixed-import/`.ts`-source ESM convention — see the
current oracle test's own `from './deus-tui-permission-decision.js'`
import). This file must NOT be created by you — its absence is exactly what
makes the oracle red right now. Do not stub it, do not create it empty, do
not create it at all.

Use `vitest` (`describe`/`it`/`it.each`/`expect`), matching this repo's
existing test style (see the old oracle test file for conventions:
`describe`, `it.each` tables, `// @oracle:` tags on every assertion line —
tag every oracle assertion here the same way, e.g.
`// @oracle: <one-line contract reference>`).

## Existing files for style/convention reference only (do not extend/reuse their logic)

- `src/cli/tui/deus-tui-permission-decision.ts` — old typed-letter mapping,
  being retired.
- `src/cli/tui/deus-tui-permission-decision.oracle.test.ts` — old oracle,
  being retired.
- `src/cli/tui/components/PermissionModal.tsx` — current modal component
  (for `PREVIEW_LABEL` wording and the live-countdown context described
  above only).
- `src/agent-runtimes/types.ts` — `PermissionDecision` type (authoritative,
  unchanged).
- `src/agent-runtimes/permission-registry.ts` — `DENY_TIMEOUT_MS` /
  `PendingPermissionRegistry` (authoritative for the countdown context,
  unchanged).

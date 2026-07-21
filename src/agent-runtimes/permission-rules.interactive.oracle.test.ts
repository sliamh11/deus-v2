/**
 * Oracle tests for the "interactive permission prompts for `deus chat`"
 * follow-up ticket (LIA-466;
 * ADR amendment: `docs/decisions/deus-v2-permission-rules.md`, "Amendment
 * (2026-07-21)" section) — catalog/policy parity for the new `'interactive'`
 * permission profile.
 *
 * @oracle Independently authored from the plan + ADR amendment SPEC ALONE,
 * BLIND to the implementation. As of authoring time, `permission-rules.ts`
 * still defines only the `default`/`read-only` profiles (`PERMISSION_PROFILES`
 * has exactly two entries; `PermissionDecision` is still the two-value
 * `'allow' | 'deny'` type this amendment renames to `PolicyDecision` and
 * widens to `'allow' | 'deny' | 'ask'`) — verified by reading the file
 * directly before writing this test. Must not be weakened by the
 * implementer; strengthen instead of loosen if a real gap is found.
 *
 * SPEC (from the plan + ADR amendment, verbatim intent):
 *   - Plan Scope: "a new `'interactive'` permission profile (only
 *     `web_search`/`web_fetch` -- the only two tools actually reachable in
 *     production today, per `DEUS_NATIVE_SAFE_TOOL_NAMES`, confirmed
 *     unchanged by this work -- go from allow to ask; everything else
 *     matches `'read-only'` exactly)".
 *   - ADR Amendment, "Registry extension: interactive": "Under that profile,
 *     `web_search` and `web_fetch` evaluate to `ask`; the other four
 *     catalogued read tools evaluate to `allow`; all eleven mutation-capable
 *     tools evaluate to `deny`; and the profile's `defaultDecision` is
 *     `deny`."
 *   - ADR Amendment, "Mutating-tool precondition remains unchanged": "The
 *     live boundary remains exactly: `DEUS_NATIVE_SAFE_TOOL_NAMES =
 *     ['web_search', 'web_fetch']`" (tool-broker-langchain-adapter.ts) --
 *     this follow-up "expressly makes no change to the production safe-tool
 *     allowlist".
 *   - Original ADR (unchanged by the amendment) AC3 / catalog: the broker's
 *     17-tool catalog partitions into six reads (read_file, glob_files,
 *     grep_files, web_fetch, web_search, list_tasks) and eleven
 *     mutation-capable tools; `read-only`'s `defaultDecision` is `deny` for
 *     unknown/dynamic/MCP tools, reached only via `source: 'default'`, never
 *     an accidental rule match.
 *
 * This file is RED against the current tree for a BEHAVIORAL reason (not an
 * import-resolution reason): `evaluatePermission` and `PERMISSION_PROFILES`
 * already exist (from B7/LIA-407) and the import below resolves fine, but
 * `PERMISSION_PROFILES` has no `'interactive'` entry yet -- so every
 * assertion that depends on it fails immediately, starting with the
 * `interactivePolicy()` helper below throwing a clear "no such profile"
 * error. It must go GREEN once the implementer adds the profile per the ADR
 * amendment, WITHOUT this file being edited to match whatever shape the
 * implementation happens to take.
 *
 * TEST-SEAM REQUIREMENTS imposed on the implementer (derived directly from
 * the plan + ADR amendment text):
 *   - `PERMISSION_PROFILES` (unchanged export name/shape:
 *     `ReadonlyMap<string, PermissionPolicy>`) gains a third key,
 *     `'interactive'`, additive to the existing `'default'`/`'read-only'`.
 *   - `evaluatePermission(PERMISSION_PROFILES.get('interactive'), toolName)`
 *     returns `decision: 'ask'` (widened value; the pre-amendment type
 *     literal is `'allow' | 'deny'` and does not yet include `'ask'`, but
 *     this file asserts the RUNTIME value directly, independent of whatever
 *     the implementer names/widens the type to -- `PolicyDecision` per the
 *     ADR amendment, or otherwise) for exactly `web_search` and `web_fetch`.
 *   - For every other tool name in the live broker catalog, the
 *     `'interactive'` profile's decision is identical to the `'read-only'`
 *     profile's decision for that same name (allow for the 4 other reads,
 *     deny for all 11 mutation tools).
 *   - The profile's `defaultDecision` is `'deny'`, reached via `source:
 *     'default'` for an unregistered tool name -- not a coincidental rule
 *     match.
 *   - `DEUS_NATIVE_SAFE_TOOL_NAMES` (tool-broker-langchain-adapter.ts) stays
 *     exactly `['web_search', 'web_fetch']` -- this follow-up does not touch
 *     it; this file pins that as a regression guard, not as new behavior.
 * A genuinely incorrect seam may only be changed by the oracle author or a
 * reviewer, with the reason recorded -- never silently by the implementer.
 */

import { describe, it, expect } from 'vitest';

import { getOpenAIToolDefinitions } from '../../container/agent-runner/src/tool-broker.js';

// evaluatePermission/PERMISSION_PROFILES already exist (B7/LIA-407) -- this
// import resolves today. The 'interactive' profile does not; see file header.
import { evaluatePermission, PERMISSION_PROFILES } from './permission-rules.js';

// DEUS_NATIVE_SAFE_TOOL_NAMES already exists and is unchanged by this
// follow-up per the ADR amendment -- imported to pin it as a live regression
// guard against the exact live boundary this profile's 'ask' set must match.
import { DEUS_NATIVE_SAFE_TOOL_NAMES } from './tool-broker-langchain-adapter.js';

// ---------------------------------------------------------------------------
// The spec's explicit classification (ADR amendment + original ADR AC3),
// independent of whatever the implementer's own permission-rules.ts
// hardcodes internally.
// ---------------------------------------------------------------------------

const ASK_TOOL_NAMES = ['web_search', 'web_fetch'] as const;

const OTHER_READ_TOOL_NAMES = [
  'read_file',
  'glob_files',
  'grep_files',
  'list_tasks',
] as const;

const MUTATION_TOOL_NAMES = [
  'bash_exec',
  'write_file',
  'edit_file',
  'agent_browser',
  'send_message',
  'schedule_task',
  'pause_task',
  'resume_task',
  'cancel_task',
  'update_task',
  'register_group',
] as const;

const UNKNOWN_TOOL_NAMES = [
  'totally_unknown_tool_xyz',
  'mcp__github__create_issue',
] as const;

function interactivePolicy() {
  const policy = PERMISSION_PROFILES.get('interactive');
  if (!policy) {
    throw new Error(
      '@oracle: PERMISSION_PROFILES is missing the "interactive" profile ' +
        '(ADR amendment "Registry extension: interactive" -- PERMISSION_PROFILES ' +
        'gains an additive third named profile, "interactive")',
    );
  }
  return policy;
}

function readOnlyPolicy() {
  const policy = PERMISSION_PROFILES.get('read-only');
  if (!policy) {
    throw new Error(
      '@oracle: PERMISSION_PROFILES is missing the pre-existing "read-only" ' +
        'profile -- this would be a regression in the unrelated B7/LIA-407 ' +
        'baseline, not something this follow-up should ever touch',
    );
  }
  return policy;
}

// ===========================================================================
// (a) DEUS_NATIVE_SAFE_TOOL_NAMES stays exactly ['web_search', 'web_fetch'].
//     Regression guard: the ADR amendment states this follow-up "expressly
//     makes no change to the production safe-tool allowlist".
// ===========================================================================

describe('@oracle interactive profile -- live safe-tool boundary is unchanged (ADR amendment, mutating-tool precondition)', () => {
  it('@oracle DEUS_NATIVE_SAFE_TOOL_NAMES is exactly ["web_search", "web_fetch"]', () => {
    // @oracle: ADR amendment -- "The live boundary remains exactly:
    // DEUS_NATIVE_SAFE_TOOL_NAMES = ['web_search', 'web_fetch']". A widened
    // (or narrowed) safe-tool surface introduced alongside this ticket would
    // be a scope violation this test catches independent of the profile
    // logic below.
    expect([...DEUS_NATIVE_SAFE_TOOL_NAMES]).toEqual(['web_search', 'web_fetch']);
  });
});

// ===========================================================================
// (b) The 'interactive' profile evaluates web_search/web_fetch -- and ONLY
//     those two -- to 'ask'.
// ===========================================================================

describe("@oracle interactive profile -- web_search/web_fetch evaluate to 'ask' (ADR amendment)", () => {
  it.each(ASK_TOOL_NAMES)(
    '@oracle evaluatePermission(interactive, "%s").decision === "ask"',
    (toolName) => {
      // @oracle: ADR amendment -- "Under that profile, web_search and
      // web_fetch evaluate to ask". Asserted against the runtime value, not
      // a TypeScript literal type, so this discriminates a broken profile
      // (e.g. one that left these two at 'allow') regardless of how/whether
      // the implementer renames PermissionDecision to PolicyDecision.
      const result = evaluatePermission(interactivePolicy(), toolName);
      expect(result.decision).toBe('ask');
      // Contrast: the SAME tool under 'read-only' is 'allow' (AC3, original
      // ADR) -- proving 'interactive' genuinely diverges from 'read-only'
      // at exactly these two names, not merely inheriting an accidental
      // 'ask' from some shared default.
      expect(evaluatePermission(readOnlyPolicy(), toolName).decision).toBe(
        'allow',
      );
    },
  );

  it('@oracle no OTHER tool (not web_search/web_fetch) evaluates to "ask" under the interactive profile', () => {
    // @oracle: plan Scope -- "only web_search/web_fetch ... go from allow to
    // ask; everything else matches read-only exactly". A profile that
    // accidentally set 'ask' on some other tool (or missed one of the two)
    // would pass the two tests above but fail this one.
    const liveToolNames = getOpenAIToolDefinitions().map((d) => d.name);
    const askSet = new Set<string>(ASK_TOOL_NAMES);
    for (const toolName of liveToolNames) {
      if (askSet.has(toolName)) continue;
      const result = evaluatePermission(interactivePolicy(), toolName);
      expect(
        result.decision,
        `tool "${toolName}" must NOT be 'ask' under the interactive profile`,
      ).not.toBe('ask');
    }
  });
});

// ===========================================================================
// (c) For every other broker tool, 'interactive' matches 'read-only' EXACTLY:
//     the four remaining reads allow, all eleven mutation tools deny.
// ===========================================================================

describe("@oracle interactive profile -- matches 'read-only' exactly outside the two ask-tools (plan Scope)", () => {
  it('@oracle sanity: the live broker still defines exactly the 17 tools this partition assumes', () => {
    // @oracle: guards against a vacuous test if the broker catalog drifts
    // out from under this file's hardcoded classification.
    const liveToolNames = getOpenAIToolDefinitions().map((d) => d.name);
    expect(liveToolNames.sort()).toEqual(
      [...ASK_TOOL_NAMES, ...OTHER_READ_TOOL_NAMES, ...MUTATION_TOOL_NAMES].sort(),
    );
  });

  it.each(OTHER_READ_TOOL_NAMES)(
    '@oracle evaluatePermission(interactive, "%s") === allow (matches read-only)',
    (toolName) => {
      // @oracle: plan Scope -- "everything else matches read-only exactly".
      // ADR amendment -- "the other four catalogued read tools evaluate to
      // allow".
      const interactiveResult = evaluatePermission(interactivePolicy(), toolName);
      const readOnlyResult = evaluatePermission(readOnlyPolicy(), toolName);
      expect(interactiveResult.decision).toBe('allow');
      expect(interactiveResult.decision).toBe(readOnlyResult.decision);
    },
  );

  it.each(MUTATION_TOOL_NAMES)(
    '@oracle evaluatePermission(interactive, "%s") === deny (matches read-only)',
    (toolName) => {
      // @oracle: ADR amendment -- "all eleven mutation-capable tools
      // evaluate to deny".
      const interactiveResult = evaluatePermission(interactivePolicy(), toolName);
      const readOnlyResult = evaluatePermission(readOnlyPolicy(), toolName);
      expect(interactiveResult.decision).toBe('deny');
      expect(interactiveResult.decision).toBe(readOnlyResult.decision);
    },
  );

  it('@oracle every broker tool outside the two ask-tools: interactive.decision === read-only.decision, for ALL 15 remaining tools at once', () => {
    // @oracle: a second, structurally independent proof of the same "matches
    // read-only exactly" invariant above -- iterates the LIVE broker catalog
    // directly (not the hardcoded OTHER_READ_TOOL_NAMES/MUTATION_TOOL_NAMES
    // arrays), so a broker tool this file's own classification forgot would
    // still be caught here rather than silently skipped.
    const liveToolNames = getOpenAIToolDefinitions().map((d) => d.name);
    const askSet = new Set<string>(ASK_TOOL_NAMES);
    for (const toolName of liveToolNames) {
      if (askSet.has(toolName)) continue;
      const interactiveResult = evaluatePermission(interactivePolicy(), toolName);
      const readOnlyResult = evaluatePermission(readOnlyPolicy(), toolName);
      expect(
        interactiveResult.decision,
        `tool "${toolName}": interactive=${interactiveResult.decision} must equal read-only=${readOnlyResult.decision}`,
      ).toBe(readOnlyResult.decision);
    }
  });
});

// ===========================================================================
// (d) An unrecognized tool name denies through the profile's defaultDecision
//     -- not an accidental rule match.
// ===========================================================================

describe('@oracle interactive profile -- unknown tools deny via defaultDecision, not a coincidental rule (ADR amendment)', () => {
  it('@oracle the interactive profile\'s defaultDecision is "deny"', () => {
    // @oracle: ADR amendment -- "the profile's defaultDecision is deny".
    expect(interactivePolicy().defaultDecision).toBe('deny');
  });

  it.each(UNKNOWN_TOOL_NAMES)(
    '@oracle evaluatePermission(interactive, "%s") === deny via the DEFAULT (source: "default", no matched rule)',
    (toolName) => {
      // @oracle: a profile that happened to default-allow (and merely
      // denied/asked the 17 known tools via explicit rules) would pass every
      // assertion above but fail this one -- this is the test that catches
      // that bug, mirroring permission-rules.oracle.test.ts's existing
      // fail-closed-default proof for the read-only profile.
      const result = evaluatePermission(interactivePolicy(), toolName);
      expect(result.decision).toBe('deny');
      expect(result.source).toBe('default');
      expect(result.matchedRuleIndex).toBeUndefined();
    },
  );
});

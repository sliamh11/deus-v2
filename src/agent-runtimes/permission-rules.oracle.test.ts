/**
 * Oracle tests for LIA-407/B7 — declarative permission rules, catalog-parity
 * and read-only-profile decision contract.
 *
 * @oracle Independently authored from the SHIP'd plan
 * (.claude/.plan-scope-b7.md, AC1 + AC3) and the Linear ticket LIA-407, BLIND
 * to the implementation — `permission-rules.ts` does not exist yet at
 * authoring time (the only production code touching tool-call permissions
 * today is `buildPermissionsMiddleware` in `middleware-stack.ts`, an
 * allow-all placeholder). Must not be weakened by the implementer;
 * strengthen instead of loosen if a real gap is found during implementation.
 *
 * SPEC (from the plan, verbatim intent):
 *   - AC1: "Declarative rules can allow or deny a tool call deterministically."
 *     A pure evaluator returns a structured result: decision, source
 *     ('rule' | 'default'), matched rule index, and a model-safe reason.
 *     Rules are evaluated in declaration order; first exact tool-name match
 *     wins; no match falls back to the policy's explicit `defaultDecision`.
 *   - AC1 + Design: "Provide a named profile registry containing `default`
 *     (empty rules, default allow) and `read-only` (the explicit catalog
 *     below, default deny)." Design section: "A Map<string, PermissionPolicy>
 *     holds the supported `default` and `read-only` strategies."
 *   - AC3: "Define the read-only preset with explicit allow rules for
 *     read_file, glob_files, grep_files, web_fetch, web_search, and
 *     list_tasks; explicit deny rules for the remaining eleven built-ins;
 *     and default deny for unknown/dynamic/MCP tools."
 *   - Research: the real 17-tool broker catalog is
 *     `container/agent-runner/src/tool-broker.ts`'s `getOpenAIToolDefinitions()`
 *     (also reachable via the `src/agent-runtimes/tool-broker-langchain-adapter.ts`
 *     seam, which maps the same full surface before its own safe-tool filter).
 *     Six reads: read_file, glob_files, grep_files, web_fetch, web_search,
 *     list_tasks. Eleven mutation-capable: bash_exec, write_file, edit_file,
 *     agent_browser, send_message, schedule_task, pause_task, resume_task,
 *     cancel_task, update_task, register_group.
 *
 * This file is RED against the current tree: `permission-rules.ts` does not
 * exist, so the import below fails to resolve. It must go GREEN once the
 * implementer adds that module satisfying the seam below, WITHOUT this file
 * being edited to match whatever shape the implementation happens to take.
 *
 * TEST-SEAM REQUIREMENTS imposed on the implementer (derived directly from
 * the plan's AC1/AC3 text and Design section — not invented beyond naming):
 *   - export type PermissionDecision = 'allow' | 'deny';
 *   - export interface PermissionRule {
 *       toolName: string;
 *       decision: PermissionDecision;
 *     }
 *   - export interface PermissionPolicy {
 *       rules: PermissionRule[];
 *       defaultDecision: PermissionDecision;
 *     }
 *   - export interface PermissionEvaluation {
 *       decision: PermissionDecision;
 *       source: 'rule' | 'default';
 *       matchedRuleIndex: number | undefined;
 *       reason: string;
 *     }
 *   - export function evaluatePermission(
 *       policy: PermissionPolicy,
 *       toolName: string,
 *     ): PermissionEvaluation
 *     — pure; first exact-name match in `policy.rules` (declaration order)
 *     wins (source: 'rule', matchedRuleIndex: that index); no match falls
 *     back to `policy.defaultDecision` (source: 'default',
 *     matchedRuleIndex: undefined).
 *   - export const PERMISSION_PROFILES: ReadonlyMap<string, PermissionPolicy>
 *     keyed by profile name, containing at least 'default' and 'read-only'.
 * A genuinely incorrect seam may only be changed by the oracle author or a
 * reviewer, with the reason recorded (per the plan's "Independent oracle
 * before implementation" section) — never silently by the implementer.
 */

import { describe, it, expect } from 'vitest';

import { getOpenAIToolDefinitions } from '../../container/agent-runner/src/tool-broker.js';

// These do not exist yet — that is the point (see file header). The import
// itself failing to resolve IS this file's red proof until the module lands.
import { evaluatePermission, PERMISSION_PROFILES } from './permission-rules.js';

// ---------------------------------------------------------------------------
// The spec's explicit six-read / eleven-mutation classification (plan AC3 +
// Research section), independent of whatever the implementer's own
// permission-rules.ts hardcodes internally.
// ---------------------------------------------------------------------------

const READ_TOOL_NAMES = [
  'read_file',
  'glob_files',
  'grep_files',
  'web_fetch',
  'web_search',
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
  // Never defined by the broker; a future/dynamic tool not yet reviewed.
  'totally_unknown_tool_xyz',
  // Plan AC3 explicitly calls out "unknown/dynamic/MCP tools" as fail-closed.
  'mcp__github__create_issue',
] as const;

function readOnlyPolicy() {
  const policy = PERMISSION_PROFILES.get('read-only');
  if (!policy) {
    throw new Error(
      '@oracle: PERMISSION_PROFILES is missing the "read-only" profile ' +
        '(plan AC1/AC3 + Design: "A Map<string, PermissionPolicy> holds ' +
        'the supported `default` and `read-only` strategies")',
    );
  }
  return policy;
}

// ===========================================================================
// 1) Catalog-parity: the real broker catalog is partitioned EXACTLY ONCE
//    into the spec's read set and mutation set — no tool missing, no tool
//    double-counted, no invented name absent from the live broker.
// ===========================================================================

describe('@oracle permission-rules — catalog-parity partition (AC3, plan Research)', () => {
  const liveToolNames = getOpenAIToolDefinitions().map((d) => d.name);

  it('@oracle sanity: the live broker still defines exactly the 17 tools the plan classified', () => {
    // @oracle: guards against a vacuous partition test if the broker catalog drifts
    // out from under the spec's hardcoded classification (plan Research section).
    expect(liveToolNames.sort()).toEqual(
      [...READ_TOOL_NAMES, ...MUTATION_TOOL_NAMES].sort(),
    );
  });

  it('@oracle every read/mutation name appears in exactly one of the two sets (no double-count)', () => {
    // @oracle: AC3 — "partitioned exactly once into ... six reads and eleven
    // mutation-capable tools". A name in both sets (or neither) falsifies the
    // partition property regardless of individual allow/deny correctness.
    const readSet = new Set<string>(READ_TOOL_NAMES);
    const mutationSet = new Set<string>(MUTATION_TOOL_NAMES);
    const overlap = READ_TOOL_NAMES.filter((n) => mutationSet.has(n));
    expect(overlap).toEqual([]);
    for (const name of liveToolNames) {
      const inRead = readSet.has(name);
      const inMutation = mutationSet.has(name);
      expect(
        inRead !== inMutation,
        `tool "${name}" must be classified as exactly one of read/mutation, got read=${inRead} mutation=${inMutation}`,
      ).toBe(true);
    }
  });

  it('@oracle every live broker tool name is covered by the read+mutation union (nothing left unclassified)', () => {
    // @oracle: AC3 — a broker tool the spec's classification forgot would be
    // silently unreachable by this test's later allow/deny assertions.
    const covered = new Set<string>([
      ...READ_TOOL_NAMES,
      ...MUTATION_TOOL_NAMES,
    ]);
    for (const name of liveToolNames) {
      expect(covered.has(name), `broker tool "${name}" is not classified`).toBe(
        true,
      );
    }
  });
});

// ===========================================================================
// 2) Every read tool evaluates to allow under the read-only profile.
// ===========================================================================

describe('@oracle permission-rules — read-only profile allows every read tool (AC3)', () => {
  it.each(READ_TOOL_NAMES)(
    '@oracle evaluatePermission(read-only, "%s") === allow',
    (toolName) => {
      // @oracle: AC3 — "explicit allow rules for read_file, glob_files, grep_files,
      // web_fetch, web_search, and list_tasks"
      const result = evaluatePermission(readOnlyPolicy(), toolName);
      expect(result.decision).toBe('allow');
      // An allow under a profile whose defaultDecision is deny (AC3: "default
      // deny for unknown/dynamic/MCP tools") can only be reached via an
      // explicit matched rule, never the fallback.
      expect(result.source).toBe('rule');
      expect(result.matchedRuleIndex).not.toBeUndefined();
      expect(typeof result.reason).toBe('string');
      expect(result.reason.length).toBeGreaterThan(0);
    },
  );
});

// ===========================================================================
// 3) Every mutation-capable tool evaluates to deny under the read-only
//    profile.
// ===========================================================================

describe('@oracle permission-rules — read-only profile denies every mutation tool (AC3)', () => {
  it.each(MUTATION_TOOL_NAMES)(
    '@oracle evaluatePermission(read-only, "%s") === deny',
    (toolName) => {
      // @oracle: AC3 — "explicit deny rules for the remaining eleven built-ins"
      // (bash_exec, write_file, edit_file, agent_browser, send_message,
      // schedule_task, pause_task, resume_task, cancel_task, update_task,
      // register_group)
      const result = evaluatePermission(readOnlyPolicy(), toolName);
      expect(result.decision).toBe('deny');
      expect(typeof result.reason).toBe('string');
      expect(result.reason.length).toBeGreaterThan(0);
    },
  );
});

// ===========================================================================
// 4) An unrecognized tool name evaluates to deny (fail-closed default) —
//    proving the profile's *default*, not just its explicit rule table.
// ===========================================================================

describe('@oracle permission-rules — read-only profile is fail-closed for unknown tools (AC3)', () => {
  it.each(UNKNOWN_TOOL_NAMES)(
    '@oracle evaluatePermission(read-only, "%s") === deny via the DEFAULT (not a coincidental rule match)',
    (toolName) => {
      // @oracle: AC3 — "default deny for unknown/dynamic/MCP tools". A
      // read-only profile that happened to default-allow (and merely denied
      // the 11 known mutations via explicit rules) would pass every assertion
      // above but fail this one — this is the test that catches that bug.
      const result = evaluatePermission(readOnlyPolicy(), toolName);
      expect(result.decision).toBe('deny');
      expect(result.source).toBe('default');
      expect(result.matchedRuleIndex).toBeUndefined();
    },
  );
});

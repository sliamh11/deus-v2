/**
 * Declarative permission rules and named profiles for the `deus-native`
 * runtime (LIA-407 / B7).
 *
 * PURE policy semantics only — no I/O, no clock, no environment, no mutable
 * runtime state. The LangChain `wrapToolCall` adapter that ENFORCES these
 * decisions lives in middleware-stack.ts (`buildPermissionsMiddleware`);
 * keeping evaluation side-effect-free makes the security decision
 * independently testable and deterministic by construction.
 *
 * Contract (AC1/AC4 — mirrored in docs/decisions/deus-v2-permission-rules.md):
 * - **Chain of Responsibility, first match wins.** `evaluatePermission` walks
 *   `policy.rules` in declaration order and stops at the FIRST exact
 *   tool-name match. Ordering is the firewall-style semantics: an intentional
 *   exception is visible by placement, and a contradictory duplicate rule is
 *   settled by position, never by "deny overrides" or "last wins".
 * - **Explicit per-policy default.** When no rule matches, the policy's
 *   `defaultDecision` applies (source: 'default'). There is no implicit
 *   global fallback.
 * - **Exact names only.** No wildcards, regexes, prefixes, or
 *   argument/path-sensitive matching — exact tool names are sufficient for
 *   the ticket and easier to audit deterministically (plan Non-goals).
 * - **Registry of named profiles.** `PERMISSION_PROFILES` is a
 *   `Map<string, PermissionPolicy>` holding the supported `default` and
 *   `read-only` strategies (O(1) named lookup). Only these NAMES are accepted
 *   from the live `backendConfig` path (via `resolvePermissionProfile`, which
 *   throws on unknown names — fail visibly, never silently weaken); arbitrary
 *   policy objects remain a programmatic/test-only input to the evaluator.
 *
 * The read/mutation classification below covers the container broker's full
 * 17-tool built-in catalog (container/agent-runner/src/tool-broker.ts,
 * `getOpenAIToolDefinitions`). `bash_exec` and `agent_browser` are classified
 * mutation-capable by CAPABILITY, not per-invocation intent: their command
 * surfaces can cause side effects, so a name-only check must treat them as
 * mutations. Catalog parity is pinned by the independent oracle
 * (permission-rules.oracle.test.ts) against the live broker definitions.
 */

/** The two possible outcomes of a permission evaluation. */
export type PermissionDecision = 'allow' | 'deny';

/** One exact-tool-name rule. Rules are ordered; first match wins. */
export interface PermissionRule {
  /** Exact tool name to match — no wildcards or patterns. */
  toolName: string;
  decision: PermissionDecision;
}

/**
 * An ordered rule list plus the explicit fallback applied when no rule
 * matches. A linear array (not an index) deliberately preserves declaration
 * order at O(n) per decision — n is bounded by the fixed built-in catalog,
 * so an index would add synchronization risk without runtime benefit.
 */
export interface PermissionPolicy {
  rules: PermissionRule[];
  defaultDecision: PermissionDecision;
}

/** Structured, model-safe evaluation result (AC1). */
export interface PermissionEvaluation {
  decision: PermissionDecision;
  /** 'rule' when an explicit rule matched; 'default' for the fallback. */
  source: 'rule' | 'default';
  /** Index into `policy.rules` of the winning rule; undefined for 'default'. */
  matchedRuleIndex: number | undefined;
  /** Human/model-safe explanation. Never includes tool-call arguments. */
  reason: string;
}

/**
 * Pure first-match-wins evaluator. Deterministic: same (policy, toolName)
 * always yields the same result — no arguments, state, time, or environment
 * are consulted (AC1).
 */
export function evaluatePermission(
  policy: PermissionPolicy,
  toolName: string,
): PermissionEvaluation {
  for (let i = 0; i < policy.rules.length; i++) {
    const rule = policy.rules[i];
    if (rule.toolName === toolName) {
      return {
        decision: rule.decision,
        source: 'rule',
        matchedRuleIndex: i,
        reason:
          `tool "${toolName}" is explicitly ` +
          `${rule.decision === 'allow' ? 'allowed' : 'denied'} ` +
          `by rule ${i} of this policy`,
      };
    }
  }
  return {
    decision: policy.defaultDecision,
    source: 'default',
    matchedRuleIndex: undefined,
    reason:
      `tool "${toolName}" matched no rule; ` +
      `the policy default is ${policy.defaultDecision}`,
  };
}

/**
 * The six read-only built-ins of the broker's 17-tool catalog (plan AC3 /
 * Research). Verified read-only by reading both the broker definitions and
 * implementations; pinned against the live catalog by the oracle test.
 */
export const READ_ONLY_ALLOWED_TOOL_NAMES: readonly string[] = [
  'read_file',
  'glob_files',
  'grep_files',
  'web_fetch',
  'web_search',
  'list_tasks',
];

/**
 * The remaining eleven mutation-capable built-ins. Explicit deny rules (not
 * just default-deny) so the classification of every KNOWN tool is a reviewed,
 * auditable decision — the default only ever covers genuinely unknown names.
 */
export const READ_ONLY_DENIED_TOOL_NAMES: readonly string[] = [
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
];

/**
 * `default` profile: empty rules, default allow — byte-for-byte today's
 * allow-all permissions behavior when no profile is requested. The separate
 * `buildSafeTools` inclusion filter (SAFE_TOOL_NAMES) still limits the
 * actual live tool surface; this profile changes nothing.
 */
const DEFAULT_POLICY: PermissionPolicy = {
  rules: [],
  defaultDecision: 'allow',
};

/**
 * `read-only` profile: explicit allow for the six reads, explicit deny for
 * the eleven mutation-capable built-ins, and FAIL-CLOSED default deny for
 * unknown/dynamic/MCP tools — a plan-mode primitive must never silently
 * grant a tool whose side-effect classification was never reviewed (AC3).
 */
const READ_ONLY_POLICY: PermissionPolicy = {
  rules: [
    ...READ_ONLY_ALLOWED_TOOL_NAMES.map((toolName): PermissionRule => ({
      toolName,
      decision: 'allow',
    })),
    ...READ_ONLY_DENIED_TOOL_NAMES.map((toolName): PermissionRule => ({
      toolName,
      decision: 'deny',
    })),
  ],
  defaultDecision: 'deny',
};

/**
 * Registry of the named profiles accepted on the live backend-config path.
 * Adding a future reviewed profile extends this map without touching the
 * evaluator's control flow (plan Design: Registry).
 */
export const PERMISSION_PROFILES: ReadonlyMap<string, PermissionPolicy> =
  new Map<string, PermissionPolicy>([
    ['default', DEFAULT_POLICY],
    ['read-only', READ_ONLY_POLICY],
  ]);

/**
 * Resolves a named profile, THROWING on an unrecognized name — an invalid
 * profile must fail visibly before agent construction rather than silently
 * weakening the requested restriction (plan Scope).
 */
export function resolvePermissionProfile(name: string): PermissionPolicy {
  const policy = PERMISSION_PROFILES.get(name);
  if (!policy) {
    const known = [...PERMISSION_PROFILES.keys()]
      .map((k) => `"${k}"`)
      .join(', ');
    throw new Error(
      `resolvePermissionProfile: unknown permission profile "${name}" ` +
        `(known profiles: ${known}); refusing to fall back to a weaker policy`,
    );
  }
  return policy;
}

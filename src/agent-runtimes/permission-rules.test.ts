/**
 * Implementation-authored tests for permission-rules.ts (LIA-407 / B7,
 * AC1 + AC4, plus AC3's profile-structure coverage).
 *
 * SUPPLEMENTARY to the independent oracle
 * (permission-rules.oracle.test.ts, authored blind to this implementation):
 * the oracle pins catalog PARITY against the LIVE broker definitions and the
 * read-only decision contract; this file pins the evaluator's SEMANTICS —
 * precedence, defaults, exact-name matching, determinism, purity — and the
 * registry/resolver behavior the oracle does not exercise. Nothing here
 * re-asserts (or could weaken) an oracle expectation.
 */

import { describe, it, expect } from 'vitest';

import {
  evaluatePermission,
  resolvePermissionProfile,
  PERMISSION_PROFILES,
  READ_ONLY_ALLOWED_TOOL_NAMES,
  READ_ONLY_DENIED_TOOL_NAMES,
  type PermissionPolicy,
} from './permission-rules.js';

describe('evaluatePermission — rule matching (AC1)', () => {
  it('an explicit allow rule matches by exact tool name', () => {
    const policy: PermissionPolicy = {
      rules: [{ toolName: 'web_search', decision: 'allow' }],
      defaultDecision: 'deny',
    };
    const result = evaluatePermission(policy, 'web_search');
    expect(result.decision).toBe('allow');
    expect(result.source).toBe('rule');
    expect(result.matchedRuleIndex).toBe(0);
    expect(result.reason).toContain('web_search');
  });

  it('an explicit deny rule matches by exact tool name', () => {
    const policy: PermissionPolicy = {
      rules: [{ toolName: 'bash_exec', decision: 'deny' }],
      defaultDecision: 'allow',
    };
    const result = evaluatePermission(policy, 'bash_exec');
    expect(result.decision).toBe('deny');
    expect(result.source).toBe('rule');
    expect(result.matchedRuleIndex).toBe(0);
  });

  it('matchedRuleIndex reports the position of the winning rule, not just 0', () => {
    const policy: PermissionPolicy = {
      rules: [
        { toolName: 'read_file', decision: 'allow' },
        { toolName: 'write_file', decision: 'deny' },
        { toolName: 'web_fetch', decision: 'allow' },
      ],
      defaultDecision: 'deny',
    };
    expect(evaluatePermission(policy, 'write_file').matchedRuleIndex).toBe(1);
    expect(evaluatePermission(policy, 'web_fetch').matchedRuleIndex).toBe(2);
  });
});

describe('evaluatePermission — first-match-wins precedence (AC1, AC4)', () => {
  // Regression guard from the plan's Judgment calls: contradictory duplicate
  // rules prove declaration-order precedence — an accidental switch to
  // last-match or deny-overrides semantics fails BOTH directions below.
  it('contradictory duplicates: deny-then-allow resolves to deny (the FIRST rule)', () => {
    const policy: PermissionPolicy = {
      rules: [
        { toolName: 'edit_file', decision: 'deny' },
        { toolName: 'edit_file', decision: 'allow' },
      ],
      defaultDecision: 'allow',
    };
    const result = evaluatePermission(policy, 'edit_file');
    expect(result.decision).toBe('deny');
    expect(result.matchedRuleIndex).toBe(0);
  });

  it('contradictory duplicates: allow-then-deny resolves to allow (the FIRST rule)', () => {
    const policy: PermissionPolicy = {
      rules: [
        { toolName: 'edit_file', decision: 'allow' },
        { toolName: 'edit_file', decision: 'deny' },
      ],
      defaultDecision: 'deny',
    };
    const result = evaluatePermission(policy, 'edit_file');
    expect(result.decision).toBe('allow');
    expect(result.matchedRuleIndex).toBe(0);
  });
});

describe('evaluatePermission — explicit default fallback (AC1, AC4)', () => {
  it.each(['allow', 'deny'] as const)(
    'no rule matched: falls back to defaultDecision %s with source "default"',
    (defaultDecision) => {
      const policy: PermissionPolicy = { rules: [], defaultDecision };
      const result = evaluatePermission(policy, 'anything_at_all');
      expect(result.decision).toBe(defaultDecision);
      expect(result.source).toBe('default');
      expect(result.matchedRuleIndex).toBeUndefined();
      expect(result.reason).toContain(defaultDecision);
    },
  );
});

describe('evaluatePermission — exact-name matching only (AC1, plan Non-goals)', () => {
  const policy: PermissionPolicy = {
    rules: [{ toolName: 'read_file', decision: 'allow' }],
    defaultDecision: 'deny',
  };

  it.each([
    ['prefix', 'read'],
    ['superstring', 'read_file_v2'],
    ['case variant', 'Read_File'],
    ['whitespace variant', ' read_file'],
  ])(
    'a %s of a rule name ("%s") does NOT match — default applies',
    (_label, name) => {
      const result = evaluatePermission(policy, name);
      expect(result.decision).toBe('deny');
      expect(result.source).toBe('default');
    },
  );
});

describe('evaluatePermission — determinism and purity (AC1)', () => {
  it('repeated evaluation of the same inputs is identical every time', () => {
    const policy = resolvePermissionProfile('read-only');
    const first = evaluatePermission(policy, 'bash_exec');
    for (let i = 0; i < 100; i++) {
      expect(evaluatePermission(policy, 'bash_exec')).toEqual(first);
    }
  });

  it('never mutates the policy it evaluates (deep-frozen policy, no throw)', () => {
    const rules = [{ toolName: 'web_search', decision: 'allow' as const }];
    Object.freeze(rules[0]);
    Object.freeze(rules);
    const policy: PermissionPolicy = Object.freeze({
      rules,
      defaultDecision: 'deny' as const,
    });
    // Strict-mode mutation of a frozen object throws — so a clean pass IS
    // the purity proof for both the match and fallback paths.
    expect(evaluatePermission(policy, 'web_search').decision).toBe('allow');
    expect(evaluatePermission(policy, 'unknown_tool').decision).toBe('deny');
  });
});

describe('PERMISSION_PROFILES registry + resolver (AC1, AC3)', () => {
  it('contains exactly the three supported live profiles', () => {
    expect([...PERMISSION_PROFILES.keys()].sort()).toEqual([
      'default',
      'interactive',
      'read-only',
    ]);
  });

  it('"default" is empty-rules + default allow — today\'s behavior, preserved', () => {
    const policy = resolvePermissionProfile('default');
    expect(policy.rules).toEqual([]);
    expect(policy.defaultDecision).toBe('allow');
    // Any name — known broker tool or not — is allowed via the default.
    const result = evaluatePermission(policy, 'bash_exec');
    expect(result.decision).toBe('allow');
    expect(result.source).toBe('default');
  });

  it('"read-only" carries an EXPLICIT rule per known built-in (6 allows + 11 denies) and default deny', () => {
    const policy = resolvePermissionProfile('read-only');
    expect(policy.defaultDecision).toBe('deny');
    expect(policy.rules).toHaveLength(
      READ_ONLY_ALLOWED_TOOL_NAMES.length + READ_ONLY_DENIED_TOOL_NAMES.length,
    );
    expect(READ_ONLY_ALLOWED_TOOL_NAMES).toHaveLength(6);
    expect(READ_ONLY_DENIED_TOOL_NAMES).toHaveLength(11);
    // Every KNOWN tool's decision comes from an explicit rule, never the
    // fallback — the default only ever covers genuinely unknown names.
    for (const name of [
      ...READ_ONLY_ALLOWED_TOOL_NAMES,
      ...READ_ONLY_DENIED_TOOL_NAMES,
    ]) {
      expect(evaluatePermission(policy, name).source).toBe('rule');
    }
  });

  it('resolvePermissionProfile returns the registry instance for known names', () => {
    expect(resolvePermissionProfile('read-only')).toBe(
      PERMISSION_PROFILES.get('read-only'),
    );
    expect(resolvePermissionProfile('default')).toBe(
      PERMISSION_PROFILES.get('default'),
    );
  });

  it('resolvePermissionProfile THROWS on an unknown name, listing the known profiles', () => {
    expect(() => resolvePermissionProfile('read-onIy')).toThrow(
      /unknown permission profile "read-onIy".*"default".*"read-only"/,
    );
  });
});

describe("'interactive' profile (Amendment 2026-07-21 in deus-v2-permission-rules.md)", () => {
  const INTERACTIVE_ASK_TOOLS = ['web_search', 'web_fetch'] as const;
  const interactive = () => resolvePermissionProfile('interactive');

  it('the two live-reachable tools (web_search/web_fetch) evaluate to an explicit rule-sourced "ask"', () => {
    for (const name of INTERACTIVE_ASK_TOOLS) {
      const result = evaluatePermission(interactive(), name);
      expect(result.decision).toBe('ask');
      expect(result.source).toBe('rule');
    }
  });

  it('the "ask" rule-match reason never mislabels the verdict as denied (the fixed ternary)', () => {
    const result = evaluatePermission(interactive(), 'web_search');
    expect(result.reason).toContain('ask');
    expect(result.reason).not.toContain('denied');
    expect(result.reason).not.toContain('allowed');
  });

  it('the four other read tools stay explicit rule-sourced allow', () => {
    const otherReads = READ_ONLY_ALLOWED_TOOL_NAMES.filter(
      (name) => !(INTERACTIVE_ASK_TOOLS as readonly string[]).includes(name),
    );
    expect(otherReads.sort()).toEqual([
      'glob_files',
      'grep_files',
      'list_tasks',
      'read_file',
    ]);
    for (const name of otherReads) {
      const result = evaluatePermission(interactive(), name);
      expect(result.decision).toBe('allow');
      expect(result.source).toBe('rule');
    }
  });

  it('all eleven mutation-capable tools stay explicit rule-sourced deny — exact parity with read-only', () => {
    const readOnly = resolvePermissionProfile('read-only');
    expect(READ_ONLY_DENIED_TOOL_NAMES).toHaveLength(11);
    for (const name of READ_ONLY_DENIED_TOOL_NAMES) {
      const interactiveResult = evaluatePermission(interactive(), name);
      const readOnlyResult = evaluatePermission(readOnly, name);
      expect(interactiveResult.decision).toBe('deny');
      expect(interactiveResult.source).toBe('rule');
      expect(interactiveResult.decision).toBe(readOnlyResult.decision);
    }
  });

  it('matches read-only on EVERY tool except the two ask tools (per-name decision parity)', () => {
    const readOnly = resolvePermissionProfile('read-only');
    for (const name of [
      ...READ_ONLY_ALLOWED_TOOL_NAMES,
      ...READ_ONLY_DENIED_TOOL_NAMES,
    ]) {
      if ((INTERACTIVE_ASK_TOOLS as readonly string[]).includes(name)) {
        continue;
      }
      expect(evaluatePermission(interactive(), name).decision).toBe(
        evaluatePermission(readOnly, name).decision,
      );
    }
  });

  it('FAILS CLOSED on unknown/dynamic names via default deny (never a silent grant, never a default ask)', () => {
    expect(interactive().defaultDecision).toBe('deny');
    const result = evaluatePermission(interactive(), 'unknown_mcp_tool');
    expect(result.decision).toBe('deny');
    expect(result.source).toBe('default');
  });

  it('carries an explicit rule for every known built-in (2 asks + 4 allows + 11 denies)', () => {
    expect(interactive().rules).toHaveLength(
      READ_ONLY_ALLOWED_TOOL_NAMES.length + READ_ONLY_DENIED_TOOL_NAMES.length,
    );
    for (const name of [
      ...READ_ONLY_ALLOWED_TOOL_NAMES,
      ...READ_ONLY_DENIED_TOOL_NAMES,
    ]) {
      expect(evaluatePermission(interactive(), name).source).toBe('rule');
    }
  });
});

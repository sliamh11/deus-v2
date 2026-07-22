/**
 * Independent oracle for session-scoped `allow_always` grants.
 *
 * Derived from the reviewed Track A contract before the planned production
 * module existed. This file must remain implementation-blind: it asserts only
 * the exported class behavior named by the contract.
 */

import { describe, expect, it } from 'vitest';

import { SessionAlwaysAllowGrants } from './always-allow-grants.js';

describe('@oracle SessionAlwaysAllowGrants', () => {
  // @oracle: add/has use the exact (sessionId, toolName) pair from the spec.
  it('@oracle add grants only the exact session and tool pair', () => {
    const grants = new SessionAlwaysAllowGrants();

    expect(grants.has('session-A', 'web_search')).toBe(false);

    grants.add('session-A', 'web_search');

    expect(grants.has('session-A', 'web_search')).toBe(true);
  });

  // @oracle: a process-wide store must not leak a grant across sessions.
  it('@oracle isolates the same tool name across different sessions', () => {
    const grants = new SessionAlwaysAllowGrants();

    grants.add('session-A', 'web_search');

    expect(grants.has('session-A', 'web_search')).toBe(true);
    expect(grants.has('session-B', 'web_search')).toBe(false);
  });

  // @oracle: matching is by exact tool name, with no wildcard or prefix semantics.
  it('@oracle isolates different tool names within the same session', () => {
    const grants = new SessionAlwaysAllowGrants();

    grants.add('session-A', 'web_search');

    expect(grants.has('session-A', 'web_fetch')).toBe(false);
    expect(grants.has('session-A', 'web_search_extended')).toBe(false);
  });

  // @oracle: clear removes one session's grants and leaves other sessions intact.
  it('@oracle clear revokes every grant for only the selected session', () => {
    const grants = new SessionAlwaysAllowGrants();
    grants.add('session-A', 'web_search');
    grants.add('session-A', 'web_fetch');
    grants.add('session-B', 'web_search');

    grants.clear('session-A');

    expect(grants.has('session-A', 'web_search')).toBe(false);
    expect(grants.has('session-A', 'web_fetch')).toBe(false);
    expect(grants.has('session-B', 'web_search')).toBe(true);
  });
});

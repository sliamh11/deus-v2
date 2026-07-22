/**
 * Session-scoped store of `allow_always` permission grants.
 *
 * Wraps a `Map<sessionId, Set<toolName>>` (not a bare `Set`) because
 * `buildPermissionsMiddleware()` is rebuilt fresh every turn, but this store
 * must be a process-wide singleton shared across every session on the
 * daemon (mirroring `PendingPermissionRegistry`'s wiring) — a bare `Set`
 * would leak grants across sessions/groups.
 *
 * In-memory only, process-lifetime, no auto-clear: see
 * `docs/decisions/deus-v2-permission-rules.md`'s 2026-07-22 Amendment for
 * the full rationale (deliberate non-goal: no restart durability, no
 * automatic revoke).
 */
export class SessionAlwaysAllowGrants {
  private readonly bySession = new Map<string, Set<string>>();

  /** True if `toolName` was previously granted `allow_always` for `sessionId`. */
  has(sessionId: string, toolName: string): boolean {
    return this.bySession.get(sessionId)?.has(toolName) ?? false;
  }

  /** Records an `allow_always` grant for the exact (sessionId, toolName) pair. */
  add(sessionId: string, toolName: string): void {
    const tools = this.bySession.get(sessionId) ?? new Set<string>();
    tools.add(toolName);
    this.bySession.set(sessionId, tools);
  }

  /** Revokes every grant for `sessionId` only; other sessions are untouched. */
  clear(sessionId: string): void {
    this.bySession.delete(sessionId);
  }
}

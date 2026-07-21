/**
 * Process-wide registry of pending interactive permission requests.
 *
 * Promoted VERBATIM out of the LIA-465 spike
 * (`scripts/spikes/lia465_protocol_boundary_permission_spike.ts`, which now
 * imports it from here) into production for the interactive-permission
 * follow-up ticket (docs/decisions/deus-v2-permission-rules.md, Amendment
 * 2026-07-21). This is a Deus-owned async registry — it neither imports nor
 * depends on LangChain's HITL (`interrupt()`/`Command`) machinery.
 */

import type { PermissionDecision } from './types.js';

// Mirrors the sound part of the old TUI's design
// (docs/decisions/tui-permission-bridge.md decision #4): if nobody answers,
// deny rather than hang forever.
export const DENY_TIMEOUT_MS = 120_000;

/**
 * Registry pattern: Map<requestId, {resolve, timeout}>, O(1) register/resolve.
 * No lookup-index or ordering structure needed at this scale — same
 * rationale docs/decisions/deus-v2-permission-rules.md's own Design section
 * uses for its O(n)/O(1) evaluator.
 */
export class PendingPermissionRegistry {
  private readonly pending = new Map<
    string,
    {
      resolve: (decision: PermissionDecision) => void;
      timeout: NodeJS.Timeout;
    }
  >();

  register(
    requestId: string,
    timeoutMs: number = DENY_TIMEOUT_MS,
  ): Promise<PermissionDecision> {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.pending.delete(requestId);
        resolve('deny');
      }, timeoutMs);
      this.pending.set(requestId, { resolve, timeout });
    });
  }

  /** Returns false if requestId is unknown (already resolved, timed out, or never registered). */
  resolve(requestId: string, decision: PermissionDecision): boolean {
    const entry = this.pending.get(requestId);
    if (!entry) return false;
    clearTimeout(entry.timeout);
    this.pending.delete(requestId);
    entry.resolve(decision);
    return true;
  }

  size(): number {
    return this.pending.size;
  }
}

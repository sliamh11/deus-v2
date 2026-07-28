// LIA-495 -> LIA-496 — permission data model ported verbatim from
// LIA-495's runtime/permissions.ts (itself ported from full-shell.tsx's
// "Permission chooser (delete_file)" section). This is the SAME
// ToolCallMessagePart.approval / ToolApprovalOption[] / respondToApproval
// library-owned model: @assistant-ui/core's approval types are
// backend-neutral, so importing straight from "@assistant-ui/core" (not
// the DOM-target React binding package) makes this file genuinely
// target-neutral rather than per-target-duplicated.
//
// LIA-496 adds a NEW session-scoped grant store (closing LIA-495's honest
// "Always allow didn't persist" gap): a Map<permissionKey, "granted"> the
// adapter consults before deciding whether to attach an `approval` field to
// a tool-call part at all. When a permission has been granted, the adapter
// builds the tool-call part WITHOUT `approval` — so no approval prompt is
// ever rendered for it, because there is nothing in the message for a
// PermissionCard/PermissionPrompt renderer to key off. This is the real
// mechanism the grant-store proof (§ Feature scope, "second
// permission-requiring action") depends on: the suppression happens at
// tool-call construction time in shared/src/adapter.ts, not by hiding a UI
// element after the fact.
import type { ToolApprovalOption } from "@assistant-ui/core";
import { existsSync, rmSync } from "./virtualFs";

export type PermissionDecision = "allow_once" | "allow_always" | "deny";

export const PERMISSION_OPTIONS: readonly ToolApprovalOption[] = [
  { id: "allow_once", kind: "allow-once", label: "Allow once" },
  { id: "allow_always", kind: "allow-always", label: "Always allow" },
  { id: "deny", kind: "reject-once", label: "Deny" },
];

export function decisionFromOptionId(
  optionId: string | undefined,
): PermissionDecision | undefined {
  return PERMISSION_OPTIONS.find((o) => o.id === optionId)?.id as
    | PermissionDecision
    | undefined;
}

export function performDelete(targetPath: string): boolean {
  try {
    rmSync(targetPath);
    return !existsSync(targetPath);
  } catch {
    return false;
  }
}

// Tracks the REAL, synchronously-observed outcome of each approved (or
// grant-store auto-approved) action, keyed by toolCallId — identical
// map-based approach to full-shell.tsx's `executionOutcomes`, and for the
// identical reason: deliberately NOT threaded through
// `props.addResult`/`props.result`, because calling `addResult` on a
// tool-call whose approval is still pending races with
// `respondToApproval`'s own auto-continuation trigger (`shouldContinue`'s
// per-part gate is `result === undefined && approval !== undefined &&
// approval.approved === undefined` — setting `result` alone already
// defeats it). This module-level map is a straight port of that finding,
// generalized beyond just `delete_file` since LIA-496 has more scripted
// tool calls than LIA-495 did.
export const executionOutcomes = new Map<string, boolean>();

// ---------------------------------------------------------------------------
// Session-scoped grant store (LIA-496, new).
//
// Keyed coarsely by tool name (e.g. "delete_file") rather than by exact
// target path — this matches how "Always allow" reads to a user ("stop
// asking me about deletions this session", not "stop asking me about this
// ONE path"), and it is what makes the grant-store proof observable: turn 1
// grants on file A, turn 3's request to delete file B is a DIFFERENT
// target but the SAME permission class, and must still be auto-approved
// with no prompt rendered.
// ---------------------------------------------------------------------------
export type PermissionKey = string;

export function permissionKey(toolName: string): PermissionKey {
  return toolName;
}

const grantStore = new Map<PermissionKey, "granted">();

export function hasGrant(key: PermissionKey): boolean {
  return grantStore.get(key) === "granted";
}

export function grant(key: PermissionKey): void {
  grantStore.set(key, "granted");
}

// Exposed for the headless verification script and for a future "reset
// session" affordance — never called from the scripted turn generators
// themselves, which only ever call `grant`.
export function clearGrants(): void {
  grantStore.clear();
}

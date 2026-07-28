// LIA-495 — permission data model ported verbatim from full-shell.tsx's
// "Permission chooser (delete_file)" section. This is the SAME
// ToolCallMessagePart.approval / ToolApprovalOption[] / respondToApproval
// library-owned model the ink version used — @assistant-ui/core's approval
// types are backend-neutral (confirmed: ToolCallMessagePartProps is defined
// once in @assistant-ui/core/react and re-exported unchanged by both
// @assistant-ui/react and @assistant-ui/react-ink), so none of this needed
// to change for the web target. Only `performDelete`'s backing store
// changed (real `node:fs` → runtime/virtualFs.ts — see that file's header
// comment).
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

// Tracks the REAL, synchronously-observed outcome of each approved
// deletion, keyed by toolCallId — identical map-based approach to
// full-shell.tsx's `executionOutcomes`, and for the identical reason:
// deliberately NOT threaded through `props.addResult`/`props.result`,
// because calling `addResult` on a tool-call whose approval is still
// pending races with `respondToApproval`'s own auto-continuation trigger
// (`shouldContinue`'s per-part gate is `result === undefined && approval
// !== undefined && approval.approved === undefined` — setting `result`
// alone already defeats it). This module-level map is a straight port of
// that finding, not a new design decision for the web target.
export const executionOutcomes = new Map<string, boolean>();

// LIA-496 — PermissionCard.tsx <- the ToolCallMessagePart renderer for
// approval-gated tools (wired via `components.tools.by_name.delete_file` on
// AssistantMessage's MessagePrimitive.Parts, in Thread.tsx). Reading Room
// "decision card" treatment per the design source's .s-perm markup: pine
// "Allow" button (allow_once), ghost "Not now" (deny), text "Always allow"
// link (allow_always — feeds shared's session-scoped grant store, closing
// LIA-495's honest "Always allow didn't persist" gap).
//
// Same synchronous-deletion-before-respondToApproval sequencing LIA-495's
// PermissionToolUI proved necessary (see shared/src/permissions.ts's header
// comment): the real (virtual-fs) deletion happens HERE, synchronously,
// recorded into `executionOutcomes` BEFORE `respondToApproval` — never via
// `props.addResult`, which races respondToApproval's own auto-continuation
// trigger.
//
// WB4 (LIA-496 review-fix) — W15 fix: "Always allow" didn't state how
// broad its grant was. shared/src/permissions.ts's grant store (see its
// own header comment) is keyed by TOOL NAME, not by exact path, and lasts
// for the rest of the session — so the button's display text and the
// added scope note both say exactly that ("this session", "every <tool>
// request"), not a vaguer "always". Only the DISPLAY text changes here;
// `PERMISSION_OPTIONS`' underlying `label`/`id` values in shared stay
// untouched — a presentation-value change belongs in this file, per this
// repo's own shared-purity rule, not in shared/src/permissions.ts.
import type { FC } from "react";
import type { ToolCallMessagePartProps } from "@assistant-ui/react";
import type { ToolApprovalOption, ToolApprovalResponse } from "@assistant-ui/core";
import {
  PERMISSION_OPTIONS,
  decisionFromOptionId,
  executionOutcomes,
  performDelete,
  extractPath,
  type PermissionDecision,
} from "@lia496/shared";

function optionByKind(
  options: readonly ToolApprovalOption[],
  kind: ToolApprovalOption["kind"],
): ToolApprovalOption | undefined {
  return options.find((o) => o.kind === kind);
}

export const PermissionCard: FC<ToolCallMessagePartProps> = (props) => {
  const approval = props.approval;
  const path = extractPath(props.args);

  // No `approval` field at all — the grant-store proof (shared's
  // permissions.ts): adapter.ts built this tool-call WITHOUT approval
  // because the permission was already granted this session. Nothing to
  // render; the deletion already happened inline in the adapter.
  if (!approval) return null;

  const options = (approval.options as readonly ToolApprovalOption[] | undefined) ?? PERMISSION_OPTIONS;
  const resolved = approval.approved !== undefined || approval.resolution !== undefined;

  const respond = (chosen: ToolApprovalOption) => {
    const approved = chosen.kind === "allow-once" || chosen.kind === "allow-always";
    if (approved && path) {
      const deleted = performDelete(path);
      executionOutcomes.set(props.toolCallId, deleted);
    }
    props.respondToApproval({ approved, optionId: chosen.id } as ToolApprovalResponse);
  };

  if (resolved) {
    if (approval.resolution) {
      return (
        <div className="s-perm">
          <div className="s-perm-resolved">Request {approval.resolution} — no decision made.</div>
        </div>
      );
    }
    const decision: PermissionDecision =
      decisionFromOptionId(approval.optionId) ?? (approval.approved ? "allow_once" : "deny");
    // W15 — the resolved-state label mirrors the pending-state button text
    // below: "allow_always"'s scope is stated explicitly here too, not just
    // on the button that produced it, so re-reading a past decision is just
    // as honest about its breadth as making the decision was.
    const label =
      decision === "allow_always"
        ? "Always allow (this session)"
        : (options.find((o) => o.id === approval.optionId)?.label ?? decision);
    const deleted = executionOutcomes.get(props.toolCallId);
    const outcome =
      decision === "deny" ? "not deleted" : deleted === undefined ? "awaiting execution" : deleted ? "deleted" : "delete failed";
    return (
      <div className="s-perm">
        <div className={`s-perm-resolved ${decision === "deny" ? "denied" : "granted"}`}>
          {label} — {outcome}
        </div>
      </div>
    );
  }

  const allowOnce = optionByKind(options, "allow-once");
  const allowAlways = optionByKind(options, "allow-always");
  const deny = optionByKind(options, "reject-once");

  return (
    <div className="s-perm">
      <div className="h">Permission needed — {props.toolName.replace(/_/g, " ")}</div>
      <div className="d">{path ? <code>{path}</code> : props.argsText}</div>
      <div className="s-perm-row">
        {allowOnce && (
          <button type="button" className="s-btn go" onClick={() => respond(allowOnce)}>
            Allow
          </button>
        )}
        {deny && (
          <button type="button" className="s-btn ghost" onClick={() => respond(deny)}>
            Not now
          </button>
        )}
        {allowAlways && (
          <button type="button" className="s-always" onClick={() => respond(allowAlways)}>
            Always allow (this session)
          </button>
        )}
      </div>
      {allowAlways && (
        <div className="s-perm-scope">
          Applies to every {props.toolName.replace(/_/g, " ")} request for the rest of this
          session — not just this one.
        </div>
      )}
    </div>
  );
};

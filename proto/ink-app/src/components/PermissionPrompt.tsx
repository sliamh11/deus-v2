// LIA-496 — the ToolCallMessagePart renderer for approval-gated tools
// (registered against `delete_file` in Messages.tsx's `AssistantMessage` —
// confirm that link there, not here). Three states, driven entirely by
// `props.approval` (the library-owned data model, from
// shared/src/permissions.ts — never a local reimplementation):
//
//   1. `approval` undefined at all — the grant-store proof
//      (shared/src/permissions.ts's header comment): the adapter built this
//      tool-call WITHOUT an `approval` field because the session already
//      granted this permission class. Nothing here to key a prompt off of,
//      so this renders a plain inert completed line — NOT a permission box.
//      A dashed box rendering here would be the exact FAIL this stage's
//      dispatch calls out ("if a prompt renders, that's a FAIL").
//   2. `approval` present, unresolved (`approved === undefined` and no
//      `resolution`) — the dashed-equivalent box with [y]/[a]/[n] hints,
//      resolved via `useInput`.
//   3. `approval` present, resolved — a one-line summary.
//
// The actual delete + subsequent-turn continuation happens inside
// shared/src/fixtures/conversations.ts's `turn1Continue`/`turn3Continue`
// (invoked by the adapter once `respondToApproval` triggers its
// auto-continuation) — NOT in this component. This component's only job on
// confirm is calling `respondToApproval`; it never calls `performDelete`
// itself (that would race the exact continuation trigger
// shared/src/permissions.ts's header comment warns about).
import { type FC } from "react";
import { Box, Text, useInput } from "ink";
import type { ToolCallMessagePartProps } from "@assistant-ui/react-ink";
import { extractPath, executionOutcomes, decisionFromOptionId, type PermissionDecision } from "@lia496/shared";
import { theme } from "../theme";

const DASHED_BORDER = {
  topLeft: "┌",
  top: "╌",
  topRight: "┐",
  right: "╎",
  bottomRight: "┘",
  bottom: "╌",
  bottomLeft: "└",
  left: "╎",
};

const GLYPH = "●";

function decisionLabel(decision: PermissionDecision): string {
  switch (decision) {
    case "allow_once":
      return "Allow once";
    case "allow_always":
      return "Always allow";
    case "deny":
      return "Deny";
    default: {
      const _exhaustive: never = decision;
      return _exhaustive;
    }
  }
}

const ResolvedLine: FC<{ props: ToolCallMessagePartProps; path: string | undefined; decision: PermissionDecision }> = ({
  props,
  path,
  decision,
}) => {
  const deleted = executionOutcomes.get(props.toolCallId);
  const outcome = decision === "deny" ? undefined : deleted === undefined ? "awaiting execution" : deleted ? "deleted" : "delete failed";
  const color = decision === "deny" ? theme.err : deleted === undefined ? theme.amber : deleted ? theme.ok : theme.err;

  return (
    <Box marginBottom={1}>
      <Text color={color}>
        {GLYPH} delete_file({path ?? props.argsText}) — {decisionLabel(decision)}
        {outcome ? ` (${outcome})` : ""}
      </Text>
    </Box>
  );
};

export const PermissionPrompt: FC<ToolCallMessagePartProps> = (props) => {
  const path = extractPath(props.args);
  const approval = props.approval;
  const resolved = approval !== undefined && (approval.approved !== undefined || approval.resolution !== undefined);

  // Code-review fix (LIA-496 REVISE round): `useInput` used to sit AFTER
  // the `!approval` early return below — a Rules of Hooks violation
  // (oxlint's `react/rules-of-hooks` is enabled on web-app's config but
  // NOT on ink-app's, which is why it went uncaught; this is a genuine
  // source defect independent of whether lint happens to flag it).
  // Latent today only because a given tool-call part's `props.approval`
  // never flips from undefined to defined across renders of the SAME
  // component instance in this fixture's scripted flow — but if the
  // adapter ever streamed a part first without and then with an
  // `approval` field, this exact instance would go from 0 hooks called to
  // 1, crashing with a hook-count mismatch. Hoisted above every return so
  // the hook count is identical on every render regardless of branch;
  // `isActive`/the callback's own guard both account for the `!approval`
  // case (no approval field at all means nothing here to resolve).
  useInput(
    (input) => {
      if (!approval || resolved) return;
      if (input === "y") props.respondToApproval({ approved: true, optionId: "allow_once" });
      else if (input === "a") props.respondToApproval({ approved: true, optionId: "allow_always" });
      else if (input === "n") props.respondToApproval({ approved: false, optionId: "deny" });
    },
    { isActive: approval !== undefined && !resolved },
  );

  // Case 1 — grant-store auto-approval: no `approval` field at all. Render
  // as an inert completed line, no prompt.
  if (!approval) {
    const deleted = executionOutcomes.get(props.toolCallId);
    const outcome = deleted === undefined ? "awaiting execution" : deleted ? "deleted (always-allow, no prompt)" : "delete failed";
    return (
      <Box marginBottom={1}>
        <Text color={theme.dim}>
          {GLYPH} delete_file({path ?? props.argsText}) — {outcome}
        </Text>
      </Box>
    );
  }

  if (resolved) {
    if (approval.resolution) {
      return (
        <Box marginBottom={1}>
          <Text color={theme.amber}>
            {GLYPH} delete_file({path ?? props.argsText}) — request {approval.resolution}, no decision made
          </Text>
        </Box>
      );
    }
    const decision: PermissionDecision =
      decisionFromOptionId(approval.optionId) ?? (approval.approved ? "allow_once" : "deny");
    return <ResolvedLine props={props} path={path} decision={decision} />;
  }

  return (
    <Box flexDirection="column" borderStyle={DASHED_BORDER} borderColor={theme.dim} paddingX={1} marginY={1}>
      <Text color={theme.ink}>
        delete {path ?? props.argsText} ?
      </Text>
      <Box marginTop={1}>
        <Text backgroundColor={theme.amber} color={theme.bg}>
          {" y "}
        </Text>
        <Text> allow once   </Text>
        <Text backgroundColor={theme.amber} color={theme.bg}>
          {" a "}
        </Text>
        <Text> always allow   </Text>
        <Text backgroundColor={theme.dim} color={theme.ink}>
          {" n "}
        </Text>
        <Text> deny</Text>
      </Box>
    </Box>
  );
};

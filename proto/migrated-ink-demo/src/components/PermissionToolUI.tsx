// LIA-495 — Ink equivalent of web-first-demo's PermissionToolUI, itself
// ported from full-shell.tsx's "Permission chooser (delete_file)" section.
// Preserves the EXACT same library-owned data model
// (ToolCallMessagePart.approval / ToolApprovalOption[] / respondToApproval,
// from runtime/permissions.ts, copied verbatim) and the exact same
// synchronous-deletion-before-respondToApproval sequencing full-shell.tsx
// found necessary (see runtime/permissions.ts's header comment). The INPUT
// mechanism is restored to the Ink target's own primitive: Ink's
// `useInput(handler, { isActive })` (raw keypress reducer) replaces
// web-first-demo's `onKeyDown` + `<button>` `onClick`s, matching
// full-shell.tsx's original mechanism exactly (arrow keys / 1-3 / Enter,
// no click affordance — a terminal has no pointer).
import { useState, type FC } from "react";
import { Box, Text, useInput } from "ink";
import type { ToolCallMessagePartProps } from "@assistant-ui/react-ink";
import type { ToolApprovalOption, ToolApprovalResponse } from "@assistant-ui/core";
import { BULLET, tokens } from "../runtime/tokens";
import { extractPath } from "../runtime/util";
import {
  PERMISSION_OPTIONS,
  decisionFromOptionId,
  executionOutcomes,
  performDelete,
  type PermissionDecision,
} from "../runtime/permissions";
import { ToolPath } from "./ToolPath";

const PermissionOptionRow: FC<{
  option: ToolApprovalOption;
  index: number;
  selected: boolean;
}> = ({ option, index, selected }) => {
  const rowColor = selected ? tokens.accentPrimary : tokens.textPrimary;
  return (
    <Text color={rowColor}>
      {selected ? "› " : "  "}
      {index + 1}. {option.label ?? option.id}
    </Text>
  );
};

const ResolvedRow: FC<{
  approval: NonNullable<ToolCallMessagePartProps["approval"]>;
  options: readonly ToolApprovalOption[];
  toolName: string;
  path: string | undefined;
  argsText: string;
  toolCallId: string;
}> = ({ approval, options, toolName, path, argsText, toolCallId }) => {
  if (approval.resolution) {
    return (
      <Text color={tokens.semanticWarning}>
        {BULLET} {toolName}({path ? <ToolPath path={path} /> : argsText}) — request {approval.resolution}, no
        decision made
      </Text>
    );
  }
  const decision: PermissionDecision =
    decisionFromOptionId(approval.optionId) ?? (approval.approved ? "allow_once" : "deny");
  const label = options.find((o) => o.id === approval.optionId)?.label ?? decision;
  const deleted = executionOutcomes.get(toolCallId);
  const outcomeText =
    decision === "deny" ? undefined : deleted === undefined ? "awaiting execution" : deleted ? "deleted" : "delete failed";
  const color =
    decision === "deny"
      ? tokens.semanticError
      : deleted === undefined
        ? tokens.semanticWarning
        : deleted
          ? tokens.semanticSuccess
          : tokens.semanticError;
  return (
    <Text color={color}>
      {BULLET} {toolName}({path ? <ToolPath path={path} /> : argsText}) — {label}
      {outcomeText ? ` (${outcomeText})` : ""}
    </Text>
  );
};

export const PermissionToolUI: FC<ToolCallMessagePartProps> = (props) => {
  const [cursorIndex, setCursorIndex] = useState(0);
  const approval = props.approval;
  const options = (approval?.options as readonly ToolApprovalOption[] | undefined) ?? PERMISSION_OPTIONS;
  const resolved = approval !== undefined && (approval.approved !== undefined || approval.resolution !== undefined);
  const path = extractPath(props.args);

  const confirm = (index: number) => {
    const chosen = options[index];
    if (!chosen) return;
    const approved = chosen.kind === "allow-once" || chosen.kind === "allow-always";
    // Perform the real (virtual-fs) deletion NOW, synchronously, and record
    // its outcome in `executionOutcomes` BEFORE calling respondToApproval —
    // never via `props.addResult` here. See runtime/permissions.ts's header
    // comment: calling addResult on a tool-call whose approval is still
    // pending races with respondToApproval's own auto-continuation trigger
    // and throws. This is the ONLY call into the runtime this handler
    // makes, identical to full-shell.tsx and web-first-demo.
    if (approved && path) {
      const deleted = performDelete(path);
      executionOutcomes.set(props.toolCallId, deleted);
    }
    props.respondToApproval({ approved, optionId: chosen.id } as ToolApprovalResponse);
  };

  useInput(
    (input, key) => {
      if (resolved || options.length === 0) return;
      if (input === "1" || input === "2" || input === "3") {
        const index = Number(input) - 1;
        if (index < options.length) {
          setCursorIndex(index);
          confirm(index);
        }
        return;
      }
      if (key.upArrow) setCursorIndex((i) => (i - 1 + options.length) % options.length);
      else if (key.downArrow) setCursorIndex((i) => (i + 1) % options.length);
      else if (key.return) confirm(cursorIndex);
    },
    { isActive: !resolved },
  );

  if (resolved && approval) {
    return (
      <Box marginBottom={1}>
        <ResolvedRow
          approval={approval}
          options={options}
          toolName={props.toolName}
          path={path}
          argsText={props.argsText}
          toolCallId={props.toolCallId}
        />
      </Box>
    );
  }

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={tokens.semanticWarning} paddingX={1} marginY={1}>
      <Text bold color={tokens.semanticWarning}>
        Permission required
      </Text>
      <Box marginTop={1}>
        <Text color={tokens.textMuted}>{BULLET} </Text>
        <Text bold color={tokens.textPrimary}>
          {props.toolName}
        </Text>
      </Box>
      <Box>{path ? <ToolPath path={path} /> : <Text color={tokens.textMuted}>{props.argsText}</Text>}</Box>
      <Box marginTop={1} flexDirection="column">
        {options.map((opt, i) => (
          <PermissionOptionRow key={opt.id} option={opt} index={i} selected={i === cursorIndex} />
        ))}
      </Box>
      <Box marginTop={1}>
        <Text color={tokens.textMuted}>↑/↓ move · 1–3 choose · Enter confirm</Text>
      </Box>
    </Box>
  );
};

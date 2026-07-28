// LIA-495 — ported from full-shell.tsx's "Permission chooser (delete_file)"
// section. Preserves the EXACT same library-owned data model
// (ToolCallMessagePart.approval / ToolApprovalOption[] /
// respondToApproval, from runtime/permissions.ts) and the exact same
// synchronous-deletion-before-respondToApproval sequencing the ink version
// found necessary (see runtime/permissions.ts's header comment) — only the
// INPUT mechanism changed, because a browser has no `useInput`: Ink's
// `useInput(handler, { isActive })` (raw keypress reducer) becomes a plain
// `onKeyDown` handler on a focusable container plus real `<button>`
// `onClick`s. The number-key (1/2/3) and Enter/arrow-key affordances are
// kept for parity, but clicking is now the primary, discoverable path
// (buttons render always, not just as a keyboard hint line).
import { useState, type FC, type KeyboardEvent } from "react";
import type { ToolCallMessagePartProps } from "@assistant-ui/react";
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
  onChoose: () => void;
}> = ({ option, index, selected, onChoose }) => {
  const rowColor = selected ? tokens.accentPrimary : tokens.textPrimary;
  return (
    <button
      type="button"
      onClick={onChoose}
      style={{
        display: "block",
        width: "100%",
        textAlign: "left",
        background: "transparent",
        border: "none",
        color: rowColor,
        font: "inherit",
        padding: "2px 0",
        cursor: "pointer",
      }}
    >
      {selected ? "› " : "  "}
      {index + 1}. {option.label ?? option.id}
    </button>
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
      <span style={{ color: tokens.semanticWarning }}>
        {BULLET} {toolName}({path ? <ToolPath path={path} /> : argsText}) — request {approval.resolution}, no
        decision made
      </span>
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
    <span style={{ color }}>
      {BULLET} {toolName}({path ? <ToolPath path={path} /> : argsText}) — {label}
      {outcomeText ? ` (${outcomeText})` : ""}
    </span>
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
    // makes, identical to the ink version.
    if (approved && path) {
      const deleted = performDelete(path);
      executionOutcomes.set(props.toolCallId, deleted);
    }
    props.respondToApproval({ approved, optionId: chosen.id } as ToolApprovalResponse);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (resolved || options.length === 0) return;
    if (e.key === "1" || e.key === "2" || e.key === "3") {
      const index = Number(e.key) - 1;
      if (index < options.length) {
        setCursorIndex(index);
        confirm(index);
      }
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setCursorIndex((i) => (i - 1 + options.length) % options.length);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setCursorIndex((i) => (i + 1) % options.length);
    } else if (e.key === "Enter") {
      confirm(cursorIndex);
    }
  };

  if (resolved && approval) {
    return (
      <div style={{ marginBottom: 16 }}>
        <ResolvedRow
          approval={approval}
          options={options}
          toolName={props.toolName}
          path={path}
          argsText={props.argsText}
          toolCallId={props.toolCallId}
        />
      </div>
    );
  }

  return (
    <div
      role="group"
      aria-label="Permission required"
      tabIndex={0}
      onKeyDown={onKeyDown}
      style={{
        border: `1px solid ${tokens.semanticWarning}`,
        borderRadius: 6,
        padding: "8px 12px",
        margin: "8px 0",
        outline: "none",
      }}
    >
      <div style={{ fontWeight: 700, color: tokens.semanticWarning }}>Permission required</div>
      <div style={{ marginTop: 8, display: "flex", gap: 4, alignItems: "baseline" }}>
        <span style={{ color: tokens.textMuted }}>{BULLET} </span>
        <span style={{ fontWeight: 700, color: tokens.textPrimary }}>{props.toolName}</span>
      </div>
      <div>{path ? <ToolPath path={path} /> : <span style={{ color: tokens.textMuted }}>{props.argsText}</span>}</div>
      <div style={{ marginTop: 8 }}>
        {options.map((opt, i) => (
          <PermissionOptionRow
            key={opt.id}
            option={opt}
            index={i}
            selected={i === cursorIndex}
            onChoose={() => {
              setCursorIndex(i);
              confirm(i);
            }}
          />
        ))}
      </div>
      <div style={{ marginTop: 8, color: tokens.textMuted, fontSize: 12 }}>
        ↑/↓ move · 1–3 choose · Enter confirm · click a row
      </div>
    </div>
  );
};

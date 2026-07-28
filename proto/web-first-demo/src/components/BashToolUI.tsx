// LIA-495 — ported from full-shell.tsx's BashToolUI: same
// `⏺ Bash(command)` bullet convention, same pending/success/error bullet
// coloring (runtime/statusColor.ts's liveBulletColor, ported unchanged).
// Ink `<Box>`/`<Text>` become `<div>`/`<span>`.
import type { FC } from "react";
import type { ToolCallMessagePartProps } from "@assistant-ui/react";
import { liveBulletColor } from "../runtime/statusColor";
import { BULLET, tokens } from "../runtime/tokens";

export const BashToolUI: FC<ToolCallMessagePartProps> = (props) => {
  const pending = props.result === undefined;
  const isError = props.isError === true;
  const color = liveBulletColor(pending, isError);
  const command = (props.args as { command?: string } | undefined)?.command ?? props.argsText;

  return (
    <div style={{ marginBottom: 16 }}>
      <div>
        <span style={{ color, fontWeight: 700 }}>{BULLET} </span>
        <span style={{ fontWeight: 700 }}>Bash</span>
        <span>(</span>
        <span style={{ color: tokens.textMuted }}>{command}</span>
        <span>)</span>
      </div>
      <div style={{ paddingLeft: 16, color: pending ? tokens.textMuted : tokens.textPrimary, opacity: pending ? 1 : 0.85 }}>
        {pending ? "running…" : String(props.result)}
      </div>
    </div>
  );
};

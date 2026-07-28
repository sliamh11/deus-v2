// LIA-495 — Ink equivalent of web-first-demo's BashToolUI, itself ported
// from full-shell.tsx's BashToolUI. Same `⏺ Bash(command)` bullet
// convention, same pending/success/error bullet coloring
// (runtime/statusColor.ts's liveBulletColor, copied verbatim). DOM
// `<div>`/`<span>` become Ink `<Box>`/`<Text>`.
import type { FC } from "react";
import { Box, Text } from "ink";
import type { ToolCallMessagePartProps } from "@assistant-ui/react-ink";
import { liveBulletColor } from "../runtime/statusColor";
import { BULLET, tokens } from "../runtime/tokens";

export const BashToolUI: FC<ToolCallMessagePartProps> = (props) => {
  const pending = props.result === undefined;
  const isError = props.isError === true;
  const color = liveBulletColor(pending, isError);
  const command = (props.args as { command?: string } | undefined)?.command ?? props.argsText;

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text color={color} bold>
          {BULLET}{" "}
        </Text>
        <Text bold>Bash</Text>
        <Text>(</Text>
        <Text color={tokens.textMuted}>{command}</Text>
        <Text>)</Text>
      </Box>
      <Box>
        <Text dimColor={!pending} color={pending ? tokens.textMuted : undefined}>
          {"  "}
          {pending ? "running…" : String(props.result)}
        </Text>
      </Box>
    </Box>
  );
};

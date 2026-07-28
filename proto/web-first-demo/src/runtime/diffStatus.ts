// LIA-495 — pure diff-status logic ported verbatim from full-shell.tsx's
// ToolCallStatus / diffPanelBorderColor / assertDiffPanelNeverImpliesSuccess
// / countChanges. None of this touches ink or the DOM, so it needed no
// change beyond moving from inline colors to CSS var strings (tokens.ts).
import { tokens } from "./tokens";

export type ToolCallStatus = "success" | "error" | "unknown";

export function diffPanelBorderColor(status: ToolCallStatus): string {
  switch (status) {
    case "success":
      return tokens.borderNeutral;
    case "error":
      return tokens.semanticError;
    case "unknown":
      return tokens.semanticWarning;
    default: {
      const _exhaustive: never = status;
      throw new Error(`unhandled ToolCallStatus: ${_exhaustive}`);
    }
  }
}

function assertDiffPanelNeverImpliesSuccess(): void {
  const nonSuccessStatuses: readonly ToolCallStatus[] = ["error", "unknown"];
  for (const status of nonSuccessStatuses) {
    if (diffPanelBorderColor(status) === tokens.borderNeutral) {
      throw new Error(
        `regression: DiffPanel border for ToolCallStatus "${status}" resolved to the neutral color`,
      );
    }
  }
}
assertDiffPanelNeverImpliesSuccess();

export function countChanges(diffContent: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of diffContent.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) additions++;
    else if (line.startsWith("-")) deletions++;
  }
  return { additions, deletions };
}

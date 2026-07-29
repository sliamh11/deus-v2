// LIA-496 — the ToolCallMessagePart renderer for the `Edit` tool (registered
// against `Edit` in Messages.tsx's `AssistantMessage` — confirm that link
// there, not here). Uses the REAL `DiffView` primitive from
// `@assistant-ui/react-ink` (confirmed exported at the package's top level
// by reading node_modules/@assistant-ui/react-ink/dist/index.d.ts directly,
// not assumed) — LIA-495 already found and fixed the duplicate-header bug
// this file must not reintroduce: `DiffView` renders its own
// filename + `+N`/`-N` header internally (confirmed by reading
// node_modules/@assistant-ui/react-ink/src/primitives/diff/DiffView.tsx),
// so this component supplies exactly one header line ("Proposed changes —
// not applied", shown only when the change hasn't cleanly succeeded) and
// never a second filename/count row.
//
// I10 / D2 (LIA-496 IB2) — `DiffView`'s real prop surface, verified against
// `DiffView.d.ts`, is `{patch, oldFile, newFile, showLineNumbers?: boolean,
// contextLines?, maxLines?}` — no truncation-count output, `showLineNumbers`
// a bare boolean not a per-row toggle. So: (1) single unified gutter stays
// (rejecting GPT's two-sided-gutter ask — matches Claude Code's own actual
// convention, and there's no per-row-class numbering to build a two-sided
// version from anyway); (2) the "+N lines hidden" affordance and its ctrl+o
// expand are NOT `DiffView` props — `N` is computed here from
// `result.diffContent`'s own line count, and expand is local component
// state toggling `maxLines` between the cap and `undefined`, same pattern
// as I6's `BashLine` cap. "Number only context/+ rows on ambiguous
// deletions" is dropped per D2 — not implementable through
// `showLineNumbers`'s boolean-only surface, and no ambiguity was actually
// observed in this fixture's own diffs during this batch (see
// VERIFICATION.md).
//
// I9 (LIA-496 IB2) — no border around the diff. Borders are reserved for
// composer/permission/overlays; the per-status signal that the border used
// to carry (`diffPanelBorderStatus`) moves onto the header glyph's color
// instead, so the success/error signal isn't lost, just relocated.
import { useState, type FC } from "react";
import { Box, Text, useInput } from "ink";
import type { ToolCallMessagePartProps } from "@assistant-ui/react-ink";
import { DiffView } from "@assistant-ui/react-ink";
import { extractPath, diffPanelBorderStatus, type EditDiffResult, type ToolCallStatus } from "@lia496/shared";
import { theme, GLYPH_TOOL, STATUS_COLOR } from "../theme";
import { DIFF_LINE_CAP } from "../toolOutputCap";

export const DiffPanel: FC<ToolCallMessagePartProps> = (props) => {
  const path = extractPath(props.args);
  const pending = props.result === undefined;
  const isError = props.isError === true;
  const status: ToolCallStatus = isError ? "error" : "success";
  // I7 — same status-colored `GLYPH_TOOL` every tool part now uses; while
  // pending stays dim (nothing resolved to report a status for yet), same
  // as the pre-existing pending behavior.
  const glyphColor = pending ? theme.dim : STATUS_COLOR[diffPanelBorderStatus(status)];

  const result = pending ? undefined : (props.result as EditDiffResult);
  const diffLines = result ? result.diffContent.split("\n") : [];
  const hiddenDiffLines = Math.max(0, diffLines.length - DIFF_LINE_CAP);
  const cappedDiff = hiddenDiffLines > 0;
  const [diffExpanded, setDiffExpanded] = useState(false);

  useInput(
    (input, key) => {
      if (key.ctrl && input === "o") setDiffExpanded((prev) => !prev);
    },
    { isActive: cappedDiff },
  );

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text color={glyphColor} bold>
          {GLYPH_TOOL}{" "}
        </Text>
        <Text bold>Edit</Text>
        <Text>(</Text>
        <Text color={theme.amber}>{path ?? props.argsText}</Text>
        <Text>)</Text>
      </Box>
      {pending || !result ? (
        <Box>
          <Text color={theme.dim}> editing…</Text>
        </Box>
      ) : (
        (() => {
          const notApplied = status !== "success";
          return (
            <Box flexDirection="column" marginTop={1}>
              {notApplied ? (
                <Box marginBottom={1}>
                  <Text bold color={theme.err}>
                    Proposed changes — not applied
                  </Text>
                </Box>
              ) : null}
              <DiffView
                patch={result.diffContent}
                showLineNumbers
                contextLines={3}
                maxLines={diffExpanded ? undefined : DIFF_LINE_CAP}
              />
              {cappedDiff && !diffExpanded ? (
                <Text color={theme.dim}>
                  … +{hiddenDiffLines} lines · ctrl+o expand
                </Text>
              ) : null}
            </Box>
          );
        })()
      )}
    </Box>
  );
};

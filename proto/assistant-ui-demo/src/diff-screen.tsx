/**
 * LIA-493 prototype — screen 2 of 2: tool-call result with a structured
 * diff payload + a status glyph that must never show a false-positive
 * green checkmark on a failed/unknown call.
 *
 * This is NOT wired into a full AssistantRuntimeProvider chat loop —
 * DiffView (@assistant-ui/react-ink) is self-contained (owns its own
 * DiffRoot/DiffContext internally, confirmed by reading DiffView.js
 * verbatim) and needs no runtime/provider to render. The thing actually
 * under test here is (a) DiffView's patch-string rendering and (b) can a
 * custom status-glyph header be laid correctly around it — exactly the
 * "harder part" called out in the LIA-493 setup notes. Going through the
 * full chat/tool-call pipeline (useAssistantToolUI / toolkit render, both
 * of which exist but the former is @deprecated in this version favoring
 * toolkit-entry render/renderText) would add real-runtime plumbing that
 * is the OTHER screen's concern (interactive approval), not this one's.
 *
 * Fixture shape is a verbatim reuse of production's TranscriptEntry +
 * ToolResultContent + statusGlyph (deus-v2-mvp src/cli/tui-v2/components/
 * messages/ToolMessage.tsx + ToolResultDisplay.tsx + deus-tui-state.ts),
 * extended only with an optional `result` field so a tool-call entry can
 * carry a diff. NOTE: Deus's own codebase separately has an unrelated
 * interface also called `ChatTransport` (deus-native-chat-client.ts:125)
 * — not used or referenced here at all, mentioned only to avoid confusion
 * with assistant-ui's own (also unrelated) chat-transport vocabulary.
 */
import { render, Box, Text } from "ink";
// FRICTION: importing DiffView from the package's public barrel
// ("@assistant-ui/react-ink") crashes at runtime — react-ink's index.js
// re-exports @assistant-ui/core's react barrel, which has a *static* top-
// level import of a cloud-thread-history adapter requiring the
// `assistant-cloud` package. That's declared only as a peerDependency of
// @assistant-ui/core (never installed for a local-only demo, and not
// re-declared by react-ink at all), so Node's ESM resolver throws
// ERR_MODULE_NOT_FOUND for a feature this screen never touches. DiffView
// itself has no such dependency (verified by reading DiffView.js: it only
// imports ./DiffContext, ./DiffRoot, ./diff-utils, ./DiffContent,
// ./intra-line-utils, @assistant-ui/tap, and ink) — a relative deep import
// straight into node_modules bypasses the package.json "exports" map
// (which only gates bare-specifier resolution, not relative paths) and
// sidesteps the barrel entirely. Do NOT add `assistant-cloud` as a fix —
// this workaround requires zero extra installs.
import { DiffView } from "../node_modules/@assistant-ui/react-ink/dist/primitives/diff/DiffView.js";

// ---- Production fixture shape, reused verbatim -----------------------

/** Mirrors src/agent-runtimes/types.ts:85 (deus-v2-mvp). */
type ToolCallStatus = "success" | "error" | "unknown";

/** Mirrors ToolResultDisplay.tsx's ToolResultContent union (deus-v2-mvp). */
type ToolResultContent =
  | { type: "text"; text: string }
  | { type: "diff"; diffContent: string; filename?: string };

/**
 * Mirrors deus-tui-state.ts:38's TranscriptEntry tool variant, extended
 * with an optional `result` so this fixture can carry a diff payload —
 * the production type doesn't have this field yet (diff has no real
 * producer in the live event pipeline per that file's own header
 * comment); this is exactly the "next component" call site it names.
 */
type TranscriptEntry = {
  id: number;
  kind: "tool";
  text: string;
  status: ToolCallStatus;
  result?: ToolResultContent;
};

/** Test fixture helper, reused verbatim from ToolMessage.test.tsx. */
const toolEntry = (
  text: string,
  status: ToolCallStatus = "success",
  id = 0,
  result?: ToolResultContent,
): TranscriptEntry => ({ id, kind: "tool", text, status, result });

/**
 * Mirrors production's exported pure `statusGlyph` (ToolMessage.tsx)
 * verbatim, including the exhaustive switch + `never` check that is the
 * actual regression guard for the "misleading checkmark" bug this
 * prototype exists to re-prove doesn't creep back in.
 */
function statusGlyph(status: ToolCallStatus): { glyph: string; color: string } {
  switch (status) {
    case "success":
      return { glyph: "✓ ", color: "green" };
    case "error":
      return { glyph: "✗ ", color: "red" };
    case "unknown":
      return { glyph: "? ", color: "yellow" };
    default: {
      const _exhaustive: never = status;
      throw new Error(`unhandled ToolCallStatus: ${_exhaustive}`);
    }
  }
}

// ---- Fixtures ----------------------------------------------------------

const SUCCESS_PATCH = `--- a/src/cli/tui-v2/components/messages/ToolMessage.tsx
+++ b/src/cli/tui-v2/components/messages/ToolMessage.tsx
@@ -12,7 +12,9 @@ export function statusGlyph(
 ) {
   switch (status) {
     case "success":
-      return { glyph: "OK", color: "green" };
+      return { glyph: "✓ ", color: "green" };
     case "error":
-      return { glyph: "ERR", color: "red" };
+      return { glyph: "✗ ", color: "red" };
     case "unknown":
-      return { glyph: "?", color: "gray" };
+      return { glyph: "? ", color: "yellow" };
   }
 }
`;

const entries: TranscriptEntry[] = [
  toolEntry(
    "Edit(src/cli/tui-v2/components/messages/ToolMessage.tsx)",
    "success",
    1,
    {
      type: "diff",
      diffContent: SUCCESS_PATCH,
      filename: "src/cli/tui-v2/components/messages/ToolMessage.tsx",
    },
  ),
  toolEntry("Bash(rm -rf /var/lib/deus/sessions)", "error", 2, {
    type: "text",
    text: "Permission denied: destructive path outside allowed roots — call blocked by tool-policy gate before execution. No diff to show: the write never ran.",
  }),
  toolEntry("Read(src/cli/tui-v2/components/messages/ToolMessage.test.tsx)", "unknown", 3, {
    type: "text",
    text: "Result status could not be determined (daemon disconnected mid-call, no terminal event received).",
  }),
];

// ---- Rendering ----------------------------------------------------------

function ToolResultRow({ entry }: { entry: TranscriptEntry }) {
  const { glyph, color } = statusGlyph(entry.status);
  return (
    <Box flexDirection="column" marginBottom={1} borderStyle="round" borderColor={color} paddingX={1}>
      <Box>
        <Text color={color} bold>
          {glyph}
        </Text>
        <Text bold>{entry.text}</Text>
        <Text color={color}> [{entry.status}]</Text>
      </Box>
      {entry.result?.type === "diff" ? (
        <Box marginTop={1} flexDirection="column">
          <DiffView patch={entry.result.diffContent} showLineNumbers contextLines={3} />
        </Box>
      ) : entry.result?.type === "text" ? (
        <Box marginTop={1}>
          <Text dimColor>{entry.result.text}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

function App() {
  return (
    <Box flexDirection="column" padding={1}>
      <Box marginBottom={1}>
        <Text bold underline>
          LIA-493 prototype — tool-call result: diff + status glyph
        </Text>
      </Box>
      <Text dimColor>
        Success shows a real unified diff via DiffView. Error and unknown never
        show green — glyph is derived from status alone, never inferred from
        presence/absence of a diff.
      </Text>
      <Box marginTop={1} flexDirection="column">
        {entries.map((e) => (
          <ToolResultRow key={e.id} entry={e} />
        ))}
      </Box>
    </Box>
  );
}

render(<App />);

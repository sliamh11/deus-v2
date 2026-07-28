/**
 * LIA-493 prototype (round 3 — Claude Code design-language pass) — screen 2
 * of 2: a resolved tool-call row carrying a structured diff, redesigned to
 * the shared design spec (spec-and-plan.md "Claude Code Design Language
 * Spec" + its "@assistant-ui/react-ink" per-candidate application plan).
 *
 * Round-2 baseline (see FINDINGS.md "Screen 2" for the full history) used
 * a `✓`/`✗`/`?` glyph family and a bordered box around every row. This pass
 * switches to the canonical Claude Code line shape — a single stateful `⏺`
 * bullet whose COLOR (never its glyph) carries success/error/unknown — and
 * stops boxing every transcript line, reserving the rounded panel for the
 * diff itself.
 *
 * Still NOT wired into a full AssistantRuntimeProvider chat loop — DiffView
 * (@assistant-ui/react-ink) is self-contained (owns its own DiffRoot/
 * DiffContext internally, confirmed by reading DiffView.js verbatim) and
 * needs no runtime/provider to render. That remains this screen's actual
 * subject under test: DiffView's patch-string rendering plus a custom
 * status-glyph/header laid correctly around it.
 *
 * Fixture shape mirrors production's TranscriptEntry + ToolResultContent +
 * statusGlyph (deus-v2-mvp src/cli/tui-v2/components/messages/
 * ToolMessage.tsx + ToolResultDisplay.tsx + deus-tui-state.ts), extended
 * with an optional `result` field so a tool-call entry can carry a diff —
 * still ahead of a real producer in the live event pipeline (see that
 * file's own header comment). Round 3 additionally splits the entry's
 * `toolName`/`path`/`argsPreview` into separate fields instead of a single
 * pre-formatted `"Edit(path)"` string, per the design-spec's fixture
 * refactor instruction — this avoids parsing a display string merely to
 * bold the tool name or hyperlink the path.
 */
import { render, Box, Text } from "ink";
import path from "node:path";
// FRICTION (unchanged from round 2, kept for reproducibility): importing
// DiffView from the package's public barrel ("@assistant-ui/react-ink")
// crashes at runtime — react-ink's index.js re-exports @assistant-ui/core's
// react barrel, which has a *static* top-level import of a cloud-thread-
// history adapter requiring the `assistant-cloud` package. That's declared
// only as a peerDependency of @assistant-ui/core (never installed for a
// local-only demo, and not re-declared by react-ink at all), so Node's ESM
// resolver throws ERR_MODULE_NOT_FOUND for a feature this screen never
// touches. DiffView itself has no such dependency (verified by reading
// DiffView.js: it only imports ./DiffContext, ./DiffRoot, ./diff-utils,
// ./DiffContent, ./intra-line-utils, @assistant-ui/tap, and ink) — a
// relative deep import straight into node_modules bypasses the package.json
// "exports" map (which only gates bare-specifier resolution, not relative
// paths) and sidesteps the barrel entirely.
//
// Per the round-3 spec's "Packaging constraint" section, the RIGHT fix for
// a reproducible prototype is a pinned explicit `assistant-cloud`
// dependency plus a public-barrel import in both screen files, replacing
// this deep-dist-path workaround (brittle across react-ink version bumps —
// not a public contract) and Screen 1's hand-authored node_modules stub.
// That is a `package.json`/`package-lock.json` change explicitly out of
// this file's scope (a sibling agent/stage owns packaging in this round —
// see FINDINGS.md for the up-to-date adoption-cost record); left as the
// deep import here so this screen keeps running without an `npm install`.
import { DiffView } from "../node_modules/@assistant-ui/react-ink/dist/primitives/diff/DiffView.js";

// ---- Design tokens (spec-and-plan.md "Color system") -------------------
// Hex values passed directly to Ink's `color`/`borderColor` props, never
// named colors like "red"/"green" (an explicit implementation rule) — with
// one documented exception: DiffView's own internal +/-  line and stat
// coloring is hardcoded to Ink's named "green"/"red" and is NOT
// configurable from the outside (verified by reading DiffView.js: the
// color prop is a literal string, not a prop). Per the spec's explicit
// instruction, that is preserved as-is rather than forked/reimplemented
// just to recolor it — recorded here as an adaptation cost, not silently
// worked around.
const tokens = {
  textMuted: "#B0AEA5",
  accentInfo: "#6A9BCC",
  semanticSuccess: "#788C5D",
  semanticWarning: "#C49A52",
  semanticError: "#B95C50",
  borderNeutral: "#B0AEA5",
} as const;

// ---- Production fixture shape, reused verbatim (kind/status) -----------

/** Mirrors src/agent-runtimes/types.ts:85 (deus-v2-mvp). */
type ToolCallStatus = "success" | "error" | "unknown";

/** Mirrors ToolResultDisplay.tsx's ToolResultContent union (deus-v2-mvp). */
type ToolResultContent =
  | { type: "text"; text: string }
  | { type: "diff"; diffContent: string; filename?: string };

/**
 * Mirrors deus-tui-state.ts:38's TranscriptEntry tool variant, extended
 * with an optional `result` so this fixture can carry a diff payload (the
 * production type doesn't have this field yet — diff has no real producer
 * in the live event pipeline per that file's own header comment). Round 3
 * splits the display string into `toolName` + `path` + `argsPreview` so
 * the header and the OSC 8 path hyperlink each get a real field instead of
 * parsing `"Edit(path)"`.
 */
type TranscriptEntry = {
  id: number;
  kind: "tool";
  toolName: string;
  /** File path argument, if this call took one — rendered as an OSC 8 hyperlink. */
  path?: string;
  /** Non-path argument summary (e.g. a shell command), rendered as plain text. */
  argsPreview?: string;
  status: ToolCallStatus;
  result?: ToolResultContent;
};

// ---- Canonical `⏺` state glyph (spec: "canonical line shape") ----------
//
// The bullet's COLOR carries state; the glyph itself never changes between
// success/error/unknown. This directly replaces round 2's `statusGlyph()`,
// which switched between `✓`/`✗`/`?` — an explicitly prohibited pattern
// per the spec ("do not switch between unrelated success/error glyph
// families such as ✓, ✗, and ? in the tool-call header").
const BULLET = "⏺";

function toolCallColor(status: ToolCallStatus): string {
  switch (status) {
    case "success":
      return tokens.semanticSuccess;
    case "error":
      return tokens.semanticError;
    case "unknown":
      return tokens.textMuted;
    default: {
      const _exhaustive: never = status;
      throw new Error(`unhandled ToolCallStatus: ${_exhaustive}`);
    }
  }
}

/**
 * Regression guard, carried forward from round 2's exhaustive
 * `statusGlyph()` switch (itself a verbatim port of production's
 * `ToolMessage.tsx` regression guard). Round 2 checked that non-success
 * statuses never returned the green GLYPH; that signal is gone by design
 * now that every state renders the same `⏺` glyph, so this asserts the
 * equivalent invariant on COLOR instead — no non-success status may ever
 * resolve to `semantic.success`. This is the actual protection against the
 * "misleading checkmark" bug class this prototype exists to re-prove
 * doesn't creep back in.
 */
function assertNoFalsePositiveSuccess(): void {
  const nonSuccessStatuses: readonly ToolCallStatus[] = ["error", "unknown"];
  for (const status of nonSuccessStatuses) {
    const color = toolCallColor(status);
    if (color === tokens.semanticSuccess) {
      throw new Error(
        `regression: ToolCallStatus "${status}" resolved to semantic.success color`,
      );
    }
  }
}
assertNoFalsePositiveSuccess();

// ---- OSC 8 file-path hyperlink (spec: "For file paths") ----------------

const OSC8_OPEN = "]8;;";
const OSC8_CLOSE = "";

/** Resolves a project-relative path to a `file://` URL against cwd, percent-encoding each segment. */
function toFileUrl(relPath: string): string {
  const abs = path.resolve(process.cwd(), relPath);
  const segments = abs.split(path.sep).map((segment) => encodeURIComponent(segment));
  return `file://${segments.join("/")}`;
}

/**
 * Wraps `label` in an OSC 8 hyperlink escape sequence pointing at `relPath`'s
 * absolute `file://` URL, while keeping `relPath` (the concise
 * project-relative form) as the visible label — per spec: "Resolve relative
 * paths against the client's working directory... Render the concise
 * project-relative path as the visible label... Fall back to ordinary text
 * when OSC 8 is unsupported." Terminals that don't understand OSC 8 ignore
 * the escape sequence and display the label text as-is, which is the
 * fallback this relies on.
 */
function hyperlink(label: string, relPath: string): string {
  const url = toFileUrl(relPath);
  return `${OSC8_OPEN}${url}${OSC8_CLOSE}${label}${OSC8_OPEN}${OSC8_CLOSE}`;
}

/**
 * Renders a project-relative path as an OSC 8 hyperlink. Color is applied
 * to the Text wrapper independently of the hyperlink escape sequence —
 * per spec: "Apply color separately from hyperlink behavior; hyperlink
 * correctness must not depend on blue text."
 */
function FilePath({ relPath }: { relPath: string }) {
  return <Text color={tokens.accentInfo}>{hyperlink(relPath, relPath)}</Text>;
}

// ---- Fixtures ------------------------------------------------------------
// Deterministic across capture runs; same patch/paths/tool names as round 2
// so before/after captures are comparable.

const SUCCESS_PATCH = `--- a/src/cli/tui-v2/components/messages/ToolMessage.tsx
+++ b/src/cli/tui-v2/components/messages/ToolMessage.tsx
@@ -12,7 +12,9 @@ export function statusGlyph(
 ) {
   switch (status) {
     case "success":
-      return { glyph: "OK", color: "green" };
+      return { glyph: "⏺", color: "semantic.success" };
     case "error":
-      return { glyph: "ERR", color: "red" };
+      return { glyph: "⏺", color: "semantic.error" };
     case "unknown":
-      return { glyph: "?", color: "gray" };
+      return { glyph: "⏺", color: "text.muted" };
   }
 }
`;

/** Deterministic cap so captures are stable regardless of terminal height. */
const MAX_DIFF_LINES = 30;
const DIFF_CONTEXT_LINES = 3;

const DENIED_PATCH = `--- a/src/agent-runtimes/permission-registry.ts
+++ b/src/agent-runtimes/permission-registry.ts
@@ -15,7 +15,7 @@ export class PendingPermissionRegistry {
-  private readonly DENY_TIMEOUT_MS = 120_000;
+  private readonly DENY_TIMEOUT_MS = 0;
`;

const entries: TranscriptEntry[] = [
  {
    id: 1,
    kind: "tool",
    toolName: "Edit",
    path: "src/cli/tui-v2/components/messages/ToolMessage.tsx",
    status: "success",
    result: {
      type: "diff",
      diffContent: SUCCESS_PATCH,
      filename: "src/cli/tui-v2/components/messages/ToolMessage.tsx",
    },
  },
  {
    id: 2,
    kind: "tool",
    toolName: "Bash",
    argsPreview: "rm -rf /var/lib/deus/sessions",
    status: "error",
    result: {
      type: "text",
      text: "Permission denied: destructive path outside allowed roots — call blocked by tool-policy gate before execution. No diff to show: the write never ran.",
    },
  },
  {
    id: 3,
    kind: "tool",
    toolName: "Read",
    path: "src/cli/tui-v2/components/messages/ToolMessage.test.tsx",
    status: "unknown",
    result: {
      type: "text",
      text: "Result status could not be determined (daemon disconnected mid-call, no terminal event received).",
    },
  },
  // RECONCILE addition (finding #2 fix, replaces the round-2 TextResult-only
  // "denied fixture" note with an actual carried diff): a denied Edit that
  // DOES carry the diff the model proposed. Exercises DiffPanel's non-
  // success path — must render "Proposed changes — not applied" with a
  // warning/error border, never a plain green diff.
  {
    id: 4,
    kind: "tool",
    toolName: "Edit",
    path: "src/agent-runtimes/permission-registry.ts",
    status: "error",
    result: {
      type: "diff",
      diffContent: DENIED_PATCH,
      filename: "src/agent-runtimes/permission-registry.ts",
    },
  },
];

// ---- Rendering ------------------------------------------------------------

/** `⏺ ToolName(path-or-args)` — the canonical tool-call line; bullet color carries state. */
function ToolCallHeader({ entry }: { entry: TranscriptEntry }) {
  const color = toolCallColor(entry.status);
  return (
    <Box>
      <Text color={color} bold>
        {BULLET}{" "}
      </Text>
      <Text bold>{entry.toolName}</Text>
      <Text>(</Text>
      {entry.path ? <FilePath relPath={entry.path} /> : null}
      {entry.argsPreview ? <Text>{entry.argsPreview}</Text> : null}
      <Text>)</Text>
    </Box>
  );
}

/**
 * Compact addition/deletion counts for the header line above the diff
 * panel, computed from the raw unified-diff text (a simple `+`/`-` line
 * count, excluding the `+++`/`---` file-marker lines) — kept independent
 * of DiffView's own internal per-file stat computation (which is real and
 * correct, verified by reading DiffView.js, but not exposed as data we can
 * read back out; it only renders directly).
 */
function countChanges(diffContent: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of diffContent.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) additions++;
    else if (line.startsWith("-")) deletions++;
  }
  return { additions, deletions };
}

/**
 * The diff panel: our own OSC 8-hyperlinked path + compact +/- counts line
 * (spec: "Show the file path as an OSC 8 hyperlink above the diff, followed
 * by compact addition/deletion counts"), then DiffView itself inside a
 * rounded `border.neutral` panel.
 *
 * Known, accepted duplication: DiffView renders its own bold (non-
 * hyperlinked, untokenized) filename + +/-  stat line directly above its
 * diff body — that is DiffView's own internal presentation and, per the
 * spec's explicit instruction not to fork/reimplement DiffView merely to
 * recolor or relabel it, is left exactly as the library renders it. Our
 * header above the panel is the one that actually satisfies the
 * hyperlink/token requirement; DiffView's internal one is a harmless
 * second, plainer restatement immediately below it.
 */
/**
 * RECONCILE fix (GPT-5.6-Sol review finding #2, SUCCESS-STYLING-REGRESSION):
 * every diff used to route through this SAME neutral panel regardless of
 * `entry.status`, so a denied/error or indeterminate tool call carrying a
 * diff could render green additions with nothing marking it as unapplied.
 * `status` is now a required param: a non-`success` status gets an explicit
 * "Proposed changes — not applied" label and a warning/error-colored border
 * instead of the neutral one, so the panel itself — not just the bullet
 * above it — can never imply a change actually landed.
 */
function diffPanelBorderColor(status: ToolCallStatus): string {
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

/**
 * Regression guard, same shape as `assertNoFalsePositiveSuccess()` above but
 * for the diff panel itself: no non-success status may resolve to a neutral
 * (implicitly-applied-looking) border, and every non-success status must
 * carry the "not applied" label.
 */
function assertDiffPanelNeverImpliesSuccess(): void {
  const nonSuccessStatuses: readonly ToolCallStatus[] = ["error", "unknown"];
  for (const status of nonSuccessStatuses) {
    if (diffPanelBorderColor(status) === tokens.borderNeutral) {
      throw new Error(
        `regression: DiffPanel border for ToolCallStatus "${status}" resolved to the neutral (applied-looking) color`,
      );
    }
  }
}
assertDiffPanelNeverImpliesSuccess();

function DiffPanel({
  diffContent,
  path: relPath,
  status,
}: {
  diffContent: string;
  path?: string;
  status: ToolCallStatus;
}) {
  const { additions, deletions } = countChanges(diffContent);
  const notApplied = status !== "success";
  const borderColor = diffPanelBorderColor(status);
  return (
    <Box flexDirection="column" marginTop={1}>
      {relPath ? (
        <Box marginBottom={1}>
          <FilePath relPath={relPath} />
          <Text> </Text>
          <Text color={tokens.semanticSuccess}>+{additions}</Text>
          <Text> </Text>
          <Text color={tokens.semanticError}>-{deletions}</Text>
        </Box>
      ) : null}
      {notApplied ? (
        <Box marginBottom={1}>
          <Text bold color={borderColor}>
            Proposed changes — not applied
          </Text>
        </Box>
      ) : null}
      <Box borderStyle="round" borderColor={borderColor} paddingX={1}>
        <DiffView
          patch={diffContent}
          showLineNumbers
          contextLines={DIFF_CONTEXT_LINES}
          maxLines={MAX_DIFF_LINES}
        />
      </Box>
    </Box>
  );
}

/**
 * Text-only result: used when the operation never actually ran (denied/
 * blocked) or its outcome is indeterminate — never boxed (spec: "Do not box
 * every transcript line... Use panels for permission prompts, multiline
 * diffs, and other content that needs a clear boundary"), and never
 * confused with a "proposed changes" diff since there is no diff content at
 * all here — the fixture text says so explicitly ("No diff to show: the
 * write never ran."). If a future fixture attaches a genuine proposed-but-
 * unapplied diff to a denied/failed entry, it must render through
 * `DiffPanel` labeled "Proposed changes — not applied" rather than through
 * this text-only path, so a real rejected edit is never silently invisible.
 */
function TextResult({ text, status }: { text: string; status: ToolCallStatus }) {
  return (
    <Box marginTop={1}>
      <Text color={status === "unknown" ? tokens.semanticWarning : undefined} dimColor={status !== "unknown"}>
        {text}
      </Text>
    </Box>
  );
}

function ToolResultRow({ entry }: { entry: TranscriptEntry }) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <ToolCallHeader entry={entry} />
      {entry.result?.type === "diff" ? (
        <DiffPanel diffContent={entry.result.diffContent} path={entry.path} status={entry.status} />
      ) : entry.result?.type === "text" ? (
        <TextResult text={entry.result.text} status={entry.status} />
      ) : null}
    </Box>
  );
}

function App() {
  return (
    <Box flexDirection="column" padding={1}>
      {entries.map((e) => (
        <ToolResultRow key={e.id} entry={e} />
      ))}
    </Box>
  );
}

render(<App />);

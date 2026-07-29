// LIA-496 IB2 (I6/I10) — single source of truth for "how many lines of a
// tool-call's output are we willing to show before capping it", shared by
// three call sites that would otherwise duplicate the same two numbers and
// the same "which tool parts are capped" question:
//   - `components/Messages.tsx`'s `BashLine` — the live/committed renderer
//     for Bash (and any other non-`Edit`/`delete_file`) tool-call output.
//   - `components/DiffPanel.tsx` — the `Edit`-tool diff renderer.
//   - `committedBlocks.tsx` — the `<Static>` commit gate.
//
// Why `committedBlocks.tsx` needs this too (found live during this batch's
// own verification, not assumed): `<Static>` commits a tool-call PART the
// instant that part's own `status` settles (IB1's part-granularity commit
// fix) — and this fixture's tool RESULTS aren't incrementally streamed,
// they resolve in one atomic yield, so a capped BashLine/DiffPanel
// instance's `useInput`-driven ctrl+o handler would get unmounted by
// `<Static>` within a single React tick of first appearing, before any
// human could plausibly react. `committedBlocks.tsx`'s commit loop imports
// `isCappedToolPart` to hold such a part live a little longer — through the
// REST of that message's own streaming — giving the same realistic window
// a live terminal session actually has, instead of an unmountable
// microsecond one. See that file's header comment for the full mechanism.
export const OUTPUT_LINE_CAP = 5;
export const DIFF_LINE_CAP = 30;

type CappableToolPart = {
  type: string;
  toolName?: string;
  result?: unknown;
};

// Structural, not stateful: true whenever a part's OWN result content is
// long enough that `BashLine`/`DiffPanel` would render it collapsed by
// default — independent of whether any component instance is currently
// mounted to show that. This is what lets `committedBlocks.tsx` make a
// commit-timing decision without needing any React-state registry shared
// across unrelated modules.
export function isCappedToolPart(part: CappableToolPart | undefined): boolean {
  if (!part || part.type !== "tool-call" || part.result === undefined) return false;
  if (part.toolName === "Edit") {
    const diffContent = (part.result as { diffContent?: string } | undefined)?.diffContent ?? "";
    return diffContent.split("\n").length > DIFF_LINE_CAP;
  }
  // `delete_file` renders through `PermissionPrompt`, which has no
  // collapse/expand affordance at all — never treat it as capped.
  if (part.toolName === "delete_file") return false;
  return String(part.result).split("\n").length > OUTPUT_LINE_CAP;
}

// LIA-496 — semantic status KEYS only. This is the "tokens.ts lesson"
// module: LIA-495's runtime/tokens.ts held real presentation values — CSS
// custom-property reference strings, one per semantic role — and
// runtime/statusColor.ts + runtime/diffStatus.ts consumed them directly,
// so a byte-identical port of those two files would have smuggled that
// same presentation syntax into `shared/` — exactly what this repo's
// purity gate exists to catch, and exactly what the plan's runtime/UI
// boundary forbids ("shared/ contains zero presentation values").
//
// The fix: shared/ classifies status into a small closed set of semantic
// KEYS. Each target (web-app/theme.css, ink-app/theme.ts) owns its own
// key -> real-color mapping. Nothing in this file, or anything that
// imports it, may contain a color literal, a CSS custom-property
// reference, or a theme name.
export type StatusKey = "accent" | "ok" | "warn" | "err" | "dim";

// ---------------------------------------------------------------------------
// diffStatus.ts's ToolCallStatus -> border semantics, ported from LIA-495's
// runtime/diffStatus.ts's diffPanelBorderColor but re-targeted at StatusKey
// instead of `tokens.borderNeutral` / `tokens.semanticError` /
// `tokens.semanticWarning` CSS-var strings. Same mapping, same
// exhaustiveness self-check, semantic-key output instead of a color.
// ---------------------------------------------------------------------------
export type ToolCallStatus = "success" | "error" | "unknown";

export function diffPanelBorderStatus(status: ToolCallStatus): StatusKey {
  switch (status) {
    case "success":
      return "dim";
    case "error":
      return "err";
    case "unknown":
      return "warn";
    default: {
      const _exhaustive: never = status;
      throw new Error(`unhandled ToolCallStatus: ${_exhaustive}`);
    }
  }
}

function assertDiffPanelNeverImpliesSuccess(): void {
  const nonSuccessStatuses: readonly ToolCallStatus[] = ["error", "unknown"];
  for (const status of nonSuccessStatuses) {
    if (diffPanelBorderStatus(status) === "dim") {
      throw new Error(
        `regression: DiffPanel border for ToolCallStatus "${status}" resolved to the neutral status key`,
      );
    }
  }
}
assertDiffPanelNeverImpliesSuccess();

// ---------------------------------------------------------------------------
// statusColor.ts's liveBulletColor, ported the same way: pending/error ->
// semantic key, not a color.
// ---------------------------------------------------------------------------
export function liveBulletStatus(pending: boolean, isError: boolean): StatusKey {
  if (pending) return "dim";
  return isError ? "err" : "ok";
}

// ---------------------------------------------------------------------------
// Shell/thread status, generalized from LIA-495's runtime/hooks.ts
// useShellStatus classification (which returned "idle" | "working" |
// "awaiting approval" strings straight to the UI). Kept as semantic keys
// here too so both targets can decide independently how "working" reads
// (spinner glyph + accent color on web, rotating gerund + amber dot on
// Ink) from the same classification.
// ---------------------------------------------------------------------------
export type ShellStatus = "idle" | "working" | "awaiting-approval";

export function shellStatusKey(status: ShellStatus): StatusKey {
  switch (status) {
    case "idle":
      return "dim";
    case "working":
      return "accent";
    case "awaiting-approval":
      return "warn";
    default: {
      const _exhaustive: never = status;
      throw new Error(`unhandled ShellStatus: ${_exhaustive}`);
    }
  }
}

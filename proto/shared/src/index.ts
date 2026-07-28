// LIA-496 shared package entrypoint. Target-neutral runtime for both
// "Reading Room" (web) and "Transcript" (Ink) — see AGENTS notes in each
// module for the "tokens.ts lesson" this package is built to avoid
// repeating: zero presentation values live here, only semantic status
// keys, data, and runtime logic. Each app imports what it needs directly
// from the specific module rather than a single flat re-export, but this
// file exists as the documented, typechecked public surface.
export { getFixtureAdapter, resetFixtureAdapters } from "./adapter";
export { fixtureThreadListAdapter, resetFixtureThreads, knownThreadIds } from "./threadList";
export { useHasListError, simulateNextListError } from "./listStatus";
export { createHistoryAdapter, deleteHistoryFor, resetAllHistory } from "./history";
export {
  PERMISSION_OPTIONS,
  decisionFromOptionId,
  performDelete,
  executionOutcomes,
  permissionKey,
  hasGrant,
  grant,
  clearGrants,
  type PermissionDecision,
  type PermissionKey,
} from "./permissions";
export {
  diffPanelBorderStatus,
  liveBulletStatus,
  shellStatusKey,
  type StatusKey,
  type ToolCallStatus,
  type ShellStatus,
} from "./status";
export {
  highlightToHtml,
  highlightToTokens,
  ensureThemeLoaded,
  ensureLanguageLoaded,
} from "./highlight";
export { SEED_THREADS, type SeedThread } from "./fixtures/threads";
export { extractPath } from "./util";
export { existsSync, writeFileSync, rmSync } from "./virtualFs";
// diffStatus.ts's `ToolCallStatus`/`diffPanelBorderStatus` are the same
// symbols re-exported from ./status above (see that file's header comment
// on why) — only `countChanges` is unique to this module.
export { countChanges } from "./diffStatus";
export type { EditDiffResult, ThreadScript, ResolvedApproval } from "./stream";

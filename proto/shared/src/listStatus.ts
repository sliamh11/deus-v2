// LIA-496 — code-review fix (REVISE round): a genuinely observable error
// state for the seeded thread list's `list()` call.
//
// `@assistant-ui/core`'s `RemoteThreadListThreadListRuntimeCore` swallows a
// `list()`-load rejection internally (confirmed by reading
// `RemoteThreadListThreadListRuntimeCore.tsx`'s own `getLoadThreadsPromise`
// directly: a thrown error is caught, logged via `console.error`, and
// `isLoading` is reset to `false` — with NO reactive error field anywhere on
// `ThreadsState`, confirmed against `store/scopes/threads.d.ts`'s full
// field list). That means a genuine `list()`-load failure is PERMANENTLY
// INDISTINGUISHABLE from "loaded successfully, zero threads" through
// `useAuiState` alone — there is no library-provided lever to drive a real
// error UI state from.
//
// This tiny external store (the same `useSyncExternalStore` pattern
// `ink-app/src/freshDraftTracker.ts` already uses, for the identical reason
// — bypassing a reactive gap the library itself doesn't cover) is
// `fixtureThreadListAdapter`'s OWN record of whether its last `list()` call
// actually threw, kept independently of the library's own
// (silently-discarded) rejection.
import { useSyncExternalStore } from "react";

let hasError = false;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

export function markListError(): void {
  if (hasError) return;
  hasError = true;
  notify();
}

export function clearListError(): void {
  if (!hasError) return;
  hasError = false;
  notify();
}

function subscribe(callback: () => void): () => void {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

export function useHasListError(): boolean {
  return useSyncExternalStore(subscribe, () => hasError);
}

// Exposed for the headless verification script (and any manual repro) to
// force the NEXT `list()` call to genuinely throw — the same "honest
// fakes" pattern `fixtures/conversations.ts`'s `theme-swap-crash` script
// already uses to make `ErrorState.tsx` testable: a REAL thrown `Error`,
// not a scripted UI prop. Auto-resets after one use (so a `reload()`
// retry can genuinely recover, matching real backend behavior — an error
// is not necessarily permanent). Never triggered by the adapter or any UI
// on its own.
let forceNextListFailure = false;

export function simulateNextListError(): void {
  forceNextListFailure = true;
}

export function consumeForcedListFailure(): boolean {
  if (!forceNextListFailure) return false;
  forceNextListFailure = false;
  return true;
}

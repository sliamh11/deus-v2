// LIA-496 — code-review fix (REVISE round): `ctrl+n`'s message pane not
// rebinding.
//
// Root-caused by LIVE reproduction (real tmux pty, not re-derived from
// reading library source — the exact mistake that produced the original
// false "ctrl+n verified working" claim): `@assistant-ui/react-ink`'s
// singular `s.thread` scope (and everything downstream of it —
// `ThreadPrimitive.Empty`/`.Messages`, `useAuiState((s) => s.thread...)`)
// is built via `@assistant-ui/store`'s `Derived()` + `useClientResource()`,
// which read the active thread's state through a proxy backed by a ref
// that is not always current with the freshest render (confirmed directly:
// `useAuiState((s) => s.thread.messages.length)` kept returning a PRIOR
// thread's exact message count/content on specific rapid
// `switchToNewThread()`→send→`switchToThread()`→`switchToNewThread()`
// sequences, persisting indefinitely — not a one-tick lag — until another
// switch occurred). By contrast `s.threads.mainThreadId` (a sibling scope
// that is NOT routed through `Derived()`) was reactively correct in every
// one of ~10 independent live reproductions. Two targeted upstream patches
// (in `@assistant-ui/core`'s `ShallowMemoizeSubject` and
// `@assistant-ui/store`'s `useClientResource`) were tried and DISPROVEN
// live before landing on this workaround — see the LIA-496 session log for
// the full trace; both were reverted rather than shipped unverified.
//
// Workaround: don't trust `s.thread`/`ThreadPrimitive.*` for "is the
// current thread empty" AT ALL for a thread this session itself just
// minted via `switchToNewThread()` — we already KNOW, by construction
// (`generateId()` uniqueness, confirmed in
// `node_modules/@assistant-ui/core/.../RemoteThreadListThreadListRuntimeCore.tsx`),
// that a brand-new local id has zero messages the instant it's created.
// This tiny external store (plain `Set` + subscribers, using React's own
// un-wrapped `useSyncExternalStore` — deliberately bypassing every
// assistant-ui reactive layer implicated above) tracks that fact
// independently: `markFreshDraft` is called once `switchToNewThread()`
// resolves (`Sidebar.tsx`'s `ctrl+n`/`ThreadListPrimitive.New` handler);
// `clearFreshDraft` is called the moment that thread's OWN adapter
// actually runs a turn (`useThreadRuntime` below, App.tsx) — i.e. the
// instant real content needs to start rendering for it, at which point we
// hand back off to the normal primitives.
import { useSyncExternalStore } from "react";

const freshDraftIds = new Set<string>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

export function markFreshDraft(id: string): void {
  if (freshDraftIds.has(id)) return;
  freshDraftIds.add(id);
  notify();
}

export function clearFreshDraft(id: string): void {
  if (!freshDraftIds.delete(id)) return;
  notify();
}

function subscribe(callback: () => void): () => void {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

export function useIsFreshDraft(id: string | undefined): boolean {
  return useSyncExternalStore(
    subscribe,
    () => (id !== undefined ? freshDraftIds.has(id) : false),
  );
}

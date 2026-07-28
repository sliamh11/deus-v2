// LIA-496 — FixtureThreadListAdapter: a real implementation of
// @assistant-ui/core's RemoteThreadListAdapter (verified directly against
// node_modules/@assistant-ui/core/dist/runtimes/remote-thread-list/
// types.d.ts — not the no-op InMemoryThreadListAdapter shape reference),
// backed by an in-memory Map seeded from fixtures/threads.ts.
// list/rename/archive/unarchive/delete are genuinely working mutations on
// that Map; initialize registers new threads.
import type {
  RemoteThreadListAdapter,
  RemoteThreadListPageOptions,
  RemoteThreadListResponse,
  RemoteThreadMetadata,
  RemoteThreadInitializeResponse,
} from "@assistant-ui/core";
// The "/react" subpath below is part of the target-neutral core package
// itself (its `exports` map has "."/"./internal"/"./store"/"./store/
// internal"/"./react" — confirmed by reading package.json directly, S0),
// a DIFFERENT npm package from the DOM-target React binding one target-
// specific web code depends on. `createSimpleTitleAdapter` (only
// reachable via this subpath — it isn't on the package root) and
// `RuntimeAdapterProvider` both live here, built on plain `react`
// (context/hooks only, no DOM), which is why they're safe for shared/ to
// depend on. This import string is short enough that scripts/
// check-shared-purity.sh's forbidden-package substring check does not
// match it, intentionally — see that script's own comment so a future
// edit doesn't "fix" it into a false positive.
import { createSimpleTitleAdapter, RuntimeAdapterProvider, type RuntimeAdapters } from "@assistant-ui/core/react";
import { createAssistantStream, type AssistantStream } from "assistant-stream";
import { useAui } from "@assistant-ui/store";
import { type FC, type PropsWithChildren, createElement, useMemo } from "react";
import { SEED_THREADS } from "./fixtures/threads";
import { createHistoryAdapter, deleteHistoryFor } from "./history";
import { clearListError, consumeForcedListFailure, markListError } from "./listStatus";

type MutableThreadRecord = {
  remoteId: string;
  externalId?: string | undefined;
  title: string;
  lastMessageAt: Date;
  status: "regular" | "archived";
};

function toMetadata(record: MutableThreadRecord): RemoteThreadMetadata {
  return {
    status: record.status,
    remoteId: record.remoteId,
    externalId: record.externalId,
    title: record.title,
    lastMessageAt: record.lastMessageAt,
  };
}

// Seeded once at module load — every consumer of this module (both
// targets, and the headless verification script) shares the same 7
// threads for the lifetime of the process, matching a real backend's
// "list already has data on first load" behavior rather than an empty
// InMemoryThreadListAdapter.
const store = new Map<string, MutableThreadRecord>(
  SEED_THREADS.map((seed) => [
    seed.id,
    { remoteId: seed.id, title: seed.title, lastMessageAt: seed.lastMessageAt, status: "regular" },
  ]),
);

let newThreadCounter = 0;

const titleAdapter = createSimpleTitleAdapter();

// unstable_Provider — see history.ts's header comment for the mechanism
// this depends on (useAui() reading the ThreadListItemRuntimeProvider
// scope this Provider is mounted inside, per-active-thread).
//
// BUILD-stage fix (S2B, ink target): written as `createElement(...)`, not
// JSX. Confirmed by actually running `npx tsx src/main.tsx` (not just
// `tsc --noEmit`, which never caught this — it's a runtime-only failure):
// the ORIGINAL `<RuntimeAdapterProvider ...>` JSX line crashed with "React
// is not defined" the moment a thread first mounted. Root cause, isolated
// by testing which files DID vs did NOT hit this: `tsx`'s esbuild-based
// transform resolves this file via its `@lia496/shared` node_modules
// symlink and does not pick up shared/tsconfig.json's `"jsx":
// "react-jsx"` for that resolved path, falling back to esbuild's default
// (classic) JSX transform, which compiles to `React.createElement` and
// needs a `React` global this file never imported — ink-app's OWN
// `.tsx` files (App.tsx, Sidebar.tsx, etc.) rendered fine first, only
// shared/src's JSX broke, confirming the transform-mode gap is specific to
// this cross-package resolution path, not a general JSX misconfiguration.
// `createElement` sidesteps the whole classic-vs-automatic ambiguity
// (works identically under any bundler/loader, including web-app's Vite,
// which was never actually affected by this — Vite's dev pipeline handles
// the automatic runtime across workspace links correctly) rather than
// papering over one environment with a `React` import that `tsc
// --noEmit`'s `noUnusedLocals` would then flag as dead under the
// automatic-runtime tsconfig this package actually declares.
const Provider: FC<PropsWithChildren> = ({ children }) => {
  const aui = useAui();
  const remoteId = aui.threadListItem.getState().remoteId;
  const history = useMemo(() => createHistoryAdapter(remoteId ?? "unknown-thread"), [remoteId]);
  const adapters: RuntimeAdapters = useMemo(() => ({ history }), [history]);
  return createElement(RuntimeAdapterProvider, { adapters, children });
};

export const fixtureThreadListAdapter: RemoteThreadListAdapter = {
  async list(_params?: RemoteThreadListPageOptions): Promise<RemoteThreadListResponse> {
    // Seeded 250ms latency (§ Feature scope, "Honest fakes"): the
    // mechanism (an async adapter call the runtime awaits before
    // rendering the list) is real; only the delay is manufactured, so the
    // loading state is actually observable instead of resolving on the
    // same tick.
    await new Promise((resolve) => setTimeout(resolve, 250));
    // Code-review fix (LIA-496 REVISE round) — see listStatus.ts's header
    // comment for the full mechanism/rationale. A real thrown Error, only
    // triggered on request (never spontaneously), so the "error" leg of
    // the plan's "empty/loading/error" triad is genuinely testable rather
    // than silently unimplemented.
    if (consumeForcedListFailure()) {
      markListError();
      throw new Error("fixtureThreadListAdapter.list: simulated failure (loading/error-state verification)");
    }
    clearListError();
    return { threads: [...store.values()].map(toMetadata) };
  },

  async rename(remoteId: string, newTitle: string): Promise<void> {
    const record = store.get(remoteId);
    if (!record) throw new Error(`fixtureThreadListAdapter.rename: unknown thread "${remoteId}"`);
    record.title = newTitle;
  },

  async archive(remoteId: string): Promise<void> {
    const record = store.get(remoteId);
    if (!record) throw new Error(`fixtureThreadListAdapter.archive: unknown thread "${remoteId}"`);
    record.status = "archived";
  },

  async unarchive(remoteId: string): Promise<void> {
    const record = store.get(remoteId);
    if (!record) throw new Error(`fixtureThreadListAdapter.unarchive: unknown thread "${remoteId}"`);
    record.status = "regular";
  },

  async delete(remoteId: string): Promise<void> {
    if (!store.delete(remoteId)) {
      throw new Error(`fixtureThreadListAdapter.delete: unknown thread "${remoteId}"`);
    }
    deleteHistoryFor(remoteId);
  },

  async initialize(threadId: string): Promise<RemoteThreadInitializeResponse> {
    // A brand-new, not-previously-seeded thread the user just started.
    // Reuse the local threadId as the remoteId — this fixture has no
    // separate backend id space — and register it so `list()` shows it
    // from here on.
    newThreadCounter += 1;
    if (!store.has(threadId)) {
      store.set(threadId, {
        remoteId: threadId,
        title: `New thread ${newThreadCounter}`,
        lastMessageAt: new Date(),
        status: "regular",
      });
    }
    return { remoteId: threadId };
  },

  async generateTitle(_remoteId: string, unstable_messages): Promise<AssistantStream> {
    // TitleGenerationAdapter.generateTitle(messages): Promise<string> does
    // NOT satisfy RemoteThreadListAdapter.generateTitle's
    // Promise<AssistantStream> return directly (wrong arity, wrong return
    // type) — confirmed by reading both types.ts's non-optional member
    // list and TitleGenerationAdapter.d.ts during S0/plan-review. The
    // real bridge, matching @assistant-ui/core's own
    // LocalStorageThreadListAdapter pattern: get the string from the
    // title adapter, then wrap it in a stream that emits it as one text
    // delta. Streaming (growing) titles stay Stretch-tier; this is the
    // Must-tier synchronous-content-in-a-stream-wrapper.
    const title = await titleAdapter.generateTitle(unstable_messages);
    return createAssistantStream((controller) => {
      controller.appendText(title);
    });
  },

  async fetch(threadId: string): Promise<RemoteThreadMetadata> {
    const record = store.get(threadId);
    if (!record) throw new Error(`fixtureThreadListAdapter.fetch: unknown thread "${threadId}"`);
    return toMetadata(record);
  },

  unstable_Provider: Provider,
};

// Exposed for the headless verification script (and a future "reset
// session" affordance) so seeded state can be inspected/restored without
// restarting the process. Never called by the adapter itself.
export function resetFixtureThreads(): void {
  store.clear();
  for (const seed of SEED_THREADS) {
    store.set(seed.id, {
      remoteId: seed.id,
      title: seed.title,
      lastMessageAt: seed.lastMessageAt,
      status: "regular",
    });
  }
  newThreadCounter = 0;
}

export function knownThreadIds(): readonly string[] {
  return [...store.keys()];
}

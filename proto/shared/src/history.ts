// LIA-496 — per-thread ThreadHistoryAdapter, in-memory. This is the piece
// that makes "switch away and back preserves live-created messages within
// the session" real: each seeded/created thread gets its OWN message
// list, keyed by remoteId, that `load()` returns and `append`/`update`
// grow — not a single shared buffer that would bleed messages between
// threads.
//
// Wiring confirmed by reading
// node_modules/@assistant-ui/core/src/react/runtimes/cloud/
// useCloudThreadListAdapter.tsx and AssistantCloudThreadHistoryAdapter.ts
// directly (S0): `unstable_Provider` is mounted per-active-thread INSIDE
// `ThreadListItemRuntimeProvider`, so a Provider component nested there can
// call `useAui()` with no arguments to read the ALREADY-registered
// `threadListItem` scope and pull `remoteId` off it — that's how the cloud
// adapter's own history-provider knows which thread it's building history
// for despite `unstable_Provider`'s type having no threadId prop. Same
// mechanism here, just backed by this module's Map instead of a real
// cloud call.
import type {
  ExportedMessageRepository,
  ExportedMessageRepositoryItem,
  ThreadHistoryAdapter,
} from "@assistant-ui/core";

const stores = new Map<string, ExportedMessageRepositoryItem[]>();

export function createHistoryAdapter(threadId: string): ThreadHistoryAdapter {
  return {
    async load(): Promise<ExportedMessageRepository> {
      const messages = stores.get(threadId) ?? [];
      // headId intentionally omitted: ExportedMessageRepository.import()
      // falls back to `messages.at(-1)?.message.id` when absent, which is
      // correct here since `append`/`update` always keep this array in
      // append order.
      return { messages };
    },
    async append(item: ExportedMessageRepositoryItem): Promise<void> {
      const list = stores.get(threadId) ?? [];
      list.push(item);
      stores.set(threadId, list);
    },
    async update(item: ExportedMessageRepositoryItem): Promise<void> {
      const list = stores.get(threadId) ?? [];
      const index = list.findIndex((existing) => existing.message.id === item.message.id);
      if (index === -1) {
        // An update for an id whose earlier `append` failed/raced — treat
        // as an upsert, per this method's own doc comment in
        // @assistant-ui/core's ThreadHistoryAdapter type.
        list.push(item);
      } else {
        list[index] = item;
      }
      stores.set(threadId, list);
    },
  };
}

// Called by threadList.ts's `delete(remoteId)` so a deleted thread's
// history doesn't linger as an orphaned entry for the rest of the
// session.
export function deleteHistoryFor(threadId: string): void {
  stores.delete(threadId);
}

// Exposed for the headless verification script.
export function resetAllHistory(): void {
  stores.clear();
}

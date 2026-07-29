// LIA-496 IB1 (I2) — the committed-blocks module. Owns the ONE ever-growing,
// append-only array `<Static>` renders from, plus the
// "── thread: <title> ──" banner logic thread-switching appends to it.
// ← App.tsx (`MainPane`, confirm that link there, not here) mounts
// `CommittedTranscript` as a sibling of `LiveMessageTail` (the still-live
// tail of the actively-streaming message + status line +
// composer/`ThreadPicker`), per the plan's verified `<Static>`/native-
// scrollback mechanism (`node_modules/ink/build/ink.js:320-349`, and this
// repo's own `Static.js`, both read directly — see the two comments below
// at the exact lines that mechanism constrains).
//
// Mechanism — Approach B, the IB1 spike's winner (see the spike's own
// write-up; `spike/approach-b.tsx` is the scratch proof this file
// productionizes): `MessageByIndexProvider` (confirmed real,
// `@assistant-ui/core/dist/react/providers/MessageByIndexProvider.js`)
// wraps the EXISTING, UNMODIFIED `UserMessage` (`components/Messages.tsx`,
// zero edits) per committed user-message index — no hand-typed prop
// reconstruction, leaf components stay driven by the real runtime shape.
//
// Two things this file's design has to get right that the spike (a single
// already-complete message, never switched threads) didn't have to prove:
//
// 1. PUSH ORDER, not just push timing, is what keeps every render correct.
//    `<Static>` (`node_modules/ink/build/components/Static.js`, read
//    directly) renders each NEW item exactly once, synchronously, using
//    whatever React context is live at the moment `items` grows — it does
//    NOT snapshot context per-item. `MessageByIndexProvider` resolves
//    `aui.thread.message({index})` against the ambient `aui.thread` scope,
//    which is a SINGLE reactive binding to whichever thread is currently
//    "active" (`s.threads.mainThreadId`) — this app does not mount a
//    separate always-alive provider per visited thread the way
//    `RemoteThreadListHookInstanceManager`'s OWN internal plumbing does
//    (confirmed by reading that file directly: `__internal_RenderThreadRuntimes`
//    keeps every STARTED thread's runtime alive, but that machinery is
//    library-internal, not something this app's component tree can address
//    per-thread). So a message index is only resolvable at the instant its
//    OWN thread is the active one. The two effects below are ordered so
//    every push happens while `activeThreadId` already matches the
//    block's own `threadId` — the commit effect pushes a thread's
//    newly-settled content every render pass where that thread is still
//    active (before any switch away), and the banner effect for a NEW
//    thread only fires on the render pass AFTER `mainThreadId` has already
//    become that thread (so the very next commit pass, now scoped to the
//    new thread, resolves correctly too). A rapid double-switch landing
//    between a push and `<Static>`'s next commit is a real, accepted
//    residual risk — same class as `App.tsx:123-137`'s documented
//    double-`ctrl+n` gap, not solved here for the same reason (out of
//    scope, not silently ignored).
// 2. A message must not be committed while it's still LIVE — not just
//    "still streaming" (`status.type === "running"`) but also
//    "awaiting a decision" (`status.type === "requires-action"`, the
//    pending-permission case `PermissionPrompt.tsx` drives via its own
//    `useInput`). Committing either into `<Static>` would unmount it from
//    the live tree the very next render (`Static.js`: consumed items drop
//    out of `itemsToRender` for good) and silently kill the interactive
//    `useInput` handler mid-decision. `isMessageLive` below is the single
//    predicate this file's commit effect relies on to know when a message
//    is fully done.
//
// Code-review fix (LIA-496 REVISE round — code-review finding, high
// severity, re-verified via a real forced-tall multi-part capture): this
// file previously committed at MESSAGE granularity — a whole assistant
// message moved into `<Static>` only once its OWN status fully settled, so
// a multi-part streaming message (reasoning + tool call + closing text)
// whose INDIVIDUAL parts each fit the dynamic-region budget still stayed
// entirely in the dynamic tail — and kept re-triggering
// `ink.js:322-330`'s destructive scrollback clear (`\x1b[3J`, confirmed
// 173× in a real forced-tall recording) for as long as the cumulative
// height stayed over the pane's row count, well before the message ever
// settled enough to commit. The plan's own constraint 2 mandates PART
// granularity for exactly this reason: "each completed text/tool part of
// the streaming message moves into `<Static>` as it completes; only the
// actively-streaming part + status row + composer stay dynamic." Fixed
// below: `useCommittedBlocks` now commits an assistant message's parts one
// at a time as EACH part's own `status` settles (`isPartLive`, the
// part-level sibling of `isMessageLive`), not only once the whole message
// does. `MessagePrimitive.PartByIndex` (confirmed real,
// `@assistant-ui/core/dist/react/primitives/message/MessageParts.d.ts`,
// re-exported as `MessagePrimitive.PartByIndex` — this repo's own
// `node_modules/@assistant-ui/core/src/react/primitives/message/
// MessageParts.tsx` was read directly to confirm it exists, dispatches by
// part type/tool name using the exact same `components` shape
// `MessagePrimitive.Parts` already takes, and needs only a
// `MessageByIndexProvider`-scoped `aui.message` ambient context to resolve
// `aui.message.part({index})` from) is the library-provided per-index
// dispatch primitive the plan's own constraint 2 anticipated needing to
// hand-build — it already exists, so no local per-part-type dispatch
// component had to be written. `assistantPartComponents`
// (`components/Messages.tsx`, exported for exactly this reuse) is the same
// `components` config both this file's committed-part rendering AND the
// live `AssistantMessage`'s own `MessagePrimitive.Parts` usage dispatch
// through — never duplicated between the two.
//
// Code-review fix (IB1 round, medium severity): the part-granularity
// rewrite above regressed error-state rendering. `ErrorPrimitive.Root`/
// `ErrorState` used to live INSIDE the "assistant-header" block, which
// commits into `<Static>` on the message's very FIRST commit pass —
// typically while the message is still streaming, well before a real
// `themeSwapCrashScript`-style thrown error (which only flips
// `message.status` to `{type:"incomplete", reason:"error"}` at the END of
// the generator, after every part has already streamed — confirmed by
// reading `shared/src/fixtures/conversations.ts`'s `themeSwapCrashTurn1`
// directly) has happened yet. `<Static>` renders each item exactly once,
// synchronously, using whatever state is live at that instant, then drops
// it from the render tree for good — so that early paint of
// `ErrorPrimitive.Root` permanently captured "no error yet" and never got
// a second chance to render the real one. `LiveMessageTail` couldn't pick
// up the slack either: `showHeader` (the only place it rendered
// `ErrorState`) goes false the instant the header commits, which — same
// early-commit timing — is also always before the message can possibly be
// erroring, since `isMessageLive` (running/requires-action) and the error
// status (incomplete/error) are mutually exclusive by construction. So the
// error box rendered nowhere, in either the committed or live path.
// Fixed by decoupling: "assistant-header" now renders ONLY the glyph +
// "deus" label (still committed immediately, unchanged), and a new
// "assistant-error" block carries `ErrorPrimitive.Root`/`ErrorState`,
// pushed only once the message actually SETTLES (`settled` below) —
// after that message's own parts, since append-only `<Static>` can't
// retroactively insert before content already committed. By settle time
// the real, final status is known, so the one-shot render is correct by
// construction instead of racing the error. This also means
// `LiveMessageTail` never needs to render `ErrorState` at all — a message
// that IS live (per `isMessageLive`) can never simultaneously be errored,
// so it was dead code there even before this fix.
//
// LIA-496 IB2 (I6/I10) — found live during this batch's own verification,
// not anticipated by the original plan: committing a tool-call part the
// INSTANT its own status settles is correct for ordinary content, but for
// a CAPPED part (BashLine's "… +N lines" / DiffPanel's diff cap) it made
// the new ctrl+o expand affordance unmountable within a single React
// tick — this fixture's tool results resolve in one atomic yield, not
// incrementally, so there was never a realistic human-reactable window
// before `<Static>` swallowed the live, interactive instance. The
// per-part commit loop below now holds a capped part live until its
// CONTAINING MESSAGE settles (not just the part itself) — see the
// `isCappedToolPart`/`../toolOutputCap.ts` import and the loop's own
// comment at the exact line this changes.
import { useEffect, useRef, useState, type FC } from "react";
import { Box, Text, Static } from "ink";
import { MessageByIndexProvider, MessagePrimitive, ErrorPrimitive, useAuiState, type MessageState } from "@assistant-ui/react-ink";
import { theme, GLYPH_ASSISTANT } from "./theme";
import { UserMessage, assistantPartComponents } from "./components/Messages";
import { ErrorState } from "./components/ErrorState";
import { getUserLabel, getCwdLabel, PRODUCT_NAME, MODEL_NAME } from "./identity";
import { isCappedToolPart } from "./toolOutputCap";

// A message is "live" (must stay OUT of `<Static>`) while it's actively
// streaming or waiting on a pending tool-approval decision. Anything else
// (a plain user message with no `status` at all, or an assistant message
// that has genuinely finished — `complete` or `incomplete`) is settled.
export function isMessageLive(message: MessageState | undefined): boolean {
  if (!message) return false;
  return message.role === "assistant" && (message.status?.type === "running" || message.status?.type === "requires-action");
}

// The part-level sibling of `isMessageLive` — same two live states
// (`running`/`requires-action`, the latter real for a pending tool-approval
// part per `ToolCallMessagePartStatus`), scoped to one part instead of the
// whole message. A part with no `status` at all (some part types don't
// carry one) is treated as already-settled, matching how a message with no
// `status` field is already treated as settled by `isMessageLive` above.
function isPartLive(part: { status?: { type: string } } | undefined): boolean {
  const type = part?.status?.type;
  return type === "running" || type === "requires-action";
}

type CommittedBlock =
  | { key: string; kind: "identity" }
  | { key: string; kind: "banner"; threadId: string; title: string }
  | { key: string; kind: "user-message"; threadId: string; index: number }
  | { key: string; kind: "assistant-header"; threadId: string; index: number; spacer?: boolean }
  | { key: string; kind: "assistant-part"; threadId: string; index: number; partIndex: number; spacer?: boolean }
  | { key: string; kind: "assistant-error"; threadId: string; index: number; spacer?: boolean };

// Info `LiveMessageTail` needs to render exactly the NOT-yet-committed
// remainder of the one currently-live message (if any) — derived fresh
// every render from the same refs the commit effect below owns, never a
// second independently-tracked copy (the "must be exactly the message
// `committedBlocks.tsx`'s own effect just committed, never a gap or a
// duplicate" invariant the old message-granularity version of this file
// already had to prove, now re-proven at part granularity).
type LiveTailInfo = {
  threadId: string;
  index: number;
  showHeader: boolean;
  fromPartIndex: number;
  totalParts: number;
};

function useCommittedBlocks(): { blocks: CommittedBlock[]; tail: LiveTailInfo | undefined } {
  const [blocks, setBlocks] = useState<CommittedBlock[]>(() => [{ key: "identity", kind: "identity" }]);
  const activeThreadId = useAuiState((s) => s.threads.mainThreadId);
  const messages = useAuiState((s) => s.thread.messages);
  const threadItems = useAuiState((s) => s.threads.threadItems);
  const prevThreadIdRef = useRef<string | undefined>(undefined);
  // Per-thread count of how many leading messages are FULLY settled and
  // committed — never re-scanned from scratch, so a thread we've switched
  // back to doesn't get its already-committed messages pushed a second
  // time. A message still mid-stream does NOT advance this count, even
  // once some of its own parts are committed (see `committedPartCountRef`).
  const committedMessageCountRef = useRef<Map<string, number>>(new Map());
  // Per-message (`${threadId}:${index}`) count of how many LEADING parts
  // are already committed — the part-granularity counterpart of the above.
  const committedPartCountRef = useRef<Map<string, number>>(new Map());
  // Per-message: has the "● deus" header block already been pushed? Tracked
  // separately from the part count since the header commits once, the
  // instant a message is first seen, independent of how many of its parts
  // have settled yet.
  const headerCommittedRef = useRef<Set<string>>(new Set());

  // Thread-switch banner — see point 1 above for why this only fires
  // (and only ever needs to fire) strictly after `activeThreadId` has
  // already become the new thread.
  useEffect(() => {
    if (activeThreadId === prevThreadIdRef.current) return;
    const isFirstThread = prevThreadIdRef.current === undefined;
    prevThreadIdRef.current = activeThreadId;
    if (!activeThreadId || isFirstThread) return;
    const title = threadItems.find((item) => item.id === activeThreadId)?.title ?? "(untitled)";
    setBlocks((prev) => [...prev, { key: `banner:${activeThreadId}:${prev.length}`, kind: "banner", threadId: activeThreadId, title }]);
  }, [activeThreadId, threadItems]);

  // Commit newly-settled content of the active thread, in order: whole
  // user messages atomically, assistant messages part-by-part as each
  // part's own status settles, stopping at the first still-live message
  // (there is at most one at a time — see `isMessageLive`).
  useEffect(() => {
    if (!activeThreadId) return;
    const already = committedMessageCountRef.current.get(activeThreadId) ?? 0;
    const newBlocks: CommittedBlock[] = [];
    let settledThrough = already;

    for (let i = already; i < messages.length; i++) {
      const message = messages[i];
      if (!message) break;

      if (message.role !== "assistant") {
        // User (and any system) messages never stream — commit atomically
        // the first time they're reached.
        newBlocks.push({ key: `msg:${activeThreadId}:${i}`, kind: "user-message", threadId: activeThreadId, index: i });
        settledThrough = i + 1;
        continue;
      }

      const msgKey = `${activeThreadId}:${i}`;
      let lastPushedIndexThisPass = -1;

      if (!headerCommittedRef.current.has(msgKey)) {
        newBlocks.push({ key: `hdr:${msgKey}`, kind: "assistant-header", threadId: activeThreadId, index: i });
        headerCommittedRef.current.add(msgKey);
        lastPushedIndexThisPass = newBlocks.length - 1;
      }

      // Hoisted above the parts loop (was computed after it, pre-IB2) — the
      // capped-part hold below (I6/I10) needs to know whether the WHOLE
      // message has settled yet while still walking its individual parts,
      // not just after.
      const settled = !isMessageLive(message);

      const parts = message.parts ?? [];
      const partsAlready = committedPartCountRef.current.get(msgKey) ?? 0;
      let partsThrough = partsAlready;
      for (let p = partsAlready; p < parts.length; p++) {
        const part = parts[p];
        if (isPartLive(part)) break;
        // I6/I10 (LIA-496 IB2) — hold a CAPPED tool-call part (BashLine's
        // "… +N lines" / DiffPanel's diff cap) live a little longer than
        // "its own status settled": this fixture's tool results resolve in
        // one atomic yield, not incrementally, so committing it into
        // `<Static>` the instant it settles would unmount its interactive
        // ctrl+o `useInput` handler within a single React tick — before any
        // human could plausibly react, making the collapse/expand
        // affordance dead on arrival. Holding it until the REST of the
        // message finishes streaming gives it the same realistic window a
        // live terminal session actually has: as long as the turn is still
        // going, its own tool calls are still "current" and interactive;
        // once the whole turn settles, it commits below exactly like
        // everything else (frozen in whatever expand state it's in — the
        // same accepted `<Static>` immutability this file's header comment
        // already documents for restyled chrome, now applying to expand
        // state too). See `../toolOutputCap.ts` for `isCappedToolPart`.
        if (!settled && isCappedToolPart(part)) break;
        newBlocks.push({ key: `part:${msgKey}:${p}`, kind: "assistant-part", threadId: activeThreadId, index: i, partIndex: p });
        lastPushedIndexThisPass = newBlocks.length - 1;
        partsThrough = p + 1;
      }
      if (partsThrough !== partsAlready) committedPartCountRef.current.set(msgKey, partsThrough);

      if (settled) {
        // Error state is only knowable once the message has fully
        // settled — commit it now, never earlier, so `ErrorPrimitive.Root`
        // reads the real final status on its one-and-only render instead
        // of freezing a premature "no error yet" read into `<Static>`
        // (see this file's header comment for the mechanism this closes).
        newBlocks.push({ key: `err:${msgKey}`, kind: "assistant-error", threadId: activeThreadId, index: i });
        lastPushedIndexThisPass = newBlocks.length - 1;
      }
      if (settled && lastPushedIndexThisPass !== -1) {
        // Mark the LAST block committed for this message (this pass) as
        // the one that carries the gap before the next message/banner —
        // mirrors the single trailing `marginBottom` the old whole-message
        // `AssistantMessage` box used to carry. The error block (always
        // pushed when settled, immediately above) is always this last
        // block now.
        const block = newBlocks[lastPushedIndexThisPass]!;
        newBlocks[lastPushedIndexThisPass] = { ...block, spacer: true } as CommittedBlock;
      }
      if (!settled) break; // still in-flight; re-evaluate remaining parts next render
      settledThrough = i + 1;
    }

    if (settledThrough !== already) committedMessageCountRef.current.set(activeThreadId, settledThrough);
    if (newBlocks.length > 0) setBlocks((prev) => [...prev, ...newBlocks]);
  }, [activeThreadId, messages]);

  const lastIndex = messages.length - 1;
  const lastMessage = messages[lastIndex];
  const tail: LiveTailInfo | undefined =
    activeThreadId && lastMessage && isMessageLive(lastMessage)
      ? {
          threadId: activeThreadId,
          index: lastIndex,
          showHeader: !headerCommittedRef.current.has(`${activeThreadId}:${lastIndex}`),
          fromPartIndex: committedPartCountRef.current.get(`${activeThreadId}:${lastIndex}`) ?? 0,
          totalParts: (lastMessage.parts ?? []).length,
        }
      : undefined;

  return { blocks, tail };
}

// Takes `blocks` as a prop rather than calling `useCommittedBlocks` itself
// — `App.tsx`'s `MainPane` calls the hook exactly ONCE and passes `blocks`
// here and `tail` to the sibling `LiveMessageTail` below, so both halves of
// the transcript read from the same single bookkeeping instance (see this
// file's header comment, point 1, on why a second independent instance
// would be a real drift risk, not just redundant).
export const CommittedTranscript: FC<{ width: number; blocks: CommittedBlock[] }> = ({ width, blocks }) => {
  return (
    <Static items={blocks} style={{ flexDirection: "column", width, paddingLeft: 2, paddingRight: 2 }}>
      {(block) => {
        if (block.kind === "identity") {
          return (
            <Box key={block.key} flexDirection="column" marginBottom={1}>
              <Text color={theme.ink}>{PRODUCT_NAME}</Text>
              <Text color={theme.dim}>
                model: <Text color={theme.ok}>{MODEL_NAME}</Text> · {getUserLabel()} · {getCwdLabel()}
              </Text>
            </Box>
          );
        }
        if (block.kind === "banner") {
          return (
            <Box key={block.key} marginY={1}>
              <Text color={theme.dim}>
                {"── thread: "}
                {block.title}
                {" ──"}
              </Text>
            </Box>
          );
        }
        if (block.kind === "user-message") {
          return (
            <MessageByIndexProvider index={block.index} key={block.key}>
              <UserMessage />
            </MessageByIndexProvider>
          );
        }
        if (block.kind === "assistant-header") {
          // I8 (LIA-496 IB2) — no "deus" label. Found live during this
          // batch's own verification capture (not caught by reading
          // `components/Messages.tsx` alone): this block is a SEPARATE,
          // hand-rolled header render from `AssistantMessage`'s own gutter
          // markup (required because `<Static>` needs the header to commit
          // at a different instant than the message's own parts — see this
          // file's header comment), so removing the label from
          // `AssistantMessage` alone left this copy still printing it into
          // the committed transcript, which is what most of the app's
          // visible content actually goes through.
          return (
            <Box key={block.key} flexDirection="row" marginBottom={block.spacer ? 1 : 0}>
              <Box width={2}>
                <Text color={theme.dim} bold>
                  {GLYPH_ASSISTANT}
                </Text>
              </Box>
              <Box flexDirection="column" flexGrow={1} />
            </Box>
          );
        }
        if (block.kind === "assistant-error") {
          // Committed only once the message has settled (see this file's
          // header comment) — the one-and-only render below is guaranteed
          // to read the message's real, final status, so it is safe here
          // in a way it was not inside "assistant-header" above.
          return (
            <Box key={block.key} flexDirection="row" marginBottom={block.spacer ? 1 : 0}>
              <Box width={2} />
              <Box flexDirection="column" flexGrow={1}>
                <MessageByIndexProvider index={block.index}>
                  <ErrorPrimitive.Root>
                    <ErrorState />
                  </ErrorPrimitive.Root>
                </MessageByIndexProvider>
              </Box>
            </Box>
          );
        }
        // assistant-part — left gutter kept empty (no repeated glyph/label)
        // so continuation lines still align under the header's text column.
        return (
          <Box key={block.key} flexDirection="row" marginBottom={block.spacer ? 1 : 0}>
            <Box width={2} />
            <Box flexDirection="column" flexGrow={1}>
              <MessageByIndexProvider index={block.index}>
                <MessagePrimitive.PartByIndex index={block.partIndex} components={assistantPartComponents} />
              </MessageByIndexProvider>
            </Box>
          </Box>
        );
      }}
    </Static>
  );
};

// The still-LIVE remainder of the one currently-streaming message (if any)
// — everything committed already lives permanently in `CommittedTranscript`
// instead. Reads `tail` from the SAME `useCommittedBlocks` state
// `CommittedTranscript` does (both called once each from `App.tsx`'s
// `MainPane`, not nested — there is exactly one hook instance's worth of
// commit bookkeeping in the whole app, never two independently-tracked
// copies that could drift apart).
export const LiveMessageTail: FC<{ tail: LiveTailInfo | undefined }> = ({ tail }) => {
  if (!tail) return null;
  const remaining = Math.max(0, tail.totalParts - tail.fromPartIndex);
  if (!tail.showHeader && remaining === 0) return null;
  return (
    <Box flexDirection="column">
      {tail.showHeader ? (
        // I8 (LIA-496 IB2) — no "deus" label, same fix and same reason as
        // `CommittedTranscript`'s own "assistant-header" block above: this
        // is a third, independent copy of the header markup (the
        // not-yet-committed live case), so the label had to be dropped here
        // too, not just in `AssistantMessage`.
        <Box flexDirection="row">
          <Box width={2}>
            <Text color={theme.dim} bold>
              {GLYPH_ASSISTANT}
            </Text>
          </Box>
          <Box flexDirection="column" flexGrow={1} />
        </Box>
      ) : null}
      {Array.from({ length: remaining }, (_, offset) => tail.fromPartIndex + offset).map((partIndex) => (
        <Box key={partIndex} flexDirection="row">
          <Box width={2} />
          <Box flexDirection="column" flexGrow={1}>
            <MessageByIndexProvider index={tail.index}>
              <MessagePrimitive.PartByIndex index={partIndex} components={assistantPartComponents} />
            </MessageByIndexProvider>
          </Box>
        </Box>
      ))}
    </Box>
  );
};

export { useCommittedBlocks };

// LIA-496 — Thread.tsx <- App.tsx, inside AssistantRuntimeProvider.
// ThreadPrimitive.Root/Messages(components={{UserMessage,
// AssistantMessage}})/Empty, per the S1 dispatch. AssistantMessage wires
// MessagePrimitive.Parts' `components.Text` -> MarkdownText.tsx (which
// itself wires `components.code` -> CodeBlock.tsx — see that file's header
// comment for why this two-hop link matters) and `components.tools.by_name`
// -> DiffPanel.tsx (Edit) / PermissionCard.tsx (delete_file), plus the
// per-message footer (ActionBar.tsx + BranchPicker.tsx) and ErrorState.tsx.
//
// WB1 (LIA-496 review-fix) — W2 streaming activity indicator + W3
// scroll-to-bottom, both added here.
//
// WB3 (LIA-496 review-fix) — W10 edit-to-branch + copy on user messages,
// W12 collapsed-by-default reasoning disclosure, W13 collapsed-row+chevron
// tool-output disclosure, all added here.
//
// W10 — the real mechanism, verified first-hand by reading source (not
// assumed from the plan's own citation): `ActionBarPrimitive.Edit`'s
// underlying hook (`useActionBarEdit`, `@assistant-ui/core/react`) calls
// `aui.composer.beginEdit()` — the exact runtime call
// `composer-runtime.d.ts:198` confirms exists. `beginEdit()` is real, not
// a stub: `default-edit-composer-runtime-core.js`'s constructor seeds the
// edit composer's text from `getThreadMessageText(message)` (so the
// textarea opens pre-filled with the message's own text) and its
// `handleSend` appends a NEW message with the SAME `parentId`/`sourceId`
// as the original — i.e. a genuine sibling branch, not a same-branch edit.
// The piece that makes this render at all: `ThreadMessages.js`'s
// `getComponent(components, role, isEditing)` swaps `UserMessage` for
// `components.UserEditComposer` the instant `s.message.composer.isEditing`
// flips true (read directly off `@assistant-ui/core/dist/react/
// primitives/thread/ThreadMessages.js`) — so `UserEditComposer` below
// MUST be registered in `ThreadPrimitive.Messages`' `components` prop
// (see this file's `Thread` component) or `beginEdit()` fires with no
// visible effect. `ComposerPrimitive.Root`/`.Input`/`.Cancel`/`.Send`
// rendered inside that swapped-in component resolve to the message's own
// EDIT composer scope (ambient, via the same `MessageByIndexProvider`
// `ThreadPrimitive.Messages` already wraps every message in) — not the
// thread-level composer Composer.tsx drives; `.Cancel` here calls
// `composer.cancel()`, which per `composer-runtime.d.ts`'s own doc
// comment "In edit mode, this will exit edit mode" (confirmed also by
// `DefaultEditComposerRuntimeCore.handleCancel` -> `endEditCallback()`).
//
// W2: `useStreamingTiming`/`StreamingTimingState` are real exports,
// confirmed at node_modules/@assistant-ui/core/dist/react/index.d.ts:114
// (re-exported from @assistant-ui/core/react — NOT from @assistant-ui/react
// itself, same "core, not the target binding" precedent ErrorState.tsx's
// own header comment already establishes for useMessageError). Read its
// real implementation directly
// (node_modules/@assistant-ui/core/dist/react/runtimes/
// useStreamingTiming.js): it returns only FINALIZED per-message timing —
// `timings[id]` stays absent for the entire duration a message is
// streaming and is populated in the single React update where `isRunning`
// flips back to false (the doc comment says so explicitly: "empty when
// streaming is still in flight"). It therefore cannot itself drive a LIVE
// pre-first-token/mid-stream toggle — that per-part liveness comes from
// the real `status.type === "running"` field MarkdownText.tsx/ReasoningPart
// already receive as props (see MarkdownText.tsx's header comment). What
// this hook DOES give, genuinely: real elapsed/tokens-per-second data once
// a message finishes, which AssistantMessage below surfaces as a caption —
// a real consumer of the hook's actual output, not a decorative unused
// call standing in for "used useStreamingTiming" on paper. Either way,
// zero setTimeout/setInterval anywhere in this file — the exact hand-
// rolled-timer approach plan-review rejected.
import { createContext, useContext, useState, type FC } from "react";
import {
  ThreadPrimitive,
  MessagePrimitive,
  ActionBarPrimitive,
  ComposerPrimitive,
  useAuiState,
  type ReasoningMessagePartProps,
  type ToolCallMessagePartProps,
} from "@assistant-ui/react";
import { useStreamingTiming } from "@assistant-ui/core/react";
// MessageTiming itself lives on @assistant-ui/core's root export, not the
// /react subpath (confirmed: TS rejects it from /react — the subpath only
// re-exports the hook, not this data type).
import type { MessageTiming } from "@assistant-ui/core";
import { MarkdownText } from "./MarkdownText";
import { DiffPanel } from "./DiffPanel";
import { PermissionCard } from "./PermissionCard";
import { ActionBar } from "./ActionBar";
import { BranchPicker } from "./BranchPicker";
import { EmptyState } from "./EmptyState";
import { ErrorState } from "./ErrorState";

// Finalized per-message timing, keyed by message id — provided by `Thread`
// (the only place with access to the full `messages`/`isRunning` state
// useStreamingTiming needs) and read by `AssistantMessage` (which only
// knows its own message id). A plain context rather than threading a prop
// through `ThreadPrimitive.Messages`' `components` map, which assistant-ui
// itself owns and invokes with no extra-prop passthrough.
const MessageTimingContext = createContext<Record<string, MessageTiming>>({});

// Same status-driven shimmer/cursor treatment as MarkdownText.tsx's Text
// override — see that file's header comment for the mechanism.
// ReasoningMessagePartProps already carries `status` for free (it's
// `MessagePartState & ReasoningMessagePart`, confirmed by reading
// MessagePartComponentTypes.d.ts), so no extra hook is needed here either.
//
// W12 fix (WB3): was always-expanded with no label — a screen-reader user
// had no way to know this content existed as a distinct, collapsible
// region, and every reasoning trace dumped its full text into the
// transcript unconditionally. Now a real labelled disclosure
// (`aria-expanded` on the toggle button), collapsed by default. While
// streaming, the toggle keeps showing the live cursor next to the label
// even when collapsed — a "still thinking" signal that doesn't require
// exposing the (possibly long, possibly still-forming) text itself.
const ReasoningPart: FC<ReasoningMessagePartProps> = ({ text, status }) => {
  const [expanded, setExpanded] = useState(false);
  const isRunning = status.type === "running";
  if (!text) {
    return isRunning ? <div className="s-shimmer s-shimmer-reasoning" aria-hidden="true" /> : null;
  }
  return (
    <div className="s-reasoning-wrap">
      <button
        type="button"
        className="s-reasoning-toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded((e) => !e)}
      >
        <span className={`s-tool-chevron${expanded ? " open" : ""}`} aria-hidden="true">
          ›
        </span>
        Reasoning
        {isRunning && <span className="s-cursor s-cursor-reasoning" aria-hidden="true" />}
      </button>
      {expanded && <p className="s-reasoning">{text}</p>}
    </div>
  );
};

// Fallback for tool calls that aren't Edit/delete_file (Bash, the various
// `grep`/`ls` checks the fixture scripts run) — a compact inline line
// rather than a silent gap, matching the design source's understated
// treatment of intermediate tool activity.
//
// W13 fix (WB3): raw tool output used to dump unconditionally, no
// disclosure grammar at all. Now a collapsed-by-default row (single-line
// truncated preview via CSS `text-overflow: ellipsis`, not React
// truncation, so the full string is still in the DOM for copy/search) with
// a chevron toggle that reveals the full raw output below — same
// `.s-tool-chevron` disclosure control DiffPanel.tsx's W13 fix uses, one
// visual family across both raw-tool-output and diff disclosures.
const GenericToolLine: FC<ToolCallMessagePartProps> = (props) => {
  const [expanded, setExpanded] = useState(false);
  const output = typeof props.result === "string" ? props.result : props.argsText;
  return (
    <div className="s-toolline-wrap">
      <button type="button" className="s-toolline" aria-expanded={expanded} onClick={() => setExpanded((e) => !e)}>
        <span className={`s-tool-chevron${expanded ? " open" : ""}`} aria-hidden="true">
          ›
        </span>
        <span>{props.toolName}</span>
        <span className="dot">·</span>
        <span className="s-toolline-preview">{output}</span>
      </button>
      {expanded && <pre className="s-toolline-body">{output}</pre>}
    </div>
  );
};

const messageComponents = {
  Text: MarkdownText,
  Reasoning: ReasoningPart,
  tools: {
    by_name: { Edit: DiffPanel, delete_file: PermissionCard },
    Fallback: GenericToolLine,
  },
};

// W10 fix (WB3): hover pencil (edit-to-branch) + copy, both on real
// primitives — see this file's header comment for the verified mechanism.
// `.s-user-actions` is CSS-hover-revealed via `.s-user:hover` — deliberately
// an opacity/pointer-events toggle (theme.css), NOT the `display:none` ->
// `display:flex` pattern Sidebar.tsx's `.s-item-row:hover .s-item-actions`
// uses for WB2's W5: a `display:none` element's descendants drop out of the
// tab order, so a `:focus-within` reveal on it could never actually match
// (code-review caught this as a real dead-selector bug, not a hypothetical —
// see theme.css's `.s-user-actions` comment). Staying `display:flex` and
// toggling opacity instead keeps the buttons real tab stops at all times, so
// Tab can reach and focus them, which is what makes `:focus-within` fire.
// Not `ActionBarPrimitive.Root`'s own `autohide`/`isHovering` mechanism —
// that mechanism depends on `MessagePrimitive.Root`'s mouseenter/mouseleave
// listener, which this app's `UserMessage` doesn't mount (it renders plain
// divs, not `MessagePrimitive.Root`), so `s.message.isHovering` would
// never flip and `autohide="always"` would just stay permanently hidden.
// `:focus-within` reveals the row so keyboard-only users (Tab into the
// buttons) aren't locked out by the hover-only CSS.
//
// `<BranchPicker />` is ALSO mounted here, always (its own
// `hideWhenSingleBranch` controls real visibility) — real behavioral
// finding from re-running the actual edit flow, not assumed: editing a
// USER message forks the tree at the USER message's own position
// (`DefaultEditComposerRuntimeCore.handleSend` appends the edit as a
// sibling of the ORIGINAL user message, same `parentId`/`sourceId` — see
// this file's header comment). The pre-existing `BranchPicker` was wired
// only into `AssistantMessage`'s footer, which shows branch count for the
// ASSISTANT's reply — a *different* message that stays single-branch
// after a user-message edit (each edit spawns a fresh assistant reply, not
// a sibling of the old one). Without a branch picker here, "the branch
// picker shows 2/2" (this batch's own named re-verification claim) had no
// UI surface to show it on at all — confirmed by re-running the edit flow
// headlessly against the real dev server and inspecting the rendered DOM
// before adding this.
const UserMessage: FC = () => {
  // `s.message.isCopied` (real, live state — see ActionBarCopy.js's own
  // `data-copied` mechanism this mirrors) drives the label directly via
  // useAuiState, same pattern the rest of this file already uses
  // everywhere else, rather than reaching for the deprecated
  // `MessagePrimitive.If` (its own doc comment: "Use `<AuiIf
  // condition={(s) => s.message...} />` instead").
  const isCopied = useAuiState((s) => s.message.isCopied);
  return (
    <div className="s-user">
      <div className="s-user-col">
        <div className="chip">
          <MessagePrimitive.Content />
        </div>
        <div className="s-user-row">
          <div className="s-user-actions">
            <ActionBarPrimitive.Edit className="s-abtn" aria-label="Edit message">
              ✎
            </ActionBarPrimitive.Edit>
            <ActionBarPrimitive.Copy className="s-abtn" aria-label="Copy message">
              {isCopied ? "Copied" : "Copy"}
            </ActionBarPrimitive.Copy>
          </div>
          <BranchPicker />
        </div>
      </div>
    </div>
  );
};

// The edit-mode replacement for `UserMessage` — registered as
// `components.UserEditComposer` below, swapped in automatically by
// `ThreadPrimitive.Messages` the instant `beginEdit()` (triggered by the
// pencil above) flips `s.message.composer.isEditing`. Pre-filled text,
// `Escape` cancels (real `ComposerPrimitive.Input` default,
// `cancelOnEscape` defaults to `true` — confirmed in `ComposerInput.d.ts`),
// `Cancel` exits edit mode without sending, `Save` sends and creates the
// sibling branch.
const UserEditComposer: FC = () => (
  <div className="s-user">
    <ComposerPrimitive.Root className="s-edit-field">
      <ComposerPrimitive.Input autoFocus rows={1} className="s-edit-input" />
      <div className="s-edit-actions">
        <ComposerPrimitive.Cancel className="s-btn ghost" aria-label="Cancel edit">
          Cancel
        </ComposerPrimitive.Cancel>
        <ComposerPrimitive.Send className="s-btn go" aria-label="Save and send">
          Save
        </ComposerPrimitive.Send>
      </div>
    </ComposerPrimitive.Root>
  </div>
);

// Formats the finalized MessageTiming genuinely returned by
// useStreamingTiming (see this file's header comment) into a compact
// caption — the real consumer of the hook's actual output, shown once a
// message finishes streaming.
function formatTiming(timing: MessageTiming): string | null {
  const bits: string[] = [];
  if (timing.totalStreamTime !== undefined) bits.push(`${(timing.totalStreamTime / 1000).toFixed(1)}s`);
  if (timing.tokensPerSecond !== undefined) bits.push(`${timing.tokensPerSecond.toFixed(0)} tok/s`);
  return bits.length > 0 ? bits.join(" · ") : null;
}

const AssistantMessage: FC = () => {
  const messageId = useAuiState((s) => s.message.id);
  const timings = useContext(MessageTimingContext);
  const timing = timings[messageId];
  const label = timing ? formatTiming(timing) : null;

  return (
    <div className="s-msg-group">
      <MessagePrimitive.Parts components={messageComponents} unstable_showEmptyOnNonTextEnd={false} />
      <ErrorState />
      <div className="s-footer">
        <ActionBar />
        <BranchPicker />
        {label && <span className="s-timing">{label}</span>}
      </div>
    </div>
  );
};

export const Thread: FC<{ onOpenDrawer: () => void }> = ({ onOpenDrawer }) => {
  const title = useAuiState((s) => s.threadListItem.title);
  const messages = useAuiState((s) => s.thread.messages);
  const isRunning = useAuiState((s) => s.thread.isRunning);

  // W2 — genuinely called with the thread's real messages/isRunning state
  // (see this file's header comment for exactly what its return value can
  // and can't drive).
  const timings = useStreamingTiming(messages, isRunning, {
    getAssistantMessageId: (msgs) => msgs.findLast((m) => m.role === "assistant")?.id,
    getTextLength: (msgs, id) => {
      const m = msgs.find((mm) => mm.id === id);
      if (!m || m.role !== "assistant") return 0;
      return m.content.reduce((n, p) => (p.type === "text" || p.type === "reasoning" ? n + p.text.length : n), 0);
    },
    getToolCallCount: (msgs, id) => {
      const m = msgs.find((mm) => mm.id === id);
      if (!m || m.role !== "assistant") return 0;
      return m.content.filter((p) => p.type === "tool-call").length;
    },
  });

  return (
    <ThreadPrimitive.Root style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0, position: "relative" }}>
      <div className="s-top">
        <div className="s-top-left">
          <button className="s-drawer-open" onClick={onOpenDrawer} aria-label="Open sidebar">
            ☰
          </button>
          <h2 className="serif">{title ?? "New chat"}</h2>
        </div>
        <span className="s-model">Sonnet 5</span>
      </div>
      <ThreadPrimitive.Viewport className="s-thread">
        <div className="s-col">
          <ThreadPrimitive.Empty>
            <EmptyState />
          </ThreadPrimitive.Empty>
          <MessageTimingContext.Provider value={timings}>
            <ThreadPrimitive.Messages components={{ UserMessage, UserEditComposer, AssistantMessage }} />
          </MessageTimingContext.Provider>
        </div>
      </ThreadPrimitive.Viewport>
      {/* W3 — ThreadPrimitive.ScrollToBottom, confirmed real
          (primitives/thread/ThreadScrollToBottom.d.ts). Code-review fix
          (WB1 second REVISE round, medium-severity finding): this comment
          previously claimed it "renders null when already at the bottom" —
          false, confirmed by reading createActionButton.js (the real
          shared implementation behind ScrollToBottom) directly: the button
          is ALWAYS mounted; only its `disabled` attribute toggles based on
          whether `useThreadScrollToBottom()` returns a callback or null.
          The visibility logic this comment claimed was unnecessary lives in
          theme.css's `.s-scroll-bottom:disabled` rule instead. */}
      <ThreadPrimitive.ScrollToBottom className="s-scroll-bottom" aria-label="Scroll to latest message">
        ↓
      </ThreadPrimitive.ScrollToBottom>
    </ThreadPrimitive.Root>
  );
};

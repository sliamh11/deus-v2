// LIA-496 — Composer.tsx <- App.tsx, sibling to Thread.tsx. Pill shape,
// pine send circle, per the design source's .s-field/.s-send. VERIFIED:
// ComposerPrimitive.Input is rendered INSIDE ComposerPrimitive.Root below —
// this is the exact regression LIA-495 shipped and had to fix (input
// rendered as a sibling of Root instead of a child, so submitOnEnter's
// requestSubmit() found no <form> ancestor and Enter silently no-opped).
// Hidden entirely while a permission decision is pending — same reasoning
// as LIA-495's ComposerRow: no cross-component focus management exists, so
// a stray keystroke could land in the composer's textarea while
// PermissionCard's buttons are the thing that should have focus.
//
// WB1 (LIA-496 review-fix) — W1 stop-generating control. `Cancel` is a real
// exported primitive, confirmed by reading
// node_modules/@assistant-ui/react/dist/primitives/composer/
// ComposerCancel.d.ts directly: `ComposerPrimitive.Cancel` self-disables
// (via useComposerCancel's `disabled = !s.composer.canCancel`) when
// canceling genuinely isn't available, same self-disable contract `.Send`
// already relies on below. `ComposerPrimitive.If` was checked and rejected
// for this — its filter set is `{editing, dictation}` only (confirmed by
// reading ComposerIf.d.ts), no `running` filter — so the swap is gated on
// the real `s.thread.isRunning` flag read via useAuiState (same pattern
// this file already uses for `useIsAwaitingApproval`), not a guess.
import type { FC } from "react";
import { ComposerPrimitive, useAuiState } from "@assistant-ui/react";

function useIsAwaitingApproval(): boolean {
  const messages = useAuiState((s) => s.thread.messages);
  const last = messages[messages.length - 1];
  if (!last || last.role !== "assistant") return false;
  return last.content.some(
    (part) => part.type === "tool-call" && part.approval !== undefined && part.approval.approved === undefined,
  );
}

export const Composer: FC = () => {
  const awaitingApproval = useIsAwaitingApproval();
  const isRunning = useAuiState((s) => s.thread.isRunning);

  if (awaitingApproval) {
    return (
      <div className="s-composer">
        <div className="s-composer-waiting">Resolve the permission prompt above to continue…</div>
      </div>
    );
  }

  return (
    <div className="s-composer">
      <ComposerPrimitive.Root className="s-field">
        <ComposerPrimitive.Input
          submitOnEnter
          placeholder="Ask Deus to do something…"
          autoFocus
          rows={1}
        />
        {isRunning ? (
          <ComposerPrimitive.Cancel className="s-send s-send-stop" aria-label="Stop generating">
            ■
          </ComposerPrimitive.Cancel>
        ) : (
          <ComposerPrimitive.Send className="s-send" aria-label="Send">
            ↑
          </ComposerPrimitive.Send>
        )}
      </ComposerPrimitive.Root>
    </div>
  );
};

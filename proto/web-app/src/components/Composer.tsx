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
        <ComposerPrimitive.Send className="s-send" aria-label="Send">
          ↑
        </ComposerPrimitive.Send>
      </ComposerPrimitive.Root>
    </div>
  );
};

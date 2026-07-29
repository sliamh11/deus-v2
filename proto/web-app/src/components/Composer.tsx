// LIA-496 — Composer.tsx <- App.tsx, sibling to Thread.tsx. Pill shape,
// pine send circle, per the design source's .s-field/.s-send. VERIFIED:
// ComposerPrimitive.Input is rendered INSIDE ComposerPrimitive.Root below —
// this is the exact regression LIA-495 shipped and had to fix (input
// rendered as a sibling of Root instead of a child, so submitOnEnter's
// requestSubmit() found no <form> ancestor and Enter silently no-opped).
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
//
// WB4 (LIA-496 review-fix) — W14 fix: the composer used to UNMOUNT itself
// entirely while a permission decision was pending (replaced by a bare
// `<div className="s-composer-waiting">` sibling with no `<form>` at all),
// per the reasoning that no cross-component focus management exists so a
// stray keystroke could land in the textarea while PermissionCard's
// buttons should have focus. Round-2 review (D1/W14) rejected that
// tradeoff: unmounting is a bigger surprise than a disabled control —
// ChatGPT/Claude.ai's own convention (a persistent, disabled composer
// during a blocking action) is followed here instead, matching the plan's
// deliberate per-platform split (Ink genuinely replaces its input slot
// during approval, per D1; web keeps a disabled composer visible). The
// stray-keystroke concern is now handled by `disabled` on the real
// `<textarea>` itself — a disabled form control cannot receive focus or
// keystrokes at all, which is a strictly stronger guarantee than the old
// unmount-and-hide approach.
//
// WB4 (LIA-496 review-fix) — post-W14 refocus, investigated and found
// ALREADY CORRECT: round-2 review raised a plausible concern that
// `autoFocus` only fires on mount, and since W14 (above) means this
// `<textarea>` no longer unmounts/remounts across an approval cycle, focus
// would strand on `<body>` after a permission resolves. That's true for a
// raw HTML `autofocus` attribute, but NOT for `ComposerPrimitive.Input`:
// reading node_modules/@assistant-ui/react/dist/primitives/composer/
// ComposerInput.js directly shows it computes `autoFocusEnabled = autoFocus
// && !isDisabled` and re-runs a `textarea.focus()` effect (`useEffect(() =>
// focus(), [focus])`) every time `autoFocusEnabled`'s value changes — not
// just on mount. Since this component's own `disabled={awaitingApproval}`
// is necessarily reactive (that's the whole point of the W14 fix above),
// `isDisabled` flips true->false exactly when a permission resolves, which
// flips `autoFocusEnabled` false->true and re-fires the library's own
// focus effect — no custom code needed. Confirmed empirically, not just by
// reading source: a Playwright run that deliberately moves focus onto
// PermissionCard's own "Always allow" button, resolves the approval, and
// reads `document.activeElement` afterward shows focus lands back on this
// textarea every time (see captures/verify-wb4-fix.mjs, VERIFICATION.md).
import type { FC } from "react";
import { ComposerPrimitive, useAuiState } from "@assistant-ui/react";
import { ModelPicker } from "./ModelPicker";

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

  return (
    <div className="s-composer">
      <ComposerPrimitive.Root className={`s-field${awaitingApproval ? " s-field-waiting" : ""}`}>
        <ComposerPrimitive.Input
          submitOnEnter
          placeholder={
            awaitingApproval
              ? "Resolve the permission prompt above to continue…"
              : "Ask Deus to do something…"
          }
          autoFocus={!awaitingApproval}
          disabled={awaitingApproval}
          rows={1}
        />
        {isRunning && !awaitingApproval ? (
          <ComposerPrimitive.Cancel className="s-send s-send-stop" aria-label="Stop generating">
            ■
          </ComposerPrimitive.Cancel>
        ) : (
          <ComposerPrimitive.Send className="s-send" aria-label="Send" disabled={awaitingApproval}>
            ↑
          </ComposerPrimitive.Send>
        )}
      </ComposerPrimitive.Root>
      {/* WB4 (LIA-496 review-fix) — W16 composer secondary row, per the
          plan's D3 resolution. Fable rated the missing attach/model-picker
          row "low, acceptable for a spike"; GPT rated it "high, a real
          structural gap." This row is the resolution: exactly one real
          control (ModelPicker — a genuine `<button aria-haspopup=
          "listbox">` + popover, toggling between two scripted labels,
          web-app-local presentation state deliberately NOT exported from
          @lia496/shared, see ModelPicker.tsx's own header comment).
          Deliberately NOT an attach button: an attach control that can't
          attach is exactly the "visibly actionable but actually disabled"
          fake affordance the Ink review already condemned (`+ new
          session`) — `.s-attach-slot` below reserves that geometry (an
          empty, aria-hidden, non-interactive placeholder) without
          rendering a fake control. This also retires Fable's separate
          "static badge styled as interactive" finding: the old inert
          `<span className="s-model">` that used to sit in Thread.tsx's
          header (Thread.tsx:80 at the time of that finding) is removed
          from there — its function (showing/choosing the model) now lives
          here as a genuinely interactive control instead of a
          non-functional duplicate. */}
      <div className="s-composer-row2">
        <div className="s-attach-slot" aria-hidden="true" />
        <ModelPicker />
      </div>
    </div>
  );
};

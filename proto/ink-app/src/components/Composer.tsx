// LIA-496 — ← App.tsx, sibling to Messages.tsx (same position LIA-495's
// composer regression lived in — see that repo's FINDINGS.md: the DOM
// target's textarea was outside any `<form>`, fixed by wrapping
// `ComposerPrimitive.Input` in `ComposerPrimitive.Root`; Ink has no DOM
// `<form>` concept, but `ComposerPrimitive.Root` is wired here too for
// structural parity, confirmed by reading its source — a plain `Box`
// wrapper with no context requirement of its own, so this costs nothing
// and keeps both targets' composer wrapped the same way). Under the hood
// `ComposerPrimitive.Input` renders `TextInput` (react-ink's own export —
// confirmed by reading node_modules/@assistant-ui/react-ink/src/
// primitives/composer/ComposerInput.tsx directly), behind a `"> "` prompt
// glyph per theme.ts's `COMPOSER_PROMPT` (see that file's header comment on
// why this differs from the design source's literal `❯` composer glyph).
//
// Stays permanently mounted — **BUILD-stage finding, corrected after a
// real misdiagnosis** (see App.tsx's own header comment for the full
// trace): Ink's native `useFocus`/Tab-cycling genuinely works, and
// `TextInput`'s own `useInput` is already gated on ITS OWN `isFocused`
// (`{isActive: isFocused}`), so unmounting this component for pane
// switching was actively HARMFUL: doing so raced Ink's own `focusNext()`
// reassigning `activeFocusId` on the identical Tab keypress, so the
// freshly-remounted `TextInput`'s `autoFocus` claim lost the race and it
// silently stopped accepting input afterward — confirmed by running the
// app and watching typed characters simply not appear. LIA-496 IB1 note:
// the pane this was originally written to switch AWAY from
// (`Sidebar.tsx`'s persistent `useFocus({id:"sidebar"})` rail) is gone —
// replaced by the transient `ThreadPicker.tsx` overlay, which fully
// replaces this component in `App.tsx`'s JSX while open rather than
// competing with it for Tab-focus — but the underlying lesson (don't
// unmount `ComposerPrimitive.Input` for pane-switching purposes) still
// governs this component's own mount lifecycle.
//
// STILL hides the real input for the one case that genuinely needs it: a
// permission decision pending. `PermissionPrompt.tsx` uses a plain
// always-active `useInput` (`{isActive: approval !== undefined &&
// !resolved}`, plus the arrow/enter/esc/ctrl+c handling I14 added — see
// that file's own header comment), NOT `useFocus` — it deliberately
// bypasses Ink's focus system so its keys resolve the prompt regardless of
// which pane currently has Tab-focus. If `ComposerPrimitive.Input` stayed
// mounted (and Tab-focused) at the same time, the SAME keystrokes would
// ALSO get typed into the composer buffer. Unmounting it here is safe (no
// competing App-level focus mechanism to race against, per the fix above),
// same reasoning LIA-495's ComposerRow used originally.
//
// LIA-496 IB4 (I14, D1's coexistence resolution) — while awaiting
// approval this component now renders NOTHING (`null`), not a disabled
// notice row. D1's decision, verbatim: "while an approval is pending, the
// dashed approval box is the sole bottom-region interactive surface" —
// the old notice row duplicated context the box itself now carries in its
// own hint row (`PermissionPrompt.tsx`), which is exactly the "two
// surfaces both talking about the same pending decision" GPT's review
// flagged. Full replacement (nothing rendered here at all) also preserves
// Fable's original value from the same review round — no live input stays
// mounted during a pending decision — without reintroducing the
// duplication. Reference check (per D1): Claude Code's own permission
// dialog occupies the input slot itself and never renders a second
// disabled line beneath it; Hermes' approval panel does the same.
import type { FC } from "react";
import { Box, Text } from "ink";
import { ComposerPrimitive, useAui, useAuiState } from "@assistant-ui/react-ink";
import { theme, COMPOSER_PROMPT } from "../theme";

// Exported (LIA-496 IB1 REVISE round — code-review finding, untested
// interaction) so `App.tsx`'s `useThreadNavigation` can gate opening
// `ThreadPicker` on the SAME "is a permission decision pending" check this
// component already uses to decide whether its own interactive input is
// safe to keep mounted — never a second, independently-drifting
// reimplementation of this predicate (this repo's own "never duplicate
// content across files" rule). See `App.tsx`'s `useThreadNavigation`
// header comment for the untested-interaction this closes: opening the
// picker mid-decision used to unmount the live `PermissionPrompt` and let
// `Enter` switch threads with the approval left permanently unresolved.
export function useIsAwaitingApproval(): boolean {
  return useAuiState((s) => {
    if (s.thread.isRunning) return false;
    const lastAssistant = [...s.thread.messages].reverse().find((m) => m.role === "assistant");
    return lastAssistant?.role === "assistant" && lastAssistant.status?.type === "requires-action";
  });
}

// LIA-496 IB1 (I3) — `onOpenThreadPicker` wires the composer's one
// slash-command (`/threads`, an alternate path to the same overlay
// `ctrl+t` opens) up to `App.tsx`'s picker state. Intercepted via
// `ComposerPrimitive.Input`'s own `onSubmit` override (confirmed real,
// `ComposerInput.tsx`, read directly) rather than a separate `useInput`
// racing the composer's own keystroke handling for the same Enter press.
// Supplying `onSubmit` replaces `ComposerInput`'s default submit body
// entirely (its own source: `if (onSubmit) { onSubmit(text); return; }`),
// so the non-command branch below reproduces that same default exactly —
// this is the ONE new place that behavior needs to be duplicated, not
// drift risk (there's nowhere to share it from without adding a prop
// `ComposerInput` itself doesn't expose).
export const Composer: FC<{ onOpenThreadPicker: () => void }> = ({ onOpenThreadPicker }) => {
  const awaitingApproval = useIsAwaitingApproval();
  const aui = useAui();

  if (awaitingApproval) {
    // I14 (D1) — no notice row. See this file's own header comment for
    // why full replacement (render nothing) is the correct fix, not a
    // disabled placeholder.
    return null;
  }

  return (
    <ComposerPrimitive.Root>
      <Box width="100%" borderStyle="single" borderColor={theme.line} borderBottom={false} borderLeft={false} borderRight={false} paddingX={1}>
        <Text color={theme.amber}>{COMPOSER_PROMPT}</Text>
        <ComposerPrimitive.Input
          submitOnEnter
          placeholder="ask deus to do something… (/threads for sessions)"
          autoFocus
          onSubmit={(text) => {
            if (text.trim() === "/threads") {
              aui.composer.setText("");
              onOpenThreadPicker();
              return;
            }
            const threadState = aui.thread.getState();
            if (threadState.isRunning && !threadState.capabilities.queue) return;
            aui.composer.send();
          }}
        />
      </Box>
    </ComposerPrimitive.Root>
  );
};

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
// Stays permanently mounted for Sidebar-vs-composer pane switching —
// **BUILD-stage finding, corrected after a real misdiagnosis** (see
// App.tsx's own header comment for the full trace): Ink's native
// `useFocus`/Tab-cycling genuinely works, and `TextInput`'s own
// `useInput` is already gated on ITS OWN `isFocused` (`{isActive:
// isFocused}`), so once Tab moves focus to `Sidebar.tsx`'s
// `useFocus({id:"sidebar"})`, this component's `TextInput` naturally stops
// reacting to keystrokes on its own — no unmounting needed, and
// unmounting it was actively HARMFUL: doing so raced Ink's own
// `focusNext()` reassigning `activeFocusId` on the identical Tab
// keypress, so the freshly-remounted `TextInput`'s `autoFocus` claim lost
// the race and it silently stopped accepting input afterward — confirmed
// by running the app and watching typed characters simply not appear.
//
// STILL hides the real input for the one case that genuinely needs it: a
// permission decision pending. `PermissionPrompt.tsx` uses a plain
// always-active `useInput` (`{isActive: !resolved}`), NOT `useFocus` — it
// deliberately bypasses Ink's focus system so `y`/`a`/`n` resolve the
// prompt regardless of which pane currently has Tab-focus. If
// `ComposerPrimitive.Input` stayed mounted (and Tab-focused) at the same
// time, the SAME `y`/`a`/`n` keystroke would ALSO get typed into the
// composer buffer. Unmounting it here is safe (no competing App-level
// focus mechanism to race against, per the fix above), same reasoning
// LIA-495's ComposerRow used originally.
import type { FC } from "react";
import { Box, Text } from "ink";
import { ComposerPrimitive, useAuiState } from "@assistant-ui/react-ink";
import { theme, COMPOSER_PROMPT } from "../theme";

function useIsAwaitingApproval(): boolean {
  return useAuiState((s) => {
    if (s.thread.isRunning) return false;
    const lastAssistant = [...s.thread.messages].reverse().find((m) => m.role === "assistant");
    return lastAssistant?.role === "assistant" && lastAssistant.status?.type === "requires-action";
  });
}

export const Composer: FC = () => {
  const awaitingApproval = useIsAwaitingApproval();

  if (awaitingApproval) {
    return (
      <Box borderStyle="single" borderColor={theme.line} borderBottom={false} borderLeft={false} borderRight={false} paddingX={1}>
        <Text color={theme.amber}>{COMPOSER_PROMPT}</Text>
        <Text color={theme.dim}>Resolve the permission prompt above to continue…</Text>
      </Box>
    );
  }

  return (
    <ComposerPrimitive.Root>
      <Box borderStyle="single" borderColor={theme.line} borderBottom={false} borderLeft={false} borderRight={false} paddingX={1}>
        <Text color={theme.amber}>{COMPOSER_PROMPT}</Text>
        <ComposerPrimitive.Input submitOnEnter placeholder="ask deus to do something…" autoFocus />
      </Box>
    </ComposerPrimitive.Root>
  );
};

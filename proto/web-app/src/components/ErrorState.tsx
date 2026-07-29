// LIA-496 — ErrorState.tsx <- rendered inside AssistantMessage (Thread.tsx),
// via ErrorPrimitive, for the one fixture thread scripted to throw from the
// adapter ("theme-swap-crash" — see shared/src/fixtures/conversations.ts's
// `themeSwapCrashTurn1` header comment for the exact mechanism: a real
// thrown Error inside run(), caught by @assistant-ui/core's
// LocalThreadRuntimeCore and turned into
// message.status={type:"incomplete",reason:"error",error}).
// `useMessageError()` returns undefined for every other message — this
// component renders null in that case, so it's safe to mount
// unconditionally inside every AssistantMessage.
//
// WB1 (LIA-496 review-fix) — W4 inline retry. `ActionBarPrimitive.Reload`
// is the SAME real "re-invoke the adapter for this message" mechanism
// ActionBar.tsx's own Reload button already uses live (see that file's
// header comment: "re-invokes the REAL adapter ... the mechanism is real;
// only the model is scripted") — not a second, parallel implementation.
// `useActionBarReload` disables itself when reload genuinely isn't
// available (thread running / not an assistant message), same self-disable
// contract every other action-button primitive in this app relies on.
// Known, out-of-scope fixture limit (not a new gap this component
// introduces): `themeSwapCrashScript.start` (conversations.ts) only
// scripts turnIndex 1 to throw; turnIndex 2+ falls to `unscripted()`
// (empty, non-erroring) — same documented "no second-attempt content
// scripted" limit `simpleScript`'s own header comment already states for
// its regenerate path. Retrying here re-invokes the real adapter (the
// affordance genuinely works) and lands on that same honest empty-turn
// fallback, not a fabricated "recovered" response — changing the crash
// script itself is outside WB1's sanctioned shared/ change (only the
// abortSignal check is sanctioned this batch).
import type { FC } from "react";
import { ActionBarPrimitive, ErrorPrimitive } from "@assistant-ui/react";
// useMessageError is exported from @assistant-ui/core/react, not
// @assistant-ui/react's own root (confirmed by grepping both dist/index.d.ts
// files directly — zero matches in @assistant-ui/react, two in
// @assistant-ui/core/react).
import { useMessageError } from "@assistant-ui/core/react";

export const ErrorState: FC = () => {
  const error = useMessageError();
  if (error === undefined) return null;
  return (
    <ErrorPrimitive.Root className="s-error">
      <div className="h">Something went wrong</div>
      <ErrorPrimitive.Message />
      <ActionBarPrimitive.Reload className="s-error-retry">Try again</ActionBarPrimitive.Reload>
    </ErrorPrimitive.Root>
  );
};

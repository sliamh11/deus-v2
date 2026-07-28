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
import type { FC } from "react";
import { ErrorPrimitive } from "@assistant-ui/react";
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
    </ErrorPrimitive.Root>
  );
};

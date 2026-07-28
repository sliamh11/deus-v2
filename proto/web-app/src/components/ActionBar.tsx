// LIA-496 — ActionBar.tsx <- Thread.tsx's per-message footer, mounted via
// ActionBarPrimitive.Root inside AssistantMessage (Thread.tsx). Copy is
// real (ActionBarPrimitive.Copy uses the message's own text, real
// clipboard write). Reload/regenerate re-invokes the REAL adapter
// (ActionBarPrimitive.Reload -> ThreadRuntime.startRun on this message's
// parent), which shared/src/adapter.ts's per-thread turnIndex counter
// naturally advances on re-run — so the mechanism is real; only the model
// is scripted (§ Feature scope's "honest fakes").
import type { FC } from "react";
import { ActionBarPrimitive } from "@assistant-ui/react";

export const ActionBar: FC = () => {
  return (
    <ActionBarPrimitive.Root className="s-actionbar" hideWhenRunning autohide="not-last" autohideFloat="single-branch">
      <ActionBarPrimitive.Copy className="s-abtn">Copy</ActionBarPrimitive.Copy>
      <ActionBarPrimitive.Reload className="s-abtn">Reload</ActionBarPrimitive.Reload>
    </ActionBarPrimitive.Root>
  );
};

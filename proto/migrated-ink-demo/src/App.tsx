// LIA-495 — Ink equivalent of web-first-demo's App, itself ported from
// full-shell.tsx's `App`: header, transcript, in-progress spinner row,
// tasks footer, composer. Same `useLocalRuntime(adapter)` +
// `AssistantRuntimeProvider` + `ThreadPrimitive` composition web-first-demo
// used, restored to the Ink target's own primitives — a max-width `<div>`
// column becomes an Ink `<Box width={104}>` column.
//
// NotificationBridge is restored here (full-shell.tsx had it,
// web-first-demo dropped it): `useNotification()` fires a real terminal
// BEL + OSC 9 escape sequence on each scripted turn's `status:
// {type:"complete"}` yield — confirmed present in @assistant-ui/react-ink
// and confirmed ABSENT from @assistant-ui/react's web export by
// web-first-demo's setup stage ("useNotification" has zero matches under
// node_modules/@assistant-ui/react/dist). This is the mirror image of the
// DiffView/LiveChecklist asymmetry: here Ink has a real primitive the web
// target genuinely lacks, so restoring it is a legitimate part of porting
// back to Ink's full primitive surface, not scope creep.
import type { FC } from "react";
import { Box } from "ink";
import { AssistantRuntimeProvider, useLocalRuntime, ThreadPrimitive, useNotification } from "@assistant-ui/react-ink";
import { adapter } from "./runtime/adapter";
import { Header } from "./components/Header";
import { ActiveStatusRow } from "./components/Spinner";
import { TasksFooter } from "./components/TasksFooter";
import { ComposerRow } from "./components/Composer";
import { UserMessage, AssistantMessage, ToolUIRegistrations } from "./components/Messages";

const NotificationBridge: FC = () => {
  useNotification();
  return null;
};

const App: FC = () => {
  const runtime = useLocalRuntime(adapter);
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ToolUIRegistrations />
      <Box flexDirection="column" width={104}>
        <Header />
        <ThreadPrimitive.Root>
          <ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage }} />
          <ThreadPrimitive.If running>
            <ActiveStatusRow />
          </ThreadPrimitive.If>
          <TasksFooter />
          <ComposerRow />
        </ThreadPrimitive.Root>
      </Box>
      <NotificationBridge />
    </AssistantRuntimeProvider>
  );
};

export default App;

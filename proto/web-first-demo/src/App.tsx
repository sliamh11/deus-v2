// LIA-495 — the composed shell, ported from full-shell.tsx's `App`: header,
// transcript, in-progress spinner row, tasks footer, composer. Same
// `useLocalRuntime(adapter)` + `AssistantRuntimeProvider` + `ThreadPrimitive`
// composition; an Ink `<Box width={104}>` column becomes a max-width `<div>`
// column, and there is no `NotificationBridge` (full-shell.tsx's
// `useNotification()` fires a real terminal BEL + OSC 9 escape sequence —
// confirmed absent from @assistant-ui/react's web export, "useNotification"
// has zero matches under node_modules/@assistant-ui/react/dist — this was
// out of this ticket's six required pieces, so it's dropped rather than
// faked with a browser Notification API call the setup stage never
// verified).
import type { FC } from "react";
import { AssistantRuntimeProvider, useLocalRuntime, ThreadPrimitive } from "@assistant-ui/react";
import { adapter } from "./runtime/adapter";
import { Header } from "./components/Header";
import { ActiveStatusRow } from "./components/Spinner";
import { TasksFooter } from "./components/TasksFooter";
import { ComposerRow } from "./components/Composer";
import { UserMessage, AssistantMessage, ToolUIRegistrations } from "./components/Messages";

const App: FC = () => {
  const runtime = useLocalRuntime(adapter);
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ToolUIRegistrations />
      <div style={{ width: "100%", maxWidth: 860, display: "flex", flexDirection: "column" }}>
        <Header />
        <ThreadPrimitive.Root>
          <ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage }} />
          <ThreadPrimitive.If running>
            <ActiveStatusRow />
          </ThreadPrimitive.If>
          <TasksFooter />
          <ComposerRow />
        </ThreadPrimitive.Root>
      </div>
    </AssistantRuntimeProvider>
  );
};

export default App;

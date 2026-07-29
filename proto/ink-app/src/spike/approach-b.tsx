// LIA-496 IB1 spike — Approach B: by-index provider.
// SPIKE-ONLY scratch entry point. Not wired into App.tsx.
//
// Wraps the EXISTING, UNMODIFIED UserMessage/AssistantMessage components
// (imported straight from components/Messages.tsx, zero changes) in
// MessageByIndexProvider per committed message index, driven by
// unstable_useThreadMessageIds. A real AssistantRuntimeProvider +
// useLocalRuntime backs this — MessageByIndexProvider needs a real `aui`
// store to derive `aui.thread.message({index})` from
// (node_modules/@assistant-ui/core/dist/react/providers/
// MessageByIndexProvider.js, read directly). `initialMessages` seeds the
// thread with the fixture turn already complete — no streaming adapter
// needed for this spike.
import type { FC } from "react";
import { render, Box, Text, Static } from "ink";
import {
  AssistantRuntimeProvider,
  useLocalRuntime,
  useAuiState,
  MessageByIndexProvider,
  unstable_useThreadMessageIds,
} from "@assistant-ui/react-ink";
import type { ChatModelAdapter } from "@assistant-ui/react-ink";
import { theme } from "../theme";
import { UserMessage, AssistantMessage } from "../components/Messages";
import { SPIKE_INITIAL_MESSAGES } from "./fixture";

// Never actually invoked in this spike (initialMessages already supplies
// the complete turn) — required only because useLocalRuntime's first
// argument is mandatory.
const neverRunAdapter: ChatModelAdapter = {
  async *run() {
    // eslint-disable-next-line no-console
    console.error("[approach-b SPIKE FAIL] chatModel.run() invoked — fixture should not have needed a live turn");
    yield { content: [] };
  },
};

// Mirrors ThreadMessages.tsx's own internal `getComponent`/role-switch
// (node_modules/@assistant-ui/react-ink/dist/primitives/thread/
// ThreadMessages.js, read directly) — the smallest amount of new code
// needed to pick UserMessage vs AssistantMessage once MessageByIndexProvider
// has scoped the context to one message.
const RoleSwitch: FC = () => {
  const role = useAuiState((s) => s.message.role);
  if (role === "user") return <UserMessage />;
  return <AssistantMessage />;
};

// Committed batch: waits for both fixture messages to exist in the live
// thread state, then renders them into <Static> exactly once via a stable
// `items` array — same "commit once, never re-render" contract IB1's real
// committed-blocks module will need, just hand-rolled for this spike
// instead of windowSize-driven like the library's own internal
// ThreadMessagesInner.
const CommittedBatch: FC = () => {
  const ids = unstable_useThreadMessageIds();
  if (ids.length < 2) {
    return <Text color={theme.dim}>(waiting for fixture messages to land in thread state…)</Text>;
  }
  const indices = [0, 1];
  return (
    <Static items={indices}>
      {(index) => (
        <MessageByIndexProvider index={index} key={index}>
          <RoleSwitch />
        </MessageByIndexProvider>
      )}
    </Static>
  );
};

const SpikeApp: FC = () => {
  const runtime = useLocalRuntime(neverRunAdapter, { initialMessages: SPIKE_INITIAL_MESSAGES });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <Box flexDirection="column" width={104}>
        <Text color={theme.amber} bold>
          === Approach B (by-index provider) — rendered inside &lt;Static&gt; ===
        </Text>
        <CommittedBatch />
        <Text color={theme.ok}>=== end of Static output — dynamic tail below ===</Text>
      </Box>
    </AssistantRuntimeProvider>
  );
};

render(<SpikeApp />);

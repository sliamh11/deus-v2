// LIA-496 IB1 (I5) — ← App.tsx (`MainPane`, confirm that link there, not
// here), rendered once, dynamically, directly above `Composer`. Replaces
// the old boxed header row's live status half (`App.tsx:167-182`'s
// `model: sonnet-5` text) and old `Sidebar.tsx`'s footer
// (`Sidebar.tsx:260-263`, which also hardcoded the identity this file
// sanitizes — see `identity.ts`'s header comment). The other half of the
// old header (product name/model, static per-session) moved into
// `committedBlocks.tsx`'s once-printed identity banner instead — this line
// is only the parts that are genuinely LIVE (current cwd, and the
// keybindings this batch actually wires).
//
// LIA-496 IB3 (I11) — the dynamic status row itself. `@assistant-ui/
// react-ink` already ships real primitives for exactly this — confirmed by
// reading `node_modules/@assistant-ui/react-ink/dist/primitives/loading/
// index.d.ts` (`LoadingPrimitive.Root/Spinner/Text/ElapsedTime`) and
// `.../primitives/statusBar.d.ts` (`StatusBarPrimitive.Root/ModelName/
// MessageCount/TokenCount/Latency/Status`) directly — this file COMPOSES
// those, it does not hand-roll a spinner/timer/run-state check from
// scratch. `LoadingPrimitive.Root` itself is `null` unless
// `useThreadIsRunning()` is true (`LoadingRoot.js`, read directly) — so
// nesting the spinner/elapsed-time block inside it is what makes those two
// fields appear ONLY while a turn is actually running, with zero local
// run-state boolean of our own duplicating that check. Only two things
// here are genuinely custom, per this batch's own dispatch: the esc-cancel
// wiring below, and which of the available StatusBar/Loading fields this
// row actually shows (deliberately NOT all of them — `MessageCount`/
// `TokenCount`/`Latency` would be real but noisy for a compact one-line
// status row; the model name + live run-state + the keybinding hint this
// batch is actually about are the fields worth this row's width).
import type { FC } from "react";
import { Box, Text, useInput } from "ink";
import { useAuiState } from "@assistant-ui/react-ink";
// `useComposerCancel` is NOT re-exported by `@assistant-ui/react-ink`'s own
// `dist/index.d.ts` (confirmed: zero matches grepping that file directly)
// — only `@assistant-ui/core/react` exports it. Same import shape the web
// target's own WB1 batch already established for `useStreamingTiming`
// (`web-app/src/components/Thread.tsx`, its own header comment cites the
// identical re-export gap) — not a new pattern, the proven one.
import { useComposerCancel } from "@assistant-ui/core/react";
import { LoadingPrimitive, StatusBarPrimitive } from "@assistant-ui/react-ink";
import { theme, STATUS_COLOR } from "../theme";
import { getCwdLabel, MODEL_NAME } from "../identity";

export const StatusLine: FC = () => {
  const isRunning = useAuiState((s) => s.thread.isRunning);
  // The genuinely custom half of I11: interrupt. `useComposerCancel` is the
  // SAME core hook `ComposerPrimitive.Cancel` (the web target's own W1 stop
  // control) wraps internally (confirmed by reading `react-ink`'s own
  // `ComposerCancel.js` directly) — calling it here reaches the identical
  // `abortSignal` WB1 already proved genuinely halts the shared fixture
  // generator (`shared/src/adapter.ts`/`stream.ts`'s own abortSignal
  // threading), not a second, parallel cancellation path. `disabled` is
  // checked (not just `isActive: isRunning`) for the same reason
  // `ComposerPrimitive.Cancel` self-disables on `!canCancel` — a real
  // capability gate, not a guess.
  const { cancel, disabled: cancelDisabled } = useComposerCancel();

  useInput(
    (_input, key) => {
      if (key.escape && !cancelDisabled) cancel();
    },
    { isActive: isRunning },
  );

  return (
    <Box paddingX={2}>
      <StatusBarPrimitive.Root>
        <LoadingPrimitive.Root>
          <LoadingPrimitive.Spinner color={theme.amber} />
          <Text> </Text>
        </LoadingPrimitive.Root>
        <StatusBarPrimitive.ModelName name={MODEL_NAME} color={STATUS_COLOR.ok} />
        <LoadingPrimitive.Root>
          <Text color={theme.dim}> </Text>
          <LoadingPrimitive.ElapsedTime color={theme.dim} />
        </LoadingPrimitive.Root>
        <Text color={theme.dim}>
          {" · "}
          {getCwdLabel()}
          {" · "}
          {isRunning ? "esc interrupt" : "ctrl+t threads · ctrl+n new · ? help"}
        </Text>
      </StatusBarPrimitive.Root>
    </Box>
  );
};

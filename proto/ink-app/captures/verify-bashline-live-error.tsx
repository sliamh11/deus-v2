// LIA-496 IB2 round-2 fix verification (Messages.tsx BashLine auto-expand-
// on-error, code-review REVISE finding). Standalone repro, not a
// tmux/asciinema recording capture — this scenario is latent (no fixture
// Bash error result exceeds 5 lines, per the finding itself), so there is
// no existing rendered capture to re-run; this proves the FIX mechanism
// directly instead: mount BashLine while `pending` (isError=false,
// matching a live-streaming tool call whose result hasn't arrived yet),
// then `rerender()` the SAME instance with the error result attached —
// exactly the sequence the finding described as broken (a mount-time-only
// `useState(isError)` initializer never seeing the later transition).
//
// Needs a real TTY (BashLine's ctrl+o `useInput` requires raw-mode
// support), so it's driven under `tmux`/`captures/run-bashline-live-error-verify.sh`,
// same mechanism as this repo's other captures — not run bare under tsx.
//
// Run:  bash captures/run-bashline-live-error-verify.sh   (from ink-app/)
import { render } from "ink";
import React from "react";
import { BashLine } from "../src/components/Messages";

const LONG_ERROR = Array.from({ length: 8 }, (_, i) => `stack frame ${i + 1}: boom`).join("\n");

const pendingProps: any = {
  toolName: "Bash",
  toolCallId: "verify-1",
  args: { command: "run-the-thing" },
  argsText: "run-the-thing",
  result: undefined,
  isError: false,
};

const errorProps: any = {
  ...pendingProps,
  result: LONG_ERROR,
  isError: true,
};

const { rerender } = render(<BashLine {...pendingProps} />);

// Simulate the pending -> error transition arriving on the SAME live
// instance (no unmount/remount) — the exact window the finding named.
setTimeout(() => {
  rerender(<BashLine {...errorProps} />);
}, 300);

// Leave the process alive long enough for `tmux capture-pane` to read the
// settled (post-effect) frame, then exit.
setTimeout(() => {
  process.exit(0);
}, 1500);

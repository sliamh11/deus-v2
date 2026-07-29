// LIA-496 — the ToolCallMessagePart renderer for approval-gated tools
// (registered against `delete_file` in Messages.tsx's `AssistantMessage` —
// confirm that link there, not here). Three states, driven entirely by
// `props.approval` (the library-owned data model, from
// shared/src/permissions.ts — never a local reimplementation):
//
//   1. `approval` undefined at all — the grant-store proof
//      (shared/src/permissions.ts's header comment): the adapter built this
//      tool-call WITHOUT an `approval` field because the session already
//      granted this permission class. Nothing here to key a prompt off of,
//      so this renders a plain inert completed line — NOT a permission box.
//      A dashed box rendering here would be the exact FAIL this stage's
//      dispatch calls out ("if a prompt renders, that's a FAIL").
//   2. `approval` present, unresolved (`approved === undefined` and no
//      `resolution`) — the dashed-equivalent box with [y]/[a]/[n] hints,
//      resolved via `useInput`.
//   3. `approval` present, resolved — a one-line summary.
//
// The actual delete + subsequent-turn continuation happens inside
// shared/src/fixtures/conversations.ts's `turn1Continue`/`turn3Continue`
// (invoked by the adapter once `respondToApproval` triggers its
// auto-continuation) — NOT in this component. This component's only job on
// confirm is calling `respondToApproval`; it never calls `performDelete`
// itself (that would race the exact continuation trigger
// shared/src/permissions.ts's header comment warns about).
//
// LIA-496 IB4 (I14, D1's coexistence resolution) — case 2's box (below)
// now does three more things the plain y/a/n hints didn't:
//   - **Arrow+enter navigation with a visible default.** `OPTIONS` is an
//     ordered array; `selected` (a `useState`, hoisted above every early
//     return same as `useInput` already is, for the identical Rules of
//     Hooks reason the comment below explains) starts at index 0 — "allow
//     once", the least-broad grant, deliberately NOT "always allow"
//     (defaulting Enter to the broadest grant would reintroduce exactly
//     the kind of scope-blindness W15's "Always allow doesn't state scope"
//     finding is about, just on the Ink side). Left/up and right/down
//     arrows move the selection with wraparound; Enter resolves whichever
//     option is currently highlighted. The highlighted option is rendered
//     with a `▸` caret + bold/underline (not a conditionally-bordered Box,
//     which would shift the row's width between renders during a capture).
//   - **esc / ctrl+c = deny.** `key.escape` resolves deny directly. ctrl+c
//     requires `main.tsx` to pass `exitOnCtrlC: false` to `render()` —
//     verified necessary by reading `ink/build/hooks/use-input.js`
//     directly: with the default `exitOnCtrlC: true`, a ctrl+c keypress
//     never reaches ANY `useInput` consumer at all (Ink's own `handleData`
//     filters it out before calling `inputHandler`); Ink's App-level
//     `handleInput` exits the process directly instead. `main.tsx`'s
//     header comment carries the full trace; `App.tsx`'s
//     `useThreadNavigation` owns the "no approval pending" ctrl+c-exits
//     fallback so the app can still be quit normally once this flag flips.
//   - **The hint row's context, per D1.** `Composer.tsx`'s old
//     "Resolve the permission prompt above to continue…" notice row is
//     gone entirely (D1: the dashed box below is now the SOLE
//     bottom-region interactive surface, not one of two surfaces both
//     talking about the same pending decision) — the "why is typing dead"
//     context that notice used to carry now lives in this box's own
//     bottom hint line instead.
//   - y/a/n single-key accelerators are UNCHANGED and still resolve
//     immediately, same as before — arrow+enter is an addition, not a
//     replacement of the fast path.
import { type FC, useState } from "react";
import { Box, Text, useInput } from "ink";
import type { ToolCallMessagePartProps } from "@assistant-ui/react-ink";
import { extractPath, executionOutcomes, decisionFromOptionId, type PermissionDecision } from "@lia496/shared";
import { theme } from "../theme";

// I14 (D1) — ordered so index 0 is the default (see the header comment's
// "Arrow+enter navigation with a visible default" paragraph for why "allow
// once", not "always allow", is index 0). `keyCap` is the existing y/a/n
// accelerator, unchanged; `approved`/`optionId` feed `respondToApproval`
// with the exact same shape the old handler already used.
const OPTIONS: { optionId: PermissionDecision; keyCap: string; label: string; approved: boolean }[] = [
  { optionId: "allow_once", keyCap: "y", label: "allow once", approved: true },
  { optionId: "allow_always", keyCap: "a", label: "always allow", approved: true },
  { optionId: "deny", keyCap: "n", label: "deny", approved: false },
];

const DASHED_BORDER = {
  topLeft: "┌",
  top: "╌",
  topRight: "┐",
  right: "╎",
  bottomRight: "┘",
  bottom: "╌",
  bottomLeft: "└",
  left: "╎",
};

const GLYPH = "●";

function decisionLabel(decision: PermissionDecision): string {
  switch (decision) {
    case "allow_once":
      return "Allow once";
    case "allow_always":
      return "Always allow";
    case "deny":
      return "Deny";
    default: {
      const _exhaustive: never = decision;
      return _exhaustive;
    }
  }
}

const ResolvedLine: FC<{ props: ToolCallMessagePartProps; path: string | undefined; decision: PermissionDecision }> = ({
  props,
  path,
  decision,
}) => {
  const deleted = executionOutcomes.get(props.toolCallId);
  const outcome = decision === "deny" ? undefined : deleted === undefined ? "awaiting execution" : deleted ? "deleted" : "delete failed";
  const color = decision === "deny" ? theme.err : deleted === undefined ? theme.amber : deleted ? theme.ok : theme.err;

  return (
    <Box marginBottom={1}>
      <Text color={color}>
        {GLYPH} delete_file({path ?? props.argsText}) — {decisionLabel(decision)}
        {outcome ? ` (${outcome})` : ""}
      </Text>
    </Box>
  );
};

export const PermissionPrompt: FC<ToolCallMessagePartProps> = (props) => {
  const path = extractPath(props.args);
  const approval = props.approval;
  const resolved = approval !== undefined && (approval.approved !== undefined || approval.resolution !== undefined);
  // I14 — hoisted above every return for the identical Rules of Hooks
  // reason `useInput` below already is (see that comment): must stay a
  // `useState` call on every render regardless of which branch this
  // component ends up taking.
  const [selected, setSelected] = useState(0);

  // Code-review fix (LIA-496 REVISE round): `useInput` used to sit AFTER
  // the `!approval` early return below — a Rules of Hooks violation
  // (oxlint's `react/rules-of-hooks` is enabled on web-app's config but
  // NOT on ink-app's, which is why it went uncaught; this is a genuine
  // source defect independent of whether lint happens to flag it).
  // Latent today only because a given tool-call part's `props.approval`
  // never flips from undefined to defined across renders of the SAME
  // component instance in this fixture's scripted flow — but if the
  // adapter ever streamed a part first without and then with an
  // `approval` field, this exact instance would go from 0 hooks called to
  // 1, crashing with a hook-count mismatch. Hoisted above every return so
  // the hook count is identical on every render regardless of branch;
  // `isActive`/the callback's own guard both account for the `!approval`
  // case (no approval field at all means nothing here to resolve).
  //
  // I14 additions (D1) — arrow/enter navigation, esc/ctrl+c deny; see this
  // file's header comment for the full rationale and the `exitOnCtrlC`
  // mechanism ctrl+c depends on (`main.tsx`).
  useInput(
    (input, key) => {
      if (!approval || resolved) return;
      if (key.leftArrow || key.upArrow) {
        setSelected((i) => (i + OPTIONS.length - 1) % OPTIONS.length);
        return;
      }
      if (key.rightArrow || key.downArrow) {
        setSelected((i) => (i + 1) % OPTIONS.length);
        return;
      }
      if (key.return) {
        const opt = OPTIONS[selected]!;
        props.respondToApproval({ approved: opt.approved, optionId: opt.optionId });
        return;
      }
      if (key.escape || (key.ctrl && input === "c")) {
        props.respondToApproval({ approved: false, optionId: "deny" });
        return;
      }
      // I16 verification finding (LIA-496 IB4) — reproduced live before
      // fixing: without this guard, ctrl+n (App.tsx's global new-thread
      // binding) fell through to the bare `input === "n"` check below and
      // silently resolved this prompt as Deny — Ink normalizes ctrl+n to
      // `{input: "n", key: {ctrl: true}}` (confirmed by reading
      // `ink/build/hooks/use-input.js`'s own key-derivation directly, not
      // assumed), and none of the three branches below checked `key.ctrl`,
      // so a ctrl-held "n" satisfied the same bare-string comparison a
      // literal "n" keypress does. `App.tsx`'s `useThreadNavigation` guard
      // against `ctrl+n` firing DURING a pending approval was correct and
      // necessary but not sufficient on its own — both `useInput` hooks
      // receive the same emitted keypress independently, and this
      // component's own accelerator branch needed the identical guard.
      // Any other ctrl-combo (ctrl+t included) is likewise not one of this
      // prompt's own bindings — ignored here so it falls through to
      // `App.tsx`'s own already-correct `hasPendingApproval` no-op instead
      // of accidentally matching a bare-letter shortcut.
      if (key.ctrl) return;
      if (input === "y") props.respondToApproval({ approved: true, optionId: "allow_once" });
      else if (input === "a") props.respondToApproval({ approved: true, optionId: "allow_always" });
      else if (input === "n") props.respondToApproval({ approved: false, optionId: "deny" });
    },
    { isActive: approval !== undefined && !resolved },
  );

  // Case 1 — grant-store auto-approval: no `approval` field at all. Render
  // as an inert completed line, no prompt.
  if (!approval) {
    const deleted = executionOutcomes.get(props.toolCallId);
    const outcome = deleted === undefined ? "awaiting execution" : deleted ? "deleted (always-allow, no prompt)" : "delete failed";
    return (
      <Box marginBottom={1}>
        <Text color={theme.dim}>
          {GLYPH} delete_file({path ?? props.argsText}) — {outcome}
        </Text>
      </Box>
    );
  }

  if (resolved) {
    if (approval.resolution) {
      return (
        <Box marginBottom={1}>
          <Text color={theme.amber}>
            {GLYPH} delete_file({path ?? props.argsText}) — request {approval.resolution}, no decision made
          </Text>
        </Box>
      );
    }
    const decision: PermissionDecision =
      decisionFromOptionId(approval.optionId) ?? (approval.approved ? "allow_once" : "deny");
    return <ResolvedLine props={props} path={path} decision={decision} />;
  }

  return (
    <Box flexDirection="column" borderStyle={DASHED_BORDER} borderColor={theme.dim} paddingX={1} marginY={1}>
      <Text color={theme.ink}>
        delete {path ?? props.argsText} ?
      </Text>
      {/* I1 (LIA-496 IB1) — literal dark foreground on all three key-cap
          chips below, not `theme.ink` (light): these chips carry their OWN
          local `backgroundColor` (never removed by I1's global-background
          deletion), so their text must stay a genuinely dark color to read
          against it regardless of what the surrounding frame does.
          `theme.bg` is the right literal here specifically because it's a
          real dark hex value, matched across all three chips, not because
          it still means "the app background" (that global usage is gone).
          I14 (LIA-496 IB4) — the row is now driven by `OPTIONS` + `selected`
          instead of three hand-written `Text` pairs, so the highlighted
          (default/currently-selected) option can render a `▸` caret +
          bold/underline without hand-duplicating the row a second time. */}
      <Box marginTop={1}>
        {OPTIONS.map((opt, i) => {
          const isSelected = i === selected;
          return (
            <Box key={opt.optionId} marginRight={i < OPTIONS.length - 1 ? 3 : 0}>
              <Text color={isSelected ? theme.ink : theme.dim}>{isSelected ? "▸ " : "  "}</Text>
              <Text backgroundColor={opt.optionId === "deny" ? theme.dim : theme.amber} color={theme.bg}>
                {` ${opt.keyCap} `}
              </Text>
              <Text color={isSelected ? theme.ink : theme.dim} bold={isSelected} underline={isSelected}>
                {" "}
                {opt.label}
              </Text>
            </Box>
          );
        })}
      </Box>
      {/* I14 (D1's coexistence resolution) — this hint row carries the
          "why is typing dead" context `Composer.tsx`'s old notice row used
          to (that row is gone entirely now; see this file's header
          comment and `Composer.tsx`'s own for why). */}
      <Box marginTop={1}>
        <Text color={theme.dim}>
          ←/→ select · enter confirm{selected === 0 ? " (default)" : ""} · esc/ctrl+c deny · y/a/n shortcuts —
          composer paused until this resolves
        </Text>
      </Box>
    </Box>
  );
};

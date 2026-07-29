// LIA-496 IB3 (I12) — ← App.tsx (`MainPane`, confirm that link there, not
// here). A brand-new rendering surface, same shape as `ThreadPicker.tsx`
// (I3): a transient, full-width overlay swapped into the dynamic tail in
// place of `Composer`/`StatusLine` while open, unmounted on close — not a
// second competing focus surface. Toggled two ways, per this batch's own
// dispatch:
//   - `?`, a single raw keypress, but ONLY while the composer is genuinely
//     empty — see `Composer.tsx`'s header comment for why that trigger is
//     implemented by watching the committed composer TEXT (`s.composer.text
//     === "?"`) rather than a second competing `useInput` listener; this
//     file only owns the CLOSE half of that interaction.
//   - `/help`, a composer slash command (`Composer.tsx`'s `onSubmit`
//     override, same mechanism `/threads` already uses).
// Resolves this batch's own dispatch requirement head-on: round-3
// plan-review flagged that `ThreadPicker.tsx` (round 2) got a dedicated
// consuming-call-site + capture fix but the help overlay — a second
// brand-new rendering surface — did not; this file (and its own dedicated
// asciinema capture, see `VERIFICATION.md`) closes that exact gap.
//
// Content is a static, hand-audited list of this app's REAL keybindings as
// of this batch (IB1 + IB3) — not a placeholder/aspirational list. Grouped
// by when each binding actually applies, since a flat list would imply e.g.
// `y`/`a`/`n` are always live, when they only resolve a LIVE permission
// prompt (which — like this overlay — fully replaces the composer while
// pending, per `Composer.tsx`'s `awaitingApproval` branch; the two can
// never be on screen at once).
import type { FC } from "react";
import { Box, Text, useInput } from "ink";
import { theme } from "../theme";

type BindingRow = { keys: string; description: string };
type BindingGroup = { heading: string; rows: BindingRow[] };

const KEY_COLUMN_WIDTH = 20;

const BINDING_GROUPS: readonly BindingGroup[] = [
  {
    heading: "navigation (always live)",
    rows: [
      { keys: "ctrl+t / /threads", description: "open the thread list" },
      { keys: "ctrl+n", description: "start a new session" },
    ],
  },
  {
    heading: "while a turn is running",
    rows: [{ keys: "esc", description: "interrupt — stop generating" }],
  },
  {
    heading: "a permission prompt is pending",
    rows: [
      { keys: "y", description: "allow once" },
      { keys: "a", description: "always allow (this session)" },
      { keys: "n", description: "deny" },
    ],
  },
  {
    heading: "this overlay",
    rows: [
      { keys: "? / /help", description: "toggle keybindings help" },
      { keys: "esc", description: "close" },
    ],
  },
];

export const HelpOverlay: FC<{ onClose: () => void }> = ({ onClose }) => {
  // Mirrors `ThreadPicker.tsx`'s own always-active `useInput` for `esc` —
  // this component only exists while mounted (the overlay-swap in
  // `App.tsx` unmounts it on close), so `isActive: true` here is scoped
  // correctly by mount lifecycle alone, same reasoning as that file's.
  // `?` closes too (the toggle's own "press it again" half — the raw `?`
  // OPEN keypress is watched from `Composer.tsx` instead, since the
  // composer isn't mounted while this overlay is open to receive it here).
  useInput((input, key) => {
    if (key.escape || input === "?") onClose();
  });

  return (
    <Box
      flexDirection="column"
      width="100%"
      borderStyle="round"
      borderColor={theme.line}
      paddingX={1}
      paddingY={1}
      marginY={1}
    >
      <Box marginBottom={1} justifyContent="space-between">
        <Text color={theme.ink} bold>
          keybindings
        </Text>
        <Text color={theme.dim}>esc / ? close</Text>
      </Box>
      {BINDING_GROUPS.map((group) => (
        <Box key={group.heading} flexDirection="column" marginBottom={1}>
          <Text color={theme.dim}>
            {"── "}
            {group.heading}
          </Text>
          {group.rows.map((row) => (
            <Box key={row.keys}>
              <Text color={theme.amber}>{row.keys.padEnd(KEY_COLUMN_WIDTH)}</Text>
              <Text color={theme.ink}>{row.description}</Text>
            </Box>
          ))}
        </Box>
      ))}
    </Box>
  );
};

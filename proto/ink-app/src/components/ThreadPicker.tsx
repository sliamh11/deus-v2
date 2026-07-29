// LIA-496 IB1 (I3) — ← App.tsx (`MainPane`, confirm that link there, not
// here). Replaces the old persistent `Sidebar.tsx` (deleted by this
// batch): a persistent 34-column rail is geometrically impossible once
// transcript lines are printed into real terminal scrollback (I2's
// `<Static>` model) — this is a TRANSIENT full-width overlay in the
// dynamic tail instead, mounted only while open, unmounted on close.
//
// Reuses the old Sidebar's real interaction model wholesale (day-bucket
// grouping, cursor/enter/d-with-confirm) — only the presentation shape
// (persistent 34-col rail vs. transient full-width overlay) and the
// mount lifecycle (always-mounted vs. open/close) changed. `ThreadIds`
// (not `Object.keys(threadItems)`) is still the index space this reads
// against, same fix/reasoning as old `Sidebar.tsx`'s own header comment on
// why that matters for `headerFor`'s day-bucket boundaries.
//
// "n: new session" is real (calls `onNewSession`, wired by `App.tsx` to
// the SAME `triggerNewThread` the global `ctrl+n` binding uses — see that
// file's header comment for why the fresh-draft bookkeeping has to live
// in an always-mounted component, not here, since this component itself
// unmounts on close) — replacing the old sidebar's disabled fake
// "+ new session" affordance.
import { useState, type FC } from "react";
import { Box, Text, useInput } from "ink";
import { useAui, useAuiState } from "@assistant-ui/react-ink";
import { theme } from "../theme";

function isSameCalendarDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

// Code-review fix (LIA-496 REVISE round — low-severity finding, same
// untruthful-bucketing class the web review's own W6 caught): the old
// `headerFor` only ever distinguished "today" from a catch-all "yesterday"
// — a 9-day-old thread rendered under a "── yesterday" header exactly as if
// it were from the day before, since `isToday` was the ONLY thing being
// compared. Real calendar-day distance, not a boolean, decides the bucket
// now — "today" / "yesterday" / "previous 7 days" / "older", the same
// truthful bucket set the plan's W6 fix names for the web sidebar.
type DayBucket = "today" | "yesterday" | "previous 7 days" | "older";

const BUCKET_LABEL: Record<DayBucket, string> = {
  today: "today",
  yesterday: "yesterday",
  "previous 7 days": "previous 7 days",
  older: "older",
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function bucketFor(lastMessageAt: Date | undefined, now: Date): DayBucket {
  if (!lastMessageAt) return "today"; // no timestamp at all — treat as brand-new
  if (isSameCalendarDay(lastMessageAt, now)) return "today";
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfThat = new Date(lastMessageAt.getFullYear(), lastMessageAt.getMonth(), lastMessageAt.getDate());
  const dayDiff = Math.round((startOfToday.getTime() - startOfThat.getTime()) / MS_PER_DAY);
  if (dayDiff === 1) return "yesterday";
  if (dayDiff >= 2 && dayDiff <= 7) return "previous 7 days";
  return "older";
}

const PickerRow: FC<{ id: string; title: string | undefined; isMain: boolean; highlighted: boolean; showHeader: string | undefined }> = ({
  title,
  isMain,
  highlighted,
  showHeader,
}) => (
  <Box flexDirection="column">
    {showHeader ? (
      <Text color={theme.dim}>
        {"── "}
        {showHeader}
      </Text>
    ) : null}
    {/* I1 — the ONLY local background this file keeps: the cursor row,
        via Ink's `inverse` (swaps fg/bg for exactly this one line), same
        as old Sidebar.tsx's row highlight. */}
    <Text color={isMain ? theme.amber : theme.dim} inverse={highlighted} wrap="truncate-end">
      {isMain ? "▸ " : "  "}
      {title ?? "(untitled)"}
    </Text>
  </Box>
);

export const ThreadPicker: FC<{ onClose: () => void; onNewSession: () => void }> = ({ onClose, onNewSession }) => {
  const aui = useAui();
  const threadIds = useAuiState((s) => s.threads.threadIds);
  const threadItems = useAuiState((s) => s.threads.threadItems);
  const mainThreadId = useAuiState((s) => s.threads.mainThreadId);
  const items = threadIds
    .map((id) => threadItems.find((item) => item.id === id))
    .filter((item): item is NonNullable<typeof item> => item !== undefined);
  const [cursor, setCursor] = useState(() => Math.max(0, items.findIndex((item) => item.id === mainThreadId)));
  const [pendingDeleteId, setPendingDeleteId] = useState<string | undefined>(undefined);

  const now = new Date();
  const headerFor = (index: number): string | undefined => {
    const item = items[index];
    if (!item) return undefined;
    const bucket = bucketFor(item.lastMessageAt, now);
    if (index === 0) return BUCKET_LABEL[bucket];
    const prevBucket = bucketFor(items[index - 1]?.lastMessageAt, now);
    if (bucket !== prevBucket) return BUCKET_LABEL[bucket];
    return undefined;
  };

  const highlightedId = items[cursor]?.id;

  useInput((input, key) => {
    if (pendingDeleteId) {
      if (input === "y") {
        aui.threads.item({ id: pendingDeleteId }).delete();
        setPendingDeleteId(undefined);
        setCursor((c) => Math.max(0, c - 1));
      } else if (input === "n" || key.escape) {
        setPendingDeleteId(undefined);
      }
      return;
    }

    if (key.escape) {
      onClose();
      return;
    }
    if (input === "n") {
      onNewSession();
      return;
    }
    if (key.upArrow) {
      setCursor((c) => (items.length === 0 ? 0 : (c - 1 + items.length) % items.length));
      return;
    }
    if (key.downArrow) {
      setCursor((c) => (items.length === 0 ? 0 : (c + 1) % items.length));
      return;
    }
    if (key.return) {
      if (highlightedId) aui.threads.switchToThread(highlightedId);
      onClose();
      return;
    }
    if (input === "d") {
      if (highlightedId) setPendingDeleteId(highlightedId);
      return;
    }
  });

  return (
    // I4 — `width="100%"` explicit (see `Composer.tsx`'s matching comment
    // for why a row/column box doesn't reliably inherit its ancestor's
    // resolved width on its own) so the overlay's own border spans the
    // same responsive frame width as everything else, at any terminal
    // size.
    <Box flexDirection="column" width="100%" borderStyle="round" borderColor={theme.line} paddingX={1} paddingY={1} marginY={1}>
      <Box marginBottom={1} justifyContent="space-between">
        <Text color={theme.ink} bold>
          threads
        </Text>
        <Text color={theme.dim}>↑/↓ enter · d delete · n new · esc close</Text>
      </Box>
      <Box flexDirection="column">
        {items.map((item, index) => (
          <PickerRow
            key={item.id}
            id={item.id}
            title={item.title}
            isMain={item.id === mainThreadId}
            highlighted={index === cursor}
            showHeader={headerFor(index)}
          />
        ))}
      </Box>
      {pendingDeleteId ? (
        <Box marginTop={1}>
          <Text color={theme.err}>delete "{items.find((i) => i.id === pendingDeleteId)?.title}"? [y/n]</Text>
        </Box>
      ) : null}
    </Box>
  );
};

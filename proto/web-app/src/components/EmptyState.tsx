// LIA-496 — EmptyState.tsx <- Thread.tsx via ThreadPrimitive.Empty.
// New-chat greeting + SuggestionPrimitive chips. Uses ThreadPrimitive.Suggestion
// (real: `prompt` + `send` actually invokes the composer/adapter, same
// mechanism a typed message would take — not a decorative button), per
// @assistant-ui/core/react/primitives/thread/ThreadSuggestion.d.ts's own
// `useThreadSuggestion` hook.
//
// WB4 (LIA-496 review-fix) — W17 fix: the greeting paragraph used to read
// "This is a scripted fixture spike (LIA-496) — pick one of the sidebar
// threads for the full flow, or try:" — internal-sounding build-process
// language ("fixture spike", a Linear issue id) that has no business
// appearing in a product's own new-chat screen; a real user has no context
// for what "LIA-496" or "fixture spike" means. Replaced with plain
// first-person copy that only talks about what the chips actually do.
// (theme.css carries this fix's other two halves: a real flex-parent
// height bug that silently broke `.s-empty`'s own `flex: 1` centering, and
// docking the composer under the greeting instead of leaving dead space
// between them — see that file's own comment on `.s-thread`/`.s-col`.)
import type { FC } from "react";
import { ThreadPrimitive } from "@assistant-ui/react";

const SUGGESTIONS = [
  "Clean up that stale scratch log in /tmp, then tighten the status-glyph comment.",
  "Did that leave anything else stale in /tmp?",
  "Wire Cmd+Enter to submit and Escape to blur in the composer.",
];

export const EmptyState: FC = () => {
  return (
    <div className="s-empty">
      <h1 className="serif">What are we working on?</h1>
      <p>Pick a thread from the sidebar, or try one of these:</p>
      <div className="s-chips">
        {SUGGESTIONS.map((prompt) => (
          <ThreadPrimitive.Suggestion key={prompt} prompt={prompt} send className="s-chip-btn">
            {prompt}
          </ThreadPrimitive.Suggestion>
        ))}
      </div>
    </div>
  );
};

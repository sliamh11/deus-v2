// LIA-496 — EmptyState.tsx <- Thread.tsx via ThreadPrimitive.Empty.
// New-chat greeting + SuggestionPrimitive chips. Uses ThreadPrimitive.Suggestion
// (real: `prompt` + `send` actually invokes the composer/adapter, same
// mechanism a typed message would take — not a decorative button), per
// @assistant-ui/core/react/primitives/thread/ThreadSuggestion.d.ts's own
// `useThreadSuggestion` hook.
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
      <p>This is a scripted fixture spike (LIA-496) — pick one of the sidebar threads for the full flow, or try:</p>
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

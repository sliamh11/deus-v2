// LIA-495 — DOM equivalent of full-shell.tsx's ActiveStatusRow. The ink
// version's spinner GLYPH comes from the library's own
// LoadingPrimitive.Spinner (ink-spinner "dots" under the hood); that
// primitive does not exist in @assistant-ui/react's web export (confirmed:
// zero matches for "LoadingPrimitive" anywhere under @assistant-ui/ except
// react-ink), so this uses a small CSS `@keyframes` rotation
// (.cc-spinner-dot in src/index.css) as the DOM equivalent glyph. The
// rotating-gerund WORD logic is unchanged — same useRotatingGerund hook
// (runtime/hooks.ts), same word list (runtime/tokens.ts's GERUND_WORDS),
// same 950ms cadence — since that part was already hand-rolled (no
// word-rotation primitive exists in either package).
import type { FC } from "react";
import { useRotatingGerund } from "../runtime/hooks";
import { tokens } from "../runtime/tokens";

export const ActiveStatusRow: FC = () => {
  const word = useRotatingGerund();
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 16, color: tokens.accentPrimary }}>
      <span className="cc-spinner-dot" aria-hidden="true">
        ⠿
      </span>
      <span>{word}…</span>
    </div>
  );
};

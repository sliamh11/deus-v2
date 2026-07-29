// LIA-496 (web only) — BranchPicker.tsx <- the same message footer as
// ActionBar.tsx, shown when branchCount>1. `hideWhenSingleBranch` is a
// real prop on BranchPickerPrimitive.Root (confirmed by reading
// BranchPickerRoot.d.ts directly) — it IS the branchCount>1 condition, not
// something this component re-derives. Real branching: driven by the local
// message repository, `BranchPickerPrimitive.Next`/`.Previous` correctly
// navigate any sibling branches that exist (proven end-to-end via Reload,
// which re-invokes the real adapter and creates a genuine second branch —
// see VERIFICATION.md's "Regenerate (Reload)" row, 2/2 confirmed live).
//
// WB3 (LIA-496 review-fix) — W11 fix: this comment used to claim
// "edit + resend (ComposerPrimitive's per-message edit affordance ...)
// creates the sibling branches" — that affordance did not actually exist
// anywhere in this app at the time. It now does — Thread.tsx's
// `UserMessage`/`UserEditComposer` (added in WB3, that file's own header
// comment has the verified mechanism) wires `ActionBarPrimitive.Edit` to
// the real `composer.beginEdit()` runtime call, and a real edit + Save
// creates the sibling branch this picker navigates. See
// VERIFICATION.md's WB3 rows for the live-verified detail (superseding the
// old honest-FAIL entry this comment used to point at).
//
// W11 fix (this batch): `Previous`/`Next` were plain glyph buttons with no
// accessible name — a screen reader announced them only as "‹"/"›". Real
// `aria-label`s added; `BranchPickerPrimitive.Previous`/`.Next` both accept
// standard button props (confirmed: `ButtonHTMLAttributes<HTMLButtonElement>`
// in `BranchPickerPrevious.d.ts`/`BranchPickerNext.d.ts`), so this is a
// plain prop pass-through, not a new mechanism.
import type { FC } from "react";
import { BranchPickerPrimitive } from "@assistant-ui/react";

export const BranchPicker: FC = () => {
  return (
    <BranchPickerPrimitive.Root className="s-branchpicker" hideWhenSingleBranch>
      <BranchPickerPrimitive.Previous aria-label="Previous branch">‹</BranchPickerPrimitive.Previous>
      <BranchPickerPrimitive.Number /> / <BranchPickerPrimitive.Count />
      <BranchPickerPrimitive.Next aria-label="Next branch">›</BranchPickerPrimitive.Next>
    </BranchPickerPrimitive.Root>
  );
};

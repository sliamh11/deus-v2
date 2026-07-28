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
// Code-review fix (LIA-496 REVISE round): this comment used to claim
// "edit + resend (ComposerPrimitive's per-message edit affordance ...)
// creates the sibling branches" — that affordance does not actually exist
// anywhere in this app. Confirmed by reading `Thread.tsx`'s `UserMessage`
// directly: it renders only `<div className="s-user"><div
// className="chip"><MessagePrimitive.Content/></div></div>`, no
// button/dblclick handler ever calls `composer.beginEdit()`. Corrected
// here rather than left as a documented-but-nonexistent behavior — see
// VERIFICATION.md's "Edit a user message, branch picker shows 2/2" row
// (honest FAIL) for the live-verified detail.
import type { FC } from "react";
import { BranchPickerPrimitive } from "@assistant-ui/react";

export const BranchPicker: FC = () => {
  return (
    <BranchPickerPrimitive.Root className="s-branchpicker" hideWhenSingleBranch>
      <BranchPickerPrimitive.Previous>‹</BranchPickerPrimitive.Previous>
      <BranchPickerPrimitive.Number /> / <BranchPickerPrimitive.Count />
      <BranchPickerPrimitive.Next>›</BranchPickerPrimitive.Next>
    </BranchPickerPrimitive.Root>
  );
};

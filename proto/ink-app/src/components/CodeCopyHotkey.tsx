// LIA-496 — code-review fix (REVISE round): the single global keybinding
// for `codeClipboard.ts`'s OSC-52 best-effort copy (see that file's
// header comment for the full mechanism). Mounted once in `App.tsx`,
// sibling to `MainPane` — no visual output, matches `App.tsx`'s own
// `useThreadNavigation` (`ctrl+n`/`ctrl+t`) "always active regardless of
// focus" pattern (a plain always-`isActive` `useInput`, not gated on
// `useFocus`), already confirmed safe to coexist with
// `ComposerPrimitive.Input`'s own focus-gated `useInput`.
import type { FC } from "react";
import { useInput } from "ink";
import { copyLatestCodeBlock } from "../codeClipboard";

export const CodeCopyHotkey: FC = () => {
  useInput(
    (input, key) => {
      if (key.ctrl && input === "y") copyLatestCodeBlock();
    },
    { isActive: true },
  );
  return null;
};

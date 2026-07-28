// LIA-495 — fixture data ported verbatim (same paths/commands/patch text)
// from full-shell.tsx's fixtures block, except SCRATCH_PATH's existence is
// now backed by runtime/virtualFs.ts instead of real `node:fs` (see that
// file's header comment for why a browser tab needs a stand-in
// filesystem).
import { existsSync, writeFileSync } from "./virtualFs";

export const SCRATCH_PATH = "/tmp/deus-shell-scratch.log";
export const EDIT_PATH = "src/cli/tui-v2/components/messages/ToolMessage.tsx";
export const CHECK_COMMAND = `ls -la ${SCRATCH_PATH}`;
export const VERIFY_COMMAND = "ls /tmp | grep deus";

if (!existsSync(SCRATCH_PATH)) {
  writeFileSync(SCRATCH_PATH, "LIA-493 full-shell scratch fixture\n");
}

// Identical patch text to full-shell.tsx's STATUS_GLYPH_PATCH.
export const STATUS_GLYPH_PATCH = `--- a/src/cli/tui-v2/components/messages/ToolMessage.tsx
+++ b/src/cli/tui-v2/components/messages/ToolMessage.tsx
@@ -12,7 +12,9 @@ export function statusGlyph(
 ) {
   switch (status) {
     case "success":
-      return { glyph: "OK", color: "green" };
+      return { glyph: "⏺", color: "semantic.success" };
     case "error":
-      return { glyph: "ERR", color: "red" };
+      return { glyph: "⏺", color: "semantic.error" };
     case "unknown":
-      return { glyph: "?", color: "gray" };
+      return { glyph: "⏺", color: "text.muted" };
   }
 }
`;

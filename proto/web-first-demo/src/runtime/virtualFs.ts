// LIA-495 — genuine web/DOM adaptation, not a cosmetic port.
//
// full-shell.tsx (the Ink version) calls real `node:fs` (`existsSync`,
// `writeFileSync`, `rmSync`) to back its "clean up a stale scratch file"
// fixture — that's legitimate there because an Ink app runs under Node.
// A Vite-bundled browser app has no filesystem at all: there is no `fs`
// module to import (bundling one in would require a Node polyfill and would
// still have nothing real on disk to touch from a browser tab), so the SAME
// fixture idea — "a file exists, an assistant proposes deleting it, the
// user must approve, the deletion is real and observable" — needs a real
// stand-in for "the filesystem" that a browser tab genuinely has: an
// in-memory store, seeded once at module load exactly like full-shell.tsx
// seeds SCRATCH_PATH on import.
//
// This module is intentionally shaped like `node:fs`'s three calls
// full-shell.tsx uses (`existsSync`/`writeFileSync`/`rmSync`) so the calling
// code in runtime/permissions.ts and runtime/adapter.ts reads the same way
// the ink version's did — only the storage backend changed, not the logic
// that consumes it.
const store = new Map<string, string>();

export function existsSync(path: string): boolean {
  return store.has(path);
}

export function writeFileSync(path: string, contents: string): void {
  store.set(path, contents);
}

export function rmSync(path: string): void {
  store.delete(path);
}

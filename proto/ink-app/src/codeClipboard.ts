// LIA-496 — code-review fix (REVISE round): the OSC-52 best-effort
// code-block copy feature named in the plan's Must tier ("markdown +
// shiki code blocks with copy (web: clipboard API; Ink: OSC-52 escape,
// best-effort)") had zero implementation anywhere in ink-app/src and no
// VERIFICATION.md row — silently dropped, not even honestly reported as a
// FAIL. "Best-effort" (per the plan) permits the escape sequence going
// unsupported by a given terminal emulator; it does not permit the
// feature never being wired at all.
//
// OSC 52 (`ESC ] 52 ; c ; <base64> BEL`) is the terminal-level "set
// clipboard" escape sequence a subset of terminal emulators honor
// (iTerm2, kitty, WezTerm, tmux with `set-clipboard on`, among others).
// Ink has no DOM `navigator.clipboard` to call — this IS the
// terminal-native equivalent, written straight to `process.stdout`.
// "Best-effort" concretely means: this module writes the correct escape
// sequence and has no ack channel to confirm the terminal actually
// accepted it — the raw bytes hitting the stream is the honest
// verification ceiling for this feature, not a UI-level "it worked"
// claim we cannot actually back up headless.
//
// Wired from `TokenLine.tsx` (each rendered code block registers itself
// here) and `CodeCopyHotkey.tsx` (the single global `ctrl+y` binding that
// triggers the actual copy) — see both files' own header comments for
// their side of this.
import { useSyncExternalStore } from "react";

let nextId = 0;
let latestId: number | undefined;
let latestCode = "";
let copiedId: number | undefined;
let copiedTimer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

function subscribe(callback: () => void): () => void {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

// One stable id per mounted `TokenLine` instance (assigned once via
// `useRef`, never reused) — NOT re-derived from render order, so which
// block counts as "latest" tracks content updates, not mount timing.
export function nextCodeBlockId(): number {
  return nextId++;
}

// Called whenever a registered instance's own code text changes
// (including the empty-then-growing text of a still-streaming block) —
// the most recently UPDATED block is "latest", which naturally tracks
// whichever code block the user is actually looking at finish streaming.
export function setLatestCodeBlock(id: number, code: string): void {
  latestId = id;
  latestCode = code;
  notify();
}

export function useIsLatestCodeBlock(id: number): boolean {
  return useSyncExternalStore(subscribe, () => latestId === id);
}

export function useIsJustCopied(id: number): boolean {
  return useSyncExternalStore(subscribe, () => copiedId === id);
}

function writeOsc52(text: string): void {
  const b64 = Buffer.from(text, "utf8").toString("base64");
  process.stdout.write(`\x1b]52;c;${b64}\x07`);
}

// Global, always-active hotkey action (mounted once, from
// `CodeCopyHotkey.tsx`) — copies the MOST RECENTLY RENDERED code block.
// Mirrors `Sidebar.tsx`'s own `ctrl+n` binding: "always active regardless
// of focus", already confirmed safe to coexist with `TextInput`'s own
// focus-gated `useInput` (that file's own comment) — `ctrl+y` is a
// distinct chord from anything else bound in this app (`y`/`a`/`n`
// un-modified for permission decisions, `ctrl+n` for new thread), so
// there is no key collision to worry about, unlike the Tab-handling
// conflict App.tsx's header comment documents and deliberately avoids
// repeating here.
export function copyLatestCodeBlock(): void {
  if (latestId === undefined || !latestCode) return;
  writeOsc52(latestCode);
  const id = latestId;
  copiedId = id;
  notify();
  if (copiedTimer) clearTimeout(copiedTimer);
  copiedTimer = setTimeout(() => {
    copiedId = undefined;
    notify();
  }, 2000);
}

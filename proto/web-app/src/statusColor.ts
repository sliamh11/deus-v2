// LIA-496 (web) — the target-local half of the "tokens.ts lesson":
// shared/src/status.ts exports only semantic StatusKeys ("accent" | "ok" |
// "warn" | "err" | "dim"); this module is where Reading Room's own real
// color values (theme.css's --s-* custom properties) get attached to those
// keys. Nothing in shared/ imports this file or anything like it.
import type { StatusKey } from "@lia496/shared";

export function statusColorVar(key: StatusKey): string {
  switch (key) {
    case "accent":
      return "var(--s-pine)";
    case "ok":
      return "var(--s-diff-add)";
    case "warn":
      return "var(--s-warn)";
    case "err":
      return "var(--s-err)";
    case "dim":
      return "var(--s-dim)";
    default: {
      const _exhaustive: never = key;
      throw new Error(`unhandled StatusKey: ${_exhaustive}`);
    }
  }
}

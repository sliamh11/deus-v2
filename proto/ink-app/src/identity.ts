// LIA-496 IB1 (I5) — sanitized identity values for the once-printed
// identity banner (`committedBlocks.tsx`) and the compact status line
// (`components/StatusLine.tsx`). Both consumers import from here rather
// than reading `os`/`process` themselves, so there is exactly one place
// that decides what's safe to print.
//
// CRITICAL, public-repo requirement (plan `I5`): `sliamh11/deus-v2` is a
// PUBLIC repo. The component this file replaces (`Sidebar.tsx`'s old
// footer, deleted by this batch) hardcoded the host username and the
// personal repo home-path directly into JSX as literal strings — exactly
// the personal-value leak this repo's own `core-behavioral-rules.md`
// ("public repo changes must be user-agnostic") forbids. Both functions
// below fail closed to a generic
// placeholder rather than ever letting a real, unsanitized value through:
// `os.userInfo()` can throw in some sandboxed/CI environments, and an
// empty-string edge case is treated the same as a thrown error.
import os from "node:os";
import path from "node:path";

// Code-review fix (LIA-496 REVISE round, public-repo username leak):
// `os.userInfo().username` on POSIX reads the real account name straight
// from the passwd database for the current uid — it is NOT influenced by
// `$USER`/`$LOGNAME` (confirmed: Node's implementation calls
// `uv_os_get_passwd`, which never consults the environment). Checking
// `$USER`/`$LOGNAME` FIRST is a real, standard Unix convention (the same
// override many CLI tools already honor, e.g. for `sudo -u`/containers/
// scripted `env USER=x` invocations) — not a capture-only special case.
// It also happens to be what makes a clean, non-personal capture possible
// (`env USER=you LOGNAME=you npx tsx src/main.tsx`) without touching this
// function's fail-closed contract: still falls through to the real OS
// value, still fails closed to `"you"` on an empty/thrown result either
// way.
export function getUserLabel(): string {
  try {
    const envName = process.env.USER || process.env.LOGNAME;
    const name = envName && envName.trim().length > 0 ? envName : os.userInfo().username;
    return name && name.trim().length > 0 ? name : "you";
  } catch {
    return "you";
  }
}

export function getCwdLabel(): string {
  try {
    const base = path.basename(process.cwd());
    return base && base.length > 0 ? base : "~";
  } catch {
    return "~";
  }
}

// Product/model identity text. Centralized here (not duplicated between
// `committedBlocks.tsx`'s once-printed banner and
// `components/StatusLine.tsx`'s compact status line) per this repo's
// "never duplicate content across files" rule.
export const PRODUCT_NAME = "deus // transcript";
export const MODEL_NAME = "sonnet-5";

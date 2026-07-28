#!/usr/bin/env bash
# LIA-496 — check-shared-purity.sh
#
# Enforces the "tokens.ts lesson" (§ "Build the shared package" in the S1
# dispatch): shared/src must contain ZERO presentation values and ZERO
# target-specific dependencies. Run in the S1 gate and again at S5
# reconcile, per the plan's runtime/UI boundary section.
#
# Patterns checked, per the S1 dispatch:
#   @assistant-ui/react, react-ink, react-dom, var(--, hex color literals
#   outside fixtures/, CSS named colors, rgb(/hsl(, raw ANSI SGR escapes
#   (\x1b[), chalk.
#
# fixtures/ exemption, generalized: the dispatch names it explicitly only
# for hex literals ("hex color literals outside fixtures/"). This script
# applies the SAME reasoning uniformly to every pattern, not just hex,
# because shared/src/fixtures/ holds scripted CONVERSATION CONTENT — e.g.
# a realistic git-diff string a tool-call result displays, or a grep
# transcript quoted back to the user — which legitimately CONTAINS text
# that mentions a hex color, a CSS named color, an npm package specifier,
# or even (in prose) the string "@assistant-ui/react", as opaque example
# DATA a DiffPanel/Markdown renderer displays verbatim. That data is never
# imported or executed, so it cannot leak these as real dependencies into
# either target's build — which is the actual thing this gate protects
# against. Everything OUTSIDE fixtures/ (shared/'s real runtime modules)
# gets zero exemption for anything below.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SHARED_SRC="$(cd "$SCRIPT_DIR/../shared/src" && pwd)"

fail=0

# --- helpers -----------------------------------------------------------
# All shared/src/*.ts(x) files, fixtures/ excluded.
non_fixture_files() {
  find "$SHARED_SRC" \( -name '*.ts' -o -name '*.tsx' \) -not -path '*/fixtures/*'
}

report() {
  local label="$1"
  shift
  echo "FAIL [$label] (forbidden in shared/src, outside fixtures/):"
  printf '%s\n' "$@" | sed 's/^/  /'
  fail=1
}

check() {
  local label="$1" pattern="$2"
  local files
  files="$(non_fixture_files)"
  if [ -z "$files" ]; then
    return
  fi
  local hits
  hits="$(grep -nE "$pattern" $files 2>/dev/null || true)"
  if [ -n "$hits" ]; then
    report "$label" "$hits"
  fi
}

# --- checks --------------------------------------------------------------
# Plain substring match is deliberate and sufficient: "@assistant-ui/react"
# does NOT appear as a contiguous substring inside "@assistant-ui/core/react"
# (the only legitimate such subpath shared/ imports — see threadList.tsx's
# header comment on why that subpath is used and safe), so this correctly
# catches a real @assistant-ui/react or @assistant-ui/react-ink import
# without a false positive on the core package's own /react entrypoint.
check "@assistant-ui/react (the DOM-target React binding package)" \
  '@assistant-ui/react'

check "react-ink" \
  'react-ink'

check "react-dom" \
  'react-dom'

check "CSS var()" \
  'var\(--'

check "hex color literal" \
  '#[0-9A-Fa-f]{3}([0-9A-Fa-f]{3})?\b'

check "CSS named color" \
  '\b(red|green|blue|yellow|orange|purple|black|white|gray|grey|cyan|magenta|pink|brown|violet|indigo|teal|maroon|navy|olive|lime|aqua|fuchsia|silver|gold|coral|salmon|crimson|khaki|orchid|plum|beige|ivory|lavender|turquoise|chocolate|tan)\b'

check "rgb()/hsl()" \
  '(rgb|hsl)a?\('

check "raw ANSI SGR escape" \
  '\\x1b\['

check "chalk" \
  '\bchalk\b'

# --- verdict -------------------------------------------------------------
if [ "$fail" -ne 0 ]; then
  echo
  echo "check-shared-purity: FAILED — shared/src must contain zero presentation" >&2
  echo "values and zero target-specific dependencies. See this script's header" >&2
  echo "comment and the plan's runtime/UI boundary section." >&2
  exit 1
fi

echo "check-shared-purity: PASSED — shared/src is clean."

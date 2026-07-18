# Archive the custom Rust TUI

**Status:** Accepted
**Date:** 2026-07-17
**Scope:** `tui/`, `deus-cmd.sh`, `.github/workflows/ci.yml`, TUI-related
documentation and architecture decision records
**Ticket:** LIA-389
**Related:** LIA-140, LIA-428 (G1), LIA-429 (G2), LIA-430 (G3), LIA-441,
LIA-442, [deus-native-cli-chat.md](deus-native-cli-chat.md),
[tui-agent-orchestration.md](tui-agent-orchestration.md),
[tui-permission-bridge.md](tui-permission-bridge.md),
[backend-strategy-trait.md](backend-strategy-trait.md),
[parallel-agent-orchestration.md](parallel-agent-orchestration.md)

## Context

Deus has a custom full-screen Rust terminal UI under `tui/`. Re-verified
fresh on 2026-07-17, immediately before this decision: it is still fully
live — 31 tracked files, 30 commits since May 2026 with the most recent
6 days before this decision, a dedicated `test-tui` CI job, and a
first-class `deus tui` command wired into `deus-cmd.sh` (including as the
default interface for bare `deus`/`deus home` via the `tui_default` config
key). This is therefore a deliberate feature removal, not cleanup of code
that was already dead.

**Prior finding on this same ticket.** A 2026-07-14 scouting pass on
LIA-389 found the ticket's original archival premise factually wrong at
the time: it had cited LIA-140 as ongoing "Phase-2 intent" and cited a
stale abandonment narrative, when LIA-140 was actually a narrow,
already-resolved facade finding (`tui/src/widgets/mod.rs`, an empty
placeholder module, fixed in commit `a5a91bc3`/PR #643) unrelated to
archiving the TUI as a whole, and the TUI had 30 commits since May with the
most recent only 3 days before that finding — directly contradicting an
"abandoned after May" premise. That pass recommended NOT archiving on a
false premise, and the user agreed at the time ("do not archive... on a
false premise").

**This decision supersedes that finding with the user's own, separate,
informed call.** On 2026-07-17 the user explicitly stated: *"I haven't
used that at all ever since created it, I don't see value in it at its
current state. If LangChain offers some native TUI features we could
explore them instead."* This is not a reversion to the original false
premise — the TUI's liveness/maintenance state is unchanged from the
07-14 finding (still actively developed, still CI-tested, still wired).
The user is making a product decision based on their own usage, not
correcting a factual error. LIA-140 is cited above per the ticket's
original ask, with the caveat (per the 07-14 finding) that it documents a
narrow, already-resolved facade fix — not "Phase-2 intent" for the TUI as
a whole — and is not itself the authority for this broader archival call.

**Replacement evaluation.** LIA-428/429/430 (G1/G2/G3) shipped a thinner
terminal-chat path on the daemon-owned `deus-native` `AgentRuntime`:

- LIA-428 added `deus chat` — a thin terminal client over an authenticated
  loopback HTTP endpoint that the daemon owns, keeping the runtime,
  credential proxy, and session store in the daemon rather than a second
  in-process runtime inside the terminal (see
  `deus-native-cli-chat.md` for the full rationale). One resumable CLI
  thread, backend-scoped SQLite session persistence (`resume: true`,
  `/exit` never clears the row).
- LIA-429 added `deus chat model set|show` for main-agent and per-role
  model configuration.
- LIA-430 added `/plan on|off`, an in-chat toggle that snapshots/restores
  the daemon's configured permission profile, switching to B7's
  `read-only` profile for subsequent turns.

`deus chat` covers the Rust TUI's core use case — a resumable terminal
conversation with model selection and a safer read-only mode — but is
explicitly narrower, per the `deus-native-chat.ts` module's own
"non-goals" doc-comment and independent verification against the TUI's
own README and ADRs:

1. No multi-panel dashboards. The TUI has dedicated panels for wardens,
   services, channels, config, and system status
   (`/wardens`, `/services`, `/channels`, `/config`, `/status`).
   `deus chat` has none of these.
2. No multi-session picker. The TUI's Ctrl+B picker
   (`parallel-agent-orchestration.md`) let a user spawn and switch between
   parallel background agent sessions. `deus chat` has one fixed,
   resumable CLI thread — no `/new`, no named conversations, no
   concurrent sessions.
3. No interactive per-call permission approval. The TUI's permission
   bridge (`tui-permission-bridge.md`) intercepted individual
   `PreToolUse` events via file-based IPC with a 120s timeout/deny
   fallback. `deus chat`'s `/plan on|off` is coarse permission-*profile*
   selection (switch to read-only and back) — not a per-action
   approve/deny prompt. This is the same category of gap, not a new one.
4. No richer chat-panel UX. The TUI had markdown tables/blockquotes/links,
   Ctrl+F search, @-file mention autocomplete, `/rewind`, kill-ring yank,
   and clipboard integration. `deus chat` renders only the normalized
   `RuntimeEvent` union the runtime contract supplies today.

**LangChain-native alternative (per the user's own suggestion).** A brief,
targeted check found no first-party LangChain/LangGraph terminal UI:
LangGraph Studio is a desktop/web IDE, and LangChain's own chat-interface
product ("Agent Chat UI") is a web app, not a TUI. The only terminal
project found in the LangGraph ecosystem was an unaffiliated community
repository, with no evidence of official support or production readiness.

Separately, the user pointed at LangChain's official "Deep Agents Code"
(`dcode`) as a reference point for what LangChain-native CLI tooling looks
like in practice — a terminal/CLI coding agent, not a traditional
multi-panel TUI. Checked against what G1 already ships: `deus chat`
already covers dcode's *interactive conversational mode* and *persistent
memory across sessions* pillars (the resumable, backend-scoped session
described above). It does not yet have dcode-style *human-in-the-loop
approval gates* (the same gap as item 3 above, now with an external
reference point) or *custom skills* wired into the chat session, and has
no *remote-sandbox/off-machine execution* surface — the daemon-owned
architecture is local-only by design. `dcode` is Python-only and not
directly adoptable into this JS/TS runtime, so this is not an
implementation task: it is a named, deferred direction for `deus chat` to
grow toward if there's real future demand, consistent with not solving
problems that don't exist yet — not a commitment made by this ADR.

Given the user does not use the TUI and does not see value in it at its
current state, and its core use case is covered by a shipped, tested,
architecturally cleaner replacement, the residual gaps above are accepted
and named explicitly rather than silently dropped.

## Decision

Preserve the complete pre-removal Rust TUI implementation on the remote
branch `legacy/tui-phase1`, pushed to `deus-v2-origin` before any removal
from `main`. The preserved base commit, recorded here for reference:

`24e396da7e8e8c4e30e5fb3195033376ee0e3c08`

Remove from `main`:

- the complete tracked `tui/` directory;
- the `test-tui` CI job (`.github/workflows/ci.yml`);
- the `TUI_DEFAULT`/`tui_default` config-key routing,
  `_launch_tui_with_context()`, and all build/exec of
  `tui/target/release/deus-tui` in `deus-cmd.sh`;
- documentation that presented the Rust TUI, or its TUI-only `Backend`
  trait, as live/current architecture.

`deus tui` does not silently alias to `deus chat` — the two are not
feature-equivalent (see the residual gaps above), and aliasing would
misrepresent capability. Invoking `deus tui` now prints a fixed
diagnostic (`DEUS_TUI_ARCHIVED_MSG` in `deus-cmd.sh`) directing the user
to `deus chat`, and exits non-zero. A stale `tui_default=true` in an
existing user's config no longer launches anything; the bare `deus`/`deus
home` entry points print the same diagnostic to stderr and continue to
the normal (non-TUI) launch, so existing configs degrade gracefully
instead of breaking the primary entry point.

The four TUI-specific ADRs remain in the repository as historical
records, each with its Status line changed to Archived or Superseded (see
their headers) and cross-linked to this ADR.

**Two follow-ups are intentionally out of this change's diff, not
silently skipped:** `AGENTS.md:113` (a stale "TUI backends" row) and
`docs/decisions/INDEX.md` (rows presenting the four archived TUI ADRs as
live rulings) both need correcting, but both files were under an explicit
do-not-touch constraint for this implementation session (a concurrent
session was working on them the same day). Tracked as LIA-441 and
LIA-442 respectively, both blocked on this PR merging.

**Also out of scope, flagged only:** a separate, already-dead
TypeScript/Ink TUI prototype exists at `packages/tui/` (`@deus-ai/tui`) —
last commit 2026-05-05, not in root `package.json` workspaces, not wired
into `deus-cmd.sh`/`deus-cmd.ps1`, not mentioned in README.md. It appears
to be an abandoned first draft superseded by the Rust rewrite this ADR
now also archives. It was not evaluated for archival here — LIA-389 was
scoped to "the custom Rust TUI" specifically — but `docs/agent-agnostic
-debt.md`'s `AAG-015` (updated in this change) now flags it as needing
its own triage decision.

Future terminal UI work should begin from current user needs and the
daemon-owned `AgentRuntime` boundary. It may reuse ideas or code from
`legacy/tui-phase1`, but restoring the archived Rust application is not
the default.

## Consequences

**Positive:**

- One supported terminal-chat path (`deus chat`), built on the
  daemon-owned runtime/session/credential/permission contracts.
- Rust build time, Clippy/rustfmt maintenance, dependency updates, and a
  dedicated CI job are removed from the active codebase.
- Provider-integration guidance no longer conflates the archived TUI's
  Rust `Backend` trait with the active Node.js/`deus-native` runtime
  architecture.
- The complete implementation and its design history remain available for
  inspection or selective reuse via `legacy/tui-phase1`.

**Accepted negative consequences** (named explicitly, not silently
dropped — see the residual-gap list in Context):

- Users lose the wardens/services/channels/config/status dashboards.
- Users lose the Ctrl+B multi-session picker and parallel-session
  interaction model.
- Users lose real-time per-tool approve/deny prompts from the file-based
  permission bridge; `/plan on|off` is coarse profile selection, not an
  equivalent replacement.
- Users lose the richer chat rendering, search, mention, rewind, and
  clipboard behavior unique to the Rust TUI.
- An existing `tui_default=true` config becomes inert (warns, does not
  launch) rather than doing what it used to.
- Until LIA-441/LIA-442 land, `AGENTS.md:113` and the relevant
  `docs/decisions/INDEX.md` rows remain stale — tracked, not silent.

These losses are accepted because the maintainer does not use the TUI and
does not consider its current-state value sufficient to justify continued
maintenance.

## Rollback

No database migration; no daemon-owned chat session or user conversation
data is touched or deleted.

To restore the former TUI: revert this change, or restore `tui/` from
`legacy/tui-phase1`, then reinstate the `deus tui`/`tui_default` launcher
paths, the Rust CI job, and the four archived ADRs' prior status. Any
restoration must be integrated against the then-current `main` — the
legacy branch should not be merged blindly once runtime, permission, or
CLI contracts have moved on. A future decision to build a terminal UI
does not automatically trigger this rollback; it should first be
evaluated against current demand and the daemon-owned runtime boundary,
same as any new feature.

# LIA-441 / LIA-442: TUI doc cleanup after archival (LIA-389)

Two stale-reference fixes, both unblocked now that `docs/decisions/tui-archival.md` has
landed on `main` and archived the Rust TUI (implementation moved to the `legacy/tui-phase1`
branch, Status headers on the four TUI-scoped ADRs already flipped to Archived/Superseded).

**LIA-441 (`AGENTS.md`):** The "TUI backends" row (previously line 114, pointing at
`tui/src/backend/` as a live "Strategy trait — one file per provider") described code that
no longer exists on `main`. Changed the row to `TUI backends (archived)`, pointing at the
`legacy/tui-phase1` branch instead of the removed path, and linking to
`docs/decisions/tui-archival.md` as the authoritative record — consistent with how the ADR
itself already described this row as needing correction.

**LIA-442 (`docs/decisions/INDEX.md`):** Four ADR rows (`backend-strategy-trait.md`,
`parallel-agent-orchestration.md`, `tui-agent-orchestration.md`, `tui-permission-bridge.md`)
still presented archived TUI designs as live rulings, even though each ADR's own Status
header was already updated to Archived/Superseded by the tui-archival change. Rewrote all
four "One-line ruling" cells to state Archived/Superseded status, link to
`tui-archival.md`, and preserve each ADR's residual-gap note (e.g. the Ctrl+B multi-session
picker and the per-call permission bridge are explicitly NOT replaced by `deus chat`) so the
index doesn't overstate what the replacement covers. Topic columns were also suffixed with
"(archived)" for at-a-glance scanning. The `tui-archival.md` row itself and all non-TUI rows
were left untouched — out of scope for these two tickets.

No code changes; documentation-only. Verified via `git diff` that only `AGENTS.md` and
`docs/decisions/INDEX.md` changed, and only the targeted rows within them.

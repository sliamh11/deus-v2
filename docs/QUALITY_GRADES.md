# Quality Grades

Per-subsystem health at a glance. Updated manually or by the doc-gardening agent.

**Scale:** A (clean, well-tested) | B (functional, minor gaps) | C (functional, known gaps) | D (fragile, active issues)

| Subsystem | Grade | Last audited | Key gaps | Debt/ADR refs |
|-----------|-------|-------------|----------|---------------|
| Memory tree | B | 2026-05-16 | Atom fallback disabled pending benchmark | [atom-fallback-evaluation](decisions/atom-fallback-evaluation.md) |
| Scheduler/cron | A | 2026-05-16 | -- | -- |
| Warden gates | B | 2026-06-08 | No remediation instructions | -- |
| Backends (Claude/OpenAI) | B | 2026-06-08 | Codex hook parity open | [AAG-010](agent-agnostic-debt.md) |
| Eval/benchmarks | A | 2026-05-16 | -- | [benchmark-regression-gate](decisions/benchmark-regression-gate.md) |
| Channel layer | B | 2026-06-08 | Agent-native migration WIP | -- |
| TUI/CLI | Archived (TUI) / needs re-audit (CLI) | 2026-07-17 | The Rust TUI half of this grade was archived and removed (LIA-389) — the "Visual verification deferred 6+ times" gap no longer applies to a deleted feature. The CLI half (`deus chat`, `deus-cmd.sh`) grew substantially since this grade was set (G1-G3, LIA-428/429/430) and has not been re-graded on its own. | [tui-archival](decisions/tui-archival.md) |
| Pattern verification | C | 2026-06-01 | 4/5 gaps open | [pattern-verification-deferred](decisions/pattern-verification-deferred.md) |

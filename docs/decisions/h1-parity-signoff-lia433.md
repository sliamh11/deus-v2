---
name: H1 — Parity sign-off and release-scale reliability repeat
description: >
  Final evidence-backed sign-off for H1/LIA-433: backend-neutral parity
  matrix disposition, the AAG-007b three-layer synthesis, the 2026-07-18
  repeat of the A7 tool-loop benchmark against its 2026-07-14 baseline,
  accepted gaps with owner/rationale/rollback, and the default-flip
  go/no-go decision.
type: decision
tags: [deus-v2, parity, benchmark, sign-off, h1, lia-433]
date: 2026-07-18
---

# H1 — Parity Sign-Off (LIA-433)

**Status:** Recorded
**Date:** 2026-07-18
**Scope:** `docs/decisions/backend-neutral-agent-runtime.md`, `docs/decisions/deus-v2-langchain-runtime.md`, `scripts/spikes/lia400_tool_loop_reliability_benchmark.ts`

**Decision: NO-GO on flipping `deus-native` to the default backend
today.** See "Final Verdict" below.

## 1. What this document is

LIA-433 asked for three things: (1) an evidence-backed disposition for
every row of `docs/decisions/backend-neutral-agent-runtime.md`'s parity
matrix, (2) the "AAG-007b three-layer parity harness" run or its release
blockers reported, (3) the A7 tool-loop benchmark repeated at release
scale and compared to its original baseline. This doc records all three,
plus the accepted-gap ledger and the final sign-off verdict.

## 2. Parity matrix disposition (AC1)

`docs/decisions/backend-neutral-agent-runtime.md`'s two tables were
re-verified 2026-07-18. The top-level **Parity Matrix** (Claude/OpenAI/
Llama.cpp selection, sessions, credentials, context, tools, scheduling)
was already evidence-backed from prior ADRs and is unchanged.

The **Deus-Native Opt-In Readiness Matrix** had 4 rows still reading
"Not Tested" (dispositions carried over from the PR that first wrote the
table, meaning only "not exercised by that PR" — not necessarily
uncovered system-wide). Each was independently re-verified this session;
the table itself now carries the citations. Summary:

| Row | Prior disposition | New disposition | Evidence |
|---|---|---|---|
| Container-based multi-agent orchestrator | Not Tested | **Verified Pass** | `npx vitest run src/multi-agent/orchestrator.test.ts` — 23/23 passing |
| Credential-proxy routing | Not Tested | **Verified Pass** | `npx vitest run src/credential-proxy.test.ts` — 24/24 passing (Claude OAuth/API-key leg + `/openai` route + auth rejection + header stripping) |
| Scheduled-task-level Deus-native override | Not Tested | **Release Blocker** | `grep -n "backend" src/task-scheduler.test.ts` — only `'claude'`/`'openai'` backend values appear; no `deus-native` end-to-end scheduled-task test exists |
| Container tool-broker parity | Not Tested | **Release Blocker** | `find . -iname "*tool-broker*test*"` (repo-wide) — zero results; the ADR's own Verification section already says this needs a rebuilt container + provider credentials, neither available this session |

**AC1 status: not fully met.** Every row now has an evidence-backed
disposition (2 Pass, 2 honestly-labeled Blocker — "no coverage" is itself
evidence, just not passing evidence), but 2 of those dispositions are
release blockers, not clean passes. See §5.

## 3. AAG-007b "three-layer parity harness" (AC2)

**No formal, separately-named "AAG-007b three-layer parity harness"
exists anywhere** — confirmed by:
- `grep -rn "AAG-007b" .` across the full repo (docs, src, scripts): only
  one hit, `docs/agent-agnostic-debt.md`'s `AAG-C002a` closure line,
  unrelated.
- `grep -rn "three-layer\|three layer"` across the repo: zero hits.
- The two vault research docs LIA-433's own Linear "Why" section cites
  (`Research/2026-07-13-deus-v2-base-harness-selection.md`,
  `Research/2026-07-13-deus-v2-cleanup-and-revival-audit.md`) mention
  AAG-007b exactly once, as a one-line roadmap pull-in ("Backend parity
  testing AAG-007b — directly de-risks V2 itself; pulled INTO the
  migration roadmap"). Neither defines a "three-layer" design.
- A Linear search for "AAG-007b" and "three-layer parity harness" returns
  only LIA-433 itself.

Building a new, formally-named three-layer harness from scratch was
judged out of scope for this session (per the ticket's own allowance for
a smaller representative run instead of large net-new infrastructure).
Instead, this sign-off treats the three artifacts that already jointly
cover backend parity as the de-facto three layers, and ran/re-verified
all three this session:

1. **Layer 1 — Backend-Neutral Parity Matrix** (session start/resume,
   tools, credentials, scheduling, context, commands) — §2 above.
2. **Layer 2 — Deus-Native Opt-In Readiness Matrix** (capability-by-
   capability readiness for the new host-side runtime) — §2 above.
3. **Layer 3 — A7 tool-loop reliability benchmark** (does the tool-
   calling MECHANISM work per provider) — §4 below.

**AC2 status: the closest existing equivalent ran successfully and
reports explicit release blockers** (§5) rather than a from-scratch
"three-layer harness" being built new. This is a scope-down, stated
plainly rather than silently.

## 4. A7 benchmark repeat vs. baseline (AC3, AC4)

**No separate "release-scale provider/sample configuration" is
documented anywhere** for A7 — confirmed by `grep -rn "release-scale\|release scale"` across the repo and vault docs: zero hits. The only
documented configuration is the one `scripts/spikes/lia400_tool_loop_reliability_benchmark.md` already defines: 6 representative multi-step
tool chains × 3 providers (Claude, GPT, Ollama), no `--smoke`/`--providers`
flags. That configuration was used verbatim as "release scale" since it
is the only one that exists; this is called out explicitly per AC3's own
wording rather than silently assumed.

**Repeat run: 2026-07-18** (`npx tsx scripts/spikes/lia400_tool_loop_reliability_benchmark.ts`, no flags, all 6 chains × all 3 providers).
Full output in the committed, regenerated
`scripts/spikes/lia400_tool_loop_reliability_benchmark.results.json`.

| chain | claude | gpt | ollama |
|---|---|---|---|
| single_tool_lookup | NOT-EXEC | NOT-EXEC | PASS |
| sequential_two_tool | NOT-EXEC | NOT-EXEC | PASS |
| calculation_chain | NOT-EXEC | NOT-EXEC | PASS |
| delegate_to_subagent | NOT-EXEC | NOT-EXEC | PASS |
| error_recovery | NOT-EXEC | NOT-EXEC | PASS |
| mcp_get_status | NOT-EXEC | NOT-EXEC | PASS |

**Comparison to the 2026-07-14 baseline: structurally identical.** The
original baseline run also produced `claude`×6 NOT-EXEC, `gpt`×6
NOT-EXEC, `ollama`×6 PASS — see
`scripts/spikes/lia400_tool_loop_reliability_benchmark.md` §"AC3/AC4".
The blocking cause is the same class of error on both dates:

- Claude leg: `429 rate_limit_error` from Anthropic on the very first
  call, both 2026-07-14 and 2026-07-18 (confirmed via a `--smoke` probe
  before spending the full run's quota).
- GPT leg: `429` OpenAI `insufficient_quota` billing error, both dates —
  a valid, present API key (confirmed 2026-07-18: env var set,
  non-empty) with no funded usage quota, not a missing-key or transient
  issue.
- Ollama leg (`gemma4:e2b`, confirmed present in `ollama list` both
  dates): 6/6 PASS both dates, including the cross-provider
  `delegate_to_subagent` re-validation and the real-infra
  `mcp_get_status` MCP round-trip.

This is a genuine repeat, not a rerun invalidated by drift: same chains,
same provider set, same result shape, 4 days apart. It confirms the
Anthropic/OpenAI account-level billing blockers are a **persistent
environmental condition**, not a one-off flake.

**Applying the frozen AC6 kill-switch rubric** (from the original A7
plan, `.claude/.plan-scope-a7.md`) to this repeat: the verdict is
unchanged — **NO-PASS-YET (qualified)**. Only 1 of 3 providers (Ollama)
was actually executed on either date; the rubric's own fallback clause
("if fewer than two providers were actually executed... NO-PASS-YET
(qualified)") applies verbatim, both times.

**AC3 status: met, with the scale caveat stated above.** **AC4 status:
met** — results are directly comparable and compared.

## 5. Accepted gaps — owner, rationale, rollback impact (AC5)

| Gap | Owner | Rationale for accepting (not blocking H1's other work) | Rollback impact |
|---|---|---|---|
| **Claude/GPT tool-loop reliability never empirically validated** (A7 criterion 4 still NO-PASS-YET) | Liam (account/billing owner) | External account-state blocker (Anthropic rate limit, OpenAI unfunded quota), not a code defect — no tool-calling mechanism evidence exists to judge either way. Re-testable cheaply once either clears (`--providers=claude` / `--providers=gpt`). | **Directly blocks default-flip.** `claude` remains default; rollback is moot since nothing has flipped. This is the primary reason for the NO-GO below. |
| **Container tool-broker has zero test coverage** | Whoever owns the next container-tool-broker touch (unassigned) | Needs a rebuilt agent container + real provider credentials per the ADR's own Verification section — infra not available in this host-only sign-off session. | Blocks confidence in the container-adapter path specifically; `deus-native`'s own tool surface (`web_search`/`web_fetch` only, per the LangChain ADR) does not depend on this broker, so it does not block a `deus-native`-only flip, only a broader OpenAI/Codex-container flip. |
| **Scheduled-task-level `deus-native` override never exercised end-to-end** | Whoever owns `task-scheduler.ts` next | Resolution path is generic/shared with `claude`/`openai` and is covered at the resolver-unit level; only the full end-to-end wiring through a live scheduled task is unverified. Lower risk than the two gaps above because the shared code path is tested for the other two backend values. | Blocks confidence specifically for scheduled (not chat-turn) `deus-native` usage; does not block interactive chat-turn default-flip. |
| **E2/AAG-012 — no chat-message trigger for `dispatchSubAgents()`/Researcher** | Liam | Deliberate, reviewed scope-down (commit `b37ab69b`/PR #29 explicitly states "AAG-012... is NOT closed by this change"), not an oversight — auto-triggering sub-agent dispatch on every research-shaped message was judged too invasive to wire in blind. Verified accurate against the actual merged commit message, not just the debt-doc's paraphrase. Linear follow-up filed: **LIA-444**, "Wire a production chat-trigger for SubAgent dispatch (E2 follow-up, AAG-012)". | Zero rollback impact — nothing chat-facing currently depends on this path; it is purely additive future work. **Treated as accepted, documented, ticketed partial parity — not a release blocker for H1.** |

## 6. Final verdict (AC6)

**Default-flip criteria are NOT met today.** Specifically:

- The single piece of evidence H1 exists to produce — whether Claude and
  GPT tool-calling reliability holds up under LangChain's `createAgent`
  loop — could not be produced on either 2026-07-14 or 2026-07-18 because
  of persistent, external account-level billing/rate-limit blockers on
  both providers. Only Ollama has positive mechanism evidence. Per the
  benchmark's own frozen kill-switch rubric, this is NO-PASS-YET
  (qualified), not a PASS.
- Container tool-broker parity and scheduled-task-level `deus-native`
  override both have zero real test coverage, confirmed by direct
  grep/find in this session, not inherited assumption.

**Recommendation:** keep `claude` as the default backend. Re-run
`npx tsx scripts/spikes/lia400_tool_loop_reliability_benchmark.ts --providers=claude` and `--providers=gpt` individually once Anthropic
rate-limiting clears at lower session load and/or OpenAI quota is funded;
if both clear the mechanism bar (valid tool-call formatting, correct
sequencing, tool results reaching the model — 6/6 not required), and the
two coverage gaps in §2/§5 get real tests, H1's criteria would then be
met and this doc should be updated (not silently superseded) with a
revised GO verdict.

**E2/AAG-012 gap:** explicitly NOT counted as a blocker for this
verdict, per the ticket's own instruction — it is accepted, documented
here, and tracked as LIA-444.

**Cross-ticket consequence (2026-07-18, H3/LIA-435):** H2/LIA-434 remains
blocked; Claude stays default until a later H1 evidence update records a GO.

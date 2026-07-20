# Benchmark: representative tool-loop reliability across providers (LIA-400 / A7)

This benchmark validates LIA-400 AC1–AC6: it defines a small set of
representative multi-step tool-calling chains, drives each of them through
three provider backends (Claude via A4's isolated credential-proxy child, GPT
via a direct `ChatOpenAI` call, and local Ollama), and mechanically scores
whether each provider's tool-calling MECHANISM worked — correct tool-call
formatting, correct sequencing, and tool results actually reaching the model
— rather than judging open-ended answer quality.

It reuses three already-reviewed spikes verbatim rather than re-deriving
their mechanisms:

- `lia396_provider_override_walking_skeleton.ts` (A3) — `createProviderRoutingMiddleware`,
  `makeDelegateToSubagentTool`, `OLLAMA_SUB_MODEL_ID`, `OLLAMA_BASE_URL` — for
  the `delegate_to_subagent` chain, which re-validates A3's own nested-session
  middleware under each of the three providers benchmarked here (not just
  A3's original Claude/Ollama pairing).
- `lia397_credential_proxy_billing_spike.ts` (A4) — `spawnProxyChild`,
  `waitForChildReady`, `buildProxyRoutedChatAnthropic` — for the Claude leg.
  Never touches the live `:3001` daemon; spawns its own isolated proxy child.
- `lia398_mcp_adapter_walking_skeleton.ts` (A5) — `assertMcpXBuilt`,
  `createMcpXClient` — for the `mcp_get_status` chain, the one real-infra
  chain (A5's already-built `mcp-x` MCP server's `get_status` tool, the one
  tool documented safe with zero credentials).

## AC1 — 5-8 representative multi-step tool chains

Six chains are defined in `CHAINS` (within the reviewed 5-8 range), each with
an `id`, `description`, `seedPrompt`, and a mechanically-checked
`expectedToolSequence`:

1. **`single_tool_lookup`** — one `lookup_fact` call against a canned KB.
   Simplest possible loop: does the provider recognize a tool is needed at
   all and format one correct call.
2. **`sequential_two_tool`** — `get_weather(city)` then
   `convert_temperature(value, from, to)`, where the second call must use the
   first call's result (68°F → 20°C). Tests result-chaining across two hops.
3. **`calculation_chain`** — `add(3,4)` then `multiply(7,6)`, composing two
   tool results in order (product 42). A second, arithmetic-flavored
   result-chaining chain.
4. **`delegate_to_subagent`** — reuses A3's real, already-reviewed
   implementation verbatim (main provider → tool call → nested `createAgent`
   sub-invoke on local Ollama → tool result → final answer). The only chain
   that is also a cross-provider regression check on A3's middleware itself.
5. **`error_recovery`** — a `fetch_record` tool that fails with a scripted
   transient error on its first invocation and succeeds on a retry with the
   same id; checks whether the provider retries appropriately vs gives up,
   via tool-invocation count (`['fetch_record', 'fetch_record']`) plus final
   answer content.
6. **`mcp_get_status`** — real infra, not synthetic: A5's `mcp-x` MCP
   server's `get_status` tool via `@langchain/mcp-adapters`'
   `MultiServerMCPClient`, exactly as A5's spike already does. The agent is
   given ONLY the `get_status` tool (filtered out of `mcp-x`'s full tool set)
   so the benchmark can never accidentally invoke a credentialed or
   side-effecting tool.

**Rationale for deterministic/local tools over live external APIs for 5 of
the 6 chains:** the property under test is tool-LOOP reliability — does each
provider correctly recognize when to call a tool, format the call, chain
multiple results together, and use them in a final answer — which needs to
be objectively, mechanically checkable per chain per provider. Live external
APIs with variable/error responses would make this noisy and
non-discriminating between providers. This mirrors A3's own
`makeScriptedMainStub` approach (deterministic scripted tool responses)
rather than `quality_bench.py`'s LLM-judge (which scores open-ended TEXT
quality, not mechanically-checkable tool-call correctness — see next
section).

## AC2 — methodology traceability to `eval/quality_bench.py`

Structural parallels, by design:

| `eval/quality_bench.py`                                                           | `lia400_tool_loop_reliability_benchmark.ts`                                                                                          |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `CASES` (5 fixed cases with `id`/`input`/`expected`/`dimension`)                  | `CHAINS` (6 fixed chains with `id`/`description`/`seedPrompt`/`expectedToolSequence`)                                                |
| per-backend invocation loop (`invoke_claude`/`invoke_codex` CLI subprocess calls) | per-backend invocation loop (three `ChatModel` instances — `ChatAnthropic`/`ChatOpenAI`/`ChatOllama` — driven through `createAgent`) |
| local Ollama LLM-judge scores 0.0-1.0 per dimension                               | mechanical expected-tool-sequence match (`sequencesEqual`) + non-empty-final-answer check                                            |
| structured JSON results + printed comparison                                      | `lia400_tool_loop_reliability_benchmark.results.json` + printed chain×provider summary table                                         |
| `--smoke` (1 case), `--dry` (show cases only)                                     | `--smoke` (1 chain), `--dry` (show chains only), plus `--providers=claude,gpt,ollama`                                                |

**Deliberate, justified divergence in scoring mechanism:** `quality_bench.py`
judges open-ended text quality with an LLM judge because "is this a good
answer to a reasoning question" has no mechanical ground truth. Tool-loop
correctness is different — it IS mechanically checkable in code (did the
expected tool names get called, in order, with a non-empty final answer) —
so introducing an LLM judge here would add noise, not signal, to a property
already checkable without one. The `CHAINS`/invocation-loop/JSON-results/
summary-table structure is preserved; only the scoring step is replaced with
a purpose-fit mechanical check.

## AC3 — provider execution + AC4 — comparable results

**Final live run, 2026-07-15 (results.json `generatedAt:
2026-07-14T22:41:59.945Z` UTC), `npx tsx
scripts/spikes/lia400_tool_loop_reliability_benchmark.ts` (no flags — all 6
chains × all 3 providers), full command output captured. This run was
performed AFTER fixing the misclassification bug described in "Deviations
from the plan" #1 below (an earlier run recorded the GPT leg's billing 429
as FAIL because the retry/reclassify wrapper was Claude-only):**

```
chain                   claude    gpt       ollama
single_tool_lookup      NOT-EXEC  NOT-EXEC  PASS
sequential_two_tool     NOT-EXEC  NOT-EXEC  PASS
calculation_chain       NOT-EXEC  NOT-EXEC  PASS
delegate_to_subagent    NOT-EXEC  NOT-EXEC  PASS
error_recovery          NOT-EXEC  NOT-EXEC  PASS
mcp_get_status          NOT-EXEC  NOT-EXEC  PASS
```

Full structured output: `lia400_tool_loop_reliability_benchmark.results.json`
(committed alongside this doc).

### Claude leg — NOT-EXEC across all 6 chains (persistent rate-limiting)

The proxy child started cleanly (`authMode: "oauth"`, matching A4's own
reviewed subscription-billing path). The very first chain
(`single_tool_lookup`) hit a real `429 rate_limit_error` from Anthropic on
its first attempt:

```json
"error": "429 {\"type\":\"error\",\"error\":{\"type\":\"rate_limit_error\",\"message\":\"Error\"},\"request_id\":\"req_011Cd2kiDqFso97KMFUoQL4q\"}"
```

Per the plan's documented retry policy, the runner retried with linear
backoff (20s, then 40s) on top of the Anthropic SDK's own internal retries —
still 429 after both. The cell was recorded honestly as
`"notExecutedReason": "not executed due to persistent rate-limiting (still
429 after 2 runner-level retries on top of the SDK's internal retries)"`,
never as a fabricated pass or fail. The runner's rate-limit latch then
short-circuited the remaining 5 Claude chains as NOT-EXEC with the same
reason rather than burning further quota on calls known to fail — this is
exactly the disclosed, real risk from the plan (A4 and A5 both hit the same
`rate_limit_error` this session against the same shared account-level
quota), and exactly the AC3 escape hatch this benchmark's design
anticipated ("or document why only two of those providers were
executable").

### GPT leg — NOT-EXEC across all 6 chains (billing/quota 429, not a missing key)

`process.env.OPENAI_API_KEY` was present and non-empty (confirmed before the
run, 164 chars). The first GPT chain call failed with:

```
429 You exceeded your current quota, please check your plan and billing
details. For more information on this error, read the docs:
https://platform.openai.com/docs/guides/error-codes/api-errors.
```

This is OpenAI's `insufficient_quota` billing error, not a transient rate
limit — the account has a valid API key but no funded usage quota. It is a
persistent account state (retries cannot clear it), and — like Anthropic's
429 on the Claude leg — it is an external, environmental blocker entirely
upstream of the property under test: the request never reached the point
where tool-call formatting, sequencing, or result-marshaling could be
exercised. `runChainWithRetry` (now applied to every provider leg — see
"Deviations from the plan" #1 for the bug this fixed) retried per the
documented policy, reclassified the cell as NOT-EXEC with the standard
`notExecutedReason`, and the runner's latch short-circuited the remaining 5
GPT chains as NOT-EXEC rather than burning further calls known to fail. One
honest wording caveat: the shared `notExecutedReason` string is phrased as
"persistent rate-limiting" because `isRateLimitError`'s 429-class pattern is
what caught it; the underlying cause on this leg is quota/billing
exhaustion, as the recorded `error` field on the first cell shows verbatim.

### Ollama leg — PASS across all 6 chains

`gemma4:e2b`, reachable and confirmed present in `/api/tags` before the run
started, passed every chain — the tool-calling mechanism worked end to end
for all 6 chains:

- `single_tool_lookup`: 1 correct `lookup_fact` call, 5769ms, final answer
  correctly stated the aurora fact.
- `sequential_two_tool`: `get_weather` → `convert_temperature` in order,
  6772ms, correctly reported 20°C (from 68°F).
- `calculation_chain`: `add` → `multiply` in order, 6476ms, correctly
  reported 42.
- `delegate_to_subagent`: `delegate_to_subagent` called once, 9350ms,
  A3's nested main→sub→main loop completed — **note:** the final answer text
  itself ("I encountered an issue because the request was too ambiguous. The
  subagent asked me to clarify what 'it' refers to before it could find a
  favorite fruit...") reads as a confused/incomplete completion of the
  actual task, but the chain is still scored `matched: true` because the
  mechanical check (exact expected tool sequence + non-empty final answer)
  only verifies the tool-LOOP mechanism fired correctly, not task success —
  precisely the scoring boundary AC2's methodology section states. This is
  the one cell across the whole grid where the mechanical PASS and a human's
  intuitive "did it actually work" judgment would diverge; it's called out
  explicitly rather than left implicit.
- `error_recovery`: `fetch_record` called twice (first hit the scripted
  transient error, second succeeded), 5911ms, model correctly retried rather
  than giving up.
- `mcp_get_status`: real `mcp-x` server, real stdio MCP round-trip,
  `get_status` called once, 6295ms, correctly reported "X credentials are
  not configured" (accurate — no X credentials are set in this worktree).

Results are in directly comparable form: same JSON schema per cell
(`chainId`, `provider`, `succeeded`, `actualToolSequence`,
`expectedToolSequence`, `matched`, `finalAnswer`/`error`,
`notExecutedReason?`, `latencyMs`), plus the printed chain×provider summary
table (PASS/FAIL/NOT-EXEC).

## AC5 — repeatable inputs and runner

- `CHAINS` is a static, in-file array — no external fixtures, no
  network-dependent seed data. The KB (`FACT_KB`), tool implementations
  (`get_weather`, `convert_temperature`, `add`, `multiply`,
  `makeFlakyFetchRecordTool`), and seed prompts are all deterministic code.
- CLI: `npx tsx scripts/spikes/lia400_tool_loop_reliability_benchmark.ts
[--smoke] [--dry] [--providers=claude,gpt,ollama]`.
  - `--dry` prints the 6 chains without running them.
  - `--smoke` runs only the first chain (`single_tool_lookup`) across the
    requested providers.
  - `--providers=` (default: all three) selects a subset, e.g.
    `--providers=ollama` to run only the leg with local infra.
- One-time build prerequisite for the `mcp_get_status` chain (same as A5's
  documented prerequisite):
  ```sh
  cd packages/mcp-channel-core && npm install && npm run build && \
  cd ../mcp-x && npm install && npm run build
  ```
- Each run overwrites `lia400_tool_loop_reliability_benchmark.results.json`
  with a fresh, timestamped, structured result set and prints the same
  summary table shown above.
- Unit tests (`lia400_tool_loop_reliability_benchmark.test.ts`, 25/25
  passing, zero network) verify the chain tool implementations and the
  full scripted scoring loop (via a generalized `ExecuteOverride`, same
  seam A3's `makeScriptedMainStub` established) deterministically, plus the
  rate-limit retry/backoff/latch logic with a fake `sleep`. Live-gated tests
  (mcp-x discovery, live Ollama smoke) self-gate on a live probe / build
  check, matching A3/A5's established convention, and are skipped (not
  failed) when the local infra isn't present.

**Verification commands run (re-run after the deviation-#1 fix), real
output:**

```
$ npx tsc --noEmit
(clean, no output)

$ npx vitest run scripts/spikes/lia400_tool_loop_reliability_benchmark.test.ts
 Test Files  1 passed (1)
      Tests  25 passed (25)
   Duration  5.84s
```

## AC6 — kill-switch criterion-4 verdict

**Verdict: NO-PASS-YET (qualified) — kill-switch NOT fired; the frozen
rubric's insufficient-evidence clause applies because only 1 of 3 providers
was actually executed.**

The rubric for this verdict was frozen in `.claude/.plan-scope-a7.md`
("Kill-switch criterion-4 aggregation rubric") BEFORE the live run, so the
verdict below is an application of pre-committed criteria, not a
post-hoc rationalization of a disappointing grid.

Applying the rubric to the final grid mechanically:

- **Structural failure?** No. The rubric's structural-failure trigger
  requires "a provider that was actually executed" to show a fundamental
  tool-calling incompatibility. The only provider actually executed —
  Ollama (`gemma4:e2b`) — showed the opposite: 6/6 chains produced correctly
  formatted tool calls in the expected order, tool results visibly reached
  the model (each final answer incorporates the tool output, including the
  scripted 68°F→20°C chaining, the 7×6=42 composition, the retry-after-
  transient-error, and a real stdio MCP round-trip against the live `mcp-x`
  server), and the harness (`createAgent` + A3's routing middleware) never
  errored before reaching the model. Nothing in the run exhibits any of the
  rubric's named structural shapes for any provider.
- **Isolated failures?** Yes, exactly the kind the rubric pre-classified.
  All 12 non-executed cells (Claude ×6, GPT ×6) fall under the rubric's own
  example of an isolated, non-structural cause: "one provider leg was 'not
  executed' due to an external/environmental blocker (429, missing key)".
  Claude's blocker is Anthropic account-level rate-limiting (`429
rate_limit_error`, persisting through 2 runner-level retries with 20s/40s
  backoff on top of the SDK's own retries — the same account-quota
  exhaustion A4 and A5 both hit this session). GPT's blocker is OpenAI's
  `insufficient_quota` billing 429 (valid key, no funded quota — a
  persistent account state, not a transient throttle). Both arrive from the
  provider's edge BEFORE any tool-calling machinery is exercised: no tool
  schema was ever serialized incorrectly, no tool call was ever malformed,
  no tool result ever failed to reach a model — those code paths were simply
  never reached on these two legs.
- **Pass bar?** Not met — but specifically on quantity of evidence, not on
  any negative signal. The rubric's pass bar is defined "across the
  providers that were actually executed", and its explicit fallback clause
  states: "If fewer than two providers were actually executed (e.g. both
  Claude and GPT blocked), the verdict is NO-PASS-YET (qualified),
  following A5's precedent for insufficient evidence rather than a forced
  PASS or FAIL." That hypothetical is this run's literal outcome: both
  Claude and GPT were blocked, one provider executed. The clause applies
  verbatim.

The distinction that matters, stated plainly (A5 precedent): for Claude and
GPT this run produced an **absence of evidence, not evidence of absence**.
Nothing observed on either leg is signal about their tool-calling
mechanisms — a billing block and a rate limit are facts about account
state, not about LangChain's tool-call formatting, sequencing, or
result-marshaling for those providers. Meanwhile the Ollama leg is genuine
**positive** mechanism evidence for one provider — including cross-provider
re-validation of A3's `delegate_to_subagent` middleware and a real-infra
MCP chain reusing A5's server — but one executed provider cannot, under the
frozen rubric, support a cross-provider reliability PASS.

**The OpenAI Agents SDK / OpenCode re-evaluation fallback is NOT
triggered.** That fallback is scoped to evidence of a structural
tool-calling failure on an executed provider, and this run contains zero
such evidence for any provider. Firing a harness re-evaluation over
account-level quota/billing states would be responding to the environment,
not to the property the kill-switch guards.

**Conditions to convert this into a real PASS:** re-run the benchmark
(`npx tsx scripts/spikes/lia400_tool_loop_reliability_benchmark.ts`, or
`--providers=claude` / `--providers=gpt` individually) once at least one of
the two blockers clears — Anthropic quota reset at lower session load for
the Claude leg, funded OpenAI quota for the GPT leg — such that at least
two providers actually execute. If each executed provider then clears the
rubric's mechanism bar (valid tool_call formatting, correct sequencing on
at least the simpler chains, tool results visibly reaching the model),
criterion 4 records as PASS — 6/6 chains on 3/3 providers is explicitly
not required.

**Conditions that would make this a real FAIL:** a re-run in which an
actually-executed provider shows a provider-wide structural incompatibility
per the rubric — never emitting a valid tool_call on ANY chain, tool
results never reaching the model, or the harness erroring before the model
for that provider. In that event criterion 4 fails and the OpenAI Agents
SDK / OpenCode re-evaluation fires.

Downstream guidance: do not record criterion 4 as passed; do not trigger
the fallback re-evaluation; hold the base-harness-migration decision on
this criterion until a re-run with at least two executed providers lands.
The retest is cheap and fully repeatable — the runner, chains, and scoring
are committed, and the Ollama leg's 6/6 demonstrates the benchmark itself
is sound end-to-end.

## Deviations from the plan

1. **GPT's real failure mode differed from the plan's anticipated one, and
   exposed a real classification bug that was found, fixed, and re-run.**
   The plan's only documented GPT escape hatch was "OPENAI_API_KEY
   unavailable in this shell" (empty/unset key) — verified NOT the case here
   (key was present, 164 chars, confirmed before the run). The live run
   instead hit an OpenAI account-level `insufficient_quota` billing 429 on
   every call — a valid-format key with no funded usage quota. **The bug:**
   because the plan scoped the retry-then-record-as-not-executed treatment
   specifically to the Claude leg's disclosed rate-limit risk, the initial
   runner only applied `runChainWithRetry` behind a `leg.name === 'claude'`
   check at the call site — so the first live run recorded GPT's 6 billing
   429s as `FAIL`, which misreads an external/environmental blocker as
   evidence of a tool-calling MECHANISM defect. **The fix:** OpenAI's
   billing-quota 429 matches the same `isRateLimitError` 429-class pattern
   as an Anthropic rate limit, and both are the same category of blocker —
   entirely upstream of the mechanism under test — so `runChainWithRetry`
   is now applied to every provider leg unconditionally (its doc comment
   documents the rationale), and the benchmark was re-run live with the fix
   in place. The final grid above and the committed results.json are from
   that post-fix run: the GPT cells now correctly read `NOT-EXEC` with a
   `notExecutedReason`, matching the AC6 rubric's own language, which names
   "an external/environmental blocker (429, missing key)" as isolated (not
   structural) — the classification the AC6 verdict below makes explicitly.
2. **The Claude leg's `authMode` check was relaxed from A4's stricter gate.**
   A4's own spike required `authMode === 'oauth'` because it was
   specifically validating the subscription/OAuth _billing_ path. This
   benchmark tests tool-CALLING reliability, which is billing-mode
   agnostic, so `setUpClaudeLeg` accepts the proxy child on any successful
   `readiness.outcome === 'started'`, recording whichever `authMode` it
   resolved to in `modelId`. In the live run it resolved to `oauth` anyway
   (same as A4/A5), so this relaxation had no observable effect this run,
   but it is a deliberate, intentional design choice not explicitly spelled
   out in the plan, made because the plan's own AC3 language ("Claude via
   proxy") does not require the OAuth-specific billing mode.
3. **No `.env`-file GPT model override was added.** The plan's dependency
   section only calls out `@langchain/openai` as a new dependency; the GPT
   model id (`gpt-4o`) is resolved from `process.env.DEUS_OPENAI_MODEL` with
   a fallback matching the production OpenAI backend's own default
   (`container/agent-runner/src/openai-backend.ts:387,499`) rather than the
   codex-CLI model ids (`gpt-5.5`/`gpt-5.4`) used elsewhere in this repo —
   those name Codex CLI config, not this leg's direct chat-completions API
   call, so reusing them would have been a mismatched convention. This
   wasn't explicitly specified in the plan file and is called out here as a
   judgment call, not a plan violation.

## Addendum (2026-07-20): `claude-cli-subprocess` leg — a fresh H1/LIA-433 re-run

**Production-impact statement, up front**: this addendum documents a BENCHMARK re-run only. It
does not change, gate, or unblock any production deploy decision by itself — the CLI-subprocess
transport (LIA-454) is already live in this install independent of this benchmark's outcome. What
this addendum DOES produce is fresh, real, mechanically-scored evidence toward the H1/LIA-433
base-harness-migration GO/NO-GO criterion for the CLI-subprocess transport specifically. It does
NOT resolve the 2026-07-15 NO-PASS-YET verdict in full — that verdict covered the raw-HTTP `claude`
and `gpt` legs, both still unexecuted (unchanged since that run, both still blocked the same way).
This addendum adds a genuinely new data point (a 3rd, different transport) to the same GO/NO-GO
question, not a re-decision of the original two legs' insufficient-evidence finding.

### Why a 4th leg, not a re-run of the existing 3

`setUpClaudeLeg`/`setUpGptLeg` are still hardcoded to raw-HTTP clients
(`buildProxyRoutedChatAnthropic`, `ChatOpenAI`) — unchanged since the original NO-PASS-YET run. A
blind re-run would reproduce the identical 429s, testing nothing new. Today's session hardened a
genuinely different transport (LIA-454's CLI-subprocess mechanism, via LIA-457/458/459/460 —
compaction, memory-recall, lease observability, nested-dispatch usage propagation), which spawns
the real `claude` CLI binary through real OAuth subscription auth instead of the blocked raw-HTTP
credential-proxy path. A 4th `claude-cli-subprocess` leg was added (PR #55) — a new
benchmark-only MCP server (`lia400-cli-subprocess-benchmark-mcp-server.ts`) exposing the same 6
chains' tools, driven through `ClaudeCliSessionPool` (the same class production uses) — reusing the
existing scoring/kill-switch-rubric pipeline unchanged. Full design rationale: PR #55's description
and the plan history in that PR's review thread.

### A real scoring bug found and fixed before any run counted as evidence

The first live run (this session, pre-fix) showed the CLI-subprocess leg scoring FAIL on every
chain — but inspecting the raw tool sequences showed several cells where the model correctly called
the right tool(s) in the right order (e.g. `[mcp__lia400_bench_tools__get_weather ->
mcp__lia400_bench_tools__convert_temperature]` for `sequential_two_tool`) yet still scored FAIL.
Root cause: the real `claude` CLI reports a tool_use block's `name` as the fully qualified
`mcp__<serverName>__<toolName>` string, not the bare name `expectedToolSequence` uses —
`extractCliToolSequence` was comparing the qualified name directly against the bare one, so
`sequencesEqual` never matched regardless of correctness. Fixed via a `stripMcpToolPrefix` helper
(PR follow-up, same-day), with a new regression test using the real qualified-name shape. **No run
before this fix landed counts as valid reliability evidence for this leg** — only counted post-fix.

A second, unrelated, pre-existing environment gap was also hit and resolved: `packages/mcp-x`'s
built `dist/` referenced an unresolvable workspace package (`@deus-ai/channel-core`) because
`packages/mcp-channel-core` had never been installed+built in this checkout — a documented
prerequisite (AC5 above) that had simply never been run here. Running it
(`cd packages/mcp-channel-core && npm install && npm run build && cd ../mcp-x && npm install && npm
run build`) resolved it for both legs identically; this is an environment-setup gap, not a code
defect in either leg.

### Real data: 4 post-fix runs, `--providers=ollama,claude-cli-subprocess`

Four independent real, credentialed runs were executed after the scoring fix (one `claude-only`,
three with both legs). Per-run grids (`PASS`/`FAIL`/`NOT-EXEC`):

```
Run 2 (mcp-x not yet locally built — mcp_get_status NOT-EXEC for both, real infra gap):
chain                   ollama    claude-cli-subprocess
single_tool_lookup      PASS      FAIL
sequential_two_tool     PASS      PASS
calculation_chain       PASS      PASS
delegate_to_subagent    PASS      PASS
error_recovery          PASS      FAIL
mcp_get_status          NOT-EXEC  NOT-EXEC

Run 3 (mcp-x built):
chain                   ollama    claude-cli-subprocess
single_tool_lookup      PASS      FAIL
sequential_two_tool     PASS      FAIL
calculation_chain       PASS      FAIL
delegate_to_subagent    PASS      FAIL
error_recovery          PASS      FAIL
mcp_get_status          PASS      PASS

Run 4 (claude-cli-subprocess only):
chain                   claude-cli-subprocess
single_tool_lookup      FAIL
sequential_two_tool     PASS
calculation_chain       FAIL
delegate_to_subagent    PASS
error_recovery          PASS
mcp_get_status          FAIL

Run 5:
chain                   ollama    claude-cli-subprocess
single_tool_lookup      PASS      PASS
sequential_two_tool     PASS      FAIL
calculation_chain       PASS      FAIL
delegate_to_subagent    PASS      FAIL
error_recovery          PASS      PASS
mcp_get_status          PASS      PASS
```

**Aggregated per-chain tally, `claude-cli-subprocess`, real attempts only (excludes Run 2's
infra-blocked `mcp_get_status` NOT-EXEC on both sides):**

| chain | PASS / real attempts |
| --- | --- |
| single_tool_lookup | 1/4 |
| sequential_two_tool | 2/4 |
| calculation_chain | 1/4 |
| delegate_to_subagent | 2/4 |
| error_recovery | 2/4 |
| mcp_get_status | 2/3 |
| **total** | **10/23 (~43%)** |

**`ollama` baseline, real attempts only: 17/17 (100%)** — ollama ran in Runs 2, 3, and 5 only (Run 4
was `claude-cli-subprocess`-only); 5 real attempts in Run 2 (its `mcp_get_status` was the same
infra-blocked NOT-EXEC excluded above) + 6 in Run 3 + 6 in Run 5 = 17, all PASS, no exceptions. This
is the same clean signal the original 2026-07-15 run already established; included here only as the
same-session comparison point.

**Every chain passed with fully correct tool-call formatting and sequencing at least once**,
including the multi-hop chains (`sequential_two_tool`, `calculation_chain`), the real nested
CLI-to-CLI dispatch (`delegate_to_subagent` — a genuine second `claude` CLI conversation spawned and
returning a coherent answer), and the real external MCP round-trip (`mcp_get_status`, hitting the
same real `mcp-x` server as the Ollama leg). Tool results visibly reached the model and were
correctly incorporated into final answers on every PASS. On FAIL cells, the model either stopped
after narrating intent without calling the tool, or (on several cells) produced a response
describing generic Claude-Code-like capabilities ("file/shell/editing tools", one explicitly
mentioning PowerShell) unrelated to the actual restricted MCP-only tool set it was given — a
plausible-sounding but fabricated explanation rather than an honest "no tool available" response.
This is CONSISTENT with a real model behavior under an unusually bare, single-purpose MCP tool
catalog (no built-in tools at all, per `--tools ''`) rather than a persistent wiring defect —
`system/init` events captured during this same investigation confirmed the MCP server successfully
connects and correctly lists all 8 intended tools when probed directly (a raw non-benchmark
diagnostic call, `'ping'` prompt, showed `mcp_servers: [{name: "lia400_bench_tools", status:
"connected"}]`). This rules out a PERSISTENT/ALWAYS-BROKEN wiring defect, but does not rule out an
INTERMITTENT one coincident with specific FAIL cells — the diagnostic ping confirms the mechanism
CAN connect correctly, not that it did on every FAIL cell in these 4 runs. Distinguishing "genuine
model unreliability" from "occasional connection-timing flakiness" with confidence would need
per-cell `system/init` capture added to the benchmark itself — not done here, flagged as a
follow-up rather than asserted as resolved.

### Applying the frozen kill-switch rubric literally, then flagging a judgment call beyond it

The rubric defines exactly three outcomes for criterion 4 — PASS, FAIL, NO-PASS-YET — via two named
criteria, quoted verbatim from the AC6 section above:

- **Structural failure trigger — NOT met.** Requires an executed provider to show "never emitting a
  valid tool_call on ANY chain, tool results never reaching the model, or the harness erroring
  before the model." `claude-cli-subprocess` demonstrably does none of these — 10 real,
  correctly-sequenced, correctly-marshaled tool-call successes spanning every chain type across 4
  independent runs. This trigger does not fire.
- **Pass bar — met.** "Valid tool_call formatting, correct sequencing on at least the simpler
  chains, tool results visibly reaching the model" — demonstrated for every chain type at least
  once, and the rubric's own text explicitly states "6/6 chains on 3/3 providers is explicitly not
  required" for a pass, i.e. it does not set a success-rate threshold at all.

**A strictly literal reading of the rubric's own two named criteria therefore yields PASS** — the
rubric does not encode a reliability-rate bar, so it has no textual basis to withhold PASS over a
~43% success rate on its own terms. **This literal PASS is not the whole story, and I am adding a
judgment call beyond what the rubric's text covers, not deriving a different verdict FROM it**: a
~43% real-attempt success rate with zero clean 6/6 runs across 4 independent attempts, next to
Ollama's clean 100% baseline in the same runs, is a real, measured reliability gap the rubric simply
wasn't written to weigh (it anticipated "occasional" imperfection, not near-coinflip reliability on
several chains). Recommendation: treat criterion 4 as **PASS per the rubric's literal text, with an
explicit, quantified reliability caveat (10/23, no clean run) that should be weighed by whoever makes
the actual production-readiness call** — not silently absorbed into an unqualified GO, and not
misrepresented as a rubric-derived FAIL or NO-PASS-YET either, since neither of those is what the
rubric's own criteria actually produce here.

**Confidence and what would raise it**: this addendum's ~43% figure rests on only 23 real
chain-attempts across 4 runs — enough to establish "not structurally broken" and "meaningfully less
reliable than Ollama" with confidence, but not enough to pin down a precise success rate with a
tight confidence interval. A larger-N follow-up run (e.g. 10+ repetitions per chain) would sharpen
this from "a real, qualitative reliability gap" to a specific, comparable number — filed as a
follow-up rather than run here, given the real API cost of each repetition.

## Addendum 2 (2026-07-20): root cause of the ~43% figure — an MCP-init race, mechanism confirmed

The prior addendum above left the root cause of the ~43% figure explicitly undiagnosed. This
addendum diagnoses it, with first-hand instrumented evidence: the leg's low reliability is
**very likely a harness/CLI-timing artifact, not a genuine Claude Sonnet tool-calling
deficiency** — with a concrete, empirically-confirmed mechanism, not just a correlation.

### The mechanism

`ClaudeCliSessionPool.createConversation()` spawns the `claude` CLI child and returns after a
single `setImmediate` tick (only long enough to catch an immediate spawn error) — it does **not**
wait for the CLI's own `system/init` stream-json event, which is what reports each configured MCP
server's connection status (`mcp_servers: [{name, status}]`) and the resolved tool list
(`tools: [...]`). The benchmark's `runChainAgainstCliSubprocess` called `sendTurn()` (writing the
first turn to the child's stdin) immediately after `createConversation()` returned, with zero
synchronization against MCP-server-ready state. The CLI emits `system/init` exactly **once** per
process, with an **immutable** snapshot of `mcp_servers` status at whatever moment that snapshot
was taken — so if the MCP stdio handshake hasn't completed by then, the model's tool catalog for
that entire session is genuinely empty (compounded here by `--tools ''`, meaning zero built-in
tools either), and there is no second, corrected event to arrive later.

This is not speculation: it matches a documented, still-open upstream regression
(`anthropics/claude-code`#76239, `claude-agent-sdk-typescript`#368, `claude-ai-mcp`#383) — since
CLI 2.1.144, the first turn's tool snapshot is no longer blocked on stdio MCP servers finishing
their connection handshake. Our installed CLI is 2.1.215, past that regression's introduction.

### Instrumentation added (this PR's first commit)

`ChainResult.cliMcpDiagnostics` now captures, per `claude-cli-subprocess` cell: the `system/init`
event's `mcp_servers` status and resolved `tools` list, plus host-side timing
(`spawnToInitMs`/`spawnToFirstAssistantMs`) `ClaudeCliSessionPool` already tracked internally but
this benchmark previously discarded. A first real instrumented run (single run,
`--providers=claude-cli-subprocess,ollama`, no experimental changes yet) directly confirmed the
race, cell by cell:

```
calculation_chain (FAIL): mcp_servers=[{status:"pending"}], toolsAtInit=[], finalAnswer="I don't
  have dedicated 'add' or 'multiply' tools available in my current toolset — only file, search,
  and shell tools."
error_recovery (FAIL): mcp_servers=[{status:"pending"}], toolsAtInit=[]
single_tool_lookup / sequential_two_tool / delegate_to_subagent / mcp_get_status (all PASS):
  mcp_servers=[{status:"connected"}], toolsAtInit=<all 8 tools>
```

Every FAIL cell showed the MCP server still `pending` (empty tool catalog) at the moment
`system/init` was captured; every PASS cell showed `connected` with the full 8-tool list. The
`calculation_chain` FAIL's own text is the confabulation pattern predicted by an empty-catalog
race: rather than an honest "no tool available," the model fabricated a plausible-but-wrong
description of generic Claude-Code-like capabilities it did not actually have in this
maximally-restricted session (`--tools ''`, `--setting-sources ''`, MCP-only).

### The pre-turn-delay experiment (this PR's second commit) — control vs. treatment

To test causally (not just correlationally) whether the race is fixable from the caller side, a
flat, unconditional delay was inserted between `createConversation()` and `sendTurn()`
(`--preTurnDelayMs=<n>`), with `TSX_DISABLE_CACHE=1` forced on the MCP server's spawn env in both
arms so neither run benefits from tsx's persistent module-transform cache being warmer than the
other (a real, verified confound — this machine already had 400+ cached entries before this
investigation began). Two runs, `--providers=claude-cli-subprocess` only, back to back in the same
session:

**Control** (`--preTurnDelayMs=0`) — reproduces the original race:

```
chain                   status      mcp_servers   tools  spawnToInitMs
single_tool_lookup      PASS        connected     8      966
sequential_two_tool     PASS        connected     8      916
calculation_chain       FAIL        pending       0      709
delegate_to_subagent    FAIL        pending       0      725
error_recovery          PASS        connected     8      826
mcp_get_status          PASS        connected     8      1083
```

4/6 PASS (67%) — consistent with the ~43% figure's earlier runs' variance, not an outlier.

**Treatment** (`--preTurnDelayMs=3000`) — clean sweep:

```
chain                   status      mcp_servers   tools  spawnToInitMs
single_tool_lookup      PASS        connected     8      3017
sequential_two_tool     PASS        connected     8      3046
calculation_chain       PASS        connected     8      3044
delegate_to_subagent    PASS        connected     8      3049
error_recovery          PASS        connected     8      3042
mcp_get_status          PASS        connected     8      3044
```

**6/6 PASS (100%)**, `mcp_servers` `connected` with the full tool list on every cell.

**The mechanistically decisive finding is `spawnToInitMs` itself, not just the PASS/FAIL grid**:
in the treatment run, `spawnToInitMs` lands at ~3017-3049ms in every single cell — moving in
lockstep with the inserted 3000ms delay, not clustering near the control run's ~700-1100ms range.
This means the CLI's one-time `system/init` snapshot is **not** simply taken at a fixed
spawn-relative time; its timing tracks closely with when the first turn's stdin write happens.
Delaying that write gave the MCP stdio handshake the extra ~2-2.3s it needed to complete before
the snapshot was taken, on every cell, including the two that failed in the control run at
identical chain definitions.

### Explicitly scoped conclusion

This is one pair of runs (N=6 chains per arm) — directionally decisive given the clean 4/6→6/6
result AND the `spawnToInitMs`-tracks-the-delay mechanism (not just an aggregate rate that could
be attributed to noise), but **not** a statistically powered reliability figure. A larger-N
repeated-trial run (10+ reps per chain, both arms) remains a legitimate follow-up to replace "one
clean pair of runs" with a precise, defensible number — not done here, same real-API-cost
rationale as the original addendum's own equivalent caveat.

**What this changes for LIA-400/H1/LIA-433**: the ~43% figure from the original addendum should
**not** be read as evidence of a Claude Sonnet tool-calling reliability ceiling. The evidence here
points to a specific, mechanistically-explained, and — within this benchmark's own harness —
apparently mitigable MCP-server-readiness race, not a property of the model. This does not by
itself flip the mitigation into production (the actual `ClaudeCliSessionPool` used by
`deus-native` in production is unmodified by either PR in this investigation — only the benchmark
script's own diagnostic/experimental code changed), and it does not resolve H1/LIA-433's much
broader scope (parity matrix, AAG-007b, release-scale sampling). It does mean: **whoever makes the
production-readiness call on the CLI-subprocess transport should weigh this finding as "a
diagnosed, plausibly-mitigable harness timing issue," not "a demonstrated model-reliability
gap."** A genuine production mitigation (e.g. a wait-for-MCP-ready check before the first real
turn, applied in `ClaudeCliSessionPool` or its callers, not just this benchmark) is a distinct,
not-yet-scoped follow-up.

# Deus-native transcript storage

**Status:** Accepted
**Date:** 2026-07-18
**Scope:** `src/agent-runtimes/transcript-store.ts`, `src/agent-runtimes/deus-native-backend.ts`, transcript-consuming Python tools

## Context

LangGraph checkpoints in
[`checkpointer.ts`](../../src/agent-runtimes/checkpointer.ts) are opaque resumable
graph state. Vault session logs written by
[`memory-session-log.ts`](../../src/memory-session-log.ts) are lossy Markdown
summaries. Neither is a durable, line-oriented source transcript owned by Deus.
Historical consumers therefore depended on Claude Code JSONL even after the
host-side `deus-native` runtime became a real execution path.

`STORE_DIR` is the real `<PROJECT_ROOT>/store` constant in
[`config.ts`](../../src/config.ts). There is no `DEUS_STORE_DIR` configuration
contract. A Python process cannot import that TypeScript value, so normal tools
derive the same repository-relative root and expose an explicit
`--native-transcripts-dir` seam for atypical daemon working directories.

## Decision

### Owned append-only store

Successful completed `deus-native` turns are appended beneath:

```text
<PROJECT_ROOT>/store/transcripts/deus-native/<sha256(UTF-8 sessionId)>.jsonl
```

The original session id remains inside each record. Hashing confines arbitrary
caller-supplied ids to one direct child filename. The writer owns recursive
directory creation, queues appends per final path inside the single host process,
and writes each turn with one append operation containing exactly two
newline-terminated JSON objects: user first, assistant second. It never truncates,
rewrites, compacts, or deletes v1 transcript files.

On POSIX, the writer sets and verifies the final directory at `0700` and each
transcript at `0600`, including pre-existing paths. Windows does not provide a
meaningful POSIX-mode-to-ACL mapping; writing remains best-effort there and relies
on the user's local filesystem ACL.

### Schema v1

Every record has `schemaVersion: 1`, `source: "deus-native"`, `type`,
`sessionId`, `uuid`, `turnId`, `timestamp`, `groupFolder`, `role`, `message`, and
`deusNative`. `cwd` is present only when the runtime supplied it. A turn shares one
minted `turnId`; the assistant has `parentUuid` pointing to the user id.

The authoritative native fields are:

- `deusNative.backend: "deus-native"` and
  `deusNative.schema: "deus-native-transcript-v1"`;
- ordered `deusNative.usage`, one entry per real runtime usage event, containing
  `provider`, `model`, and only token fields actually reported;
- ordered `deusNative.toolCalls`, with id when known and name;
- assistant content containing final text followed by ordered tool-use blocks
  with JSON-safe arguments.

The Claude-shaped top-level/message fields are compatibility projections for thin
offline consumers. `message.model` is the resolved primary model and does not
claim every usage event used it. `message.stop_reason: "end_turn"` records Deus's
completed status. `message.usage` is allowed only for exactly one event that
reported input, output, and total tokens; it contains only `input_tokens`,
`output_tokens`, and `total_tokens`.

Native records never invent cache-creation/cache-read tokens, provider request
ids, or `main`/`nested` provenance. They also exclude tool-result payloads,
checkpoint state, system prompts, injected repository/vault context, and retrieved
memory content.

### Success boundary and failure behavior

[`deus-native-backend.ts`](../../src/agent-runtimes/deus-native-backend.ts)
captures prompt, current-turn ids, ordered tool calls, timestamps, resolved model,
and a tee of the existing usage-event sink. It first awaits the unchanged
`output_text` and `turn_complete` emissions, prepares the successful `RunResult`,
then invokes the writer as the final guarded action before returning. No error or
catch path writes a pair.

The direct `runTurn` seam is more accurate than an EventBus subscriber because the
runtime event union does not contain the submitted prompt or complete assistant
projection. The writer catches directory, permission, serialization, open, and
append failures and warns without transcript content. A second narrow backend
catch protects against an unexpected rejected writer promise. Persistence can
never change status, output text, session id, usage aggregate, event order, or
terminal delivery.

Crash or disk exhaustion can leave a missing final turn or malformed trailing
line. Readers are therefore line-oriented and fail-soft: they return earlier valid
records while skipping blank, malformed, non-object, unsupported-version, and
orphan records with path/line-only warnings.

## Consumer audit

Nine genuine transcript consumers have these dispositions:

1. [`analyze_token_efficiency.py`](../../scripts/analyze_token_efficiency.py)
   scans Claude and native sources by default, keeping native calls/turns in a
   separately labelled `deus-native` section. Native cache metrics are unavailable,
   not zero. The selected v1 rendering is “Deus-native usage — calls, turns,
   tokens, cache not reported,” followed by per-provider/model evidence.
2. [`transcript_archive.py`](../../scripts/transcript_archive.py) adds exact hashed
   native-session resolution, `auto|claude|deus-native` selection, frozen
   precedence, and ambiguity errors while archiving selected raw bytes unchanged.
3. [`recall_source.py`](../../scripts/recall_source.py) remains production-unchanged:
   content-hash lookup and decompression are schema-agnostic. Native byte-round-trip
   coverage proves the boundary.
4. [`cc_backfill.py`](../../evolution/cc_backfill.py) remains Claude-only because
   `eval_suite='claude_code'` describes historical source provenance.
5. [`backfill.py`](../../evolution/backfill.py) unions path-sorted legacy
   `data/sessions` history with path-sorted native history under
   `eval_suite='backfill'`; limit applies only after that combined order exists.
6. The codegraph-first reader in
   [`codex_warden_hooks.py`](../../scripts/codex_warden_hooks.py) remains bound to
   the executing Claude PreToolUse event's `transcript_path`.
7. [`stop_hook.py`](../../scripts/stop_hook.py) remains bound to the Claude Stop
   event's `transcript_path` for live turn extraction and checkpoint/compress gates.
8. [`nonumb-gate.sh`](../../.claude/hooks/nonumb-gate.sh) remains bound to Claude's
   Stop-hook schema and current-session transcript path.
9. `createPreCompactHook`/`parseTranscript` in the F1-owned
   [`container/agent-runner/src/index.ts`](../../container/agent-runner/src/index.ts)
   remains unchanged. It archives Claude Code PreCompact input as Markdown and is
   explicitly outside F5's migration boundary.

[`drift_check.py`](../../scripts/drift_check.py) is a separate Claude Code schema
oracle, not a general offline consumer. It must continue inspecting live Claude
JSONL and must not adapterize against native records.

## Verified non-consumers

Eight categories were checked and require no native adapter work:

1. The `/checkpoint` and `/handoff` skill instructions write vault Markdown and do
   not parse conversation JSONL.
2. [`log_review.py`](../../scripts/log_review.py) reads infrastructure logs and
   usage counters, not conversation transcripts.
3. [`session_preflight.py`](../../scripts/session_preflight.py) reads Claude's live
   process/session registry, deliberately distinct from append-only transcripts.
4. [`compression_benchmark.py`](../../scripts/compression_benchmark.py) checks a
   Claude-projects path as a vault candidate but does not parse turns.
5. `_is_excluded` in
   [`codex_warden_hooks.py`](../../scripts/codex_warden_hooks.py) is only a
   path-string exclusion predicate. This function-level fact does not change that
   file's genuine codegraph reader disposition above.
6. Eval/evolution benchmark fixtures and unrelated JSONL producers—including
   `eval/conftest.py`, `evolution/benchmark_judge.py`,
   `evolution/build_judge_benchmark.py`, token probes, implicit-feedback mining,
   and embedding experiments—do not read live session transcripts.
7. Host/container ingress, audit, tool-call, tool-size, and usage JSONL paths are
   infrastructure logs rather than conversation turns. The same
   `container/agent-runner/src/index.ts` file is classified per function: its
   PreCompact reader is consumer 9, while its usage/tool-size logging is not.
8. `readTranscript()` in
   [`lia397_credential_proxy_billing_spike.test.ts`](../../scripts/spikes/lia397_credential_proxy_billing_spike.test.ts)
   parses that test's intercepted console record, not a session transcript.

## Accepted parity gaps

No native codegraph-first enforcement, Claude Stop-hook auto-checkpoint/background
`/compress` gate, or no-numb edit detection is added here. Native middleware invokes
only the plan/code/AI-engineering/verification review behaviors and carries no
Claude `transcript_path`. Its live tool inclusion boundary is currently web-only,
so edit/search hook parity is non-applicable until that surface is separately
widened. LangGraph checkpoint continuity and host idle auto-compress are separate
mechanisms; neither is represented as a native Stop event.

## Consequences and reversibility

- Native raw prompts, responses, cwd values, and tool arguments now persist in a
  host-local sensitive store and become available to genuine offline consumers.
- Checkpoints remain resumable graph state; vault Markdown remains a lossy memory
  artifact; content-addressed archives remain a distinct cold store.
- Reverting or disabling the writer stops new appends immediately. Reverting the
  adapters stops native discovery. Existing native files and already-created
  archives remain readable and are never automatically deleted, migrated, or
  rewritten. Retention requires a separate explicit operator decision.

## Completeness and verification audit

Last run: 2026-07-18.

```bash
grep -rln '\.jsonl' --exclude-dir={node_modules,dist,.git,.claude} .
grep -rn 'claude/projects' .
rg 'data/sessions|sessions/.*\.jsonl|\.jsonl' evolution scripts src docs -g '!node_modules' -g '!dist' -g '!.git' -g '!.claude'
rg 'writeFile|appendFile|createWriteStream|mkdir.*data/sessions|data/sessions' .
grep -rl 'transcript_path' . --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=.git
grep -rl -E 'def read_transcript|scan_transcript|_resolve_agent_transcript' . --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=.git
```

The plan-correction checks were also run:

```bash
rg -n 'DEUS_STORE_DIR' .
git ls-files 'scripts/tests/test*backfill.py' 'evolution/tests/test*backfill.py'
```

The audit confirmed the nine consumer dispositions, separate Claude schema oracle,
eight non-consumer categories, real repository-relative store root, and use of the
already tracked backfill suites under `scripts/tests/`.

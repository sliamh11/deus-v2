# Spike: SQLite checkpointer durable session resume (LIA-399 / A6)

This spike proves LIA-399 AC1–AC5: `createAgent` wired to a `SqliteSaver`
(`@langchain/langgraph-checkpoint-sqlite`) persists every turn's checkpoints
to a real SQLite file, a `thread_id` alone locates the saved checkpoint, and a
completely fresh runtime instance — up to and including a separate OS process
started later — resumes the conversation with the previously persisted state
reloaded from disk. The model is a local Ollama `gemma4:e2b` (see design
notes: this spike deliberately avoids the Anthropic proxy).

The core seam is `createCheckpointerAgent(dbPath, model?)`: each call builds a
**brand-new** `SqliteSaver` over the same db file plus a **brand-new**
`createAgent`, sharing zero JS state with any previous instance — so anything
a second instance sees must have round-tripped through SQLite. The CLI
(`--mode=start|resume --db=<path> --thread=<id>`) wraps that seam so the
fresh-runtime claim can be escalated to two separate OS processes, each
printing a single structured JSON line to stdout (the A4/A5
parse-child-stdout convention).

All live output below was captured on 2026-07-15 against a running local
Ollama daemon with `gemma4:e2b`, in this worktree.

## AC1 — the walking skeleton persists checkpoints to SQLite

`SqliteSaver.fromConnString(dbPath)` is handed straight to
`createAgent({ model, checkpointer })` (`CreateAgentParams` has a direct
`checkpointer?: BaseCheckpointSaver | boolean` field —
`node_modules/langchain/dist/agents/types.d.ts:599`). After the live start
turn below, the db file on disk contains real rows:

```
$ sqlite3 demo.sqlite ".tables" \
    "SELECT thread_id, checkpoint_id, parent_checkpoint_id IS NOT NULL AS has_parent
     FROM checkpoints ORDER BY checkpoint_id;"
checkpoints  writes
lia399-demo|1f17fd27-e921-6a80-ffff-7e5e509dcb40|0
lia399-demo|1f17fd27-e930-64e0-8000-d6de5f04a6f2|1
lia399-demo|1f17fd28-169c-6b90-8001-680db8568b57|1
lia399-demo|1f17fd28-6f35-6630-8002-0a0a48ba03fc|1
lia399-demo|1f17fd28-6f41-6980-8003-6bce8abbea3e|1
lia399-demo|1f17fd28-94bc-6520-8004-f1f7b343565d|1
```

(The first three rows are the start turn's checkpoint lineage; the last three
were appended by the resume turn shown under AC3/AC4 — the resume process
extended the SAME thread's chain, `has_parent` linking each to its
predecessor.)

## AC2 — a session identifier locates the saved checkpoint

`locateCheckpoint(checkpointer, threadId)` calls
`checkpointer.getTuple({ configurable: { thread_id } })` directly — no agent
invoke involved — and `main` runs it BEFORE the turn, so in resume mode the
report proves the thread_id alone found the previous process's checkpoint
before any new model call could have written anything.

**Live run, start process (fresh db — nothing to find yet):**

```json
"checkpointBeforeTurn": { "found": false }
```

**Live run, resume process (separate OS process, same `--db` +
`--thread=lia399-demo`):**

```json
"checkpointBeforeTurn": {
  "found": true,
  "checkpointId": "1f17fd28-169c-6b90-8001-680db8568b57",
  "checkpointMessageCount": 2
}
```

That `checkpointId` is verbatim one of the `checkpoints` rows in the AC1
sqlite3 dump, and `checkpointMessageCount: 2` matches the start process's
persisted transcript (human + ai). The unit suite adds the negative control:
on the same db file, a *different* thread_id reports `{ found: false }` and
its turn sees none of the first thread's messages — the identifier selects
the checkpoint, not merely the file.

## AC3 — stop after a completed turn, resume in a fresh runtime instance

Two separate `npx tsx` invocations — two OS processes; the first fully exited
(closing the SQLite handle in a `finally`) before the second started:

**Process 1, 2026-07-15:**

```
$ npx tsx scripts/spikes/lia399_sqlite_checkpointer_walking_skeleton.ts \
    --mode=start --db=<tmp>/demo.sqlite --thread=lia399-demo
```

```json
{
  "mode": "start",
  "threadId": "lia399-demo",
  "checkpointBeforeTurn": { "found": false },
  "turn": { "succeeded": true },
  "messageCount": 2,
  "messages": [
    { "type": "human", "text": "Remember this fact: the persistence marker is \"teal-482\". Reply with one word." },
    { "type": "ai", "text": "Understood." }
  ]
}
```

**Process 2, started after process 1 exited:**

```
$ npx tsx scripts/spikes/lia399_sqlite_checkpointer_walking_skeleton.ts \
    --mode=resume --db=<tmp>/demo.sqlite --thread=lia399-demo
```

```json
{
  "mode": "resume",
  "threadId": "lia399-demo",
  "checkpointBeforeTurn": {
    "found": true,
    "checkpointId": "1f17fd28-169c-6b90-8001-680db8568b57",
    "checkpointMessageCount": 2
  },
  "turn": { "succeeded": true },
  "messageCount": 4,
  "messages": [
    { "type": "human", "text": "Remember this fact: the persistence marker is \"teal-482\". Reply with one word." },
    { "type": "ai", "text": "Understood." },
    { "type": "human", "text": "What is the persistence marker I told you earlier? Reply with only the marker." },
    { "type": "ai", "text": "teal-482" }
  ]
}
```

(`dbPath` fields elided above for brevity; both processes printed the same
temp path. The unit suite's same-process variant proves the narrower form of
the claim too: two `createCheckpointerAgent` instances in one process, the
first's db handle closed before the second opens.)

## AC4 — the resumed turn has access to the persisted conversation state

The resume process's transcript above IS the evidence: its first two messages
are the start process's human prompt and AI reply, byte-identical, reloaded
from SQLite (the resume process was only ever given the `RESUME_PROMPT`).
The proof is structural — the persisted messages round-trip regardless of
model quality — but as a bonus the model's final answer, `"teal-482"`, is the
marker planted by the *previous process's* turn: the reloaded state was not
just present but actually consumed by the resumed model call.

## AC5 — automated, scripted proof

`lia399_sqlite_checkpointer_walking_skeleton.test.ts`, run 2026-07-15
(15/15 passing; the two live tests ran for real — Ollama was reachable — and
the two-child-process integration test reproduces the AC3/AC4 resume behavior
end-to-end with fresh temp dbs on every run):

```
$ npx vitest run scripts/spikes/lia399_sqlite_checkpointer_walking_skeleton.test.ts

 ✓ parseCliArgs > parses the three flags in start mode
 ✓ parseCliArgs > parses resume mode regardless of flag order
 ✓ parseCliArgs > rejects an unknown mode
 ✓ parseCliArgs > rejects a missing flag
 ✓ parseCliArgs > rejects an unrecognized argument by name
 ✓ closeCheckpointer > closes the underlying better-sqlite3 handle
 ✓ locateCheckpoint > reports found false for a thread with no saved checkpoint
 ✓ SQLite persistence round-trip (real saver + agent, fake model)
   > resumes a thread in a fresh runtime instance with the first turn reloaded from SQLite
 ✓ SQLite persistence round-trip (real saver + agent, fake model)
   > keeps threads isolated: a different thread_id on the same db sees none of the first thread
 ✓ main > prints a single JSON line with the pre-turn checkpoint location and turn outcome
 ✓ main > sends the start prompt in start mode
 ✓ main > reports a failed turn without messages and still closes the checkpointer
 ✓ main > closes the checkpointer even when locateCheckpoint throws
 ✓ live resume against local Ollama (skipped when no daemon is reachable)
   > resumes a real-model thread in a fresh same-process runtime instance      8665ms
 ✓ live resume against local Ollama (skipped when no daemon is reachable)
   > a second OS process resumes the thread a first OS process persisted      9531ms

 Test Files  1 passed (1)
      Tests  15 passed (15)
   Duration  18.51s
```

`npx tsc --noEmit` was clean on the same tree.

## Design notes

- **Why local Ollama, not the Anthropic proxy:** A6 tests checkpointer
  persistence mechanics — billing/auth is A4's job and MCP consumption is
  A5's. Routing through the proxy would re-expose this spike to the real
  account-level 429 rate-limit fragility that blocked both A4's and A5's live
  evidence, for zero additional signal about SQLite persistence. `gemma4:e2b`
  is confirmed live locally, free, and has no external dependency. A3's spike
  (lia396) defines the same `OLLAMA_BASE_URL` / model-id constants, but on
  its own unmerged branch (PR #1034) outside this worktree's ancestry — so
  this spike duplicates the two constants rather than importing across
  branches, and declares its own `@langchain/ollama` devDependency.
- **Hermetic tests via the injectable model seam:** CI's root vitest job runs
  `scripts/spikes/**/*.test.ts` with no Ollama daemon, so
  `createCheckpointerAgent`'s `model` parameter is injectable. The hermetic
  round-trip tests inject `FakeToolCallingModel` (langchain's own
  `createAgent` test model — a real `BaseChatModel` with a working
  `bindTools`), which keeps the REAL `SqliteSaver` + `createAgent`
  checkpoint write/read path under test everywhere while only the
  network-bound LLM is faked. The live suites self-skip via a 1.5s
  `/api/tags` reachability probe instead of failing the run.
- **POSIX-only child spawning:** the integration test spawns
  `node_modules/.bin/tsx` directly (same mechanism as A4's
  `spawnProxyChild`). Throwaway spike scope is intentionally POSIX-only;
  production portability remains centralized in `src/platform.ts`.
- **`agent.getState()` gotcha:** on the `ReactAgent` returned by
  `createAgent`, `getState()`/`getStateHistory()` are typed `never` and
  marked `@internal` — calling them through the typed surface is a compile
  error. This spike only needs `invoke().messages` (cast through the same
  `{ messages: BaseMessage[] }` shape A1/A3/A4/A5 already use, since
  `ReturnType<typeof createAgent>` can't thread the full generics). If a real
  `StateSnapshot` is ever needed, use `agent.graph.getState(config)` — the
  underlying `CompiledStateGraph`'s genuinely typed method.
- **`setup()` is never called:** `SqliteSaver.setup()` is `protected`, lazy,
  and idempotent — invoked internally by `getTuple`/`list`/`put`/`putWrites`.
  Table creation is therefore implicit in first use, which the AC1 sqlite3
  dump confirms.
- **No `close()` on `SqliteSaver`:** the caller owns the lifecycle of the
  public `db` field (a better-sqlite3 `Database`); `closeCheckpointer` wraps
  `checkpointer.db.close()` and every open site pairs it in a `finally`.

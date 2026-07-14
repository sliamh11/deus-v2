# Spike: MCP → LangChain tool adapter walking skeleton (LIA-398 / A5)

This spike validates LIA-398 AC1–AC5: `@langchain/mcp-adapters`'
`MultiServerMCPClient` can spawn a real Deus MCP server (`mcp-x`) over stdio,
convert its tools into LangChain `DynamicStructuredTool`s, and a
`createAgent` agent can discover and invoke one of those tools with the tool
result visible to the model. The proof uses two independent child processes:
an isolated credential-proxy child (A4's mechanism, imported directly from
`lia397_credential_proxy_billing_spike.ts`) that authenticates the model call
on the subscription/OAuth path, and the `mcp-x` server child that the MCP
client spawns to serve the tools. `mcp-x` was chosen as the target server
because it degrades gracefully with zero credentials — its `XClient`
constructor warns and returns rather than throwing when `X_API_KEY` etc. are
unset — so tool discovery and invocation work on any machine.

## AC1 — construct an MCP client for a real Deus MCP server

`createMcpXClient` points `MultiServerMCPClient` at the built `mcp-x` server
over stdio:

```ts
return new MultiServerMCPClient({
  mcpServers: {
    'mcp-x': {
      transport: 'stdio',
      command: 'node',
      args: [MCP_X_DIST_PATH],
    },
  },
});
```

`MCP_X_DIST_PATH` resolves to `packages/mcp-x/dist/index.js` relative to the
spike file's own location, and `assertMcpXBuilt` fails loud with build
instructions before any subprocess spawn if the dist output is missing. No
`env` override is passed — `mcp-x` starts cleanly with zero credentials. No
`onConnectionError` is passed either: the default (`'throw'`) is what we want,
since a genuine connection failure should surface immediately rather than be
papered over.

## AC2 — tool discovery over stdio

`runToolDiscoverySmokeTest` calls `client.getTools('mcp-x')`, throws if the
server connects but exposes zero tools, and reports the discovered tool names
plus whether `get_status` is among them. Expected output: a `toolNames` array
containing `get_status` (and the other X tools such as `post_tweet`), with
`statusToolFound: true`.

**Live run, 2026-07-15 (two consecutive attempts, `npx tsx
scripts/spikes/lia398_mcp_adapter_walking_skeleton.ts`, identical result both
times):**

```json
{
  "toolNames": [
    "post_tweet", "reply_to_tweet", "quote_tweet", "like_tweet",
    "unlike_tweet", "retweet", "undo_retweet", "get_timeline",
    "search_tweets", "get_tweet", "get_my_profile", "get_status"
  ],
  "statusToolFound": true
}
```

Real, unambiguous evidence: `MultiServerMCPClient` connected over stdio to
the actual running `mcp-x` server (no mocks, no credentials) and discovered
all 12 of its real tools, `get_status` confirmed present. AC1 and AC2 are
both cleanly satisfied by this output — the adapter genuinely connects to a
real Deus MCP server and discovers real tools through `createAgent`'s tool
array.

## AC3 + AC4 — agent invokes an MCP tool, result visible to the model

`runAgentToolInvocationSmokeTest` builds a `createAgent` agent from the
proxy-routed `ChatAnthropic` model plus the discovered MCP tools, then asks
it to "Check whether X credentials are configured and tell me." — a prompt
that steers the model toward calling `get_status`. The returned message list
is then inspected:

- a message with `getType() === 'tool'` **and** `name === 'get_status'`
  proves the agent actually invoked THAT specific MCP tool through the
  adapter (not just any of the several tools `mcp-x` exposes), and its
  `content` is captured as `toolResult`;
- "visible to the model" means exactly that tool message: it sits in the
  transcript BEFORE the final AI message, so the model's closing answer
  (`finalResponse`, the last message with `getType() === 'ai'`) was generated
  with the tool's output in context.

The function never throws — any failure is normalized into
`{ succeeded: false, toolWasCalled: false, error }`.

**Live run, 2026-07-15 (both attempts, identical result):**

```json
{
  "succeeded": false,
  "toolWasCalled": false,
  "error": "429 {\"type\":\"error\",\"error\":{\"type\":\"rate_limit_error\",\"message\":\"Error\"},\"request_id\":\"req_011Cd2fAmvq4TbTjYEkAzEgj\"}\n\nTroubleshooting URL: https://docs.langchain.com/oss/javascript/langchain/errors/MODEL_RATE_LIMIT/\n"
}
```

Both attempts hit `429 rate_limit_error` from Anthropic's real API on the
**very first model call** inside `createAgent`'s invocation — before the
model ever reached a tool-selection decision. The error body's own `"type"`
field reads `rate_limit_error`, not `authentication_error` — the same
signature A4 saw, and by the same reasoning (Anthropic only rate-limits
requests it has already authenticated), this confirms the proxy-routed
model call reached Anthropic authenticated. The most plausible cause is this
session's own very heavy API usage today across both the A4 and A5
multi-round plan/code-review cycles, sharing the same account-level quota.

**Important asymmetry vs A4:** A4's spike captured real request headers even
on its rate-limited call (via a header-capturing fetch wrapper), so that 429
arrived *after* direct evidence of the tested property. This spike has no
header capture — it only inspects the message list after a successful
`invoke()`, and since `invoke()` itself 429'd before any tool-selection
reasoning could occur, **this run provides no direct evidence that the
agent can actually discover-then-invoke an MCP tool and see its result** —
only that the underlying auth mechanism (already proven by A4) still works.
AC3 ("the agent invokes the discovered tool successfully") and AC4's "the
tool result is visible to the model" half were not exercised end-to-end.
The unit suite (14/14 passing, including a test that correctly distinguishes
a `get_status` call from a different tool's call) verifies the
*detection/extraction logic* is correct against scripted message lists —
but verifies nothing about whether a live model actually produces that call.

## AC5 — kill-switch verdict

**Verdict: NO-PASS-YET (qualified) — kill-switch NOT fired; one clean
confirmation run required before criterion 3 can be recorded as PASS.**

The evidence splits cleanly. MCP *discovery* (AC1+AC2) is proven with real,
unambiguous evidence — connect, discover 12 real tools, confirm `get_status`
present, no mocks. MCP *consumption* — the agent actually invoking a
discovered tool and seeing its result (AC3/AC4) — was never exercised
end-to-end on either attempt.

Discovery alone does not satisfy the spirit of criterion 3. "All
channel/host MCP servers must keep working" means the tools are *usable*
from the new harness, not merely enumerable — a broken schema translation,
tool-call dispatch, or result-marshaling path between
`@langchain/mcp-adapters` and `createAgent` is exactly the class of silent
failure a kill-switch exists to catch, and nothing in this run rules that
out. This differs from A4's own PASS specifically because A4's rate-limited
call still carried direct evidence of the property under test (real
request headers proving correct auth/protocol); A5's rate-limited call
carried none, since the 429 arrived before the tested mechanism (tool
selection and invocation) was ever reached.

Critically, **nothing observed indicates a mechanism failure** — the
blocker is external, account-level quota exhaustion, deterministic to
clear, not evidence the LangChain+MCP path cannot work. Triggering the
roadmap's OpenAI Agents SDK / OpenCode re-evaluation fallback would
therefore be the wrong response: that fallback is scoped to evidence of
failure, and this is an absence of evidence, not evidence of absence.

**Conditions to convert this into an unqualified PASS:** one clean live run
(after quota resets) in which (1) the model, given the real MCP-discovered
tools, emits a tool call targeting `get_status`; (2) the tool executes
against the live `mcp-x` server and its result appears as a tool message in
the returned message list, with the final AI turn reflecting that content.
**If a confirmation run instead reveals a genuine tool-calling failure
(malformed call, result not surfaced to the model), criterion 3 becomes a
FAIL and the OpenAI Agents SDK / OpenCode re-evaluation fires.**

Downstream guidance: do not record criterion 3 as passed, do not trigger
the fallback re-evaluation yet, and hold the final base-harness-migration
decision on this specific criterion until the confirmation run lands.
Everything upstream of the model call is proven; the remaining risk
surface is narrow and cheaply retestable — re-run
`npx tsx scripts/spikes/lia398_mcp_adapter_walking_skeleton.ts` once API
load is lower.

## Design notes

- **Why mcp-x:** it is the one Deus MCP server verified to start with zero
  credentials — its `XClient` constructor warns and returns instead of
  throwing when `X_API_KEY`/`X_API_SECRET` etc. are unset — so the walking
  skeleton exercises real stdio transport and real tool schemas without any
  secret provisioning.
- **Why an isolated proxy child, not the live `:3001` daemon:** round-1 plan
  review caught that the live credential-proxy daemon requires a valid
  `x-deus-proxy-token` header (`DEUS_PROXY_AUTH_ENABLED` is on by default)
  that only the container-runner can mint, so a headerless spike request
  would be rejected at the daemon's own auth gate. The spike therefore spawns
  its OWN isolated proxy child by importing `spawnProxyChild` /
  `waitForChildReady` / `buildProxyRoutedChatAnthropic` from A4's spike —
  already built, tested, and reviewed across 10 rounds — and never sends any
  request to the live daemon.
- **Nested cleanup, not sibling blocks:** the spike manages two independent
  child processes — the proxy child and the MCP client's spawned `mcp-x`
  child. The proxy child must still be alive when the agent invocation
  (which routes its model call through the proxy) runs, so the MCP client's
  `try { … } finally { await client.close(); }` is nested INSIDE the proxy
  child's `try { … } finally { proxyChild.kill(); }`. Sibling try/finally
  blocks would kill the proxy before the invocation runs and silently break
  AC3/AC4.
- **One-time local build prerequisite:** the spike spawns the built server,
  so before the first live run:

  ```sh
  cd packages/mcp-channel-core && npm install && npm run build && \
  cd ../mcp-x && npm install && npm run build
  ```

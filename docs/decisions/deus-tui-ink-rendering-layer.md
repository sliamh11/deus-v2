# `deus tui`: Ink-Based Rich Rendering Layer

**Status:** Accepted
**Date:** 2026-07-22
**Scope:** `src/cli/tui/`, `deus-cmd.sh`, `deus-cmd.ps1`, `tsconfig.json`,
`vitest.config.ts`, `package.json`, `tests/test_session_type_contract.py`,
`docs/decisions/tui-archival.md`, `docs/agent-agnostic-debt.md`
**Ticket:** Track B of `/Users/liam10play/.claude/plans/expressive-foraging-reef.md`
**Related:**

- [tui-archival.md](tui-archival.md) — archived the prior Rust TUI (LIA-389)
  and shipped `deus tui`'s temporary archival-diagnostic stub. This ADR
  supersedes that stub's behavior (not the archival decision itself — the
  Rust implementation stays archived and is not restored); see the
  superseding note added to that ADR's Decision section.
- [deus-native-cli-chat.md](deus-native-cli-chat.md) (if present) /
  `deus-native-chat-client.ts`'s own module doc — `deus chat` (LIA-428/G1,
  LIA-430/G3), whose `ChatTransport`/`ChatDisplayEvent`/`NativeChatStatus`/
  `PermissionDecision` contracts this ADR reuses unchanged.
- `deus-v2-permission-rules.md`'s 2026-07-21 Amendment (LIA-465/LIA-466) —
  shipped the live `[y]/[N]` permission prompt and the `allow_once`/
  `allow_always`/`deny` three-way `PermissionDecision` this TUI's
  `PermissionModal` renders.
- `docs/agent-agnostic-debt.md`'s `AAG-015` — a SEPARATE, still-open
  triage decision about a dead `packages/tui/` TypeScript/Ink prototype.
  Cross-linked, not resolved or touched by this ADR (see "Not the
  `packages/tui/` prototype" below).

## Context

`deus chat` (LIA-428/G1) is a plain-readline terminal client: it prints
assistant text, tool/progress feedback lines, and a static
`[y]es / [N]o` permission prompt straight to stdout, with no persistent
layout. A 2026-07-21 handoff
(`Handoffs/2026-07-21-23-19-deus-v2-ui-ship-web-direction-next.md`) named
the concrete unfinished piece from that work: "the richer TUI rendering
layer (multi-pane activity view, command palette)... the actual 'make it
feel like a real TUI, not just Y/N prompts' step." The same day, LIA-465
(protocol spike) and LIA-466 (live permission prompts, three-way
`allow_once`/`allow_always`/`deny` decision) shipped into production
`deus chat`, giving a rich TUI something real to render against.

Separately, a 6-scout research swarm + Fable/GPT-5.6-Sol debate
(2026-07-21) on adopting an external TUI/web project (Hermes, Crush,
OpenCode, LangGraph-ecosystem tooling) concluded: don't fork a whole
external product — steal UX patterns, not code; keep Deus's own
client/server protocol authoritative; one permission authority only. That
conclusion governs this ADR's Decision below.

### Framework choice: Ink

Three realistic options for the rendering framework:

1. **Ink (React-based terminal renderer).** Same engine class as Claude
   Code's and Gemini CLI's own terminal UIs — proven at this exact scale
   (a single-pane, single-session conversational TUI, not a
   high-frequency-update dashboard). React's component model maps
   directly onto this TUI's actual shape (status header / transcript
   pane / input line / modal / palette), and `ink-testing-library` gives
   a real, non-simulated keystroke-level test harness (used throughout
   `deus-tui-app.test.tsx`).
2. **blessed / neo-blessed (imperative curses-style terminal UI).** Lower
   memory footprint, no React dependency, but an imperative
   widget-tree API this codebase has no existing pattern for, and a much
   thinner testing story (no equivalent to `ink-testing-library`'s
   `render()`/`lastFrame()`/`stdin.write()` DI seam) — would have meant
   inventing a bespoke test harness for step 14 instead of reusing an
   established one.
3. **Stay readline-only (no rich layer at all).** Rejected — this is
   exactly the gap the 2026-07-21 handoff named as the concrete remaining
   work; not building it leaves the "make it feel like a real TUI" step
   permanently undone.

Prior research (cited in the plan this ADR implements) raised three
framework-risk points against Ink specifically — its ~30fps render cap,
memory weight, and an accessibility critique of raw-mode terminal UIs.
All three are judged non-issues for this use case: a single
conversational turn's `ChatDisplayEvent` stream is not high-frequency
spam (nothing like a live dashboard or game-loop workload), and `deus
chat` remains, unmodified, as the plain-text, screen-reader-friendly
fallback path for anyone for whom a raw-mode TUI is the wrong tool. Ink
was selected on that basis: it is proven at this scale by sibling tools,
its component model fits this TUI's actual shape, and it comes with a
real test harness — not because the risks don't exist, but because they
don't apply at this workload and there's an unmodified fallback for the
cases where they might.

### Not the `packages/tui/` prototype

`packages/tui/` (`@deus-ai/tui`) is a separate, already-dead
TypeScript/Ink prototype — last commit 2026-05-05, not in root
`package.json` workspaces, not wired into `deus-cmd.sh`/`deus-cmd.ps1`,
not mentioned in README.md, and flagged by `AAG-015` as needing its own
triage decision (keep-and-fix vs. remove) that this ADR does not make.
This work is placed at `src/cli/tui/` inside the existing root
workspace/build — not a new `packages/*` workspace, and not a revival or
reuse of `packages/tui/`'s code — because the root `package.json` has no
npm workspaces today (a second workspace would add build-pipeline
complexity for no payoff) and because conflating a from-scratch
implementation with a dead prototype's history would make both harder to
reason about. `AAG-015`'s row now cross-links here so a future reader
does not conflate the two; `AAG-015` itself remains open.

## Decision

### `deus tui` command repurposing

`deus tui` is no longer the archival-diagnostic stub `tui-archival.md`
shipped (`DEUS_TUI_ARCHIVED_MSG`, exit 1). `deus-cmd.sh`'s `tui)` case and
the new matching `deus-cmd.ps1` `"tui"` case (closing a pre-existing
Windows parity gap — `deus-cmd.ps1` had zero `tui`-related code before
this change) now `exec` the compiled `src/cli/tui/deus-tui-entry.js`,
mirroring the `chat)`/`"chat"` cases' own pattern exactly (no `cd`; the
client forwards the caller's cwd to the daemon; the discovery record
lives under `~/.config/deus-v2`, not the repo).

`deus tui` and `deus chat` remain **separate commands**, not an
auto-upgrade: `deus chat` is unmodified (scriptable, CI-safe, zero
regression risk — verified by the full existing `deus-native-chat-client
.test.ts` suite passing unchanged); `deus tui` is new and additive. A
non-interactive invocation (`!process.stdout.isTTY` — piped output, CI,
scripted contexts) refuses immediately with a clear message directing
the caller to `deus chat`, before reading the discovery record or
constructing a transport, matching the "refuse, don't degrade to a
useless static preview" call already made by the plan this ADR
implements. `DEUS_TUI_ARCHIVED_MSG`'s definition stays in `deus-cmd.sh`,
unreferenced from the `tui)` case, kept only because
`tests/test_session_type_contract.py`'s `test_tui_archived_message_defined`
still pins its existence in source as a historical-value regression
guard; the stale `tui_default` config-key nudge (which never actually
auto-launched anything even in the archived era, since bare `deus`/`deus
home` never auto-starts a TUI) now points the user at running `deus tui`
directly instead of at the old archived-Rust-TUI message.

### Architecture

`ChatTransport` and `createHttpChatTransport()`
(`deus-native-chat-client.ts`) are reused **unchanged** — this is a pure
rendering-layer swap, zero protocol changes. `ChatDisplayEvent`,
`NativeChatStatus`, `PermissionDecision`, `DENY_TIMEOUT_MS` are imported,
never redefined or widened.

- `deus-tui-permission-decision.ts` — pure `keyToPermissionDecision`,
  built against an independent oracle-author pass (blind to the
  implementation) per this repo's B7/LIA-407 precedent for
  security-adjacent surfaces: a wrong keymap here could silently turn an
  intended deny into `allow_always`.
- `deus-tui-state.ts` — pure reducer (`tuiReduce`), no Ink/React import,
  independently unit-testable. Its `permission_keypress` action resolves
  a `PermissionDecision` and closes the modal but performs no I/O itself
  — `deus-tui-app.tsx` is the one place that posts to the transport.
- `deus-tui-app.tsx` (`<App>` + `launchTuiApp`) — owns the transport,
  drives the reducer off `transport.turn()`'s streamed events, and
  composes the panes below. `launchTuiApp` re-checks daemon liveness
  (`transport.status()`) before ever rendering, exactly like
  `runChatCli`'s own startup check, so a dead daemon fails closed with
  `CHAT_UNAVAILABLE_MESSAGE` instead of rendering a TUI shell against
  nothing.
- `components/StatusHeader.tsx`, `TranscriptPane.tsx`, `InputLine.tsx`,
  `PermissionModal.tsx`, `CommandPalette.tsx` — render the same fields
  and events `deus chat` already handles (`NativeChatStatus` fields,
  the `ChatDisplayEvent.kind` switch, the three-way permission choice,
  the existing local commands `/plan on|off`, `/status`, `/exit`,
  `/quit`). No new server-visible fields or commands invented.
- Command-palette trigger: `/` on an empty `InputLine` opens a
  fuzzy-filterable list seeded from those same four local commands;
  Enter runs the selected one through the identical interpreter
  `InputLine`'s own Enter uses, so the local-command list is defined
  once.
- Sequential-turn safety: `deus chat`'s readline client queues lines
  typed while a turn is in flight and drains them in order (its own test
  asserts no overlapping `transport.turn()` calls). Ink's raw-mode input
  model makes a matching queue meaningfully more code for a
  single-user interactive TUI; this TUI instead disables `InputLine`
  while a turn is in flight, upholding the same "never call
  `transport.turn()` a second time before the first resolves" invariant
  via visible blocking instead of silent queuing — logged as a deliberate
  `Deviation:` from the readline client's exact mechanism, not its
  guarantee.

## Consequences

**Positive:**

- `deus tui` gives the multi-pane, command-palette experience the
  2026-07-21 handoff named as the concrete remaining gap, without
  touching `deus chat`'s proven, scriptable, CI-safe path.
- `PermissionModal` gives the three-way `allow_once`/`allow_always`/
  `deny` choice (LIA-466) a live countdown and a preview of which choice
  the current keystrokes resolve to — richer than the readline client's
  static one-line prompt, same underlying decision function
  (`keyToPermissionDecision`), same transport call
  (`respondPermission`).
- Closes a pre-existing Windows CLI parity gap (`deus-cmd.ps1` had no
  `tui` case at all, before or after LIA-389).

**Accepted non-goals** (named explicitly, not silently dropped — matching
this codebase's "don't solve problems that don't exist yet" rule):

- No multi-session picker (Ctrl+B-style) — not requested in the source
  handoff for this round.
- No ops-dashboard panels (wardens/services/channels/config) — a
  different product surface than a chat TUI; also not what
  `packages/tui/`'s dead prototype was for, avoiding a second reason to
  conflate the two.
- No manual scrollback/pane-scroll controls — `TranscriptPane` caps
  rendered rows to the most recent N and lets the terminal's own
  scrollback hold full history, the same "let the terminal do it" model
  `deus chat`'s plain stdout stream already relies on.
- No new fuzzy-matching dependency — `CommandPalette`'s filter is a
  small in-file subsequence matcher over a static 4-item list.

## Rollback

No database migration; no daemon-owned chat session or user conversation
data is touched. `deus chat` (the scriptable path) is unmodified by this
change, so rollback only affects `deus tui`: revert this change (and, if
desired, restore `deus-cmd.sh`'s prior `tui)` case printing
`DEUS_TUI_ARCHIVED_MSG` and exiting 1) to return `deus tui` to its
`tui-archival.md`-era stub behavior. No config migration is required —
`src/cli/tui/` has no persisted state of its own; the transport, session,
and permission state it renders all live in the same daemon-side stores
`deus chat` already uses.

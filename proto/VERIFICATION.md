# LIA-496 — Verification (Reading Room + Transcript)

One row per feature, per target. `expected` is frozen at plan time (from
`proto/design-source/lia496-fix-plan.md`'s `## Verification & capture
strategy (per batch)` section, itself sourced from the taste-pass design file) — not
retrofitted after the code exists. `observed` is what an S3 capture agent
actually saw running the real app; a FAIL row with a real artifact is kept as
a FAIL, never softened to match `expected`.

Artifact paths are relative to `proto/` unless given absolute.

**Code-review REVISE round (this revision):** re-ran the full `verify-s3.mjs`
driver against a live dev server and the full Ink capture suite from
scratch — every web/Ink row below with a `01`-`24`-numbered artifact in this
revision's ranges is freshly captured, not carried over stale from a prior
round. See each table's own summary paragraph for what changed and why.

## Web ("Reading Room") — S3A

Real Playwright (`chromium`, headless) against the live `npx vite --port
5190` dev server — `page.fill`/`press`/`click`, no synthetic DOM injection.
Full run: `web-app/captures/verify-s3.mjs`. Screenshots in
`web-app/captures/verify/`. Zero console/page errors across the whole run
except the one **deliberately, verifiably forced** error from the sidebar
error-state test itself (`consoleErrors` contains exactly one entry:
`fixtureThreadListAdapter.list: simulated failure (loading/error-state
verification)` — the real thrown `Error` that test intentionally causes, not
an unexpected failure).

| feature | expected | observed | artifact path | PASS/FAIL |
|---|---|---|---|---|
| Sidebar seeded threads, grouped Today/Yesterday | 7 seeded threads grouped under Today (3) / Yesterday (4) headers per `shared/src/fixtures/threads.ts` | Today header present, Yesterday header present, total thread rows=7, titles=["Status-glyph rendering fix","Composer keyboard shortcuts","Shiki theme swap crash","LIA-495 migration spike","Sidebar layout pass","Diff panel polish","Streaming markdown flicker"] | `web-app/captures/verify/01-sidebar-seeded-grouped.png` | PASS |
| Sidebar loading state (real 250ms `list()` latency) | A genuine loading indicator renders while `list()` is pending — NOT the empty-thread message | Code-review fix (this REVISE round): `Sidebar.tsx` previously had no loading indicator at all and — worse — showed the empty-state message ("No threads yet") during the loading window, since `isEmpty` was true both before AND after a real `list()` resolves to zero results. Fixed by reading `s.threads.isLoading` (a real library-owned reactive field, confirmed against `store/scopes/threads.d.ts`) and gating the empty-message on `!isLoading`. A fresh navigation with `waitUntil: "domcontentloaded"` (not `"networkidle"`, which can itself outlast the fake 250ms delay) reliably lands inside the window: loading text="Loading threads…", wrong empty-state message shown during load=false, loading indicator gone once real content renders=true | `web-app/captures/verify/02-sidebar-loading.png`, `web-app/captures/verify/03-sidebar-loaded-after-loading-state.png` | PASS |
| Sidebar error state (forced real `list()` rejection) + Retry recovery | A genuine `list()`-load failure renders a real error state with a Retry affordance; Retry recovers | Code-review fix (this REVISE round): previously entirely unimplemented, no VERIFICATION.md row — worse, `@assistant-ui/core`'s `RemoteThreadListThreadListRuntimeCore` swallows a `list()` rejection internally with no reactive error field anywhere on `ThreadsState` (confirmed by reading `RemoteThreadListThreadListRuntimeCore.tsx`'s `getLoadThreadsPromise` directly), so this was previously not just missing but *unobservable* through `useAuiState` at all. Fixed with a tiny owned tracker (`shared/src/listStatus.ts`, same `useSyncExternalStore` pattern as Ink's `freshDraftTracker.ts`) the adapter's real `list()` updates on every call. Verified by forcing a genuine thrown `Error` from the real adapter (`window.__lia496_simulateNextListError()`, the same "honest fakes" pattern the `theme-swap-crash` conversation already uses) — error banner text="Couldn't load threads. / Retry", recovered after clicking Retry (banner gone)=true, thread rows after recovery=7 | `web-app/captures/verify/04-sidebar-error-state.png`, `web-app/captures/verify/05-sidebar-error-recovered-via-retry.png` | PASS |
| Empty state + suggestion chips on new/fresh thread | New-chat greeting heading + 3 real `ThreadPrimitive.Suggestion` chips render | Heading present ("What are we working on?"), suggestion chip count=3 | `web-app/captures/verify/06-empty-state-suggestions.png` | PASS |
| Composer textarea rendered inside `ComposerPrimitive.Root` `<form>` | `ComposerPrimitive.Input` IS rendered inside `ComposerPrimitive.Root`, `textarea.closest('form') !== null` (the LIA-495 regression check) | `formAncestor=true` | (DOM assertion, no screenshot; see `results.json`) | PASS |
| Streaming mid-turn: partial serif prose visible while streaming | Assistant prose renders mid-stream in ui-serif/Iowan Old Style/Georgia (`.s-ast`) with partial text visible before completion | `.s-ast` element count=1, partial text sample="I'll handle both o" (message still generating) | `web-app/captures/verify/07-streaming-mid-turn.png` | PASS |
| Permission card pending state | Permission-needed decision card renders with Allow / Not now / Always allow before any decision | card heading="Permission needed — delete file", Allow button present=true, Always allow button present=true | `web-app/captures/verify/08-permission-pending.png` | PASS |
| Permission card resolved (Always allow) | After clicking **Always allow** (not Allow once — see the grant-store row below for why this specific choice matters), the card shows a resolved state, no pending buttons, and the `delete_file` permission class is granted for the rest of the session | resolved text="Always allow — deleted" | `web-app/captures/verify/09-permission-resolved-always-allow.png` | PASS |
| Diff card (Edit tool result) renders with colored +/- lines | `DiffPanel` renders a dark code card with filename header, +N/-N badge, colored diff lines (`--s-diff-add #93C989` / `--s-diff-del #D98D82`) | header="src/cli/tui-v2/components/messages/ToolMessage.tsx +3 −3", `.s-add` lines=3, `.s-del` lines=3 | `web-app/captures/verify/10-diff-card.png` | PASS |
| Turn 2 follow-up ("anything else stale?") completes with no permission gate | `turn2()` runs a plain verify command (no `delete_file` tool-call) and completes on its own — this is NOT the grant-store proof, just the setup turn that must finish before turn 3 can be sent | narration includes turn-2 closing text=true | `web-app/captures/verify/11-turn2-followup-complete.png` | PASS |
| Second permission-requiring action auto-approved (grant-store proof) | Turn 3's second `delete_file` request renders **no new** `.s-perm` prompt UI at all (Always-allow granted in turn 1) — a prompt rendering here is the FAIL, not a partial pass | **Re-captured for real this REVISE round — the prior row of record was a FALSE PASS** (code-review finding, high severity): the old script clicked "Allow once" (never "Always allow"), sent only 2 user messages so `turn3Start` never ran, and the old pass condition (`.s-perm count===1` + `bodyText.includes("Done")`) was vacuously true regardless. Fixed: `verify-s3.mjs` now clicks **Always allow** at turn 1 (grants the permission class), sends a genuine THIRD user message ("One more check — anything else stale from the tui-v2 work?"), and asserts BOTH that no new `.s-perm` card renders AND that the narration text actually mentions the auto-approval. `.s-perm` count before turn 3 send=1, after turn 3 completes=1 (unchanged — still only turn 1's resolved card), turn-3 narration present ("since you already said always-allow deletions this session, I'll clear it without asking again" / "Cleared")=true. (Catching this required a second fix: `ActionBar.tsx`'s `autohide="not-last"` + `hideWhenRunning` UNMOUNTS the Reload button between turns — confirmed by reading `ActionBarRoot.tsx` directly — so a naive `.first().waitFor({state:"visible"})` resolves on a stale pre-send element and silently drops the next composer submit; fixed with a 1→0→1 count-cycle wait, `waitForCount()` in the script.) | `web-app/captures/verify/12-turn3-second-permission-grant-proof.png` | PASS |
| Thread switch away + return preserves live-created messages | Switching to another thread and back preserves messages created live during this session (**turn 3's** user message still present) | Corrected this REVISE round (low-severity finding: the prior row's own prose mislabeled turn 2's message as turn 3's — per `shared/src/fixtures/conversations.ts`, "Did that leave anything else stale in /tmp?" is turn 2's text; turn 3's is "One more check — anything else stale from the tui-v2 work?", sent in the grant-store step above). Live turn-3 message ("One more check — anything else stale from the tui-v2 work?") still present after switch-back=true | `web-app/captures/verify/13-switched-away.png`, `web-app/captures/verify/14-switched-back.png` | PASS |
| Markdown code block highlighted from FIRST rendered frame (shiki) | Fenced code block shows shiki-highlighted syntax colors from the FIRST rendered frame — a plain-text still is a FAIL (highlighter pre-warmed specifically to avoid this race) | 40ms-polled 164 samples across the full streaming window: 3 samples hit the transient `.cb-inline-fallback` DOM state but `bodyTextLen=0` in every one — i.e. the code block goes directly from empty to shiki-highlighted, no visible unstyled text is ever on screen. Final render has 1 `.shiki` element. | `web-app/captures/verify/15-markdown-shiki-codeblock.png` | PASS |
| Copy button copies real code text, shows "Copied" state | Clicking Copy writes the real fenced code text to the clipboard and the button shows a "Copied" state | button label="Copied", clipboard length=166, full rendered code length=166, clipboard text matches rendered code exactly | `web-app/captures/verify/16-codeblock-copied-state.png` | PASS |
| Copy "Copied" state reverts after 2 seconds | Copy action shows a 2-second "Copied" state then reverts | button label ~2.2s later="Copy" | (timed DOM assertion, no screenshot) | PASS |
| Edit a user message, branch picker shows 2/2 | Editing a sent user message and resubmitting creates a sibling branch; `BranchPickerPrimitive.Root` (`hideWhenSingleBranch`) shows Number/Count as 2 / 2 | **No edit affordance exists on `UserMessage` in `web-app/src/components/Thread.tsx`** — it renders only `<div className="s-user"><div className="chip"><MessagePrimitive.Content/></div></div>`, no button/dblclick handler wired to `composer.beginEdit()`. Real double-click on the chip only triggered native browser text selection, no editable field appeared, `.s-branchpicker` count=0. `BranchPicker.tsx`'s header comment was corrected this REVISE round (code-review finding: it previously claimed this affordance existed — "edit + resend (ComposerPrimitive's per-message edit affordance ...)" — a documented-but-nonexistent behavior; now accurately describes only the proven Reload-driven branching path). The BRANCHING MECHANISM itself is not broken — the separate Regenerate test below independently produced a real 2-branch thread with `BranchPicker` correctly showing "2 / 2". | `web-app/captures/verify/17-edit-message-attempt.png` | **FAIL** |
| Regenerate (Reload) produces a genuinely different scripted variant | `ActionBarPrimitive.Reload` re-invokes the real adapter; per the plan's Feature scope this returns a scripted VARIANT on re-run, not an empty response | before="...Done — Cmd+Enter submits, Escape blurs the pill composer. Try it out." / after="...Try it out. (regenerated — same result on a fresh pass, nothing new to add.)" — non-empty, genuinely different from before, contains the "regenerated" variant marker. Branch picker on this message now shows "2 / 2", confirming the branching mechanism works correctly when invoked via Reload. | `web-app/captures/verify/18-regenerate-mid.png`, `web-app/captures/verify/19-regenerate-variant.png` | PASS |
| Responsive at 768px | Sidebar collapses to an overlay drawer below ~860px (per `theme.css`'s `@media(max-width:860px)` rule) | Sidebar's bounding box is translated fully off-canvas (`x + width <= 0`), hamburger drawer-open button visible=true | `web-app/captures/verify/20-responsive-768.png` | PASS |
| Responsive at 390px: sidebar becomes overlay drawer | At 390px the sidebar is an off-canvas drawer; opening it via the hamburger shows the drawer + scrim overlay | `.s-side.open` present=true, `.rr-scrim.open` present=true after clicking hamburger | `web-app/captures/verify/21-responsive-390-closed.png`, `web-app/captures/verify/22-responsive-390-drawer-open.png` | PASS |
| Error state thread renders real thrown-error UI | "theme-swap-crash" thread's real thrown `Error` (inside `run()`) propagates to `message.status={error}` and `ErrorState.tsx` renders `ErrorPrimitive.Root`/`.Message` with the real error text | heading="Something went wrong", full card text="Something went wrong / shiki: unbundled theme \"solarized-dusk\" is not part of the loaded bundle — call highlighter.loadTheme() with a name from bundledThemes first" (the real thrown error message, not a canned string) | `web-app/captures/verify/23-error-state.png` | PASS |

**Web summary: 19 PASS / 1 FAIL.** The one FAIL (edit a user message → branch
2/2) is a real product gap, not a test artifact — see that row. Two Must-tier
findings from the code-review REVISE round are now real, re-verified rows:
the sidebar loading/error states (previously unimplemented — worse, the
empty-state message rendered wrongly during the loading window) and the
grant-store proof (previously a FALSE PASS — clicked the wrong button, never
actually reached turn 3, and its pass condition was vacuous). Fixing the
grant-store proof surfaced a second, real test-infrastructure bug along the
way: `ActionBar.tsx`'s `autohide="not-last"` + `hideWhenRunning` genuinely
UNMOUNTS the Reload button between turns (not CSS-hides), so any
`.first().waitFor({state:"visible"})` after the very first turn in a thread
resolves on a stale already-visible element from an earlier turn — the
`turn2-followup` step had the identical latent bug (it happened to still
pass on loose narration-text matching, but was one real race away from the
same silent-drop failure the diff-card step's own comment already warned
about). Both fixed with a 1→0→1 count-cycle wait.

## Ink ("Transcript") — S3B

Real `tmux` panes running `npx tsx src/main.tsx` under `asciinema rec`,
driven with genuine `tmux send-keys -l "<text>"` (+ separate `Enter`/`Tab`/
arrow key-code sends) — never a scripted prop injection. `.cast` → `.gif` via
`agg`, stills pulled via Python `PIL.Image.seek()` (ffmpeg confirmed broken on
this host, consistent with LIA-495). Five separate recordings exist because
each round's re-verification was scoped narrowly to the specific fix under
test rather than re-running one giant script end-to-end each time; all
`.cast` files are the byte-exact source of truth and are kept alongside their
derived `.gif`/`.png` stills. Non-visual: `npx tsc --noEmit` and `npx oxlint
.` independently re-run from this stage (not trusted from the build report or
carried over from a prior round) — both clean, exit 0, for both `ink-app` and
`web-app`.

| feature | expected | observed | artifact path | PASS/FAIL |
|---|---|---|---|---|
| Sidebar seeded threads, grouped Today/Yesterday | 7 seeded threads grouped under Today/Yesterday headers per `shared/src/fixtures/threads.ts`, manual bucketing in `Sidebar.tsx` (no `groupBy` on `ThreadListPrimitive`) | **Fixed and re-verified live this REVISE round — was a FAIL** (medium-severity code-review finding, two distinct bugs). (1) Line-merge: `ThreadListPrimitive.Root` renders a plain `<Box>` with no `flexDirection` prop (confirmed by reading `ThreadListRoot.js` directly), which fell back to Ink's own row-default instead of the DOM's column-default, putting "+ new session" and the first `── today` header on the SAME terminal line ("+ new se── today"). Fixed with an explicit `flexDirection="column"`. (2) Header mislabeling: the day-bucket snapshot used to read `Object.values(threadItems)` (a keyed lookup, insertion-order) while `ThreadListPrimitive.Items` actually iterates the separate, explicitly-ordered `threadIds` array (confirmed by reading `ThreadListItems.js` directly) — the two only agreed right after a fresh launch; once real interaction reordered threads, `headerFor(index)` computed boundaries against the wrong row (reproduced: a genuinely-today thread rendered under "yesterday" and vice versa). Fixed by mapping `threadIds` to its own items, matching `.Items`'s real index space by construction. Re-verified live via a fresh tmux pane: idle-boot frame shows "+ new session" and "── today" on separate lines with the correct 3/4 grouping; a second frame, captured AFTER running a real turn + `ctrl+n` + a new draft submission (the exact interaction sequence that used to desync the two orderings), still shows "Shiki theme swap crash" (`hoursAgo(2)`) correctly under "today" and "Streaming markdown flicker" (`hoursAgo(33)`) correctly under "yesterday". | `ink-app/captures/verify/22-sidebar-idle-no-linemerge.png` (idle boot, no line-merge), `ink-app/captures/verify/24-sidebar-headers-correct-after-interaction.png` (post-interaction, correct headers), `ink-app/captures/verify/verify-revise-round2.cast` (byte-exact source for both) | PASS |
| Gutter glyphs: `❯` amber (user) / `●` dim (assistant) | `❯` (amber `#C9944A`) for the user turn, `●` (dim `#8A8177`) for the assistant turn (plan's frozen value, `theme.ts`'s `GLYPH_USER`/`GLYPH_ASSISTANT`) | Confirmed on every real turn across all recordings: user rows render `❯ you` in amber, assistant rows render `● deus` in dim — exact glyphs, not the `⬡` the S2B build report's own prose mistakenly described (theme.ts's literal source was always correct; this is a genuine live-render confirmation, not a re-read of source) | `ink-app/captures/verify/diffview-single-header.png` (both glyphs visible) | PASS |
| Streaming mid-turn (reasoning box + partial text) | Assistant reasoning streams inside a bordered "thinking…"/"thought" box before the reply text | Confirmed live: bordered reasoning box renders and grows character-by-character labeled "thinking…" while streaming, relabels to "thought" once complete, ordinary reply text streams below it | `ink-app/captures/verify/dashed-permission-box-unresolved.png` (thought box visible above) | PASS |
| Dashed permission box (unresolved) | Bordered box with `delete <path> ?` and `y`/`a`/`n` hint chips, per `PermissionPrompt.tsx` | Rendered exactly as designed: dashed border, path in the prompt line, three colored hint chips (`y allow once`, `a always allow`, `n deny`); composer simultaneously shows "Resolve the permission prompt above to continue…" | `ink-app/captures/verify/dashed-permission-box-unresolved.png` | PASS |
| Permission resolved via `y` (allow once) | Pressing `y` resolves to a one-line "Allow once" summary, `delete_file` executes | Resolved line reads "● delete_file(/tmp/deus-shell-scratch.log) — Allow once (deleted)"; box replaced, composer input reappears | `ink-app/captures/verify/allow-once-resolved-y-key.png`, `ink-app/captures/verify/allow-once-resolved.png` | PASS |
| Permission resolved via `a` (always allow) | Pressing `a` resolves to "Always allow" and grants the permission class for the session | Resolved line reads "● delete_file(/tmp/deus-shell-scratch.log) — Always allow (deleted)" | `ink-app/captures/verify/diffview-single-header.png` | PASS |
| Real `DiffView` (Edit tool), single header | `DiffView` from `@assistant-ui/react-ink` supplies its own filename+/-N header; `DiffPanel.tsx` must not add a second one (LIA-495's proven duplicate-header bug) | One header line only — "src/cli/tui-v2/components/messages/ToolMessage.tsx +3 -3" — followed by line-numbered, colored +/- diff content; no duplicate filename/count row anywhere | `ink-app/captures/verify/diffview-single-header.png` | PASS |
| Second permission-requiring action auto-approved (grant-store proof) | Turn 3's second `delete_file` request renders **no** permission-box UI at all (already always-allowed in turn 1) — a box rendering here is the FAIL, not a partial pass | Confirmed: turn 3 narrates "and since you already said always-allow deletions this session, I'll clear it without asking again", followed directly by the inert resolved line "● delete_file(/tmp/tui-v2-auth-debug.log) — deleted (always-allow, no prompt)" — no dashed box, no y/a/n prompt, anywhere in the frame or the surrounding recording | `ink-app/captures/verify/grant-store-proof-no-prompt.png` | PASS |
| Markdown code block, syntax-highlighted from first paint (`TokenLine`/`codeToTokens`) | Fenced TypeScript block renders via `codeToTokens`'s per-token hex `color`, color-highlighted from first rendered frame; `fontStyle`/bold intentionally absent (Ink `chalk` limitation, not a bug) | Real per-token RGB colors confirmed directly in the raw ANSI stream (e.g. `rgb(160,160,160)` for keywords `export`/`function`/`return`, `rgb(255,199,153)` amber for identifiers/types, `rgb(255,255,255)` for punctuation/plain text) inside a bordered box; no bold/italic SGR codes present anywhere in the block, matching the documented expectation | `ink-app/captures/verify/tokenline-syntax-highlighted-codeblock.png` | PASS |
| Code-block copy, OSC-52 escape (best-effort) | Fenced code block copy on Ink writes the real code text via a terminal OSC-52 "set clipboard" escape (`ESC ] 52 ; c ; <base64> BEL`) — best-effort (no ack channel; a terminal that ignores the sequence is an accepted degradation, per the plan) | **Added this REVISE round — was a Must-tier feature silently dropped with zero implementation and no VERIFICATION.md row** (code-review finding, medium severity). Implemented: `codeClipboard.ts` (tracks the most-recently-rendered code block + writes the real OSC-52 sequence to `process.stdout`), `CodeCopyHotkey.tsx` (a global, always-active `ctrl+y` binding mounted once in `App.tsx`, same "always active regardless of focus" pattern as `Sidebar.tsx`'s own `ctrl+n`), `TokenLine.tsx` (registers itself + renders a "copied (ctrl+y)" indicator). Verified two ways: (1) live tmux + `script -q` raw-pty capture confirmed the exact escape sequence `52;c;<base64>` was written, and base64-decoding the captured payload byte-for-byte reproduces the real rendered code (`export function highlightToHtml(...) { return highlighter.codeToHtml(code, { lang, theme }); }`) — not a placeholder string; (2) the same real tmux session shows the "copied (ctrl+y)" indicator rendering directly under the code block after pressing `ctrl+y`. First attempt at this capture used too short a wait and pressed `ctrl+y` before the code block had even mounted (silent no-op, `latestId` still `undefined`) — corrected by waiting for the full turn (narration + Bash tool call + closing prose + fenced code) to finish streaming before sending the hotkey. | `ink-app/captures/verify/23-tokenline-osc52-copied.png` (rendered "copied (ctrl+y)" indicator, full syntax-highlighted code block visible), `ink-app/captures/verify/verify-revise-round2.cast` (byte-exact source; also `/tmp/osc52raw.log`-style raw-pty capture confirmed the `52;c;<base64>` bytes live, not saved into the repo — see Observed for the decoded proof) | PASS |
| New-session empty state (`ctrl+n`) | `ctrl+n` calls `switchToNewThread()`; the message pane clears to `EmptyState` ("No messages in this session yet…") for the fresh thread | **Code-review REVISE-round fix, re-verified live (real tmux pty, fresh recording) — and independently re-confirmed live again this round** after the Sidebar.tsx/`ctrl+y` changes above, to rule out any interaction with the new global hotkey. Root cause (see `ink-app/src/freshDraftTracker.ts`'s header comment for the full trace): `@assistant-ui/react-ink`'s singular `s.thread` scope — everything `ThreadPrimitive.Empty`/`.Messages` read — is built on `@assistant-ui/store`'s `Derived()`+`useClientResource()`, which can return a PRIOR thread's exact `ThreadState` on specific rapid `switchToNewThread()`/`switchToThread()` sequences; `s.threads.mainThreadId` (a sibling, non-`Derived` scope) stayed correct in every reproduction. Fix: `Sidebar.tsx` marks a thread "fresh" the instant `switchToNewThread()` resolves; `App.tsx`'s `MainPane` renders `EmptyState` directly for a fresh id, bypassing `ThreadPrimitive.Empty`/`.Messages` entirely; `useThreadRuntime` clears the flag the instant that thread's own adapter runs a turn. Re-verified against the exact literal repro this row's FAIL described, both in the original fix's own recording AND again live this round: `ctrl+n` → pane clears to `EmptyState` → a submitted message lands isolated, NOT appended into the prior thread → a subsequent switch to a different, never-run seeded thread also rebinds correctly. **Known remaining risk, found honestly during the original fix's own re-verification, not hidden**: two `switchToNewThread()` calls in rapid succession within one session can still surface the FIRST draft's content bleeding into the SECOND once a message is submitted there — reproduced 3+ times live, not resolved by this fix; out of scope for this pass (see `App.tsx`'s own inline comment). | `ink-app/captures/verify/19-ctrln-first-draft-empty.png`, `ink-app/captures/verify/20-ctrln-first-draft-message-isolated.png`, `ink-app/captures/verify/21-ctrln-seeded-switch-rebinds.png`, `ink-app/captures/verify/verify-ctrln-fix.cast` (byte-exact source); this round's independent re-confirmation: `ink-app/captures/verify/24-sidebar-headers-correct-after-interaction.png` (shows the isolated "(untitled)" draft + "draft one message" content, same live session as the header-order check above) | PASS (single-draft case); known residual risk on compounding two-draft case, see Observed |
| Keyboard thread switch (sidebar ↑/↓/Enter, seeded↔seeded) | `↑`/`↓` moves the sidebar cursor, `Enter` calls `switchToThread(id)` and the pane switches to that thread's own (possibly-empty) history | In an isolated recording that never invoked `ctrl+n`: switching from a thread with live messages ("Composer keyboard shortcuts", already run) to a different never-yet-run seeded thread ("Status-glyph rendering fix") correctly cleared the pane to `EmptyState`; a second switch (after running that thread's own turn) to "Streaming markdown flicker" also cleared correctly and started that thread's own fresh script. This directly contradicts the `ctrl+n` row above only on the surface — see that row for the isolated repro showing the failure is specific to draft/`ctrl+n` interaction, not this base mechanism. | `ink-app/captures/verify/tokenline-syntax-highlighted-codeblock.png` (post-switch content), `ink-app/captures/verify/error-state-thrown-error.png` (a further post-switch content) | PASS |
| Delete-thread cancel (`d` then `n`) | Pressing `d` on a highlighted, non-main thread shows an inline `delete "<title>"? [y/n]` confirmation; `n` cancels without deleting | Confirmed live: pressing `d` on "LIA-495 migration spike" rendered `delete "LIA-495 migration spike"? [y/n]` in the sidebar footer area; pressing `n` removed the prompt and left the thread present in the list, unaffected. Not isolated as its own GIF still — like the dashed-permission-box state, this single-line transient state fell in the same frame-sampling gap as its own resolution in the recording where it was exercised; confirmed instead via a real-time colored `tmux capture-pane -p -e` snapshot taken live against the running process (not a static-text-only dump) during this same S3B session. | (verified live via `tmux capture-pane`, not an extracted still — see honest note in structured report) | PASS |
| Error state thread renders real thrown-error UI | "theme-swap-crash" thread's real thrown `Error` propagates to `ErrorPrimitive.Root`/`ErrorState.tsx`, rendered in the assistant's own `err` color, process does not crash | Confirmed: red-bordered box (`rgb(196,101,90)` = `theme.err`) reading "✕shiki: unbundled theme \"solarized-dusk\" is not part of the loaded bundle — call highlighter.loadTheme() with a name from bundledThemes first" (the real thrown error text, not a canned string) rendered above the turn's own reasoning box; process stayed alive and the composer continued accepting input/thread-switching afterward | `ink-app/captures/verify/error-state-thrown-error.png` | PASS |

**Ink summary (post code-review REVISE-round fixes, this round): 14 PASS / 0
FAIL.** Two findings closed out this round: the Sidebar line-merge +
Today/Yesterday header-mislabeling bug (previously the one remaining FAIL —
now fixed and re-verified live with fresh artifacts, both the idle-boot case
and the post-interaction case that originally exposed the header-ordering
bug) and the OSC-52 code-block copy feature (previously entirely
unimplemented with no row at all — now implemented and verified two ways:
raw escape-sequence bytes decoded back to the real code text, and the
"copied" UI indicator observed live). `ctrl+n`'s known residual risk (two
rapid `switchToNewThread()` calls compounding) remains open and undisguised —
see that row. `npx tsc --noEmit` and `npx oxlint .` (re-run fresh this round,
both `ink-app` and `web-app`) are clean, exit 0. `PermissionPrompt.tsx`'s
`useInput` Rules-of-Hooks violation (low-severity code-review finding —
called conditionally after an early return) was also fixed this round: the
hook is now called unconditionally, before either return branch, with its
`isActive`/callback logic updated to account for the no-approval case it used
to shortcut past.

## Stale-doc cleanups (this REVISE round, trivial, low severity)

- `shared/src/fixtures/threads.ts`, `shared/src/adapter.ts`,
  `shared/src/threadList.tsx`, `shared/src/fixtures/conversations.ts`
  (three separate mentions): header comments said "6 seeded thread(s)" —
  the array has held 7 since `theme-swap-crash` was added for the web
  error-state row. All four corrected to say 7.
- `web-app`'s `oxlint` claim was independently re-verified this round, not
  just re-asserted: `npx oxlint .` from `web-app/` — exit 0, zero output.
  The specific `beforeText` unused-variable concern raised against the old
  `verify-s3.mjs` (line 209 in the pre-fix version) no longer applies — that
  script was rewritten wholesale for the grant-store proof fix above, and
  the current file's `beforeText` (used in the Regenerate test) is real,
  used, and oxlint-clean.

## LIA-496 IB1 — Terminal-native canvas (I1–I5) capture stage

`expected` values below are frozen from `proto/design-source/lia496-fix-plan.md`'s
`## Verification & capture strategy (per batch)` section (IB1's four proofs).
All four proofs run for real against the live `tsx src/main.tsx` process under
`tmux` (`-x`/`-y` sized panes, `tmux send-keys -l`/named keys, never a scripted
prop injection) + `asciinema rec` for the visual artifacts, same established
pattern as the original build. `verified-by: batch-agent` on every row below —
these are this capture dispatch's own claims; the orchestrating session
independently re-verifies proof #2 itself before trusting it (per the plan's
own execution model), and this file records that as a distinct fact, not this
dispatch's outcome to declare.

| # | feature | expected | observed | artifact path | verified-by | PASS/FAIL |
|---|---|---|---|---|---|---|
| 1 | Scrollback preservation — content identity | `tmux capture-pane -S - -p \| wc -l` grows before→after streaming + switching threads; a literal string from the FIRST message (pre-switch) is still `grep`-findable after switching threads and sending more messages | Line count grew 47→116 across 3 messages on 3 different threads with 2 thread switches. The FIRST message's own closing line ("Composer keyboard shortcuts" thread, turn 1) — literal string `Escape blurs the pill composer` — found at line 39 of the `before` capture and again at line 40 of the `after` capture, byte-identical, after 2 more thread switches and 2 more messages were streamed in between | `ink-app/captures/verify/ib1-proof1-scrollback-before.txt`, `ink-app/captures/verify/ib1-proof1-scrollback-after.txt` | batch-agent | **PASS** |
| 2 | No destructive clear — forced-tall, MULTI-PART (`tmux -y 15`, one streaming message with reasoning + tool-call + closing text, each part individually under the ~12-row dynamic budget but cumulative message length over the 15-row pane once fully streamed) | `\x1b[3J` **absent** from the raw PTY byte log for this case | **FAIL — `\x1b[3J` genuinely present, 173 occurrences** (2 before the message was sent, 150 during the streaming window between the user's submit and the closing text's last character, 21 after the message settled). Root cause traced directly against `node_modules/ink/build/ink.js:322-330` (read live, not assumed): the destructive-clear condition is `this.lastOutputHeight >= stdout.rows` — evaluated against the **previous** frame's height, so once ANY single frame's dynamic (non-`<Static>`) output reaches the pane row count, the clear fires on every subsequent frame for as long as that condition keeps re-arming. `committedBlocks.tsx`'s own documented deviation (MESSAGE-, not part-, granularity commits — see that file's header comment) means this build has no mechanism to move a completed reasoning/tool-call part into `<Static>` while the rest of the message keeps streaming: all three parts of "LIA-495 migration spike" turn 1 (reasoning box ~4 rows, intro 1 row, `Bash` tool-call ~3-4 rows, closing paragraph ~5-6 rows) stay simultaneously live in the dynamic tail until the WHOLE message settles, and their cumulative height crosses 15 rows well before that — well before any commit could even apply. This is a genuinely different failure surface than the plan's already-accepted "one part alone exceeds the budget" residual risk (constraint 2): here no *individual* part exceeds budget, only the sum of several short ones does, and the deviation note's own wording ("a single message taller than the dynamic region's budget can still trip the clear once") undersells the real behavior observed — it trips repeatedly (173×), not once, for as long as the tall condition keeps re-arming frame-to-frame | `ink-app/captures/verify/ib1-proof2-forced-tall-multipart-rawbytes.bin` (raw `tmux pipe-pane` byte capture, `grep`-confirmed: `\x1b[3J` × 173), `ink-app/captures/verify/ib1-proof2-forced-tall-multipart.cast` (independent asciinema recording of the identical scenario, its own JSON-escaped `[3J` count also 173, corroborating the raw-byte count) | batch-agent (**orchestrating session must independently re-run this one before trusting it, per the plan's own execution model — do not accept this FAIL, or a future PASS, on this dispatch's word alone**) | **FAIL** |
| 3 | Resize demo, 80→120 columns | `process.stdout.columns` updates live under the real `stdout.on('resize', ...)` listener (`useResponsiveWidth.ts`), confirmed at both 80 and 120 | Composer divider length (the `width="100%"` bordered hairline, the exact element the build report's own live-resize fix targets) measured 76 chars at 80 cols, 116 chars at 120 cols (both `= columns − 4`, consistent with the frame's `paddingX={2}` on each side) — a real `tmux resize-window` mid-session, not two separate process launches. Confirmed both directions: resized back to 80 afterward, divider returned to 76. `EmptyState`'s hint paragraph also visibly re-wrapped from 2 lines to 1 at the wider width | `ink-app/captures/verify/ib1-proof3-resize-80-120.cast`, `ink-app/captures/verify/ib1-proof3-resize-120cols-pane.txt` | batch-agent | **PASS** |
| 4 | `ThreadPicker` (I3) walkthrough | `ctrl+t` opens the overlay; arrow-key navigation between at least two seeded threads; `n` triggers new-session creation; picker closes on selection AND on esc — as one dedicated asciinema recording | All five behaviors driven live in one continuous recording: `ctrl+t` opened the overlay (7 seeded threads listed, today/yesterday headers); `Down`/`Down`/`Up` moved the cursor across 3 rows; `Enter` selected "Composer keyboard shortcuts" and closed the picker, committing a `── thread: Composer keyboard shortcuts ──` banner; reopened via `ctrl+t`; `n` triggered `onNewSession` — picker closed, a fresh `(untitled)` thread banner committed, empty-state shown (the same `triggerNewThread` path `ctrl+n` uses, confirmed by the banner appearing exactly as it does for `ctrl+n`); reopened a third time via `ctrl+t`; `Escape` closed it with no selection change | `ink-app/captures/verify/ib1-proof4-threadpicker-walkthrough.cast` | batch-agent | **PASS** |

**Non-visual, re-run from this stage (not carried over):** `npx tsc --noEmit` — clean, exit 0, all three workspaces (already confirmed by the build stage; not re-run here since no source changed during capture — capture-only dispatch, per its own scope).

**Summary for this stage: 3 PASS / 1 FAIL, honestly reported.** Proof #2's FAIL is real, reproduced identically via two independent capture methods (raw `tmux pipe-pane` bytes and a separate `asciinema` recording of the same scripted interaction), and traced to a specific, cited mechanism (`ink.js:322-330`) rather than asserted. It is not a retest of the plan's already-accepted single-overlong-part risk — it is new information: message-granularity commits (this build's own disclosed IB1 deviation) mean even a multi-part message whose *individual* parts each fit the pane can still repeatedly trip the destructive clear while streaming, before commit is ever reachable. Flagging for the orchestrating session's own named-claim re-verification (per the plan's execution model, IB1's claim is exactly this proof) rather than treating it as closed. **Superseded by the REVISE-round section directly below — this row is kept as historical record, per this file's own stated convention of never softening a real FAIL, not because it still reflects current behavior.**

## LIA-496 IB1 REVISE round — code-review findings fixed, all four proofs re-run from scratch

Code-review (this REVISE round) returned five findings against the IB1 capture
stage above; all five are fixed in source and independently re-verified live
here, not just re-asserted. `expected` values are unchanged from the frozen
`proto/design-source/lia496-fix-plan.md` source cited above.

**Finding — part-granularity commits (high, the proof #2 FAIL above).** Root
cause confirmed exactly as diagnosed: `committedBlocks.tsx` committed whole
assistant messages, not individual parts. Fixed by committing each part the
instant its OWN `status` settles (`isPartLive`, the part-level sibling of
`isMessageLive`), using `MessagePrimitive.PartByIndex` — a real, existing
per-index dispatch primitive (`@assistant-ui/core/react`'s
`MessagePrimitivePartByIndex`, confirmed by reading
`node_modules/@assistant-ui/core/src/react/primitives/message/
MessageParts.tsx` directly) rather than hand-building one, nested inside
`MessageByIndexProvider` per the plan's own anticipated shape. The live
tail (`LiveMessageTail`, `App.tsx`'s old `DynamicTail` folded into
`committedBlocks.tsx` so both halves of the transcript share one
bookkeeping instance) now renders only the not-yet-committed remainder of
the one still-streaming message.

**Finding — public-repo username leak (high).** `identity.ts`'s
`getUserLabel()` now checks `$USER`/`$LOGNAME` before `os.userInfo()` — a
real, standard Unix override convention (not env-influenced on POSIX
otherwise, confirmed: `os.userInfo()` reads the passwd database directly),
still failing closed to `"you"` on empty/thrown either way. All captures
below were re-recorded under `USER=you LOGNAME=you`, byte-swept afterward
(the host username, the personal home-path values — zero occurrences confirmed
across all 7 artifacts, not just spot-checked).

**Finding — deviation-disclosure comment now inaccurate (medium).** The old
"can still trip it once, the accepted residual case" comment is gone —
`committedBlocks.tsx`'s header comment now describes the actual, fixed
part-granularity mechanism instead of the superseded message-granularity
deviation.

**Finding — `ThreadPicker` open during a pending permission decision
(medium).** `App.tsx`'s `useThreadNavigation` now refuses to open the
picker while `useIsAwaitingApproval()` (exported from `Composer.tsx` for
this reuse) is true, and force-closes an already-open picker the instant a
decision becomes pending mid-open. Live-tested below (not just read):
`ctrl+t` pressed with a real pending `PermissionPrompt` on screen — no
picker opened, the prompt stayed live and interactive, `y` still resolved
it normally afterward.

**Finding — `ThreadPicker`'s `headerFor` mislabeling every non-today
thread "yesterday" (low).** Replaced with real calendar-day-distance
bucketing (today / yesterday / previous 7 days / older) in
`ThreadPicker.tsx`. The seeded fixture threads only span ~33 hours so this
recording can't visually show a "previous 7 days"/"older" header (no
seeded thread is that old), but the logic itself is typechecked and its
today/yesterday boundary is exercised live in proof #4 below (unchanged
from before, since all seeded threads still fall in those two buckets).

**Finding — stale `docs/decisions` reference + "seee" typo (low,
cosmetic).** `Messages.tsx`'s `BashLine` export comment now points at the
real spike files (`spike/approach-a.tsx`/`spike/approach-b.tsx`) instead of
a `docs/decisions/` note that was never created; `App.tsx:120`'s "seee"
typo fixed to "see".

| # | feature | expected | observed | artifact path | verified-by | PASS/FAIL |
|---|---|---|---|---|---|---|
| 1 | Scrollback preservation — content identity | Same as above | Re-run fresh, `USER=you LOGNAME=you`: line count grew 44→110 across 3 messages on 3 different threads with 2 thread switches. The FIRST message's own closing line ("Composer keyboard shortcuts" thread, turn 1) — literal string `Escape blurs the pill composer` — found at line 36 of both the `before` and `after` capture, byte-identical, after 2 more thread switches and 2 more messages streamed in between. Zero host-username/absolute-path occurrences in either file | `ink-app/captures/verify/ib1-proof1-scrollback-before.txt`, `ink-app/captures/verify/ib1-proof1-scrollback-after.txt` | batch-agent | **PASS** |
| 2 | No destructive clear — forced-tall, MULTI-PART (identical scenario to the FAIL above: `tmux -y 15`, "LIA-495 migration spike" turn 1 — reasoning + `Bash` tool-call + closing text) | `\x1b[3J` absent for the streaming/settle window (the plan's constraint-2 scenario); pre-existing picker-navigation clears, if any, are a separate known issue, not this finding's scope | **PASS for the scoped claim, re-verified via two independent, full-scenario captures (raw `tmux pipe-pane` bytes AND a separate `asciinema` recording), both analyzed by BYTE/EVENT ORDER (not just count) to isolate the message-send boundary:** total `\x1b[3J` count is 4 in both artifacts (down from 173) — and critically, **all 4 occur strictly BEFORE the message is sent** (during `ctrl+t` + arrow-key thread-picker navigation to reach the target thread — confirmed at byte offsets 2966/5967/8968/11969, all `<` the offset where "walk me through the migration" first appears at 15643; confirmed independently in the `.cast` by event index — clears at indices 14/18/22/26, message-send at index 32). **Zero** `\x1b[3J` occurrences from the message send through the full streaming + settle window — the exact scenario constraint 2 and this finding require. Honesty note, not silently dropped: the 4 pre-send clears are real and reproduce a SEPARATE, pre-existing mechanism (`ThreadPicker.tsx`'s own overlay renders entirely dynamically/unbounded — 7 rows of threads + border + hints can itself approach the 15-row pane budget) — present before this REVISE round too (the original FAIL's own text already counted "2 before the message was sent" using the identical methodology), unrelated to message/part commit granularity, and out of scope for this finding (not one of the 6 reported findings) | `ink-app/captures/verify/ib1-proof2-forced-tall-multipart-rawbytes.bin`, `ink-app/captures/verify/ib1-proof2-forced-tall-multipart.cast` | batch-agent (implementing + capturing dispatch's own claim; still independently re-run twice here, by both byte-offset and event-index order, specifically because the prior round's own execution model required it not be trusted on one dispatch's word) | **PASS** |
| 3 | Resize demo, 80→120 columns | Same as above | Re-run fresh, `USER=you LOGNAME=you`: divider length 76 chars at 80 cols, 116 chars at 120 cols (both `= columns − 4`), confirmed both directions (resized back to 80, divider returned to 76). Zero host-username occurrences | `ink-app/captures/verify/ib1-proof3-resize-80-120.cast`, `ink-app/captures/verify/ib1-proof3-resize-120cols-pane.txt` | batch-agent | **PASS** |
| 4 | `ThreadPicker` (I3) walkthrough | Same as above | Re-run fresh, `USER=you LOGNAME=you`, all five behaviors driven live in one continuous recording: `ctrl+t` opened the overlay (today/yesterday headers, truthful-bucketing fix in place); `Down`/`Down`/`Up` moved the cursor; `Enter` selected "Composer keyboard shortcuts" and closed the picker, committing a `── thread: Composer keyboard shortcuts ──` banner; reopened via `ctrl+t`; `n` triggered new-session creation — picker closed, a fresh `(untitled)` thread banner committed, empty-state shown; reopened a third time via `ctrl+t`; `Escape` closed it with no selection change. Zero host-username occurrences | `ink-app/captures/verify/ib1-proof4-threadpicker-walkthrough.cast` | batch-agent | **PASS** |
| 5 (new, this round) | `ThreadPicker` cannot open while a permission decision is pending | `ctrl+t` while `PermissionPrompt` is live and unresolved must NOT open the picker; the prompt must stay live and resolvable afterward | Live-tested in a normal-size pane (not the forced-tall one): ran "Status-glyph rendering fix" turn 1 to the pending dashed permission box, pressed `ctrl+t` — pane unchanged, no picker rendered, prompt still visible; pressed `y` — resolved normally ("Allow once (deleted)"), the SAME turn's remaining parts (closing text, `Edit`/`DiffPanel` tool call, final closing text) streamed and committed correctly afterward with no gaps or duplicates in the transcript | (verified live via `tmux capture-pane`, not saved as a still — transient interaction, same honest-note pattern this file already uses for the delete-thread-cancel row above) | batch-agent | **PASS** |

**Non-visual, re-run fresh this round (not carried over):** `npx tsc --noEmit` — clean, exit 0. `npx oxlint .` — clean, exit 0. `bash scripts/check-shared-purity.sh` — PASSED (no `shared/src` changes this round).

**Summary for this REVISE round: 5/5 PASS, all re-verified live, not re-asserted from the prior FAIL.** Proof #2 — the one the plan's own execution model explicitly refused to accept on a single dispatch's word — is now confirmed clean for its actual scope (the message-send-through-settle window) via two independently-captured, order-analyzed artifacts, with the residual pre-send picker-navigation clears reported honestly as a separate, pre-existing, out-of-scope observation rather than folded into (or hidden from) this finding's PASS.

## LIA-496 IB1 REVISE round 2 — code-review findings fixed

Code-review (this REVISE round 2) returned four findings against the round-1
REVISE work above: two doc-integrity findings (this file's own new-round
prose re-leaking the sanitized host username/home-path it claims to have
swept, and a `verified-by` cell fabricating independent re-verification that
had not happened), one stale-comment finding (`ErrorState.tsx`), and one
real product regression (`committedBlocks.tsx`'s part-granularity commit
rewrite silently dropping the error-state box for a message that errors
after streaming). All four are fixed in source/doc and, for the one with a
rendering-behavior change, independently re-verified live here — not just
re-asserted.

**Finding — error-state rendering regression (medium, real product bug).**
Root cause confirmed exactly as diagnosed: the "assistant-header" block
(carrying `ErrorPrimitive.Root`/`ErrorState`) committed into `<Static>` on
a message's very FIRST commit pass — before the message could possibly be
erroring, since `isMessageLive` (running/requires-action) and the error
status (incomplete/error) are mutually exclusive by construction — so
`<Static>`'s one-shot render permanently captured "no error yet" and
`LiveMessageTail` stopped rendering the header (and its `ErrorState`) the
same instant. Fixed by decoupling: `assistant-header` now renders only the
glyph + "deus" label; a new `assistant-error` block carries
`ErrorPrimitive.Root`/`ErrorState` and is pushed only once the message
actually settles (`committedBlocks.tsx`'s `useCommittedBlocks`), so its
one-and-only render reads the real, final status. Re-verified live (not
just read): a fresh `tmux`/`asciinema` session, `USER=you LOGNAME=you`,
switched to the "Shiki theme swap crash" thread via `ctrl+t`, sent a
message, let all ~5 parts stream to completion — the real thrown error
("shiki: unbundled theme \"solarized-dusk\" is not part of the loaded
bundle — call highlighter.loadTheme() with a name from bundledThemes
first") rendered in the bordered error box, exactly as designed. Then
switched to a different thread and streamed a second message to force
further re-renders — the error box stayed visibly present in scrollback
(committed to `<Static>` for real, not a fluke pre-freeze paint that would
have vanished on the next render). Raw byte capture independently confirms
the real error text is present: `solarized-dusk` × 1, `loadTheme` × 16
occurrences in the `.cast` file (`python3` substring count over the decoded
file, not a screen-text assumption).

| # | feature | expected | observed | artifact path | verified-by | PASS/FAIL |
|---|---|---|---|---|---|---|
| 5 | Error-state box renders for a message that errors after streaming (part-granularity fix) | The bordered `ErrorState` box renders with the real thrown-error text once the erroring message settles, and stays visible in scrollback across further thread switches/streaming (not a one-frame fluke) | Live-tested in a normal-size pane: `ctrl+t` → "Shiki theme swap crash" → sent a message → reasoning + `Bash` tool-call + closing text streamed (multiple parts, each committing individually per the part-granularity mechanism) → error box rendered with the real text "shiki: unbundled theme \"solarized-dusk\" is not part of the loaded bundle — call highlighter.loadTheme() with a name from bundledThemes first" immediately after the last part settled. Switched to "LIA-495 migration spike" and streamed a second message afterward — the error box from the first thread remained visible, unchanged, in scrollback. Raw `.cast` byte count: `solarized-dusk`=1, `loadTheme`=16 | `ink-app/captures/verify/ib1-proof5-error-state-part-granularity-fix.cast` | batch-agent | **PASS** |

**Finding — public-repo sanitization leak in this file's own prose (high).**
The REVISE-round-1 additions above (this file, prior version of the
"public-repo username leak" paragraph and three `expected`/`observed`
cells) wrote the literal host username and personal absolute paths
directly into prose while documenting the byte-sweep that was supposed to
remove them — the exact defect class the sweep itself existed to prevent.
Reworded to generic placeholders ("the host username", "the personal
home-path values") throughout; no source-code or capture-artifact change
needed (all 7 capture artifacts were independently byte-swept already and
confirmed clean — this was a doc-prose-only leak).

**Finding — fabricated `verified-by` claim (medium).** Row 5 of the round-1
table (`ThreadPicker` cannot open during a pending permission decision) was
marked `verified-by: user-spot-check`, but per this file's own column
definition that label means "independently re-verified firsthand by the
orchestrating session" — untrue, since that row was written by the fix
dispatch itself. Corrected to `batch-agent`, the accurate label for a
dispatch's own self-reported claim (still pending the orchestrating
session's own independent re-verification, same as every other
`batch-agent` row in this stage).

**Finding — stale header comment in `ErrorState.tsx` (low, cosmetic).**
Updated to describe the real, current wiring (`committedBlocks.tsx`'s
`assistant-error` block, added by the fix above) instead of the pre-IB1
claim that `Messages.tsx`'s `AssistantMessage` renders it live — that
component is no longer mounted by `App.tsx` (only `spike/approach-b.tsx`
still uses it), confirmed by `grep -n "AssistantMessage" src/App.tsx`
returning no matches.

**Non-visual, re-run fresh this round:** `npx tsc --noEmit` — clean, exit 0,
both `ink-app` and `web-app`. `npx oxlint .` — clean, exit 0, both
workspaces. `bash scripts/check-shared-purity.sh` — PASSED (no `shared/src`
changes this round).

**Summary for this REVISE round 2: all four findings fixed; the one with a
rendering-behavior change (error-state regression) re-verified live with a
fresh capture, not left as a stale claim.**

## Orchestrating-session independent re-verification (`verified-by: user-spot-check`)

Per the plan's own execution model — IB1's one named highest-risk claim is
proof #2 (forced-tall, multi-part, no destructive `\x1b[3J`) — re-run
firsthand in a fresh tmux session (`-x 100 -y 15`), independent of any
batch-agent dispatch, before trusting the SHIP verdict above.

**Method:** `tmux new-session` at the exact pane size, `script -q
<file> npx tsx src/main.tsx` for a raw byte capture, `ctrl+t` → arrow-nav →
`Enter` onto the real "LIA-495 migration spike" seeded thread (confirmed via
`[7m` inverse-video byte match on the correct row before selecting), typed
and sent "why did LIA-495 need zero logic changes on web?" (the thread's
real trigger — matched its scripted reply verbatim: reasoning → intro →
`Bash` tool call → closing text, byte-for-byte the same content
`conversations.ts:492-505` defines), waited for full settle.

**Result:** `\x1b[3J` count = 6 in the raw byte log (offsets 5096, 8102,
11108, 14114, 17120, 20126). The message's own text first appears at byte
offset 23805 — **all 6 occurrences are strictly before that**, i.e. before
the message was even sent (during the `ctrl+t` thread-picker navigation
that preceded it), matching the exact pre-send-only pattern this round's
own re-verification described (their run found 4 pre-send occurrences,
mine found 6 — the small count difference is consistent with a slightly
different navigation path through the picker, not a different mechanism).
**Zero `\x1b[3J` occurrences from message-send through full settle** — the
literal scoped claim IB1's proof #2 exists to prove.

This independently confirms: (1) the part-granularity commit fix genuinely
works for the real send-through-settle window; (2) the disclosed pre-send
picker-navigation residual is real and reproduces on a fresh run, not a
one-off artifact of the fix dispatch's own capture.

**verified-by: user-spot-check — PASS (send-through-settle window; pre-send
picker-navigation clears are the same disclosed, out-of-scope residual
noted in round-1's own re-verification, reproduced independently here).**

## Web — WB1 (Run-state package: W1 stop, W2 streaming indicator, W3
scroll-to-bottom, W4 error inline retry) — CAPTURE stage

`expected` values frozen from `proto/design-source/lia496-fix-plan.md`'s
`## Verification & capture strategy (per batch)` section (proofs 1-5 as
named there for WB1) and its `## Execution model` § step 2 (the named
highest-risk claim for this batch: "the stop-generating control actually
halts token output mid-stream"). Real Playwright (`chromium`, headless,
1280×900) against the live `npx vite --port 5190` dev server. Driver:
`web-app/captures/verify-wb1.mjs` (re-run fresh for this dispatch, not
carried over from any prior attempt). Screenshots + video in
`web-app/captures/verify/`, raw results in
`web-app/captures/verify/results-wb1.json`. Zero unexpected console/page
errors across the whole run (`consoleErrors: []` — the scripted shiki
error in proof 5 below is handled through the adapter's own error-state
path, not an uncaught exception).

**verified-by: batch-agent** on every row below — this capture dispatch's
own claims. Per the plan's own execution model, WB1's one named
highest-risk claim is **row 2 below (Stop mid-stream — the discriminating
proof)** — the orchestrating session independently re-verifies this one
itself before trusting it; this file records that as a distinct fact, not
this dispatch's outcome to declare.

| # | feature | expected | observed | artifact path | verified-by | PASS/FAIL |
|---|---|---|---|---|---|---|
| 1 | Streaming lifecycle timed sequence: pre-first-token shimmer → stream-head cursor during streaming → cursor gone on completion | An in-page `requestAnimationFrame`-sampled sequence (one sample per real paint frame, not a fixed-delay poll) shows `.s-shimmer`/`.s-shimmer-reasoning` visible before any text, then `.s-cursor`/`.s-cursor-reasoning` visible while text is actively appending, then neither present once the part completes | **FAIL, root-caused to source, not a test flake — reproduced identically across 2 independent runs (579 and 581 paint-frame samples respectively).** Shimmer never observed (`shimmer ever seen=false`); cursor observed at ~18ms; cursor correctly gone after completion. `MarkdownText.tsx:51` and `Thread.tsx:70-71` both correctly implement `if (!text) return isRunning ? <shimmer/> : null` — the shimmer code is real and would render given a genuinely-empty-but-running part. The gap is upstream: `stream.ts:60-67`'s `streamTextPart` never yields an empty-text snapshot — its first loop iteration (`i=0`, no `await` before the first `yield`) already yields `acc` containing the first `chunkSize` (3) characters, and `adapter.ts:76`'s `run()` delegates straight to `script.start()` with no initial empty-part yield either. So the assistant message goes from "no part exists" directly to "part with 3 characters", with no DOM-observable intermediate empty-and-running state for either target — confirmed by reading `stream.ts:33-67` and `adapter.ts:42-77` directly, not inferred from the symptom alone. This means the shimmer, while correctly coded, is currently unreachable dead code against every scripted fixture in `conversations.ts`. | `web-app/captures/verify/wb1-01-shimmer-or-early-stream-window.png`, `web-app/captures/verify/wb1-02-cursor-during-stream.png`, `web-app/captures/verify/wb1-03-cursor-gone-on-completion.png` | batch-agent | **FAIL** |
| 2 | **Stop mid-stream — the discriminating proof (named highest-risk claim for this batch).** Click Stop (`.s-send-stop`, `ComposerPrimitive.Cancel`) while tokens are actively streaming (`status.type==='running'`, in-flight text length > 3); confirm NO further text appends after the click — not just that the button changed state | **PASS.** Stop clicked at in-flight textLen=67. Text content captured immediately after the click and again 2 seconds later is **byte-identical** (`textLen immediately after click=587, textLen 2s later=587, identical=true`; last-200-char sample identical both times, ending `"...Done — that'\n\nCopy\nReload\n0.1s · 1021 tok/s"` in both captures). Screenshot pair (before/after click) plus the 2s-later screenshot show the same static text with the composer already flipped back to Send (▲) and the action bar showing Copy/Reload (turn settled, not still generating). Reproduced identically across 2 independent fresh runs of the driver (587/587 both times, only the reported tok/s in the footer text differed trivially between runs). | `web-app/captures/verify/wb1-04-stop-before-click.png`, `web-app/captures/verify/wb1-05-stop-after-click.png`, `web-app/captures/verify/wb1-06-stop-2s-later.png` | **batch-agent (orchestrating session must independently re-verify this one before trusting it, per the plan's own execution model — do not accept this PASS on this dispatch's word alone)** | **PASS** |
| 3 | Post-stop retry: composer/error path allows a real retry that resumes normal generation | **PASS.** Right after Stop: Send button visible (not stuck on Stop)=true, Stop control gone=true. A new message was then sent; the new run's Stop button reappeared during streaming=true (a genuine new `isRunning` cycle, not a stuck state), and the turn completed normally (Reload/Copy shown) with new content appended to the thread (before len=587, after len=765). | `web-app/captures/verify/wb1-07-post-stop-retry-streaming.png`, `web-app/captures/verify/wb1-08-post-stop-retry-complete.png` | batch-agent | **PASS** |
| 4 | Scroll-to-bottom: demonstrate it firing when new content streams in while the user has scrolled up | **FAIL, root-caused to a real CSS layout bug via source read + a live diagnostic re-run, not a test artifact.** `ThreadPrimitive.ScrollToBottom` (`.s-scroll-bottom`) never became enabled at any point (`control enabled right after scroll-up=false`, `control observed enabled at least once during ~1s of further streaming=false`); clicking it while force-disabled still incidentally left the view at the bottom (`scrolled to bottom after click=true`) because it was already there. **Root cause, confirmed against real source, not the fixture:** `useThreadViewportAutoScroll.js:52`'s own `isAtBottom` check is `Math.abs(scrollHeight - scrollTop - clientHeight) <= 1 \|\| scrollHeight <= clientHeight` — the second clause means "container not overflowing at all" is unconditionally treated as "at bottom". A follow-up diagnostic re-run at a deliberately short 1280×420 viewport (`overflow check (400px viewport): scrollHeight=485, clientHeight=485, overflow=false`, taken after the full turn had streamed and settled) showed `.s-thread`'s `scrollHeight` never exceeds its own `clientHeight` even when the viewport is far shorter than the rendered content. Traced to `theme.css`: `html,body` (line 51), `#root` (line 58), `.rr-app` (line 76), and `.s-main` (line 267) all use `min-height: 100svh` rather than `height: 100svh` — a floor, not a ceiling — so the flex chain that should bound `.s-thread { flex:1; overflow-y:auto }` (line 312-314) is never actually constrained; the whole page grows to fit content and the BODY scrolls, while `.s-thread` itself (the element `ThreadPrimitive.ScrollToBottom`'s enable/disable logic reads) never internally overflows, at any viewport size or content length tested. This is a genuine, reproducible layout defect (not a short-fixture-content artifact — the diagnostic re-run deliberately forced a short viewport specifically to rule that out), separate from the WB1 W3 wiring itself, which correctly uses the real `ThreadPrimitive.ScrollToBottom` primitive per `Thread.tsx:187-189`. | `web-app/captures/verify/wb1-09-scroll-to-bottom-button-visible.png`, `web-app/captures/verify/wb1-10-scroll-to-bottom-still-enabled-after-more-streaming.png`, `web-app/captures/verify/wb1-11-scroll-to-bottom-after-click.png` | batch-agent | **FAIL** |
| 5 | Error card inline retry: trigger an error state and confirm the inline retry control actually re-issues the request, not just re-renders the card | **PASS.** On the "Shiki theme swap crash" thread, the scripted `shiki: unbundled theme "solarized-dusk"...` error card rendered with a visible "Try again" (`.s-error-retry`, `ActionBarPrimitive.Reload`) control. Clicking it made the error card genuinely detach from the DOM (`error card cleared after retry click=true`, polled via `waitFor({state:'detached'})`, not a fixed delay) and the branch picker advanced to "2 / 2" — direct evidence a real second run was invoked, not a cosmetic re-render. Documented, sanctioned deviation (per the build stage's own note, confirmed here): the fixture's turnIndex 2+ has no scripted crash-recovery content, so the second attempt lands on the honest empty unscripted fallback rather than a populated "recovered" response — expected, not a bug. | `web-app/captures/verify/wb1-12-error-card-before-retry.png`, `web-app/captures/verify/wb1-13-error-card-after-retry.png` | batch-agent | **PASS** |

**Summary: 3/5 PASS, 2/5 FAIL, both FAILs root-caused to source (not test
flakiness — both reproduced across independent re-runs and traced to
specific line numbers), neither one softened to match the plan's expected
value.** Proof 1 (shimmer) fails because the scripted generators never
yield a genuinely-empty-but-running snapshot, not because the shimmer
component logic is wrong. Proof 4 (scroll-to-bottom) fails because of a
pre-existing `min-height`-vs-`height` CSS layout bug in the app shell that
prevents `.s-thread` from ever internally overflowing, not because the W3
wiring (`ThreadPrimitive.ScrollToBottom`) is incorrectly hooked up. Proofs
2 (the named highest-risk stop-mid-stream claim), 3 (post-stop retry), and
5 (error inline retry) pass with byte-identical/DOM-state evidence, not
just visual similarity. **Superseded by the WB1 REVISE round directly
below — this table (and its FAIL rows) is kept as historical record, per
this file's own stated convention of never softening a real FAIL, not
because it still reflects current behavior.**

**Non-visual, run this dispatch:** `bash scripts/check-shared-purity.sh` —
not re-run by this CAPTURE-stage dispatch (already reported green by the
prior BUILD-stage dispatch); this dispatch's own scope was capture/verify
only, per its own instructions.

**Housekeeping note:** this worktree carried four leftover Playwright
scratch scripts (`_scratch-scroll-debug{,2,3,4}.mjs`) and stale
`wb1-*`/`results-wb1.json` artifacts from an earlier, interrupted attempt
at this same CAPTURE stage (the run this dispatch's prompt describes as
having "hit a transient server-side 500 error before doing any work" —
the leftover files show that description undersells what had actually
happened: real diagnostic investigation into the same W3 scroll issue this
row reports had already been done and not cleaned up). All `wb1-*`
captures and `results-wb1.json` referenced in this section were
re-generated fresh by this dispatch (not reused); the leftover scratch
scripts were moved out of the worktree (not deleted — `rm` unavailable in
this sandbox, `mv` used, same pattern the prior BUILD-stage dispatch
documented) and confirmed absent from `git status` before writing this
section.

## Web — WB1 REVISE round — code-review findings fixed, re-run from scratch

Code-review (this REVISE round) returned four findings against the WB1
capture stage above: one high-severity real product bug (W3 scroll-to-bottom
non-functional), one medium-severity real product bug (W2 shimmer
unreachable dead code), one low-severity evidence inconsistency in this
file's own row 2, and one low-severity undeclared dependency
(`web-app/package.json`). All four are fixed in source/doc; the two with a
rendering-behavior change (W3, W2) are independently re-verified here with a
fresh, from-scratch re-run of `verify-wb1.mjs` against a live dev server —
not just re-asserted.

**Finding — W3 scroll-to-bottom non-functional (high, real product bug).**
Root cause confirmed exactly as diagnosed by the capture-stage FAIL above:
`theme.css`'s `html`/`body` (was line 51), `#root` (was line 58), `.rr-app`
(was line 76), and `.s-main` (was line 267) all used `min-height: 100svh` —
a floor, not a ceiling — so the flex chain that should height-constrain
`.s-thread { flex: 1; overflow-y: auto }` was never actually bounded and the
page body scrolled instead of the thread pane. Fixed by switching all four
rules to `height: 100svh` (web-app-local CSS, no shared-file change). W3's
own wiring (`ThreadPrimitive.ScrollToBottom` in `Thread.tsx`) was already
correct and needed no change.

**Finding — W2 shimmer unreachable dead code (medium, real product bug,
shared-file change — orchestrator-sanctioned for this revise dispatch,
extending WB1's previously abortSignal-only shared-change list).** Root
cause confirmed exactly as diagnosed: `stream.ts`'s `streamTextPart` never
yielded a genuinely-empty-but-running snapshot before its first chunk, so
the correctly-coded shimmer branch (`MarkdownText.tsx`/`Thread.tsx`'s `if
(!text) return isRunning ? <shimmer/> : null`) never had a DOM state to key
off. Fixed by yielding the already-empty `parts[parts.length - 1]` (pushed
by every call site immediately before calling `streamTextPart` — confirmed
across every use in `fixtures/conversations.ts`) once, plus one `sleep`
tick, before the chunk loop starts. Logic-only, purity-safe (verified below:
`check-shared-purity.sh` still passes) — no target-specific import, no
presentation value added to the shared file itself.

**Finding — evidence inconsistency in row 2 (low).** The prior round's row
2 stated `587/587` textLen and "reproduced identically across 2 independent
fresh runs (587/587 both times)", but the committed `results-wb1.json` (the
run the shipped artifacts came from) recorded `586/586`. Both numbers were
stale point-in-time captures from earlier runs of a nondeterministic-length
fixture render; superseded below by this round's own fresh, freshly
re-recorded numbers (`584/584`, reproduced identically across 2 independent
runs of this revise round, from a `results-wb1.json` re-generated by this
dispatch and re-read directly to build this row — not retyped from memory).

**Finding — undeclared dependency (low).** `web-app/package.json` now
declares `"@assistant-ui/core": "^0.3.0"` (pinned to the same version
`shared/package.json` already declares) alongside the existing
`@assistant-ui/react`. `npm install --package-lock-only` re-run from
`proto/` to keep `package-lock.json` consistent; `npx tsc --noEmit` (all
three workspaces) and `npx oxlint .` (all three workspaces) re-run clean,
exit 0, after the change.

Re-run performed exactly as the original CAPTURE-stage dispatch's own
described method: live `npx vite --port 5190` dev server, real Playwright
(`chromium`, headless, 1280×900), `web-app/captures/verify-wb1.mjs`
unmodified (only the app/shared source under test changed). Run **twice**
in succession from a fresh page load each time, specifically to give proof
2 (the named highest-risk stop-mid-stream claim) the same "reproduced
across 2 independent fresh runs" evidence bar the prior round claimed but
undermined with mismatched numbers. `results-wb1.json` and all
`web-app/captures/verify/wb1-*.png` below are from the second (final) of
those two runs; zero unexpected console/page errors in either run
(`consoleErrors: []` both times).

| # | feature | expected | observed | artifact path | verified-by | PASS/FAIL |
|---|---|---|---|---|---|---|
| 1 | Streaming lifecycle timed sequence: pre-first-token shimmer → stream-head cursor during streaming → cursor gone on completion | Same as above | **Fixed, re-verified live — was a FAIL.** Run 1: 590 paint-frame samples, shimmer ever seen=true (first at 16.6ms), cursor ever seen=true (first at 39.4ms), shimmer-before-cursor order ok=true, cursor gone after completion=true. Run 2 (shipped): 591 paint-frame samples, shimmer ever seen=true (first at 14.3ms), cursor ever seen=true (first at 37.9ms), order ok=true, cursor gone after completion=true. Shimmer is now genuinely observable — the empty-but-running DOM state the `stream.ts` fix creates is real, not just typechecked. | `web-app/captures/verify/wb1-01-shimmer-or-early-stream-window.png`, `web-app/captures/verify/wb1-02-cursor-during-stream.png`, `web-app/captures/verify/wb1-03-cursor-gone-on-completion.png` | this-dispatch (independent re-run) | **PASS** |
| 2 | **Stop mid-stream — the discriminating proof (named highest-risk claim for this batch).** Same as above | Unchanged mechanism (no W1-related fix this round) — re-run to correct row 2's own stale/mismatched evidence (the VERIFICATION.md finding above). **PASS, corrected numbers, reproduced identically across 2 independent fresh runs of this revise round: textLen immediately after click=584, textLen 2s later=584, identical=true — 584/584 both runs**, superseding the prior round's mismatched `587/587` claim / `586/586` shipped-artifact numbers. Last-200-char sample identical both times within each run, ending `"...Done — th\n\nCopy\nReload\n0.1s · 1065 tok/s"` (tok/s differs trivially between runs, as before). | `web-app/captures/verify/wb1-04-stop-before-click.png`, `web-app/captures/verify/wb1-05-stop-after-click.png`, `web-app/captures/verify/wb1-06-stop-2s-later.png` | this-dispatch (independent re-run, 2×) | **PASS** |
| 3 | Post-stop retry: composer/error path allows a real retry that resumes normal generation | Same as above | Unchanged mechanism, re-run for consistency with rows 1/2/4 (same driver invocation). Send visible right after stop=true, Stop control gone=true, new run's Stop button reappeared during retry=true, thread grew with new content=true (before len=584, after len=762) — consistent with row 2's corrected `584` baseline. | `web-app/captures/verify/wb1-07-post-stop-retry-streaming.png`, `web-app/captures/verify/wb1-08-post-stop-retry-complete.png` | this-dispatch (independent re-run) | **PASS** |
| 4 | Scroll-to-bottom: demonstrate it firing when new content streams in while the user has scrolled up | Same as above | **Fixed, re-verified live — was a FAIL.** `theme.css`'s `height: 100svh` chain now genuinely bounds `.s-thread`. scrollTop after real wheel scroll-up=0, control enabled right after scroll-up=true, control observed enabled at least once during the following ~1s of further streaming=true, control enabled at click-decision time=true, scrolled to bottom after click=true, control disabled again after click=true — every clause of the original FAIL's expected value now true. | `web-app/captures/verify/wb1-09-scroll-to-bottom-button-visible.png`, `web-app/captures/verify/wb1-10-scroll-to-bottom-still-enabled-after-more-streaming.png`, `web-app/captures/verify/wb1-11-scroll-to-bottom-after-click.png` | this-dispatch (independent re-run) | **PASS** |
| 5 | Error card inline retry: trigger an error state and confirm the inline retry control actually re-issues the request, not just re-renders the card | Same as above | Unchanged mechanism, re-run for consistency. Error card visible before retry, text="Something went wrong / shiki: unbundled theme \"solarized-dusk\"..."; retry control visible=true; error card cleared after retry click=true; branch picker advanced (same mechanism as before). | `web-app/captures/verify/wb1-12-error-card-before-retry.png`, `web-app/captures/verify/wb1-13-error-card-after-retry.png` | this-dispatch (independent re-run) | **PASS** |

**Summary for this REVISE round: 5/5 PASS (up from 3/5 PASS, 2/5 FAIL),
both prior FAILs fixed in source and re-verified live, not re-asserted.**
Proof 1 (shimmer) now genuinely observable after the `stream.ts` empty-yield
fix. Proof 4 (scroll-to-bottom) now genuinely enables/disables/scrolls
correctly after the `theme.css` height-chain fix. Proof 2's own row-2
evidence inconsistency (the low-severity finding) is corrected with fresh,
directly-read `results-wb1.json` numbers reproduced across 2 independent
runs in this round, rather than carrying forward either of the prior
round's two mismatched numbers.

**Non-visual, re-run fresh this round:** `npx tsc --noEmit` — clean, exit 0,
all three workspaces (`shared`, `web-app`, `ink-app`). `npx oxlint .` —
clean, exit 0, all three workspaces (one pre-existing, unrelated warning in
`web-app/captures/verify-wb1.mjs:216` — an unused local in this same driver
script, not introduced by this round's changes and not part of any reported
finding). `bash scripts/check-shared-purity.sh` — PASSED (confirms the
`stream.ts` change stays within the file's declared purity constraints).

## Web — WB1 THIRD REVISE round — code-review findings fixed, re-run from scratch

Code-review returned three findings against the WB1 REVISE round above: one
high-severity finding that the "Stop mid-stream" discriminating proof's own
*record* misdescribed what actually ran (two reintroduced FINDINGS.md defect
classes — a vacuous in-flight gate and a silently-dropped turn-2 submit,
detailed below), one medium-severity finding that `Thread.tsx`'s W3 comment
was factually false (already flagged once, in the REVISE round above, but
never actually corrected in source), and one low-severity finding that all
`wb1-*` screenshots leak a hardcoded personal display name via
`Sidebar.tsx:199` (rendered in pixels — see that line for the literal
string; not repeated as text here per this file's own sanitization rule
below) — pre-existing, not touched by any WB1 round, out of this batch's
scope (see its own note at the end of this section). Both non-low
findings are fixed in source and independently re-verified live below with a
fresh, from-scratch re-run of `verify-wb1.mjs` — not just re-asserted.

**Finding — vacuous in-flight gate + silently dropped turn-2 submit (high).**
Root cause, confirmed by reading source directly (not inferred from the
symptom):

1. **Vacuous gate.** The poll loop's `document.querySelector(".s-ast")` (no
   scoping) returns the FIRST `.s-ast` element anywhere on the page — turn
   1's own, already-completed first paragraph ("I'll handle both of those.
   Let me first check on that scratch file." — exactly 67 characters,
   `wc -c` verified), not turn 2's actively-streaming reply. The
   `textLen>3` condition was therefore satisfied from page render, never an
   actual measurement of in-flight text — the same vacuous-pass-condition
   class as the S3 grant-store false PASS this repo's own `FINDINGS.md`
   already documents.
2. **Dropped submit.** The setup step's `.first().waitFor({state:
   "visible"})` on the Reload button is not a valid "turn genuinely
   finished" signal for this specific turn, and resolves on a STALE
   already-visible element — confirmed by reading
   `useActionBarFloatStatus.ts` directly: `hideWhenRunning` only hides the
   action bar while `thread.isRunning` is true, and `turn1Start`'s own
   generator RETURNS (ending that `run()` call, flipping `isRunning` back
   to false) the moment it yields `status:{type:"requires-action"}` for the
   permission gate — well before Always-allow is clicked. Since this is the
   thread's only (hence last) message, `autohide="not-last"` doesn't hide
   it either, so Reload was ALREADY visible while the permission card was
   still pending. The old wait therefore resolved instantly against that
   pre-click Reload, not against `turn1Continue`'s real completion, letting
   the driver proceed into proof 2 while `turn1Continue` (the Always-allow
   continuation) was still actively streaming. With the composer still
   effectively mid-turn, the scripted `composer.press("Enter")` for turn
   2's text was silently dropped — exactly matching the prior round's
   shipped screenshots (`wb1-04`/`05`/`06`), which showed the composer
   still containing "Did that leave anything else stale in /tmp?" and no
   turn-2 user bubble. The stream that actually stopped was turn 1's own
   Always-allow continuation, not "turn 2" as the prior round's row 2
   stated.

Both are fixed in `verify-wb1.mjs`: the setup step now uses the same 1→0→1
count-cycle wait `verify-s3.mjs` already established for the analogous
Reload race (Reload count dips to 0 when `turn1Continue`'s own `run()` call
genuinely starts, returns to 1 only once it genuinely completes — a count
that never dips is itself now a real, loud failure, not something the old
wait could paper over); the poll loop now scopes to the LAST
`.s-msg-group` (Thread.tsx's own per-assistant-message wrapper) so it reads
turn 2's own in-flight text, not turn 1's frozen one; and an explicit
`.s-user` bubble check for turn 2's exact text now runs immediately after
sending it, so a dropped submit fails loudly instead of silently degrading
into a measurement of the wrong message.

**The headline claim itself survives this fix, now genuinely measured:**
re-run twice from scratch, textLen at click=6 both times (turn 2's own
reply, "Checking", caught mid-word — genuinely in-flight, not a
pre-rendered constant), textLen immediately-after-click=1407 and
2s-later=1407 both runs, identical=true both runs. The mechanism the
headline claim describes (Stop genuinely halts token output mid-stream) was
never in question; what was wrong was the permanent record's narrative of
*which* stream it caught stopping.

**Finding — W3 header comment still false (medium, re-flagged).** The prior
REVISE round's own code-review finding on this exact comment was recorded in
this file (see the "Web — WB1 REVISE round" section... actually not
present verbatim there — this is the first round the comment fix reached
VERIFICATION.md) but the correction was never actually applied to
`Thread.tsx` source. `Thread.tsx`'s header comment above
`ThreadPrimitive.ScrollToBottom` claimed "renders null when already at the
bottom (`useThreadScrollToBottom` returns null), so no extra visibility
logic is needed here" — false, confirmed by reading
`createActionButton.js` (the real shared implementation backing
`ScrollToBottom`) directly: the button is ALWAYS mounted; only its
`disabled` attribute toggles based on whether `useThreadScrollToBottom()`
returns a callback or `null`. Visible consequence, present in every prior
round's `wb1-*` screenshot: the ↓ button floated permanently over the
composer even while already at the bottom, with no `.s-scroll-bottom:
disabled` style to hide or mute it — unlike ChatGPT/Claude.ai's reference
behavior of only showing this control when scrolled up. Fixed: the comment
now correctly attributes the always-mounted behavior to
`createActionButton.js`, and `theme.css` gained a
`.s-scroll-bottom:disabled { display: none }` rule. Re-verified live with a
NEW capture proof (not present in any prior round) that checks the control
right when the thread is at rest, already at the bottom, before any
scroll-up: control present in DOM=true, disabled=true, computed
`display!=none` (visible)=**false** — genuinely hidden, not merely
`.disabled` while still occupying layout.

Re-run performed the same way as both prior rounds: live `npx vite --port
5190` dev server, real Playwright (`chromium`, headless, 1280×900),
`web-app/captures/verify-wb1.mjs` (modified only for the two fixes above —
the app/shared source under test also changed, per the W3 CSS/comment
fix). Run **twice** in succession from a fresh page load each time, same
"reproduced across 2 independent fresh runs" bar the prior rounds used for
row 2. `results-wb1.json` and all `web-app/captures/verify/wb1-*.png` below
are from the second (final) of those two runs; zero unexpected
console/page errors in either run (`consoleErrors: []` both times). The new
at-rest check inserted a capture step before the pre-existing scroll-up
capture, shifting every subsequent screenshot's step number by one
(`wb1-09` through `wb1-13` from the prior round are now `wb1-09` through
`wb1-14`) — the prior round's now-orphaned `wb1-09`..`wb1-13` files (stale,
pre-dating this round's code change) were deleted, not left alongside the
current set, to avoid two different `wb1-09.png`s meaning two different
things in the repo.

| # | feature | expected | observed | artifact path | verified-by | PASS/FAIL |
|---|---|---|---|---|---|---|
| 1 | Streaming lifecycle timed sequence: pre-first-token shimmer → stream-head cursor during streaming → cursor gone on completion | Same as above | Unchanged mechanism, re-run for consistency with the other rows (same driver invocation). 589 paint-frame samples, shimmer ever seen=true (first at 18.4ms), cursor ever seen=true (first at 35.1ms), order ok=true, cursor gone after completion=true. | `web-app/captures/verify/wb1-01-shimmer-or-early-stream-window.png`, `web-app/captures/verify/wb1-02-cursor-during-stream.png`, `web-app/captures/verify/wb1-03-cursor-gone-on-completion.png` | this-dispatch (independent re-run) | **PASS** |
| 2 | **Stop mid-stream — the discriminating proof (named highest-risk claim for this batch).** Same as above | Now gated on the LAST message's own in-flight text (see finding above), with an explicit pre-poll check that turn 2 was genuinely submitted | **Fixed, re-verified live — was a false PASS (right verdict, wrong mechanism recorded).** Reproduced identically across 2 independent fresh runs of this round: clicked at textLen=6 both runs (turn 2's own reply "Checking", caught mid-word — measured from the LAST of 2 `.s-msg-group` elements, confirmed sent via a `.s-user` bubble check first), textLen immediately after click=1407, textLen 2s later=1407, identical=true, both runs. | `web-app/captures/verify/wb1-04-stop-before-click.png`, `web-app/captures/verify/wb1-05-stop-after-click.png`, `web-app/captures/verify/wb1-06-stop-2s-later.png` | this-dispatch (independent re-run, 2×) | **PASS** |
| 3 | Post-stop retry: composer/error path allows a real retry that resumes normal generation | Same as above | Unchanged mechanism, re-run for consistency. Send visible right after stop=true, Stop control gone=true, new run's Stop button reappeared during retry=true, thread grew with new content=true (before len=1407, after len=1863) — consistent with row 2's corrected `1407` baseline. | `web-app/captures/verify/wb1-07-post-stop-retry-streaming.png`, `web-app/captures/verify/wb1-08-post-stop-retry-complete.png` | this-dispatch (independent re-run) | **PASS** |
| 4 | Scroll-to-bottom control is hidden (not just disabled) while already at the bottom — new proof this round | `ThreadPrimitive.ScrollToBottom` is always mounted (`createActionButton.js`) but must be genuinely hidden, not merely `.disabled`, while the thread is at rest at the bottom | **New, PASS.** Control present in DOM=true, disabled=true, computed `display!=none` (visible)=false — the `theme.css` fix genuinely hides it, confirmed via `getComputedStyle`, not just the `disabled` DOM property. | `web-app/captures/verify/wb1-09-scroll-to-bottom-hidden-while-at-bottom.png` | this-dispatch (independent re-run) | **PASS** |
| 5 | Scroll-to-bottom: demonstrate it firing when new content streams in while the user has scrolled up | Same as above | Unchanged mechanism, re-run for consistency. scrollTop after real wheel scroll-up=0, control enabled right after scroll-up=true, control observed enabled at least once during the following ~1s of further streaming=true, control enabled at click-decision time=true, scrolled to bottom after click=true, control disabled again after click=true. | `web-app/captures/verify/wb1-10-scroll-to-bottom-button-visible.png`, `web-app/captures/verify/wb1-11-scroll-to-bottom-still-enabled-after-more-streaming.png`, `web-app/captures/verify/wb1-12-scroll-to-bottom-after-click.png` | this-dispatch (independent re-run) | **PASS** |
| 6 | Error card inline retry: trigger an error state and confirm the inline retry control actually re-issues the request, not just re-renders the card | Same as above | Unchanged mechanism, re-run for consistency. Error card visible before retry, text="Something went wrong / shiki: unbundled theme \"solarized-dusk\"..."; retry control visible=true; error card cleared after retry click=true. | `web-app/captures/verify/wb1-13-error-card-before-retry.png`, `web-app/captures/verify/wb1-14-error-card-after-retry.png` | this-dispatch (independent re-run) | **PASS** |

**Summary for this THIRD REVISE round: 6/6 PASS** (row count grew from 5 to
6 — the new at-rest hidden-state proof). The high-severity finding (vacuous
gate + dropped turn-2 submit) is fixed and the headline "Stop genuinely
halts mid-stream" claim is now backed by a record that actually matches
what ran — reproduced identically across 2 independent runs, not
re-asserted from the prior round's mismeasured numbers. The medium-severity
finding (false W3 comment, never actually corrected in the prior round
despite being flagged) is now fixed in both `Thread.tsx` and `theme.css`,
with a new capture proof specifically for the previously-untested
"genuinely hidden at rest" case.

**Non-visual, re-run fresh this round:** `npx tsc --noEmit` — clean, exit 0,
all three workspaces (`shared`, `web-app`, `ink-app`). `npx oxlint .` —
clean, exit 0, all three workspaces (the same pre-existing, unrelated
unused-local warning as before, now at
`web-app/captures/verify-wb1.mjs:282` since inserted comments/code shifted
its line number — same variable (`alsoIdenticalToClickMoment`), not
introduced by this round). `bash scripts/check-shared-purity.sh` — PASSED
(no shared-file changes this round; confirms nothing regressed it either).

**Known, deliberately-unfixed finding — hardcoded personal display name in
every WB1 screenshot (low, flagged for the orchestrator, not fixed here).**
All `wb1-*.png` screenshots (and the webm) render a hardcoded personal
display name in the sidebar footer — source: `web-app/src/components/
Sidebar.tsx:199` (see that line directly for the literal string; not
repeated as text in this file, in keeping with this file's own
sanitization discipline described next), pre-existing, committed at
`5c6392e`, NOT touched by any WB1 round. The mechanical absolute-path /
home-relative-path / bare-username text sweep this repo's own public-repo
sanitization discipline requires passes cleanly on every file WB1 writes or
edits (verified: zero occurrences of any absolute filesystem path,
`~`-relative path, or the machine-owner's bare username in `verify-
wb1.mjs`, `Thread.tsx`, `theme.css`, or this file) because this particular
leak is in rendered pixels, not text content — the sweep cannot catch it.
**`Sidebar.tsx` is out of this batch's scope** (WB1 is the run-state
package: W1 stop, W2 streaming indicator, W3 scroll-to-bottom, W4 error
inline retry — none of which touch the sidebar footer), so this is
consciously left unfixed here rather than scope-crept into a fix. Per the
plan's own I5 finding (the ink-side name/home-path leak, same class),
fixing `Sidebar.tsx`'s hardcode belongs in WB2 (where `Sidebar.tsx` is
already in scope) — the orchestrator should decide there whether to
regenerate these WB1 artifacts after that fix lands or consciously accept
them as an interim, disclosed leak; this note exists so that decision is
made deliberately, not by silently shipping a public-repo PNG with a real
name baked into it.

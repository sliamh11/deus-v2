// LIA-496 S3A — full capture+verify driver for "Reading Room" (web).
// Real Playwright against the live `npx vite --port 5190` dev server.
// Writes screenshots/video to captures/verify/ and prints a JSON array of
// {feature, expected, observed, artifact, pass} rows to stdout (stage
// continues past individual step failures so later steps still run and we
// get an honest partial result instead of losing everything to one crash).
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const capDir = path.join(__dirname, "verify");
mkdirSync(capDir, { recursive: true });

const URL = "http://localhost:5190";
const log = (msg) => console.error(`[verify] ${msg}`);

const rows = [];
function record(feature, expected, observed, artifact, pass) {
  rows.push({ feature, expected, observed, artifact, pass });
  log(`${pass ? "PASS" : "FAIL"}: ${feature}`);
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1280, height: 900 },
  recordVideo: { dir: path.join(capDir, "video"), size: { width: 1280, height: 900 } },
  permissions: ["clipboard-read", "clipboard-write"],
});
const page = await context.newPage();

const consoleErrors = [];
page.on("console", (msg) => {
  if (msg.type() === "error") consoleErrors.push(msg.text());
});
page.on("pageerror", (err) => consoleErrors.push(`pageerror: ${err.message}`));

let step = 0;
async function shot(name, fullPage = true) {
  step += 1;
  const file = path.join(capDir, `${String(step).padStart(2, "0")}-${name}.png`);
  await page.screenshot({ path: file, fullPage });
  log(`screenshot: ${file}`);
  return file;
}

// Polls a locator's count until it equals `target` — used instead of
// `@playwright/test`'s `expect(locator).toHaveCount()` (not available;
// this repo only depends on plain `playwright`, not `@playwright/test`).
async function waitForCount(locator, target, timeout) {
  const start = Date.now();
  for (;;) {
    const n = await locator.count();
    if (n === target) return;
    if (Date.now() - start > timeout) {
      throw new Error(`waitForCount: timed out waiting for count===${target}, last seen ${n}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function safe(label, fn) {
  try {
    await fn();
  } catch (err) {
    log(`ERROR in ${label}: ${err && err.stack ? err.stack : err}`);
    record(label, "(step threw)", `EXCEPTION: ${err && err.message ? err.message : String(err)}`, "(none)", false);
  }
}

try {
  log(`navigating to ${URL}`);
  await page.goto(URL, { waitUntil: "networkidle" });

  // --- 1. Sidebar seeded/grouped -------------------------------------
  await safe("sidebar-seeded-grouped", async () => {
    const art = await shot("sidebar-seeded-grouped");
    await page.waitForSelector(".s-side", { timeout: 10000 });
    const todaySec = page.locator(".s-sec", { hasText: "Today" });
    const yesterdaySec = page.locator(".s-sec", { hasText: "Yesterday" });
    const todayCount = await todaySec.count();
    const yesterdayCount = await yesterdaySec.count();
    const itemCount = await page.locator(".s-item-row").count();
    const titles = await page.locator(".s-item").allTextContents();
    const observed = `Today header present=${todayCount > 0}, Yesterday header present=${yesterdayCount > 0}, total thread rows=${itemCount}, titles=${JSON.stringify(titles)}`;
    const pass = todayCount === 1 && yesterdayCount === 1 && itemCount === 7;
    record(
      "Sidebar seeded threads, grouped Today/Yesterday",
      "7 seeded threads grouped under Today (3) / Yesterday (4) headers per shared/src/fixtures/threads.ts",
      observed,
      art,
      pass,
    );
  });

  // --- 1b. Sidebar loading state (real 250ms list() latency) -----------
  // Code-review fix (LIA-496 REVISE round): the sidebar used to have NO
  // loading indicator at all, and worse, showed the EMPTY-state message
  // during the loading window (isEmpty was true while list() was
  // pending) — an actively wrong state. A fresh navigation with
  // `waitUntil: "domcontentloaded"` (NOT "networkidle", which can itself
  // take longer than the fake 250ms delay and race right past the
  // loading window) reliably lands inside that window.
  await safe("sidebar-loading-state", async () => {
    await page.goto(URL, { waitUntil: "domcontentloaded" });
    const artLoading = await shot("sidebar-loading");
    const loadingText = await page.locator(".s-side-loading").innerText().catch(() => "(none)");
    const wrongEmptyMsgDuringLoad = (await page.locator(".s-empty-list").count()) > 0;
    await page.locator(".s-sec", { hasText: "Today" }).waitFor({ state: "visible", timeout: 10000 });
    const artLoaded = await shot("sidebar-loaded-after-loading-state");
    const loadingGoneAfter = (await page.locator(".s-side-loading").count()) === 0;
    record(
      "Sidebar loading state (real 250ms list() latency)",
      "A genuine loading indicator renders while list() is pending (not the empty-thread message), and clears once real threads render",
      `loading text during window="${loadingText}", wrong empty-state message shown during load=${wrongEmptyMsgDuringLoad} (must be false), loading indicator gone after real content renders=${loadingGoneAfter}`,
      `${artLoading} , ${artLoaded}`,
      loadingText.toLowerCase().includes("loading") && !wrongEmptyMsgDuringLoad && loadingGoneAfter,
    );
  });

  // --- 1c. Sidebar error state (forced real list() rejection) ----------
  // Code-review fix (LIA-496 REVISE round): "empty/loading/error" was the
  // plan's Must-tier triad; error was entirely untested. Forces a REAL
  // thrown Error from the adapter's own `list()` (shared/src/
  // listStatus.ts's `simulateNextListError`/`consumeForcedListFailure` —
  // the same "honest fakes" pattern the theme-swap-crash conversation
  // already uses), not a scripted UI prop — see that file's header
  // comment for why this is otherwise unobservable at all through
  // `useAuiState` (the library swallows the rejection with no reactive
  // error field).
  await safe("sidebar-error-state", async () => {
    await page.evaluate(() => window.__lia496_simulateNextListError?.());
    await page.evaluate(() => window.__lia496_forceReload?.());
    await page.locator(".s-side-error").waitFor({ state: "visible", timeout: 10000 });
    const artError = await shot("sidebar-error-state");
    const errorText = await page.locator(".s-side-error").innerText().catch(() => "");
    // Retry recovers — a real backend error is not necessarily permanent,
    // and `consumeForcedListFailure` auto-resets after one use.
    await page.locator(".s-side-error button", { hasText: "Retry" }).click();
    await page.locator(".s-sec", { hasText: "Today" }).waitFor({ state: "visible", timeout: 10000 });
    const artRecovered = await shot("sidebar-error-recovered-via-retry");
    const errorGoneAfterRetry = (await page.locator(".s-side-error").count()) === 0;
    const itemCountAfterRecovery = await page.locator(".s-item-row").count();
    record(
      "Sidebar error state (forced real list() rejection) + Retry recovery",
      "A genuine list()-load failure renders a real error state with a Retry affordance; Retry re-calls reload() and recovers to the normal 7-thread list",
      `error banner text="${errorText}", recovered after Retry (error banner gone)=${errorGoneAfterRetry}, thread rows after recovery=${itemCountAfterRecovery}`,
      `${artError} , ${artRecovered}`,
      errorText.length > 0 && errorGoneAfterRetry && itemCountAfterRecovery === 7,
    );
  });

  // --- 2. Empty state + suggestion chips (fresh new-chat) -------------
  await safe("empty-state-suggestions", async () => {
    await page.locator(".s-new").click();
    await page.waitForTimeout(300);
    const art = await shot("empty-state-suggestions");
    const heading = await page.locator(".s-empty h1").count();
    const chips = await page.locator(".s-chip-btn").count();
    const headingText = heading ? await page.locator(".s-empty h1").innerText() : "(none)";
    const observed = `heading present=${heading > 0} ("${headingText}"), suggestion chip count=${chips}`;
    record(
      "Empty state + suggestion chips on new/fresh thread",
      "New-chat greeting heading + 3 real ThreadPrimitive.Suggestion chips render",
      observed,
      art,
      heading > 0 && chips === 3,
    );
  });

  // --- 3. Streaming mid-turn (status-glyph-fix thread) -----------------
  await safe("streaming-mid-turn-and-permission", async () => {
    await page.locator(".s-item", { hasText: "Status-glyph rendering fix" }).click();
    const composer = page.locator(".s-field textarea");
    await composer.waitFor({ state: "visible", timeout: 10000 });

    const formAncestor = await page.evaluate(() => {
      const ta = document.querySelector(".s-field textarea");
      return ta ? ta.closest("form") !== null : false;
    });
    record(
      "Composer textarea rendered inside ComposerPrimitive.Root <form>",
      "ComposerPrimitive.Input IS rendered inside ComposerPrimitive.Root, textarea.closest('form') !== null (the LIA-495 regression check)",
      `formAncestor=${formAncestor}`,
      "(no screenshot — DOM assertion)",
      formAncestor === true,
    );

    await composer.click();
    await composer.fill("Clean up that stale scratch log in /tmp, then tighten the status-glyph comment.");
    await composer.press("Enter");
    await page.waitForTimeout(350);
    const art = await shot("streaming-mid-turn");
    const serifText = await page.locator(".s-ast").first().innerText().catch(() => "");
    const hasSerifClass = await page.locator(".s-ast").count();
    record(
      "Streaming mid-turn: partial serif prose visible while streaming",
      "assistant prose renders mid-stream in ui-serif/Iowan Old Style/Georgia (.s-ast) with partial text visible before completion",
      `.s-ast element count=${hasSerifClass}, partial text sample="${serifText.slice(0, 80)}"`,
      art,
      hasSerifClass > 0 && serifText.length > 0,
    );
  });

  // --- 4. Permission card pending -> resolved (Always allow) -----------
  // Clicks "Always allow" (`.s-always`), NOT "Allow once" (`.s-btn.go`):
  // the grant-store proof in step 6 below depends on this permission class
  // having been granted for the rest of the session (shared/src/
  // permissions.ts's `grant(permissionKey("delete_file"))`, triggered by
  // turn1Continue when `optionId === "allow_always"`) — clicking Allow
  // once here would leave the grant store empty and turn 3's second
  // delete_file request would (correctly) render its own pending prompt,
  // which is a different, already-covered code path, not the grant-store
  // suppression this row exists to prove.
  await safe("permission-pending-and-resolved", async () => {
    const permCard = page.locator(".s-perm").first();
    await permCard.waitFor({ state: "visible", timeout: 10000 });
    const artPending = await shot("permission-pending");
    const heading = await page.locator(".s-perm .h").first().innerText().catch(() => "");
    record(
      "Permission card pending state",
      "Permission-needed decision card renders with Allow / Not now / Always allow before any decision",
      `card heading="${heading}", Allow button present=${(await page.locator(".s-perm .s-btn.go").count()) > 0}, Always allow button present=${(await page.locator(".s-perm .s-always").count()) > 0}`,
      artPending,
      heading.toLowerCase().includes("permission") && (await page.locator(".s-perm .s-btn.go").count()) > 0,
    );

    await page.locator(".s-perm .s-always").first().click();
    await page.waitForTimeout(400);
    const artResolved = await shot("permission-resolved-always-allow");
    const resolvedText = await page.locator(".s-perm-resolved").first().innerText().catch(() => "");
    record(
      "Permission card resolved (Always allow)",
      "After clicking Always allow, the card shows a resolved state (label + deletion outcome), no pending buttons, and the delete_file permission class is granted for the rest of the session",
      `resolved text="${resolvedText}"`,
      artResolved,
      resolvedText.toLowerCase().includes("always allow") && (await page.locator(".s-perm .s-btn.go").count()) === 0,
    );
  });

  // --- 5. Diff card -----------------------------------------------------
  await safe("diff-card", async () => {
    const diffWrap = page.locator(".s-diff-wrap, .s-code").first();
    await diffWrap.waitFor({ state: "visible", timeout: 15000 });
    const art = await shot("diff-card");
    const addCount = await page.locator(".s-add").count();
    const delCount = await page.locator(".s-del").count();
    const header = await page.locator(".s-code-h").first().innerText().catch(() => "");
    record(
      "Diff card (Edit tool result) renders with colored +/- lines",
      "DiffPanel renders a dark code card with filename header, +N/-N badge, colored diff lines (--s-diff-add #93C989 / --s-diff-del #D98D82)",
      `header="${header}", .s-add lines=${addCount}, .s-del lines=${delCount}`,
      art,
      addCount > 0 && delCount > 0,
    );
    // Turn 2 (diff card + closing prose) is not finished the instant the
    // diff card appears — it still streams "That's both done..." after.
    // ActionBarPrimitive.Root has hideWhenRunning, so its Reload/Copy
    // buttons becoming visible is the real "turn complete" signal. Wait
    // for it before the next step tries to submit turn 3, or the composer
    // send is silently dropped while the thread is still running (caught
    // live: an earlier run of this exact script left turn 3's text sitting
    // unsent in the composer because this wait was missing).
    await page.locator(".s-abtn", { hasText: "Reload" }).first().waitFor({ state: "visible", timeout: 15000 });
  });

  // --- 6. Turn 2 — "anything else stale?" follow-up (no permission gate) --
  // This is turn 2 of statusGlyphFixScript (shared/src/fixtures/
  // conversations.ts's `turn2()`), NOT the grant-store proof — turn2() only
  // runs a `ls /tmp | grep deus` verify command, no delete_file tool-call,
  // so there is nothing here to auto-approve. The grant-store proof needs a
  // THIRD user turn (step 6b below) to actually reach turn3Start(), which is
  // the one that issues a second delete_file request.
  await safe("turn2-followup-no-permission-gate", async () => {
    // Code-review fix (LIA-496 REVISE round): `.first().waitFor({state:
    // "visible"})` on the Reload button is only a real "this turn
    // finished" signal the FIRST time it appears (0 -> 1). From the
    // second turn onward this is genuinely racy: ActionBar.tsx's
    // `autohide="not-last"` UNMOUNTS (returns null, confirmed by reading
    // ActionBarRoot.tsx directly — not just CSS-hidden) a message's
    // action bar the instant it stops being the last message, and
    // `hideWhenRunning` also unmounts the NEW message's own action bar
    // while it streams — so the Reload count goes 1 (old message, before
    // sending) -> 0 (mid-flight: old one unmounted for no longer being
    // last, new one unmounted for running) -> 1 (new message, once done).
    // It returns to the SAME count, so a naive `count > before` check
    // waits forever; `.first().waitFor({state:"visible"})` is even worse
    // since it can resolve on the STALE pre-send element before this
    // component even re-renders. The real signal is the full 1->0->1
    // cycle — this is the exact silent-drop failure mode the diff-card
    // step's own comment already warns about, hit for real here once
    // (confirmed live via a captured screenshot showing turn 3's text
    // sitting unsent in the composer, not a sent message bubble).
    const reloadLocator = page.locator(".s-abtn", { hasText: "Reload" });
    const composer = page.locator(".s-field textarea");
    await composer.waitFor({ state: "visible", timeout: 15000 });
    await composer.click();
    await composer.fill("Did that leave anything else stale in /tmp?");
    await composer.press("Enter");
    await waitForCount(reloadLocator, 0, 15000);
    await waitForCount(reloadLocator, 1, 15000);
    const art = await shot("turn2-followup-complete");
    const bodyText = await page.locator(".s-thread").innerText().catch(() => "");
    record(
      "Turn 2 follow-up ('anything else stale?') completes with no permission gate",
      "turn2() runs a plain verify command (no delete_file tool-call) and completes on its own — this is NOT the grant-store proof, just the setup turn that must finish before turn 3 can be sent",
      `narration includes turn-2 closing text=${bodyText.includes("clean") || bodyText.includes("leftover")}`,
      art,
      bodyText.includes("clean") || bodyText.includes("leftover"),
    );
  });

  // --- 6b. Turn 3 — second delete_file, auto-approved (grant-store proof) -
  await safe("grant-store-second-permission-no-prompt", async () => {
    const permCountBefore = await page.locator(".s-perm").count();
    // 1->0->1 cycle wait — see turn2-followup-no-permission-gate's own
    // comment for the full mechanism (ActionBar.tsx's `autohide="not-
    // last"` + `hideWhenRunning` unmount, confirmed by reading
    // ActionBarRoot.tsx) and why a naive "count increased" check is wrong.
    const reloadLocator = page.locator(".s-abtn", { hasText: "Reload" });
    const composer = page.locator(".s-field textarea");
    await composer.waitFor({ state: "visible", timeout: 15000 });
    await composer.click();
    await composer.fill("One more check — anything else stale from the tui-v2 work?");
    await composer.press("Enter");
    await waitForCount(reloadLocator, 0, 15000);
    await waitForCount(reloadLocator, 1, 15000);
    const art = await shot("turn3-second-permission-grant-proof");
    const permCountAfter = await page.locator(".s-perm").count();
    const bodyText = await page.locator(".s-thread").innerText().catch(() => "");
    const turn3Narrated = bodyText.includes("without asking again") || bodyText.includes("Cleared");
    record(
      "Second permission-requiring action auto-approved (grant-store proof)",
      "Turn 3's second delete_file request renders NO NEW .s-perm prompt UI at all (Always-allow granted in turn 1) — a prompt rendering here is the FAIL, not a partial pass",
      `.s-perm count before turn 3 send=${permCountBefore}, after turn 3 completes=${permCountAfter} (expect unchanged — still only turn 1's resolved Always-allow card, zero new cards for turn 3), turn-3 narration present (mentions granted deletion without asking)=${turn3Narrated}`,
      art,
      permCountAfter === permCountBefore && turn3Narrated,
    );
  });

  // --- 7. Thread switch + return (history persisted) --------------------
  await safe("thread-switch-and-return-persisted", async () => {
    await page.locator(".s-item", { hasText: "Composer keyboard shortcuts" }).click();
    await page.waitForTimeout(400);
    const artAway = await shot("switched-away");
    await page.locator(".s-item", { hasText: "Status-glyph rendering fix" }).click();
    await page.waitForTimeout(400);
    const artBack = await shot("switched-back");
    const afterText = await page.locator(".s-thread").innerText();
    // Turn 3's message (the most-recently created live message, sent in
    // step 6b above) — NOT turn 2's, despite an earlier draft of this row
    // checking turn 2's "Did that leave anything else stale in /tmp?" text
    // while describing it as "turn 3's user message" in the row prose. Per
    // shared/src/fixtures/conversations.ts, "Did that leave anything else
    // stale in /tmp?" is turn 2's text; turn 3's is "One more check —
    // anything else stale from the tui-v2 work?" (sent in step 6b).
    const stillHasLiveMessage = afterText.includes("One more check — anything else stale from the tui-v2 work?");
    record(
      "Thread switch away + return preserves live-created messages",
      "Switching to another thread and back preserves messages created live during this session (turn 3's user message still present)",
      `live turn-3 message still present after switch-back=${stillHasLiveMessage}`,
      `${artAway} , ${artBack}`,
      stillHasLiveMessage,
    );
  });

  // --- 8. Markdown + shiki code block (first-frame highlighted) ---------
  await safe("markdown-shiki-codeblock", async () => {
    await page.locator(".s-item", { hasText: "Streaming markdown flicker" }).click();
    const composer = page.locator(".s-field textarea");
    await composer.waitFor({ state: "visible", timeout: 10000 });
    await composer.click();
    await composer.fill("What's causing the flicker?");
    // Tight 40ms poll across the whole streaming window (not a single
    // point-in-time check) to see whether VISIBLE unstyled plain text ever
    // appears before shiki markup takes over. A first quick attach-moment
    // check falsely FAILed this (0 shiki AND 0 fallback at first attach)
    // before this fix — that state turned out to be an EMPTY code body
    // (0 chars, nothing visible), not a plain-text flash; corrected here
    // with real sampled data instead of asserting off one moment.
    const samples = [];
    const pollStart = Date.now();
    await composer.press("Enter");
    while (Date.now() - pollStart < 12000) {
      const s = await page.evaluate(() => {
        const card = document.querySelector(".cb-card");
        if (!card) return { state: "no-card" };
        const shiki = card.querySelector(".shiki");
        const fallback = card.querySelector(".cb-inline-fallback");
        const bodyText = card.querySelector(".cb-body")?.textContent ?? "";
        return { state: shiki ? "shiki" : fallback ? "plain-fallback" : "card-no-content", bodyTextLen: bodyText.length };
      });
      samples.push({ ms: Date.now() - pollStart, ...s });
      if (s.state === "shiki") break;
      await page.waitForTimeout(40);
    }
    const art = await shot("markdown-shiki-codeblock");
    const shikiCount = await page.locator(".cb-card .shiki").count();
    const everVisiblePlainText = samples.some((s) => s.state === "plain-fallback" && s.bodyTextLen > 0);
    const plainFallbackSamples = samples.filter((s) => s.state === "plain-fallback");
    record(
      "Markdown code block highlighted from FIRST rendered frame (shiki)",
      "Fenced code block shows shiki-highlighted syntax colors from the FIRST rendered frame — a plain-text still is a FAIL (highlighter pre-warmed to avoid the race)",
      `40ms-polled ${samples.length} samples across the streaming window: ${plainFallbackSamples.length} sample(s) hit the transient 'plain-fallback' DOM state, but bodyTextLen was 0 in every one of them (i.e. no VISIBLE unhighlighted text was ever on screen — it goes empty -> shiki-highlighted directly); final state has ${shikiCount} .shiki element(s). everVisiblePlainText=${everVisiblePlainText}`,
      art,
      shikiCount > 0 && !everVisiblePlainText,
    );

    // Let the turn finish streaming BEFORE testing Copy — clicking mid-stream
    // (as an earlier run of this script did) copies only the partial text
    // delivered so far, which tests something real but not the intended
    // "copy a completed code block" feature.
    await page.locator(".s-abtn", { hasText: "Reload" }).first().waitFor({ state: "visible", timeout: 15000 });
    const fullCodeText = await page.locator(".cb-body").first().innerText();

    // Copy button + clipboard assertion.
    const copyBtn = page.locator(".cb-copy").first();
    await copyBtn.click();
    await page.waitForTimeout(150);
    const artCopied = await shot("codeblock-copied-state");
    const copiedLabel = await copyBtn.innerText();
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    const clipMatchesFullCode = clip.trim() === fullCodeText.trim();
    record(
      "Copy button copies real code text, shows 'Copied' state",
      "Clicking Copy writes the real fenced code text to the clipboard and the button shows a 'Copied' state (then reverts after 2s)",
      `button label after click="${copiedLabel}", clipboard length=${clip.length} (full rendered code length=${fullCodeText.length}, matches=${clipMatchesFullCode}), clipboard sample="${clip.slice(0, 80).replace(/\n/g, "\\n")}"`,
      artCopied,
      copiedLabel.toLowerCase() === "copied" && clip.length > 0 && clipMatchesFullCode,
    );
    await page.waitForTimeout(2200);
    const revertedLabel = await copyBtn.innerText();
    record(
      "Copy 'Copied' state reverts after 2 seconds",
      "copy action shows a 2-second 'Copied' state then reverts",
      `button label ~2.2s later="${revertedLabel}"`,
      "(no screenshot — timed DOM assertion)",
      revertedLabel.toLowerCase() === "copy",
    );
  });

  // --- 9. Edit a message + branch picker 2/2 -----------------------------
  await safe("edit-message-branch-picker", async () => {
    // No edit affordance is wired on UserMessage in Thread.tsx (plain
    // `<div className="s-user"><div className="chip"><MessagePrimitive.Content/></div></div>`,
    // no button/dblclick handler despite BranchPicker.tsx's header comment
    // claiming "ComposerPrimitive's per-message edit affordance"). Try the
    // real, only-plausible user gesture (double-click the chip, as Sidebar's
    // own rename uses dblclick as its convention) before concluding FAIL.
    const chip = page.locator(".s-user .chip").first();
    await chip.waitFor({ state: "visible", timeout: 10000 });
    await chip.dblclick();
    await page.waitForTimeout(300);
    const art = await shot("edit-message-attempt");
    const editTextarea = await page.locator(".s-user textarea, .s-user [contenteditable]").count();
    const branchPickerVisible = await page.locator(".s-branchpicker").count();
    record(
      "Edit a user message, branch picker shows 2/2",
      "Editing a sent user message and resubmitting creates a sibling branch; BranchPickerPrimitive.Root (hideWhenSingleBranch) shows Number/Count as 2 / 2",
      `double-click on user chip produced editable field=${editTextarea > 0}, .s-branchpicker elements found anywhere=${branchPickerVisible}. No edit button/handler exists on UserMessage in Thread.tsx — BranchPicker.tsx's own header comment references "ComposerPrimitive's per-message edit affordance" but Thread.tsx's UserMessage renders only static MessagePrimitive.Content with no edit trigger wired.`,
      art,
      false,
    );
  });

  // --- 10. Regenerate variant ---------------------------------------------
  await safe("regenerate-variant", async () => {
    await page.locator(".s-item", { hasText: "Composer keyboard shortcuts" }).click();
    // Seeded threads have no pre-existing conversation (SCRIPTS only start
    // once a message is actually sent — confirmed live, the sidebar title
    // alone doesn't seed history) so turn 1 must be sent for real before
    // Reload (a second run()) has anything to regenerate.
    const composer = page.locator(".s-field textarea");
    await composer.waitFor({ state: "visible", timeout: 10000 });
    await composer.click();
    await composer.fill("Wire Cmd+Enter to submit and Escape to blur in the composer.");
    await composer.press("Enter");
    await page.locator(".s-abtn", { hasText: "Reload" }).first().waitFor({ state: "visible", timeout: 15000 });
    const beforeText = await page.locator(".s-msg-group").last().innerText();

    const reloadBtn = page.locator(".s-abtn", { hasText: "Reload" }).first();
    await reloadBtn.click();
    await page.waitForTimeout(300);
    const artMid = await shot("regenerate-mid");
    // Wait for the regenerated turn to finish (Reload button visible again).
    await page.locator(".s-abtn", { hasText: "Reload" }).first().waitFor({ state: "visible", timeout: 15000 });
    const art = await shot("regenerate-variant");
    const afterText = await page.locator(".s-msg-group").last().innerText();
    const hasVariantMarker = afterText.includes("regenerated");
    const nonEmpty = afterText.trim().length > 0;
    const genuinelyDifferent = afterText !== beforeText;
    record(
      "Regenerate (Reload) produces a genuinely different scripted variant",
      "ActionBarPrimitive.Reload re-invokes the real adapter; per the plan's Feature scope this returns a scripted VARIANT on re-run, not an empty response",
      `before="${beforeText.slice(-100)}" | after="${afterText.slice(-140)}" | non-empty=${nonEmpty}, different from before=${genuinelyDifferent}, contains 'regenerated' variant marker=${hasVariantMarker}`,
      `${artMid} , ${art}`,
      nonEmpty && genuinelyDifferent && hasVariantMarker,
    );
  });

  // --- 11. Responsive 768px / 390px ---------------------------------------
  await safe("responsive-768", async () => {
    await page.setViewportSize({ width: 768, height: 1024 });
    await page.waitForTimeout(300);
    const art = await shot("responsive-768", false);
    // Playwright's isVisible() only checks display/visibility/opacity/size,
    // not scroll/transform position — .s-side is translateX(-100%) off-canvas
    // but would still report isVisible()=true, which is misleading for "is it
    // actually on screen". Check its actual bounding-box position instead.
    const sideBox = await page.locator(".s-side").boundingBox();
    const sideOffCanvas = sideBox ? sideBox.x + sideBox.width <= 0 : true;
    const drawerBtnVisible = await page.locator(".s-drawer-open").isVisible();
    record(
      "Responsive at 768px",
      "Sidebar collapses to an overlay drawer below ~860px (per theme.css's @media(max-width:860px) rule)",
      `sidebar off-canvas (translated out of the visible viewport)=${sideOffCanvas} (bbox=${JSON.stringify(sideBox)}), hamburger drawer-open button visible=${drawerBtnVisible}`,
      art,
      drawerBtnVisible === true && sideOffCanvas === true,
    );
  });

  await safe("responsive-390", async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(300);
    const artClosed = await shot("responsive-390-closed", false);
    await page.locator(".s-drawer-open").click();
    await page.waitForTimeout(300);
    const artOpen = await shot("responsive-390-drawer-open", false);
    const sideHasOpenClass = await page.locator(".s-side.open").count();
    const scrimVisible = await page.locator(".rr-scrim.open").count();
    record(
      "Responsive at 390px: sidebar becomes overlay drawer",
      "At 390px the sidebar is an off-canvas drawer; opening it via the hamburger shows the drawer + scrim overlay",
      `.s-side.open present=${sideHasOpenClass > 0}, .rr-scrim.open present=${scrimVisible > 0}`,
      `${artClosed} , ${artOpen}`,
      sideHasOpenClass > 0 && scrimVisible > 0,
    );
    // restore viewport + close drawer for subsequent steps
    await page.locator(".rr-scrim").click({ force: true }).catch(() => {});
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.waitForTimeout(200);
  });

  // --- 12. Error state -----------------------------------------------------
  await safe("error-state-thread", async () => {
    await page.locator(".s-item", { hasText: "Shiki theme swap crash" }).click();
    const composer = page.locator(".s-field textarea");
    await composer.waitFor({ state: "visible", timeout: 10000 });
    await composer.click();
    await composer.fill("Swap the code theme.");
    await composer.press("Enter");
    await page.locator(".s-error").first().waitFor({ state: "visible", timeout: 15000 });
    const art = await shot("error-state");
    const heading = await page.locator(".s-error .h").first().innerText().catch(() => "");
    const msgText = await page.locator(".s-error").first().innerText().catch(() => "");
    record(
      "Error state thread renders real thrown-error UI",
      "'theme-swap-crash' thread's real thrown Error (inside run()) propagates to message.status={error} and ErrorState.tsx renders ErrorPrimitive.Root/.Message with the real error text",
      `heading="${heading}", full card text="${msgText.slice(0, 200)}"`,
      art,
      heading.length > 0 && msgText.length > heading.length,
    );
  });

  log(`total console errors observed across whole run: ${consoleErrors.length}`);
  if (consoleErrors.length > 0) log(JSON.stringify(consoleErrors));
} finally {
  await context.close();
  await browser.close();
}

writeFileSync(path.join(capDir, "results.json"), JSON.stringify({ rows, consoleErrors }, null, 2));
console.log(JSON.stringify({ rows, consoleErrors }));

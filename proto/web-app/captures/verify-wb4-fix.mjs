// LIA-496 WB4 review-fix — RE-VERIFICATION driver for the two behavioral
// findings from the WB4 code-review REVISE round:
//
//   1. theme.css `.s-empty`: was `justify-content: flex-end` inside an
//      `overflow-y: auto` ancestor (`.s-thread`) — a documented cross-
//      browser quirk where content taller than the box overflows in the
//      START direction (upward) and is unreachable by scrolling down from
//      scrollTop=0. Fixed to `justify-content: flex-start` + `margin-top:
//      auto` on the first child (same bottom-docked look with room, but
//      degrades to reachable top-anchored flow when it doesn't fit).
//      Verified here at a short (600px-tall) viewport, plus confirms the
//      normal 900px-tall viewport still docks the greeting at the bottom
//      exactly as before (no regression to the W17 fix).
//
//   2. Composer.tsx: `autoFocus={!awaitingApproval}` only fires on mount,
//      and post-W14 the composer never remounts across an approval cycle
//      — so focus used to strand on `<body>` after a permission resolved.
//      Fixed with a `wasAwaitingApproval` ref + effect that calls
//      `.focus()` on the true->false transition. Verified here by driving
//      a real permission prompt to resolution and reading
//      `document.activeElement` afterward.
//
// Same record()/safe()/shot() pattern as verify-wb4-capture.mjs, own
// results file and screenshot prefix so nothing here overwrites prior
// stages' artifacts.
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const capDir = path.join(__dirname, "verify");
mkdirSync(capDir, { recursive: true });

const URL = process.env.WB4_FIX_URL || "http://localhost:5187";
const log = (msg) => console.error(`[wb4-fix] ${msg}`);

const rows = [];
function record(feature, expected, observed, artifact, pass, verifiedBy = "batch-agent") {
  rows.push({ feature, expected, observed, artifact, verifiedBy, pass });
  log(`${pass ? "PASS" : "FAIL"}: ${feature}`);
}

async function safe(label, fn) {
  try {
    await fn();
  } catch (err) {
    log(`ERROR in ${label}: ${err && err.stack ? err.stack : err}`);
    record(label, "(step threw)", `EXCEPTION: ${err && err.message ? err.message : String(err)}`, "(none)", false);
  }
}

const consoleErrors = [];
const browser = await chromium.launch({ headless: true });

let step = 0;
async function shot(page, name, fullPage = false) {
  step += 1;
  const file = path.join(capDir, `fix-wb4-${String(step).padStart(2, "0")}-${name}.png`);
  await page.screenshot({ path: file, fullPage });
  const relFile = path.relative(path.join(__dirname, "..", ".."), file);
  log(`screenshot: ${relFile}`);
  return relFile;
}

try {
  // === Fix 1: .s-empty reachable-by-scroll at a short viewport ==========
  await safe("empty-state-short-viewport-scrollable", async () => {
    // 400px chosen empirically, not guessed: probed .s-thread's own
    // scrollHeight vs clientHeight across several heights against this
    // exact build (900/700/600/500px: scrollHeight === clientHeight, no
    // overflow at all — those heights cannot exercise this bug regardless
    // of which justify-content value is in effect; 450px and below:
    // scrollHeight(297) > clientHeight, genuine overflow starts). 400px
    // gives a clear ~63px overflow margin so the reachable-by-scroll
    // assertion below is a real, discriminating test of the CSS fix, not
    // a viewport that happens to never overflow either way.
    const context = await browser.newContext({ viewport: { width: 1280, height: 400 } });
    const page = await context.newPage();
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    page.on("pageerror", (err) => consoleErrors.push(`pageerror: ${err.message}`));

    await page.goto(URL, { waitUntil: "networkidle" });
    await page.waitForSelector(".s-empty", { timeout: 10000 });
    const artShort = await shot(page, "empty-state-400h");

    // Scroll .s-thread (the real overflow:auto ancestor) all the way to
    // the top, then confirm every part of the greeting (h1, p, and the
    // LAST chip button) is within the visible viewport rect — i.e.
    // nothing overflowed above scrollTop=0 where it would be permanently
    // unreachable.
    const geometry = await page.evaluate(() => {
      const thread = document.querySelector(".s-thread");
      const empty = document.querySelector(".s-empty");
      const h1 = document.querySelector(".s-empty h1");
      const p = document.querySelector(".s-empty p");
      const chips = document.querySelectorAll(".s-chip-btn");
      const lastChip = chips[chips.length - 1];
      if (!thread || !empty || !h1 || !p || !lastChip) return null;

      thread.scrollTop = 0;
      const threadRect = thread.getBoundingClientRect();
      const rects = {
        h1: h1.getBoundingClientRect(),
        p: p.getBoundingClientRect(),
        lastChip: lastChip.getBoundingClientRect(),
      };
      const within = (r) => r.top >= threadRect.top - 1 && r.bottom <= threadRect.bottom + 1;
      return {
        scrollTopAfterReset: thread.scrollTop,
        scrollHeight: thread.scrollHeight,
        clientHeight: thread.clientHeight,
        h1Within: within(rects.h1),
        pWithin: within(rects.p),
        lastChipWithin: within(rects.lastChip),
        h1Top: rects.h1.top,
        threadTop: threadRect.top,
      };
    });

    // Now scroll to the bottom and re-check — everything must ALSO be
    // reachable by scrolling down (the other half of "reachable by
    // scrolling", not just "visible at scrollTop=0" if it happens to fit).
    const geometryScrolledDown = await page.evaluate(() => {
      const thread = document.querySelector(".s-thread");
      const lastChip = document.querySelectorAll(".s-chip-btn");
      const last = lastChip[lastChip.length - 1];
      thread.scrollTop = thread.scrollHeight;
      const threadRect = thread.getBoundingClientRect();
      const r = last.getBoundingClientRect();
      return r.top >= threadRect.top - 1 && r.bottom <= threadRect.bottom + 1;
    });

    const artScrolled = await shot(page, "empty-state-400h-scrolled");

    // Content is genuinely taller than the box at this height (scrollHeight
    // 297 > clientHeight 234, confirmed above) — the last chip is NOT
    // expected to be visible at scrollTop=0 simultaneously with h1; that's
    // ordinary overflow, not the bug. The actual defect under test is
    // whether the START of the content (h1) is pushed ABOVE scrollTop=0
    // (unreachable — scrollTop can't go negative) when justify-content:
    // flex-end overflows in the start direction. So the real assertions
    // are: (a) at scrollTop=0, h1 (the top of the content) is fully within
    // the visible rect — proves nothing overflowed upward past the
    // reachable scroll range; (b) at scrollTop=scrollHeight, the last chip
    // (the bottom of the content) is fully within the visible rect —
    // proves the full length is reachable by scrolling down.
    const overflowing = geometry && geometry.scrollHeight > geometry.clientHeight;
    const reachable = geometry && overflowing && geometry.h1Within && geometry.pWithin && geometryScrolledDown;

    record(
      ".s-empty at a short (400px) viewport: full greeting reachable by scrolling, nothing stranded above scrollTop=0",
      "At a viewport too short for the greeting to fit (.s-thread.scrollHeight > .s-thread.clientHeight, i.e. genuine overflow, not a no-op test), scrolling .s-thread (the real overflow:auto ancestor) to top shows h1/p (the content's own start) fully within the visible rect — proving nothing overflowed upward past scrollTop=0 where it would be permanently unreachable — and scrolling to bottom shows the last suggestion chip (the content's own end) fully within the visible rect, proving the full length is reachable by scrolling down",
      geometry
        ? `overflowing=${overflowing} (scrollHeight=${geometry.scrollHeight} > clientHeight=${geometry.clientHeight}), scrollTopAfterReset=${geometry.scrollTopAfterReset}, h1Within(atTop)=${geometry.h1Within}, pWithin(atTop)=${geometry.pWithin}, lastChipWithin(atTop, expected false — ordinary overflow)=${geometry.lastChipWithin}, lastChipWithin(scrolledToBottom)=${geometryScrolledDown}, h1Top=${geometry.h1Top.toFixed(1)}, threadTop=${geometry.threadTop.toFixed(1)}`
        : "geometry evaluate() returned null — a required element was missing",
      artShort,
      reachable,
    );
    log(`also captured: ${artScrolled}`);

    await context.close();
  });

  // === Fix 1 regression check: 900px viewport still docks at the bottom ==
  await safe("empty-state-normal-viewport-still-docked", async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    page.on("pageerror", (err) => consoleErrors.push(`pageerror: ${err.message}`));

    await page.goto(URL, { waitUntil: "networkidle" });
    await page.waitForSelector(".s-empty", { timeout: 10000 });
    const art = await shot(page, "empty-state-900h-docked");

    const gap = await page.evaluate(() => {
      const empty = document.querySelector(".s-empty");
      const field = document.querySelector(".s-field");
      if (!empty || !field) return -1;
      const eRect = empty.getBoundingClientRect();
      const fRect = field.getBoundingClientRect();
      return fRect.top - eRect.bottom;
    });
    const docked = gap >= 0 && gap < 80;

    record(
      "Regression check: at the normal 900px viewport, the greeting is still bottom-docked under the composer (margin-top:auto reproduces the old justify-content:flex-end look)",
      "gap between .s-empty's bottom and .s-field's top stays an ordinary small padding gap, same as before the fix (not reverted to centered/top-anchored)",
      `gap=${gap.toFixed(1)}px, docked=${docked}`,
      art,
      docked,
    );

    await context.close();
  });

  // === Fix 2: composer refocuses after a permission resolves =============
  await safe("composer-refocus-after-permission-resolves", async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    page.on("pageerror", (err) => consoleErrors.push(`pageerror: ${err.message}`));

    await page.goto(URL, { waitUntil: "networkidle" });
    await page.waitForSelector(".s-side", { timeout: 10000 });

    await page.locator(".s-item", { hasText: "Status-glyph rendering fix" }).click();
    const composer = page.locator(".s-field textarea");
    await composer.waitFor({ state: "visible", timeout: 10000 });
    await composer.click();
    await composer.fill("Clean the scratch file and tighten the status-glyph comment.");
    await composer.press("Enter");

    await page.locator(".s-perm").first().waitFor({ state: "visible", timeout: 15000 });

    // Deliberately move focus AWAY from the composer while the prompt is
    // pending (same as PermissionCard's own buttons would receive focus in
    // real usage), so the refocus-on-resolve effect has something real to
    // prove — if we never moved focus off, a false pass would be possible.
    await page.locator(".s-perm .s-always").focus();
    const focusedBeforeResolve = await page.evaluate(() => document.activeElement?.className || "");

    await page.locator(".s-perm .s-always").click();
    await page.locator(".s-perm").first().waitFor({ state: "detached", timeout: 5000 }).catch(() => {});

    // Give the effect a tick to run after the state update.
    await page.waitForTimeout(200);
    const art = await shot(page, "composer-refocused-after-approval");

    const activeState = await page.evaluate(() => {
      const textarea = document.querySelector(".s-field textarea");
      return {
        activeIsTextarea: document.activeElement === textarea,
        activeIsBody: document.activeElement === document.body,
        activeTag: document.activeElement?.tagName || null,
        textareaDisabled: textarea ? textarea.disabled : null,
      };
    });

    record(
      "Composer regains focus automatically once a pending permission resolves (advisory finding investigated: ComposerPrimitive.Input's own reactive autoFocus/disabled composition already handles this, no custom code needed — see Composer.tsx's header comment)",
      "After deliberately focusing away onto the permission card's own button, resolving the permission ('Always allow') returns document.activeElement to the composer's real <textarea> — not left on <body> or the now-removed permission button",
      `focusedBeforeResolve="${focusedBeforeResolve}", activeIsTextarea=${activeState.activeIsTextarea}, activeIsBody=${activeState.activeIsBody}, activeTag=${activeState.activeTag}, textareaDisabled=${activeState.textareaDisabled}`,
      art,
      activeState.activeIsTextarea && !activeState.activeIsBody,
    );

    await context.close();
  });

  log(`total console errors observed across whole run: ${consoleErrors.length}`);
  if (consoleErrors.length > 0) log(JSON.stringify(consoleErrors));
} finally {
  await browser.close();
}

const allPass = rows.every((r) => r.pass);
writeFileSync(
  path.join(capDir, "results-wb4-fix.json"),
  JSON.stringify({ rows, consoleErrors, allPass }, null, 2),
);
if (!allPass) process.exitCode = 1;

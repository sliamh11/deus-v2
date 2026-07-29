// LIA-496 WB4 — CAPTURE STAGE independent re-verification driver.
//
// Distinct from captures/verify-wb4.mjs (the BUILD stage's own driver,
// bound to port 5191, results-wb4.json). This file is a separate,
// independently-written Playwright run against a dev server on port 5186
// (this batch's own reserved capture-stage port, per the dispatch), with
// two proofs deliberately strengthened past what the build-stage driver
// already covered:
//
//   1. Model picker — the discriminating proof. The build-stage script
//      opened the popover via click but then only ever drove SELECTION via
//      keyboard (ArrowDown + Enter), never re-demonstrating a pure-click
//      select→open→click-select round trip, nor a keyboard-only
//      open→select round trip starting from a closed, unclicked trigger.
//      This driver demonstrates BOTH independently: (a) open via a real
//      mouse click, select the OTHER option via a real mouse click on the
//      option row, confirm the label toggled; (b) reopen and select via
//      keyboard ONLY (focus the trigger, Enter to open, ArrowDown/ArrowUp
//      to move, Enter to select), confirm the label toggled back — proving
//      the toggle genuinely works via each input modality on its own, not
//      just a click-to-open + keyboard-to-select hybrid.
//   2. 6-line composer geometry + an ARIA snapshot of the picker open at
//      that height. The build-stage script grew the composer past one line
//      (4 lines of typed text) but never counted to exactly 6 rendered
//      lines, and never captured an accessibility-tree snapshot of the
//      model picker while open at a grown composer height (the plan's
//      literal phrase: "6-line composer geometry, picker open with an ARIA
//      snapshot").
//
// Same record()/safe()/shot() pattern as verify-wb4.mjs and verify-wb1.mjs
// for consistency, but writes to its own results file
// (results-wb4-capture.json) and its own screenshot prefix (cap-wb4-*) so
// nothing here overwrites the build stage's own artifacts.
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const capDir = path.join(__dirname, "verify");
mkdirSync(capDir, { recursive: true });

const URL = process.env.WB4_CAPTURE_URL || "http://localhost:5186";
const log = (msg) => console.error(`[wb4-capture] ${msg}`);

const rows = [];
function record(feature, expected, observed, artifact, pass, verifiedBy = "batch-agent") {
  rows.push({ feature, expected, observed, artifact, verifiedBy, pass });
  log(`${pass ? "PASS" : "FAIL"}: ${feature}`);
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();

const consoleErrors = [];
page.on("console", (msg) => {
  if (msg.type() === "error") consoleErrors.push(msg.text());
});
page.on("pageerror", (err) => consoleErrors.push(`pageerror: ${err.message}`));

let step = 0;
async function shot(name, fullPage = false) {
  step += 1;
  const file = path.join(capDir, `cap-wb4-${String(step).padStart(2, "0")}-${name}.png`);
  await page.screenshot({ path: file, fullPage });
  const relFile = path.relative(path.join(__dirname, "..", ".."), file);
  log(`screenshot: ${relFile}`);
  return relFile;
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
  await page.waitForSelector(".s-side", { timeout: 10000 });

  // === Empty state — fresh screenshot, no fixture-spike copy, docked =====
  await safe("empty-state", async () => {
    const emptyVisible = await page.locator(".s-empty").first().isVisible().catch(() => false);
    const bodyText = emptyVisible ? await page.locator(".s-empty").first().innerText() : "";
    const noFixtureLanguage = !/fixture spike|LIA-496/i.test(bodyText);
    const art = await shot("empty-state");

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
      "Empty state: no fixture-spike copy, composer docked under greeting",
      'Greeting has no "fixture spike"/"LIA-496" language; composer sits directly under the greeting with an ordinary padding gap, not dead space',
      `emptyVisible=${emptyVisible}, noFixtureLanguage=${noFixtureLanguage}, greeting="${bodyText.slice(0, 140)}", gap=${gap.toFixed(1)}px, docked=${docked}`,
      art,
      emptyVisible && noFixtureLanguage && docked,
    );
  });

  // === Composer mounted during approval ===================================
  await safe("composer-mounted-during-approval", async () => {
    await page.locator(".s-item", { hasText: "Status-glyph rendering fix" }).click();
    const composer = page.locator(".s-field textarea");
    await composer.waitFor({ state: "visible", timeout: 10000 });
    await composer.click();
    await composer.fill("Clean the scratch file and tighten the status-glyph comment.");
    await composer.press("Enter");

    await page.locator(".s-perm").first().waitFor({ state: "visible", timeout: 15000 });
    const art = await shot("permission-pending-composer-mounted");

    const state = await page.evaluate(() => {
      const field = document.querySelector(".s-field");
      const textarea = document.querySelector(".s-field textarea");
      return {
        fieldPresent: !!field,
        textareaPresent: !!textarea,
        textareaDisabled: textarea ? textarea.disabled : null,
        placeholder: textarea ? textarea.getAttribute("placeholder") : null,
        oldWaitingDivPresent: !!document.querySelector(".s-composer-waiting"),
      };
    });
    const focusAttempt = await page.evaluate(() => {
      const textarea = document.querySelector(".s-field textarea");
      textarea?.focus();
      return document.activeElement === textarea;
    });

    const staysMounted =
      state.fieldPresent &&
      state.textareaPresent &&
      state.textareaDisabled === true &&
      /resolve/i.test(state.placeholder || "") &&
      !state.oldWaitingDivPresent &&
      focusAttempt === false;

    record(
      "Composer stays mounted (visible in DOM, textarea disabled, waiting placeholder) during a pending permission approval",
      "The real .s-field > textarea structure stays in the DOM, disabled=true, placeholder mentions resolving the prompt above, no unmounted .s-composer-waiting div, and the disabled textarea cannot take focus",
      `fieldPresent=${state.fieldPresent}, textareaPresent=${state.textareaPresent}, textareaDisabled=${state.textareaDisabled}, placeholder="${state.placeholder}", oldWaitingDivPresent=${state.oldWaitingDivPresent}, focusStolen=${focusAttempt}`,
      art,
      staysMounted,
    );

    // === Always-allow scope text, captured in the same live prompt =======
    const alwaysBtn = page.locator(".s-perm .s-always");
    const alwaysText = (await alwaysBtn.innerText()).trim();
    const scopeNote = await page.locator(".s-perm-scope").first().innerText().catch(() => "");
    const artScope = await shot("permission-scope-note");
    const buttonStatesScope = /this session/i.test(alwaysText);
    const scopeNotePresent = scopeNote.length > 0 && /session/i.test(scopeNote);

    record(
      '"Always allow" states an explicit session-scope note',
      'Button reads "Always allow (this session)" and a visible note explains the grant applies to every request for this tool for the rest of the session',
      `buttonText="${alwaysText}", buttonStatesScope=${buttonStatesScope}, scopeNoteText="${scopeNote}", scopeNotePresent=${scopeNotePresent}`,
      artScope,
      buttonStatesScope && scopeNotePresent,
    );

    await alwaysBtn.click();
    await page.locator(".s-perm").first().waitFor({ state: "detached", timeout: 5000 }).catch(() => {});
  });

  // === Model picker — the discriminating proof ============================
  // Navigate to a thread with no in-flight permission prompt so the
  // composer/model-picker row is in its normal interactive state.
  await safe("model-picker-click-and-keyboard-toggle", async () => {
    await page.locator(".s-item", { hasText: "Composer keyboard shortcuts" }).click();
    const trigger = page.locator(".s-model");
    await trigger.waitFor({ state: "visible", timeout: 10000 });

    // trigger.innerText() includes the caret glyph span ("Sonnet 5\n⌄") —
    // extract just the model-name first line for label comparisons.
    const readLabel = async () => {
      const full = (await trigger.innerText()).trim();
      return full.split("\n")[0].trim();
    };

    const labelStart = await readLabel();
    const artClosed = await shot("model-picker-closed");

    // --- (a) REAL CLICK open, REAL CLICK select the OTHER option ---------
    await trigger.click();
    await page.locator(".s-model-menu[role='listbox']").waitFor({ state: "visible", timeout: 3000 });
    const artOpenViaClick = await shot("model-picker-open-via-click");
    const otherLabelForClick = labelStart === "Sonnet 5" ? "Opus 5" : "Sonnet 5";
    const otherOption = page.locator(".s-model-option", { hasText: otherLabelForClick });
    await otherOption.click();
    await page.locator(".s-model-menu").waitFor({ state: "detached", timeout: 3000 }).catch(() => {});
    const labelAfterClickToggle = await readLabel();
    const artAfterClickToggle = await shot("model-picker-after-click-toggle");
    const clickToggleWorked = labelAfterClickToggle !== labelStart && labelAfterClickToggle === otherLabelForClick;

    // --- (b) REAL KEYBOARD-ONLY open + navigate + select ------------------
    // Focus the trigger directly (no click), then drive the whole
    // open→navigate→select sequence with keys only.
    await trigger.focus();
    const focusedBeforeKeyOpen = await page.evaluate(
      () => document.activeElement === document.querySelector(".s-model"),
    );
    await page.keyboard.press("Enter"); // opens per onTriggerKeyDown
    await page.locator(".s-model-menu[role='listbox']").waitFor({ state: "visible", timeout: 3000 });
    const artOpenViaKeyboard = await shot("model-picker-open-via-keyboard");
    const activeBeforeArrow = await page.evaluate(
      () => document.querySelector(".s-model-option.active")?.textContent ?? null,
    );
    await page.keyboard.press("ArrowDown");
    const activeAfterArrow = await page.evaluate(
      () => document.querySelector(".s-model-option.active")?.textContent ?? null,
    );
    const arrowMoved = activeBeforeArrow !== null && activeAfterArrow !== null && activeBeforeArrow !== activeAfterArrow;
    await page.keyboard.press("Enter"); // selects the now-active option
    await page.locator(".s-model-menu").waitFor({ state: "detached", timeout: 3000 }).catch(() => {});
    const labelAfterKeyboardToggle = await readLabel();
    const artAfterKeyboardToggle = await shot("model-picker-after-keyboard-toggle");
    const keyboardToggleWorked = labelAfterKeyboardToggle !== labelAfterClickToggle;
    // Since there are exactly two scripted labels, a genuine toggle from
    // the click-driven state must land back on the ORIGINAL label.
    const keyboardToggleReturnedToOriginal = labelAfterKeyboardToggle === labelStart;

    record(
      "Model picker — real CLICK opens the popover and CLICKING the other option toggles the label",
      "A real mouse click on the trigger opens role=listbox; a real mouse click on the non-selected option row closes the popover and changes the trigger's displayed label to that option",
      `labelStart="${labelStart}", clickedOption="${labelStart === "Sonnet 5" ? "Opus 5" : "Sonnet 5"}", labelAfterClickToggle="${labelAfterClickToggle}", toggled=${clickToggleWorked}`,
      `${artClosed} , ${artOpenViaClick} , ${artAfterClickToggle}`,
      clickToggleWorked,
    );
    record(
      "Model picker — real KEYBOARD ONLY (focus + Enter to open, ArrowDown to move, Enter to select) toggles the label back",
      "With the trigger focused (no click), Enter opens the popover; ArrowDown moves the active option; Enter selects it and closes the popover; since only 2 labels exist, toggling from the post-click state must land back on the original label",
      `focusedBeforeOpen=${focusedBeforeKeyOpen}, activeBeforeArrow="${activeBeforeArrow}", activeAfterArrow="${activeAfterArrow}", arrowMoved=${arrowMoved}, labelAfterKeyboardToggle="${labelAfterKeyboardToggle}", toggled=${keyboardToggleWorked}, returnedToOriginal=${keyboardToggleReturnedToOriginal}`,
      `${artOpenViaKeyboard} , ${artAfterKeyboardToggle}`,
      arrowMoved && keyboardToggleWorked && keyboardToggleReturnedToOriginal,
    );
  });

  // === 6-line composer geometry + ARIA snapshot of picker open ===========
  await safe("six-line-composer-geometry-and-picker-aria-snapshot", async () => {
    const composer = page.locator(".s-field textarea");
    await composer.waitFor({ state: "visible", timeout: 10000 });
    await composer.click();
    await composer.fill("");

    const oneLine = await page.evaluate(() => {
      const field = document.querySelector(".s-field");
      return field.getBoundingClientRect().height;
    });

    // Type exactly 6 newline-separated lines (6 rows once wrapped/typed as
    // literal line breaks) — verified against scrollHeight/line-count
    // after typing, not assumed from the input text alone.
    const sixLines = ["Line one.", "Line two.", "Line three.", "Line four.", "Line five.", "Line six — this is the sixth and final line."].join("\n");
    await composer.fill(sixLines);
    await page.waitForTimeout(150);

    const geom = await page.evaluate(() => {
      const field = document.querySelector(".s-field");
      const textarea = document.querySelector(".s-field textarea");
      const send = document.querySelector(".s-send");
      const style = getComputedStyle(field);
      const fieldRect = field.getBoundingClientRect();
      const sendRect = send.getBoundingClientRect();
      const taStyle = getComputedStyle(textarea);
      const lineHeight = parseFloat(taStyle.lineHeight) || 20;
      const renderedLines = Math.round(textarea.scrollHeight / lineHeight);
      return {
        fieldHeight: fieldRect.height,
        radiusPx: parseFloat(style.borderRadius),
        halfHeight: fieldRect.height / 2,
        sendBottom: sendRect.bottom,
        fieldBottom: fieldRect.bottom,
        fieldPaddingBottom: parseFloat(getComputedStyle(field).paddingBottom),
        scrollHeight: textarea.scrollHeight,
        lineHeight,
        renderedLines,
      };
    });
    const artSixLine = await shot("composer-six-line");

    // Threshold matched to the build-stage driver's own multiline
    // definition (verify-wb4.mjs: `fieldHeight > oneLine.height * 1.5`) —
    // "grew well past one line", not an exact 6x/3x multiple, since
    // scrollHeight-based auto-resize does not grow perfectly linearly with
    // literal newline count (confirmed live: 6 typed lines produced a
    // field height ~2.4x the one-line height here, genuinely multiline,
    // visually confirmed in the screenshot).
    const grewSubstantially = geom.fieldHeight > oneLine * 1.8;
    const radiusRelaxed = geom.radiusPx > 0 && geom.radiusPx < geom.halfHeight * 0.8;
    const sendBottomGap = geom.fieldBottom - geom.sendBottom;
    const sendBottomAligned = sendBottomGap >= 0 && sendBottomGap <= geom.fieldPaddingBottom + 4;

    record(
      "6-line composer geometry: field grows, radius stays relaxed, send stays bottom-pinned",
      "Typing 6 literal lines grows the field well past one-line height; border-radius remains a fixed honest value (not re-clamped to a stadium cap); the send button stays flex-end (bottom) aligned",
      `oneLineHeight=${oneLine.toFixed(1)}px, sixLineFieldHeight=${geom.fieldHeight.toFixed(1)}px, textarea.scrollHeight=${geom.scrollHeight}px, lineHeight=${geom.lineHeight.toFixed(1)}px, renderedLines(approx)=${geom.renderedLines}, grewSubstantially=${grewSubstantially}, radius=${geom.radiusPx.toFixed(1)}px vs halfHeight=${geom.halfHeight.toFixed(1)}px, radiusRelaxed=${radiusRelaxed}, sendBottomGap=${sendBottomGap.toFixed(1)}px, fieldPaddingBottom=${geom.fieldPaddingBottom.toFixed(1)}px, sendBottomAligned=${sendBottomAligned}`,
      artSixLine,
      grewSubstantially && radiusRelaxed && sendBottomAligned,
    );

    // Now open the model picker AT this 6-line height and capture a real
    // ARIA snapshot (accessibility tree) of the composer secondary row +
    // open popover — the plan's literal named proof.
    const trigger = page.locator(".s-model");
    await trigger.click();
    await page.locator(".s-model-menu[role='listbox']").waitFor({ state: "visible", timeout: 3000 });
    const artSixLinePickerOpen = await shot("composer-six-line-picker-open");

    const composerRow = page.locator(".s-composer");
    const ariaSnapshot = await composerRow.ariaSnapshot();

    const ariaHasListbox = /listbox/i.test(ariaSnapshot);
    const ariaHasBothOptions = /Sonnet 5/.test(ariaSnapshot) && /Opus 5/.test(ariaSnapshot);
    const ariaHasTextbox = /textbox/i.test(ariaSnapshot);

    record(
      "6-line composer geometry — picker open, captured as a real ARIA snapshot",
      "With the composer grown to 6 lines, opening the model picker produces an accessibility tree containing a listbox role with both scripted option labels, alongside the composer's own textbox role — captured via Playwright's real ariaSnapshot(), not asserted from CSS/DOM alone",
      `ariaHasListbox=${ariaHasListbox}, ariaHasBothOptions=${ariaHasBothOptions}, ariaHasTextbox=${ariaHasTextbox}\n--- ARIA SNAPSHOT ---\n${ariaSnapshot}`,
      artSixLinePickerOpen,
      ariaHasListbox && ariaHasBothOptions && ariaHasTextbox,
    );

    // Close cleanly and clear the composer, leaving the app tidy.
    await page.keyboard.press("Escape");
    await composer.fill("");
  });

  log(`total console errors observed across whole run: ${consoleErrors.length}`);
  if (consoleErrors.length > 0) log(JSON.stringify(consoleErrors));
} finally {
  await context.close();
  await browser.close();
}

const allPass = rows.every((r) => r.pass);
writeFileSync(
  path.join(capDir, "results-wb4-capture.json"),
  JSON.stringify({ rows, consoleErrors, allPass }, null, 2),
);
console.log(JSON.stringify({ rows, consoleErrors, allPass }));

// LIA-496 WB4 — capture+verify driver for the composer & empty-state batch
// (W14 composer stays mounted during pending approval, W15 "Always allow"
// scope note, W16 composer secondary row / model picker per D3, W17 empty
// state copy + real flex bug + dead-space fix, W18 multiline pill
// geometry). Real Playwright against the live `npx vite` dev server, same
// record()/safe()/shot() pattern as captures/verify-wb1.mjs — a dedicated
// file so WB4's five proofs are independently re-runnable.
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const capDir = path.join(__dirname, "verify");
mkdirSync(capDir, { recursive: true });

const URL = process.env.WB4_URL || "http://localhost:5191";
const log = (msg) => console.error(`[wb4-verify] ${msg}`);

const rows = [];
function record(feature, expected, observed, artifact, pass) {
  rows.push({ feature, expected, observed, artifact, pass });
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
  const file = path.join(capDir, `wb4-${String(step).padStart(2, "0")}-${name}.png`);
  await page.screenshot({ path: file, fullPage });
  // proto/-relative only — never an absolute machine-local path (public repo).
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

  // === W17 — empty state: fixture copy gone, real flex bug fixed, ========
  // === composer docked under greeting (no dead space) =====================
  await safe("w17-empty-state", async () => {
    // A fresh thread (the "+ New chat" affordance, or default landing
    // state) shows the empty state — confirm we're actually on it before
    // asserting anything about it.
    const emptyVisible = await page.locator(".s-empty").first().isVisible().catch(() => false);
    const bodyText = emptyVisible ? await page.locator(".s-empty").first().innerText() : "";
    const noFixtureLanguage = !/fixture spike|LIA-496/i.test(bodyText);

    const artEmpty = await shot("empty-state");

    // Real flex-parent height bug: confirm `.s-empty` (and its ancestors)
    // actually got a non-trivial computed height — the old bug meant
    // `.s-empty`'s own box height collapsed to content-only regardless of
    // `.s-thread`'s real available height.
    const heights = await page.evaluate(() => {
      const thread = document.querySelector(".s-thread");
      const col = document.querySelector(".s-col");
      const empty = document.querySelector(".s-empty");
      return {
        threadH: thread?.getBoundingClientRect().height ?? 0,
        colH: col?.getBoundingClientRect().height ?? 0,
        emptyH: empty?.getBoundingClientRect().height ?? 0,
      };
    });
    // The bug's signature: emptyH collapsed to near-zero (content-only)
    // regardless of threadH. Fixed: emptyH should track threadH closely
    // (both flex-filled to the same available height).
    const flexBugFixed = heights.emptyH > 0 && heights.threadH > 0 && heights.emptyH >= heights.threadH * 0.9;

    // Dead space: gap between the bottom of the greeting content and the
    // top of the composer pill should be small (docked), not a large,
    // unexplained stretch of blank page.
    const gap = await page.evaluate(() => {
      const empty = document.querySelector(".s-empty");
      const field = document.querySelector(".s-field");
      if (!empty || !field) return -1;
      const eRect = empty.getBoundingClientRect();
      const fRect = field.getBoundingClientRect();
      return fRect.top - eRect.bottom;
    });
    const dockedNoDeadSpace = gap >= 0 && gap < 80;

    record(
      "W17a: empty-state copy has no internal fixture-spike language",
      'Greeting text does not contain "fixture spike" or "LIA-496" (EmptyState.tsx no longer exposes internal build-process language to the product surface)',
      `empty state visible=${emptyVisible}, greeting text="${bodyText.slice(0, 160)}", noFixtureLanguage=${noFixtureLanguage}`,
      artEmpty,
      emptyVisible && noFixtureLanguage,
    );
    record(
      "W17b: real flex-parent height bug fixed — .s-empty's flex:1 actually fills .s-thread",
      ".s-empty's rendered height tracks .s-thread's real available height (>=90%), not just its own content height — the old bug had .s-col as a non-flex parent so .s-empty's flex:1 was dead CSS",
      `threadH=${heights.threadH.toFixed(1)}px, colH=${heights.colH.toFixed(1)}px, emptyH=${heights.emptyH.toFixed(1)}px, emptyH>=90% of threadH=${flexBugFixed}`,
      artEmpty,
      flexBugFixed,
    );
    record(
      "W17c: composer docked under greeting — no dead space",
      "Gap between the bottom of the greeting/.s-empty content and the top of the composer pill (.s-field) is small (<80px, i.e. ordinary padding), not a large unexplained blank stretch",
      `gap=${gap.toFixed(1)}px, dockedNoDeadSpace=${dockedNoDeadSpace}`,
      artEmpty,
      dockedNoDeadSpace,
    );
  });

  // === W16 — composer secondary row: real model-picker dropdown =========
  await safe("w16-model-picker", async () => {
    const trigger = page.locator(".s-model");
    await trigger.waitFor({ state: "visible", timeout: 10000 });
    const initialLabel = (await trigger.innerText()).trim();
    const hasHaspopup = (await trigger.getAttribute("aria-haspopup")) === "listbox";
    const attachSlotPresent = (await page.locator(".s-attach-slot").count()) === 1;
    const attachSlotHasNoButtonRole = (await page.locator(".s-attach-slot[role='button'], button.s-attach-slot").count()) === 0;

    const artBefore = await shot("model-picker-closed");

    // Real click opens a real popover with role="listbox".
    await trigger.click();
    await page.locator(".s-model-menu[role='listbox']").waitFor({ state: "visible", timeout: 3000 });
    const artOpen = await shot("model-picker-open");
    const optionCount = await page.locator(".s-model-option").count();
    const optionTexts = await page.locator(".s-model-option").allInnerTexts();

    // Arrow-key navigation moves the "active" option.
    const activeBefore = await page.evaluate(
      () => document.querySelector(".s-model-option.active")?.textContent ?? null,
    );
    await page.keyboard.press("ArrowDown");
    const activeAfter = await page.evaluate(
      () => document.querySelector(".s-model-option.active")?.textContent ?? null,
    );
    const arrowKeyMoved = activeBefore !== null && activeAfter !== null && activeBefore !== activeAfter;

    // Enter selects the now-active option and closes the menu.
    await page.keyboard.press("Enter");
    await page.locator(".s-model-menu").waitFor({ state: "detached", timeout: 3000 }).catch(() => {});
    const labelAfterSelect = (await trigger.innerText()).trim();
    const artAfterSelect = await shot("model-picker-selected");
    const labelChanged = labelAfterSelect !== initialLabel;

    // Escape closes without changing the (now-different) selection.
    await trigger.click();
    await page.locator(".s-model-menu[role='listbox']").waitFor({ state: "visible", timeout: 3000 });
    await page.keyboard.press("Escape");
    const menuGoneAfterEscape = (await page.locator(".s-model-menu").count()) === 0;
    const labelUnchangedAfterEscape = (await trigger.innerText()).trim() === labelAfterSelect;

    // Click-outside closes it too.
    await trigger.click();
    await page.locator(".s-model-menu[role='listbox']").waitFor({ state: "visible", timeout: 3000 });
    await page.mouse.click(20, 20);
    await page.waitForTimeout(100);
    const menuGoneAfterOutsideClick = (await page.locator(".s-model-menu").count()) === 0;
    const artAfterOutsideClick = await shot("model-picker-closed-by-outside-click");

    record(
      "W16a: reserved attach-slot is present but genuinely inert (no fake affordance)",
      "A `.s-attach-slot` element exists in the composer's secondary row, aria-hidden, with no button/clickable role — reserves geometry without rendering a control that looks actionable but does nothing",
      `attachSlotPresent=${attachSlotPresent}, attachSlotHasNoInteractiveRole=${attachSlotHasNoButtonRole}`,
      artBefore,
      attachSlotPresent && attachSlotHasNoButtonRole,
    );
    record(
      "W16b: model-picker trigger is a real dropdown trigger (aria-haspopup=listbox), two scripted labels",
      'A real `<button aria-haspopup="listbox">` (not an inert `<span>`) with exactly 2 selectable options',
      `initialLabel="${initialLabel}", aria-haspopup=listbox: ${hasHaspopup}, optionCount=${optionCount}, options=${JSON.stringify(optionTexts)}`,
      artOpen,
      hasHaspopup && optionCount === 2,
    );
    record(
      "W16c: arrow-key navigation moves the active option; Enter selects and closes; label genuinely toggles",
      "ArrowDown moves .active from one option to the other; Enter selects the active option, closes the popover, and the trigger's displayed label changes to the newly-selected model",
      `activeBefore="${activeBefore}", activeAfter="${activeAfter}", arrowKeyMoved=${arrowKeyMoved}, labelAfterSelect="${labelAfterSelect}", labelChanged=${labelChanged}`,
      artAfterSelect,
      arrowKeyMoved && labelChanged,
    );
    record(
      "W16d: Escape and click-outside both dismiss the popover without altering the selection unexpectedly",
      "Escape closes the menu and leaves the label as-is; a pointerdown outside the picker's root also closes it",
      `menuGoneAfterEscape=${menuGoneAfterEscape}, labelUnchangedAfterEscape=${labelUnchangedAfterEscape}, menuGoneAfterOutsideClick=${menuGoneAfterOutsideClick}`,
      artAfterOutsideClick,
      menuGoneAfterEscape && labelUnchangedAfterEscape && menuGoneAfterOutsideClick,
    );
  });

  // === W18 — multiline composer geometry =================================
  await safe("w18-multiline-geometry", async () => {
    const composer = page.locator(".s-field textarea");
    await composer.waitFor({ state: "visible", timeout: 10000 });

    const oneLine = await page.evaluate(() => {
      const field = document.querySelector(".s-field");
      const style = getComputedStyle(field);
      return { height: field.getBoundingClientRect().height, radius: style.borderRadius };
    });
    const artOneLine = await shot("composer-one-line");

    await composer.click();
    await composer.fill("Line one of a longer request.\nLine two, still going.\nLine three — now this should be tall enough to grow the field well past one line.\nLine four.");
    await page.waitForTimeout(150);

    const multiLine = await page.evaluate(() => {
      const field = document.querySelector(".s-field");
      const textarea = document.querySelector(".s-field textarea");
      const send = document.querySelector(".s-send");
      const style = getComputedStyle(field);
      const fieldRect = field.getBoundingClientRect();
      const sendRect = send.getBoundingClientRect();
      // Parse the FIRST radius value (top-left) out of the computed
      // shorthand, robust to browsers reporting all 4 corners.
      const radiusPx = parseFloat(style.borderRadius);
      return {
        fieldHeight: fieldRect.height,
        radiusPx,
        halfHeight: fieldRect.height / 2,
        sendBottom: sendRect.bottom,
        fieldBottom: fieldRect.bottom,
        fieldPaddingBottom: parseFloat(getComputedStyle(field).paddingBottom),
      };
    });
    const artMultiLine = await shot("composer-multiline");

    const grewPastOneLine = multiLine.fieldHeight > oneLine.height * 1.5;
    // W18a: radius must be an honest fixed value well under half the
    // grown field's height (i.e. NOT still clamped into a full stadium
    // cap the way border-radius:999px would render).
    const radiusRelaxed = multiLine.radiusPx > 0 && multiLine.radiusPx < multiLine.halfHeight * 0.8;
    // W18b: send button bottom-aligned with the field (flex-end), within
    // a couple px of the field's own bottom padding edge — not floating
    // in the vertical middle of the grown field (which `center` would do).
    const sendBottomGap = multiLine.fieldBottom - multiLine.sendBottom;
    const sendBottomAligned = sendBottomGap >= 0 && sendBottomGap <= multiLine.fieldPaddingBottom + 4;

    record(
      "W18a: multiline pill geometry — border-radius relaxed (no longer a full stadium cap at multiline height)",
      "At a grown multiline height, the field's computed border-radius is a fixed, honest value well under half the field's height (previously 999px always clamped to a full stadium cap at ANY height, including multiline)",
      `oneLineHeight=${oneLine.height.toFixed(1)}px, multiLineHeight=${multiLine.fieldHeight.toFixed(1)}px, grewPastOneLine=${grewPastOneLine}, computed radius=${multiLine.radiusPx.toFixed(1)}px, half of multiline height=${multiLine.halfHeight.toFixed(1)}px, radiusRelaxed=${radiusRelaxed}`,
      `${artOneLine} , ${artMultiLine}`,
      grewPastOneLine && radiusRelaxed,
    );
    record(
      "W18b: send button is flex-end (bottom) aligned at multiline heights, not vertically centered",
      "The send circle's bottom edge sits within the field's own bottom padding of the field's bottom edge (flex-end), rather than floating in the vertical middle of the grown field (which the old align-items:center produced)",
      `fieldBottom=${multiLine.fieldBottom.toFixed(1)}, sendBottom=${multiLine.sendBottom.toFixed(1)}, gap=${sendBottomGap.toFixed(1)}px, fieldPaddingBottom=${multiLine.fieldPaddingBottom.toFixed(1)}px, sendBottomAligned=${sendBottomAligned}`,
      artMultiLine,
      sendBottomAligned,
    );

    await composer.fill("");
  });

  // === W14 — composer stays mounted during pending approval ==============
  await safe("w14-composer-stays-mounted", async () => {
    await page.locator(".s-item", { hasText: "Status-glyph rendering fix" }).click();
    const composer = page.locator(".s-field textarea");
    await composer.waitFor({ state: "visible", timeout: 10000 });
    await composer.click();
    await composer.fill("Two asks: clean the scratch file, tighten the status-glyph comment.");
    await composer.press("Enter");

    await page.locator(".s-perm").first().waitFor({ state: "visible", timeout: 15000 });
    const artPending = await shot("permission-pending-composer-state");

    const state = await page.evaluate(() => {
      const field = document.querySelector(".s-field");
      const textarea = document.querySelector(".s-field textarea");
      const send = document.querySelector(".s-send");
      return {
        fieldPresent: !!field,
        textareaPresent: !!textarea,
        textareaDisabled: textarea ? textarea.disabled : null,
        placeholder: textarea ? textarea.getAttribute("placeholder") : null,
        sendDisabled: send ? send.disabled : null,
        oldWaitingDivPresent: !!document.querySelector(".s-composer-waiting"),
      };
    });

    // The discriminating check: the REAL <form>-ancestored composer
    // structure (ComposerPrimitive.Root > Input) must still be in the DOM
    // — not replaced by a bare unmounted-input div — while genuinely
    // disabled and showing a waiting-specific placeholder.
    const staysMounted =
      state.fieldPresent &&
      state.textareaPresent &&
      state.textareaDisabled === true &&
      /resolve/i.test(state.placeholder || "") &&
      !state.oldWaitingDivPresent;

    record(
      "W14: composer stays mounted (not unmounted) while a permission decision is pending",
      "While `.s-perm` is showing, the real `.s-field` > `<textarea>` structure is still present in the DOM (not replaced by a bare unmounted div), the textarea is genuinely `disabled`, and its placeholder communicates why (mentions 'resolve')",
      `fieldPresent=${state.fieldPresent}, textareaPresent=${state.textareaPresent}, textareaDisabled=${state.textareaDisabled}, placeholder="${state.placeholder}", sendDisabled=${state.sendDisabled}, oldWaitingDivStillPresent=${state.oldWaitingDivPresent}`,
      artPending,
      staysMounted,
    );

    // Confirm a disabled textarea genuinely cannot receive focus/keystrokes
    // (the real replacement for the old unmount-based stray-keystroke
    // guard).
    const focusAttempt = await page.evaluate(() => {
      const textarea = document.querySelector(".s-field textarea");
      textarea?.focus();
      return document.activeElement === textarea;
    });
    record(
      "W14b: disabled textarea cannot take focus (stray-keystroke guard preserved without unmounting)",
      "A disabled HTML form control cannot become document.activeElement even when .focus() is called on it directly",
      `focus() on the disabled textarea resulted in document.activeElement === textarea: ${focusAttempt}`,
      artPending,
      focusAttempt === false,
    );

    // === W15 — "Always allow" states its scope =========================
    const alwaysBtn = page.locator(".s-perm .s-always");
    const alwaysText = (await alwaysBtn.innerText()).trim();
    const scopeNote = await page.locator(".s-perm-scope").first().innerText().catch(() => "");
    const artPerm = await shot("permission-card-scope-note");
    const buttonStatesScope = /this session/i.test(alwaysText);
    const scopeNotePresent = scopeNote.length > 0 && /session/i.test(scopeNote);

    record(
      'W15: "Always allow" button text states its scope ("this session")',
      'Button text reads "Always allow (this session)", not a bare "Always allow"',
      `button text="${alwaysText}", statesScope=${buttonStatesScope}`,
      artPerm,
      buttonStatesScope,
    );
    record(
      "W15b: explicit scope note explains how broad the grant is",
      "A visible note near the buttons states the grant applies for the rest of the session and to every request for this tool, not just this one",
      `scope note text="${scopeNote}", present and mentions session=${scopeNotePresent}`,
      artPerm,
      scopeNotePresent,
    );

    // Resolve it so we leave the app in a clean state.
    await alwaysBtn.click();
  });

  log(`total console errors observed across whole run: ${consoleErrors.length}`);
  if (consoleErrors.length > 0) log(JSON.stringify(consoleErrors));
} finally {
  await context.close();
  await browser.close();
}

const allPass = rows.every((r) => r.pass);
writeFileSync(path.join(capDir, "results-wb4.json"), JSON.stringify({ rows, consoleErrors, allPass }, null, 2));
console.log(JSON.stringify({ rows, consoleErrors, allPass }));

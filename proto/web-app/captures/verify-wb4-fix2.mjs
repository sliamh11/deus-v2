// LIA-496 WB4 review-fix (round 2) — RE-VERIFICATION driver for the low/
// advisory ModelPicker.tsx finding from the WB4 code-review REVISE round:
//
//   The listbox conveyed the arrow-key-active option only via a visual
//   `.active` CSS class — no `aria-activedescendant` on the focused
//   `role="listbox"` element, and the `role="option"` divs are not
//   themselves focusable, so assistive technology could not track keyboard
//   navigation between options.
//
//   Fixed by giving each option a stable id (via React's `useId`, collision
//   -safe if more than one ModelPicker instance ever mounts) and setting
//   `aria-activedescendant` on the listbox to the active option's id,
//   updated on every ArrowUp/ArrowDown — the standard WAI-ARIA pattern for
//   a roving-focus-free listbox where DOM focus stays on the listbox
//   container itself (this component already keeps focus on
//   `.s-model-menu`, never moving it onto the option divs).
//
// Same record()/safe()/shot() pattern as verify-wb4-fix.mjs, own results
// file and screenshot prefix so nothing here overwrites prior stages'
// artifacts.
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const capDir = path.join(__dirname, "verify");
mkdirSync(capDir, { recursive: true });

const URL = process.env.WB4_FIX2_URL || "http://localhost:5187";
const log = (msg) => console.error(`[wb4-fix2] ${msg}`);

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
  const file = path.join(capDir, `fix2-wb4-${String(step).padStart(2, "0")}-${name}.png`);
  await page.screenshot({ path: file, fullPage });
  const relFile = path.relative(path.join(__dirname, "..", ".."), file);
  log(`screenshot: ${relFile}`);
  return relFile;
}

try {
  await safe("model-picker-aria-activedescendant-tracks-arrow-keys", async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    page.on("pageerror", (err) => consoleErrors.push(`pageerror: ${err.message}`));

    await page.goto(URL, { waitUntil: "networkidle" });
    await page.locator(".s-item", { hasText: "Composer keyboard shortcuts" }).click();

    const trigger = page.locator(".s-model");
    await trigger.waitFor({ state: "visible", timeout: 10000 });
    await trigger.focus();
    await page.keyboard.press("Enter"); // opens per onTriggerKeyDown
    await page.locator(".s-model-menu[role='listbox']").waitFor({ state: "visible", timeout: 3000 });
    const artOpen = await shot(page, "model-picker-open-keyboard");

    // Before any arrow press: activedescendant must already point at the
    // currently-active (pre-selected) option, not be absent/empty.
    const stateBeforeArrow = await page.evaluate(() => {
      const menu = document.querySelector(".s-model-menu[role='listbox']");
      const activeOption = document.querySelector(".s-model-option.active");
      const activedescId = menu ? menu.getAttribute("aria-activedescendant") : null;
      const resolvedEl = activedescId ? document.getElementById(activedescId) : null;
      return {
        menuHasAttr: !!activedescId,
        activedescId,
        activeOptionId: activeOption ? activeOption.id : null,
        resolvedMatchesActiveOption: !!resolvedEl && resolvedEl === activeOption,
        resolvedText: resolvedEl ? resolvedEl.textContent : null,
      };
    });

    await page.keyboard.press("ArrowDown");
    const artAfterArrow = await shot(page, "model-picker-after-arrowdown");

    // After ArrowDown: activedescendant must now resolve to the NEW active
    // option (the one that just got the `.active` class), proving the
    // attribute tracks keyboard navigation live rather than being a static
    // value set once at open time.
    const stateAfterArrow = await page.evaluate(() => {
      const menu = document.querySelector(".s-model-menu[role='listbox']");
      const activeOption = document.querySelector(".s-model-option.active");
      const activedescId = menu ? menu.getAttribute("aria-activedescendant") : null;
      const resolvedEl = activedescId ? document.getElementById(activedescId) : null;
      // role="option" divs must remain intentionally non-focusable (DOM
      // focus stays on the listbox per the roving-activedescendant
      // pattern) — confirm no option itself is document.activeElement.
      const anyOptionIsDomFocused = Array.from(document.querySelectorAll(".s-model-option")).some(
        (el) => el === document.activeElement,
      );
      const listboxIsDomFocused = document.activeElement === menu;
      return {
        activedescId,
        activeOptionId: activeOption ? activeOption.id : null,
        resolvedMatchesActiveOption: !!resolvedEl && resolvedEl === activeOption,
        resolvedText: resolvedEl ? resolvedEl.textContent : null,
        anyOptionIsDomFocused,
        listboxIsDomFocused,
      };
    });

    const idsAreDistinctAcrossArrowPress = stateBeforeArrow.activedescId !== stateAfterArrow.activedescId;

    record(
      "ModelPicker listbox exposes aria-activedescendant tracking the arrow-key-active option (was: only a visual .active CSS class, no AT-visible signal)",
      "Immediately after opening via keyboard, aria-activedescendant on the role=listbox resolves (via id lookup) to the same element carrying the visual .active class; after ArrowDown moves the visual active option, aria-activedescendant updates to a different id that again resolves to the new .active element; DOM focus stays on the listbox itself (not moved onto an option div), matching the roving-activedescendant ARIA pattern this component already implements for keyboard handling",
      `before: menuHasAttr=${stateBeforeArrow.menuHasAttr}, activedescId="${stateBeforeArrow.activedescId}", resolvedMatchesActiveOption=${stateBeforeArrow.resolvedMatchesActiveOption}, resolvedText="${stateBeforeArrow.resolvedText}" | after ArrowDown: activedescId="${stateAfterArrow.activedescId}", resolvedMatchesActiveOption=${stateAfterArrow.resolvedMatchesActiveOption}, resolvedText="${stateAfterArrow.resolvedText}", idsAreDistinctAcrossArrowPress=${idsAreDistinctAcrossArrowPress}, anyOptionIsDomFocused=${stateAfterArrow.anyOptionIsDomFocused}, listboxIsDomFocused=${stateAfterArrow.listboxIsDomFocused}`,
      artOpen,
      stateBeforeArrow.menuHasAttr &&
        stateBeforeArrow.resolvedMatchesActiveOption &&
        stateAfterArrow.resolvedMatchesActiveOption &&
        idsAreDistinctAcrossArrowPress &&
        !stateAfterArrow.anyOptionIsDomFocused &&
        stateAfterArrow.listboxIsDomFocused,
    );
    log(`also captured: ${artAfterArrow}`);

    await page.keyboard.press("Escape");
    await context.close();
  });

  log(`total console errors observed across whole run: ${consoleErrors.length}`);
  if (consoleErrors.length > 0) log(JSON.stringify(consoleErrors));
} finally {
  await browser.close();
}

const allPass = rows.every((r) => r.pass);
writeFileSync(
  path.join(capDir, "results-wb4-fix2.json"),
  JSON.stringify({ rows, consoleErrors, allPass }, null, 2),
);
if (!allPass) process.exitCode = 1;

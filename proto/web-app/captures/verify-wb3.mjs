// LIA-496 WB3 — capture+verify driver for message affordances (W10
// edit-to-branch + copy on user messages, W11 branch-arrow aria-labels,
// W12 collapsed-by-default reasoning disclosure, W13 collapsed-row+chevron
// tool-output/diff disclosure). Real Playwright against the live
// `npx vite --port 5191` dev server. Pattern ported from
// captures/verify-wb1.mjs (same record()/safe()/shot() helpers, same
// repo-relative artifact-path discipline).
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const capDir = path.join(__dirname, "verify");
mkdirSync(capDir, { recursive: true });

const URL = "http://localhost:5193";
const log = (msg) => console.error(`[wb3-verify] ${msg}`);

const rows = [];
function record(feature, expected, observed, artifact, pass) {
  rows.push({ feature, expected, observed, artifact, pass });
  log(`${pass ? "PASS" : "FAIL"}: ${feature}`);
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1280, height: 900 },
  permissions: ["clipboard-read", "clipboard-write"],
});
const page = await context.newPage();

const consoleErrors = [];
page.on("console", (msg) => {
  if (msg.type() === "error") consoleErrors.push(msg.text());
});
page.on("pageerror", (err) => consoleErrors.push(`pageerror: ${err.message}`));

let step = 0;
async function shot(name, fullPage = false) {
  step += 1;
  const file = path.join(capDir, `wb3-${String(step).padStart(2, "0")}-${name}.png`);
  await page.screenshot({ path: file, fullPage });
  // Repo-relative only — proto/ is a public repo (sliamh11/deus-v2), never
  // an absolute machine-local filesystem path in the recorded artifact.
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

  // Open the same seeded thread WB1/S3 already use — its turn1 conversation
  // (fixtures/conversations.ts turn1Start) has reasoning + a Bash tool call
  // + a delete_file permission + (after approval) an Edit diff, i.e. every
  // surface this batch touches, in one real streamed turn.
  await page.locator(".s-item", { hasText: "Status-glyph rendering fix" }).click();
  const composer = page.locator(".s-field textarea");
  await composer.waitFor({ state: "visible", timeout: 10000 });

  const ORIGINAL_TEXT = "Two asks: clean the scratch file, tighten the status-glyph comment.";
  await composer.click();
  await composer.fill(ORIGINAL_TEXT);
  await composer.press("Enter");

  // Wait for the permission card (turn1Start's real stopping point before
  // any continuation) so reasoning + the Bash tool call have both fully
  // streamed and settled.
  await page.locator(".s-perm").first().waitFor({ state: "visible", timeout: 15000 });

  // === PROOF 1 — W12 reasoning collapsed by default =======================
  await safe("W12-reasoning-collapsed-by-default", async () => {
    const toggle = page.locator(".s-reasoning-toggle").first();
    await toggle.waitFor({ state: "visible", timeout: 5000 });
    const bodyCountCollapsed = await page.locator(".s-reasoning").count();
    const ariaExpandedCollapsed = await toggle.getAttribute("aria-expanded");
    const artCollapsed = await shot("reasoning-collapsed");
    await toggle.click();
    const bodyLocator = page.locator(".s-reasoning").first();
    await bodyLocator.waitFor({ state: "visible", timeout: 3000 });
    const bodyText = await bodyLocator.innerText();
    const ariaExpandedOpen = await toggle.getAttribute("aria-expanded");
    const artExpanded = await shot("reasoning-expanded");
    record(
      "W12 — reasoning is a labelled, collapsed-by-default disclosure",
      "no .s-reasoning body in the DOM before the toggle is clicked (aria-expanded=false), a real .s-reasoning body with the actual reasoning text appears after clicking the toggle (aria-expanded=true)",
      `bodyCount before click=${bodyCountCollapsed}, aria-expanded before=${ariaExpandedCollapsed}, aria-expanded after=${ariaExpandedOpen}, revealed text length=${bodyText.length} chars ("${bodyText.slice(0, 40)}...")`,
      `${artCollapsed} , ${artExpanded}`,
      bodyCountCollapsed === 0 && ariaExpandedCollapsed === "false" && ariaExpandedOpen === "true" && bodyText.length > 20,
    );
  });

  // === PROOF 2 — W13 raw tool output collapsed row + chevron ==============
  await safe("W13-toolline-collapsed-row-chevron", async () => {
    const toggle = page.locator(".s-toolline").first();
    await toggle.waitFor({ state: "visible", timeout: 5000 });
    const bodyCountCollapsed = await page.locator(".s-toolline-body").count();
    const ariaExpandedCollapsed = await toggle.getAttribute("aria-expanded");
    const previewText = await page.locator(".s-toolline-preview").first().innerText();
    const artCollapsed = await shot("toolline-collapsed");
    await toggle.click();
    const bodyLocator = page.locator(".s-toolline-body").first();
    await bodyLocator.waitFor({ state: "visible", timeout: 3000 });
    const bodyText = await bodyLocator.innerText();
    const artExpanded = await shot("toolline-expanded");
    // Whitespace-insensitive compare: the collapsed preview is a `<span>`
    // (normal inline text flow collapses runs of whitespace) while the
    // expanded body is a `<pre>` (preserves the raw command output's
    // literal spacing) — same underlying `output` string in both (see
    // Thread.tsx's `GenericToolLine`), rendered through two different HTML
    // elements. A byte-exact compare would be testing HTML whitespace
    // normalization, not this feature.
    const sameContent = bodyText.replace(/\s+/g, " ").trim() === previewText.replace(/\s+/g, " ").trim();
    record(
      "W13 — raw Bash tool output is a collapsed-by-default row with a chevron, not an unconditional dump",
      "no .s-toolline-body in the DOM before the chevron is clicked (aria-expanded=false), the full raw command output appears in a .s-toolline-body pre block after clicking",
      `bodyCount before click=${bodyCountCollapsed}, aria-expanded before=${ariaExpandedCollapsed}, preview text="${previewText}", expanded body text="${bodyText}", same content modulo whitespace=${sameContent}`,
      `${artCollapsed} , ${artExpanded}`,
      bodyCountCollapsed === 0 && ariaExpandedCollapsed === "false" && bodyText.length > 0 && sameContent,
    );
  });

  // Resolve the pending permission ("Always allow") so the Edit diff turn
  // continuation runs and DiffPanel actually mounts.
  await safe("resolve-permission-for-diff", async () => {
    await page.locator(".s-always").first().click();
    await page.locator(".s-code").first().waitFor({ state: "visible", timeout: 10000 });
  });

  // === PROOF 3 — W13 diff card: expanded-by-default, collapsible, copy ====
  await safe("W13-diffpanel-collapse-and-copy", async () => {
    const codeCard = page.locator(".s-code").first();
    await codeCard.waitFor({ state: "visible", timeout: 5000 });
    const toggle = codeCard.locator(".s-code-h-toggle").first();
    const preLocator = codeCard.locator("pre").first();
    const expandedByDefault = await preLocator.isVisible();
    const ariaExpandedDefault = await toggle.getAttribute("aria-expanded");
    const artExpandedDefault = await shot("diff-expanded-by-default");

    await toggle.click();
    await preLocator.waitFor({ state: "hidden", timeout: 3000 });
    const ariaExpandedAfterCollapse = await toggle.getAttribute("aria-expanded");
    const artCollapsed = await shot("diff-collapsed");

    await toggle.click();
    await preLocator.waitFor({ state: "visible", timeout: 3000 });
    const artReExpanded = await shot("diff-re-expanded");

    const copyBtn = codeCard.locator(".s-diff-copy").first();
    const copyLabelBefore = await copyBtn.innerText();
    await copyBtn.click();
    await page.waitForFunction(
      () => document.querySelector(".s-diff-copy")?.textContent === "Copied",
      { timeout: 3000 },
    );
    const copyLabelAfter = await copyBtn.innerText();
    const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
    const artCopied = await shot("diff-copied");

    record(
      "W13 — diff card is expanded by default (it IS the point of an Edit tool call), collapsible via the same chevron family, and has a real clipboard copy button",
      "diff body (.s-code pre) visible on first render with aria-expanded=true; clicking the header toggle hides it (aria-expanded=false) then re-clicking restores it; clicking Copy writes the real diff text to the clipboard and the button label flips to \"Copied\"",
      `expanded by default=${expandedByDefault} (aria-expanded=${ariaExpandedDefault}), after collapse click aria-expanded=${ariaExpandedAfterCollapse}, re-expanded ok, copy label before="${copyLabelBefore}" after="${copyLabelAfter}", clipboard contains diff markers (--- / +++)=${clipboardText.includes("---") && clipboardText.includes("+++")}`,
      `${artExpandedDefault} , ${artCollapsed} , ${artReExpanded} , ${artCopied}`,
      expandedByDefault &&
        ariaExpandedDefault === "true" &&
        ariaExpandedAfterCollapse === "false" &&
        copyLabelAfter === "Copied" &&
        clipboardText.includes("---") &&
        clipboardText.includes("+++"),
    );
  });

  // === PROOF 4 — W10 hover pencil -> real edit-to-branch flow =============
  await safe("W10-hover-actions-and-edit-to-branch", async () => {
    const userMsg = page.locator(".s-user").first();
    await userMsg.waitFor({ state: "visible", timeout: 5000 });
    await userMsg.hover();
    const editBtn = userMsg.locator('button[aria-label="Edit message"]');
    const copyBtn = userMsg.locator('button[aria-label="Copy message"]');
    await editBtn.waitFor({ state: "visible", timeout: 3000 });
    const artHover = await shot("user-message-hover-actions");

    // Copy first — independent of the edit flow below, and needs the
    // message still in its normal (non-editing) render.
    await copyBtn.click();
    await page.waitForFunction(
      () => document.querySelector('button[aria-label="Copy message"]')?.textContent === "Copied",
      { timeout: 3000 },
    );
    const copiedClipboard = await page.evaluate(() => navigator.clipboard.readText());
    const copyWorked = copiedClipboard === ORIGINAL_TEXT;

    await editBtn.click();
    const editInput = page.locator(".s-edit-input").first();
    await editInput.waitFor({ state: "visible", timeout: 3000 });
    const prefilled = await editInput.inputValue();
    const artEditOpen = await shot("user-message-edit-open");

    const EDITED_TEXT = "Two asks here: clean up a stale scratch file, and tighten the status-glyph comment (edited).";
    await editInput.fill(EDITED_TEXT);
    await page.locator(".s-edit-actions .s-btn.go").click();

    // A real new sibling branch was created — the branch picker on this
    // (now-edited) message should read "2 / 2".
    const branchPicker = page.locator(".s-branchpicker").first();
    await branchPicker.waitFor({ state: "visible", timeout: 5000 });
    const branchText = await branchPicker.innerText();
    const artBranched = await shot("user-message-branch-2-of-2");

    // Composer should have swapped back out of edit mode entirely.
    const editFieldGoneCount = await page.locator(".s-edit-field").count();

    record(
      "W10 — hover pencil genuinely calls composer.beginEdit() (pre-fills the real message text) and Save creates a real, navigable sibling branch",
      'hover reveals a real "Edit message" + "Copy message" button pair; Copy writes the message\'s actual text to the clipboard; Edit swaps the message to a pre-filled ComposerPrimitive edit field (not empty, not a placeholder); Save exits edit mode and the branch picker reads "2 / 2"',
      `copy worked=${copyWorked}, edit field pre-filled with original text=${prefilled === ORIGINAL_TEXT} (got "${prefilled}"), edit field gone after save=${editFieldGoneCount === 0}, branch picker text="${branchText.replace(/\s+/g, " ").trim()}"`,
      `${artHover} , ${artEditOpen} , ${artBranched}`,
      copyWorked && prefilled === ORIGINAL_TEXT && editFieldGoneCount === 0 && /2\s*\/\s*2/.test(branchText),
    );
  });

  // === PROOF 5 — W11 branch-arrow accessible names =========================
  await safe("W11-branch-arrow-aria-labels", async () => {
    const branchPicker = page.locator(".s-branchpicker").first();
    await branchPicker.waitFor({ state: "visible", timeout: 5000 });
    const prevLabel = await branchPicker.locator("button").nth(0).getAttribute("aria-label");
    const nextLabel = await branchPicker.locator("button").nth(1).getAttribute("aria-label");
    // Real ARIA-snapshot check (Playwright's modern `locator.ariaSnapshot`,
    // not the removed `page.accessibility.snapshot` API), confirming the
    // label actually reaches the accessible-name computation an assistive
    // technology reads, not just that the attribute is present in markup.
    const ariaSnapshot = await branchPicker.ariaSnapshot();
    const prevNamedInTree = /previous branch/i.test(ariaSnapshot);
    const nextNamedInTree = /next branch/i.test(ariaSnapshot);
    record(
      "W11 — branch prev/next controls have a real accessible name, not just a bare glyph",
      'Previous button aria-label="Previous branch", Next button aria-label="Next branch", both present in the accessible-name computation (ARIA snapshot)',
      `prev aria-label="${prevLabel}", next aria-label="${nextLabel}", ariaSnapshot contains "Previous branch"=${prevNamedInTree}, contains "Next branch"=${nextNamedInTree}`,
      "(no new artifact — same branch picker as the W10 proof's final screenshot)",
      prevLabel === "Previous branch" && nextLabel === "Next branch" && prevNamedInTree && nextNamedInTree,
    );
  });

  // === PROOF 6 — W10 keyboard-only accessibility (code-review REVISE fix) =
  // `.s-user-actions` used to be `display:none` with a `:focus-within`
  // reveal — a `display:none` element's descendants are pulled out of the
  // tab order entirely, so `:focus-within` could never actually match and
  // keyboard-only users had no way to reach Edit/Copy at all (code-review
  // finding, LIA-496 WB3 REVISE round). Fixed to an opacity/pointer-events
  // toggle (theme.css) that keeps the buttons real, always-present tab
  // stops. This proof exercises the ACTUAL keyboard path — no mouse, no
  // `.focus()` shortcut, real `Tab` key presses — to confirm the button is
  // both reachable and becomes visible once focused, not just that the CSS
  // "looks" reveal-ish in source.
  await safe("W10-keyboard-only-focus-reveal", async () => {
    // Move the mouse fully away and blur whatever has focus, so nothing is
    // hover- or focus-revealed before the keyboard-only walk starts. Wait
    // out the CSS transition so the settled (not mid-animation) value is
    // what gets asserted below.
    await page.mouse.move(0, 0);
    await page.evaluate(() => document.activeElement && document.activeElement.blur());
    await page.waitForTimeout(200);

    const userMsg = page.locator(".s-user").first();
    await userMsg.waitFor({ state: "visible", timeout: 5000 });
    const editBtn = userMsg.locator('button[aria-label="Edit message"]');
    // `opacity` is not an inherited CSS property — querying it on the
    // button itself would always read back its own default (1) regardless
    // of the parent's state. The actual toggle target is `.s-user-actions`
    // (theme.css), so that's what has to be asserted on to mean anything.
    const actionsRow = userMsg.locator(".s-user-actions");

    // Confirm it genuinely starts hidden before any focus arrives —
    // otherwise this proof would trivially pass even with the old bug.
    const opacityBeforeFocus = await actionsRow.evaluate((el) => getComputedStyle(el).opacity);

    // Real keyboard navigation: repeatedly press Tab until the Edit button
    // itself receives focus, exactly like a keyboard-only user tabbing
    // through the page — bounded so a regression fails loudly instead of
    // hanging.
    let reached = false;
    for (let i = 0; i < 40; i += 1) {
      await page.keyboard.press("Tab");
      // eslint-disable-next-line no-await-in-loop
      const isFocused = await editBtn.evaluate((el) => el === document.activeElement);
      if (isFocused) {
        reached = true;
        break;
      }
    }
    await page.waitForTimeout(200);
    const opacityWhileFocused = reached ? await actionsRow.evaluate((el) => getComputedStyle(el).opacity) : null;
    const artKeyboard = await shot("user-message-keyboard-focus-actions");

    record(
      "W10 (REVISE fix) — Edit/Copy row is a real, reachable Tab stop and becomes visible on keyboard focus, not display:none-locked-out",
      "`.s-user-actions` is opacity:0 (visually hidden) before any focus, its Edit button is reachable via real Tab key presses (no .focus() shortcut), and the row is opacity:1 (visible) the instant that focus lands inside it",
      `row opacity before focus="${opacityBeforeFocus}", reached edit button via Tab=${reached}, row opacity while focused="${opacityWhileFocused}"`,
      artKeyboard,
      opacityBeforeFocus === "0" && reached && opacityWhileFocused === "1",
    );
  });

  log(`consoleErrors during run: ${consoleErrors.length}`);
  if (consoleErrors.length > 0) {
    for (const e of consoleErrors) log(`  console error: ${e}`);
  }
} catch (err) {
  log(`FATAL: ${err && err.stack ? err.stack : err}`);
  record("fatal", "(script completed)", `FATAL EXCEPTION: ${err && err.message ? err.message : String(err)}`, "(none)", false);
} finally {
  const resultsFile = path.join(capDir, "results-wb3.json");
  writeFileSync(resultsFile, JSON.stringify({ rows, consoleErrors }, null, 2));
  log(`wrote ${path.relative(path.join(__dirname, "..", ".."), resultsFile)}`);
  await browser.close();
}

const failed = rows.filter((r) => !r.pass);
log(`\n${rows.length - failed.length}/${rows.length} proofs PASS`);
if (failed.length > 0) {
  log(`FAILED: ${failed.map((r) => r.feature).join(", ")}`);
  process.exitCode = 1;
}

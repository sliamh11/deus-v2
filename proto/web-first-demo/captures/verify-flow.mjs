// LIA-495 CAPTURE stage verification script — drives the REAL app via
// Playwright (real Chromium, real page.fill()/page.click(), real DOM
// state), not just static HTML. Re-verifies the Composer.tsx
// ComposerPrimitive.Root fix actually makes Enter-to-submit work, then
// drives the rest of the scripted flow (tool call -> permission prompt ->
// diff -> footer update).
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const capDir = path.join(__dirname, "verify");
mkdirSync(capDir, { recursive: true });

const URL = "http://localhost:5183";
const log = (msg) => console.log(`[verify] ${msg}`);

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1280, height: 900 },
  recordVideo: { dir: path.join(capDir, "video"), size: { width: 1280, height: 900 } },
});
const page = await context.newPage();

const consoleErrors = [];
page.on("console", (msg) => {
  if (msg.type() === "error") consoleErrors.push(msg.text());
});
page.on("pageerror", (err) => consoleErrors.push(`pageerror: ${err.message}`));

let step = 0;
async function shot(name) {
  step += 1;
  const file = path.join(capDir, `${String(step).padStart(2, "0")}-${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  log(`screenshot: ${file}`);
  return file;
}

try {
  log(`navigating to ${URL}`);
  await page.goto(URL, { waitUntil: "networkidle" });
  await shot("initial-load");

  // Locate the real composer textarea (ComposerPrimitive.Input renders a
  // <textarea name="input"> inside the ComposerPrimitive.Root <form>). A
  // second, hidden, aria-hidden shadow <textarea> exists for auto-resize
  // measurement -- excluded by targeting name="input" specifically.
  const composer = page.locator('textarea[name="input"]');
  await composer.waitFor({ state: "visible", timeout: 10000 });
  const formAncestor = await page.evaluate(() => {
    const ta = document.querySelector('textarea[name="input"]');
    return ta ? ta.closest("form") !== null : false;
  });
  if (!formAncestor) {
    throw new Error(
      "FAIL: textarea has no <form> ancestor — ComposerPrimitive.Root fix is NOT actually applying at runtime",
    );
  }
  log("confirmed: textarea IS inside a <form> element (ComposerPrimitive.Root fix verified in the live DOM)");

  const messageText = "Clean up that stale scratch log in /tmp, then tighten the status-glyph comment.";
  await composer.click();
  await composer.fill(messageText);
  await shot("typed-message");

  const filledValue = await composer.inputValue();
  if (filledValue !== messageText) {
    throw new Error(`FAIL: composer did not accept typed text (got: "${filledValue}")`);
  }

  // Real Enter keypress, exactly like a human user submitting.
  await composer.press("Enter");
  log("pressed Enter on the real composer input");

  // Confirm the message actually left the composer (submitOnEnter fired,
  // requestSubmit() found the <form>, thread runtime cleared the input) --
  // this is the exact failure mode from the RETRY NOTE: previously Enter
  // was a silent no-op and the text stayed in the box.
  await page.waitForFunction(
    () => {
      const ta = document.querySelector('textarea[name="input"]');
      return ta && ta.value === "";
    },
    { timeout: 5000 },
  );
  log("confirmed: composer cleared after Enter (submit fired, was NOT a silent no-op)");

  // Confirm the user message actually landed in the transcript.
  await page.waitForFunction(
    (text) => document.body.innerText.includes(text),
    messageText,
    { timeout: 5000 },
  );
  log("confirmed: typed message text appears in the transcript DOM");
  await shot("message-submitted");

  // Wait for the first tool-call bullet (Bash check-scratch call) to render.
  await page.waitForFunction(
    () => document.body.innerText.includes("Bash("),
    { timeout: 10000 },
  );
  log("confirmed: Bash(...) tool-call bullet appeared in transcript");
  await shot("tool-call-appeared");

  // Wait for the permission prompt to appear.
  await page.waitForFunction(
    () => document.body.innerText.includes("Permission required"),
    { timeout: 15000 },
  );
  log("confirmed: 'Permission required' prompt appeared");
  await shot("permission-prompt");

  // Click the real "Allow once" button.
  const allowOnceBtn = page.getByRole("button", { name: /Allow once/i });
  await allowOnceBtn.waitFor({ state: "visible", timeout: 5000 });
  await allowOnceBtn.click();
  log("clicked 'Allow once' button");

  // Confirm the permission prompt resolved (turns into the ResolvedRow with
  // "deleted" outcome text, "Permission required" heading disappears).
  await page.waitForFunction(
    () => !document.body.innerText.includes("Permission required"),
    { timeout: 5000 },
  );
  log("confirmed: permission prompt resolved (heading removed, ResolvedRow rendered)");
  await shot("permission-resolved");

  // Wait for the diff panel to render (Edit tool call + diff content). The
  // "Proposed changes — not applied" label only renders when status !==
  // "success" (see DiffPanel.tsx); this fixture's Edit result comes back
  // isError:false, so status IS "success" and that label is intentionally
  // absent. Assert on the diff hunk header + additions/deletions counts
  // instead, which always render regardless of status.
  await page.waitForFunction(
    () => document.body.innerText.includes("@@") && document.body.innerText.includes("+3") && document.body.innerText.includes("-3"),
    { timeout: 15000 },
  );
  log("confirmed: diff panel rendered (path, +3/-3 counts, unified-diff hunk content)");
  await shot("diff-rendered");

  // Confirm the footer task tracker updated (at least 1/3 done after the
  // delete task resolves; final state should reach further as turn1Continue
  // completes).
  await page.waitForFunction(
    () => {
      const el = [...document.querySelectorAll("div")].find((d) => /\d\/3 done/.test(d.textContent || ""));
      return el && el.textContent && !el.textContent.startsWith("0/3");
    },
    { timeout: 15000 },
  );
  const footerText = await page.evaluate(() => {
    const el = [...document.querySelectorAll("div")].find((d) => /\d\/3 done/.test(d.textContent || ""));
    return el ? el.textContent : null;
  });
  log(`confirmed: footer task tracker updated -> "${footerText}"`);
  await shot("footer-updated");

  // Let the streamed closing text finish so the final screenshot is settled.
  await page.waitForTimeout(1500);
  await shot("final-settled");

  log(`console errors observed: ${consoleErrors.length}`);
  if (consoleErrors.length > 0) {
    log(`console error details: ${JSON.stringify(consoleErrors, null, 2)}`);
  }

  log("ALL STEPS PASSED");
} catch (err) {
  log(`FAILURE: ${err.message}`);
  await shot("failure-state");
  await context.close();
  await browser.close();
  process.exit(1);
}

await context.close();
await browser.close();
log("done");

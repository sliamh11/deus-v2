// LIA-495 CAPTURE stage — real Playwright automation against the real
// running dev server. No static HTML, no mocked DOM: this launches headless
// Chromium, navigates to http://localhost:5173, and drives the actual
// assistant-ui React app via page.fill()/page.click()/page.waitForSelector().
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const capturesDir = __dirname;
const videoDir = join(capturesDir, "video");
mkdirSync(videoDir, { recursive: true });

const APP_URL = "http://localhost:5173/";

async function shot(page, name) {
  const path = join(capturesDir, `${name}.png`);
  await page.screenshot({ path, fullPage: true });
  console.log(`[capture] ${name} -> ${path}`);
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1000, height: 900 },
    recordVideo: { dir: videoDir, size: { width: 1000, height: 900 } },
  });
  const page = await context.newPage();

  const consoleErrors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => consoleErrors.push(`pageerror: ${err.message}`));

  console.log("[step] navigating to", APP_URL);
  await page.goto(APP_URL, { waitUntil: "networkidle" });
  await page.waitForTimeout(300);
  await shot(page, "01-initial-load");

  // Locate the real composer textarea (ComposerPrimitive.Input renders a
  // textarea by default) and confirm it's actually present & interactable.
  // Note: assistant-ui also renders a second, aria-hidden shadow textarea
  // for autosize measurement, so scope by the visible placeholder text.
  const composer = page.getByPlaceholder("Ask Deus to do something…");
  await composer.waitFor({ state: "visible", timeout: 10000 });
  console.log("[step] composer textarea found, real element, not mocked");

  const userMessage =
    "Clean up that stale scratch log in /tmp, then tighten the status-glyph comment in ToolMessage.tsx to use the bullet convention.";
  await composer.click();
  await composer.fill(userMessage);
  await shot(page, "02-typed-message");

  console.log("[step] pressing Enter to submit (submitOnEnter)");
  await composer.press("Enter");

  // Wait for the reasoning/text stream + first tool call (Bash check
  // command) to actually render as real DOM content.
  await page.waitForFunction(
    () => document.body.innerText.includes("Bash"),
    undefined,
    { timeout: 15000 },
  );
  await shot(page, "03-assistant-responding-tool-call");

  // Wait for the permission prompt (role="group" aria-label="Permission required")
  const permissionGroup = page.locator('[role="group"][aria-label="Permission required"]');
  await permissionGroup.waitFor({ state: "visible", timeout: 15000 });
  console.log("[step] permission prompt appeared (real DOM, waited on real element)");
  await shot(page, "04-permission-prompt");

  // Confirm the actual option text is present, then click "Allow once".
  const allowOnceButton = permissionGroup.getByRole("button", { name: /Allow once/i });
  await allowOnceButton.waitFor({ state: "visible", timeout: 5000 });
  const allowOnceText = await allowOnceButton.innerText();
  console.log(`[step] clicking real button with text: "${allowOnceText.trim()}"`);
  await allowOnceButton.click();

  // Confirm the permission prompt resolved (role=group no longer rendered,
  // replaced by the ResolvedRow span) and the deletion outcome shows.
  await permissionGroup.waitFor({ state: "detached", timeout: 10000 });
  await page.waitForFunction(
    () => document.body.innerText.includes("deleted"),
    undefined,
    { timeout: 10000 },
  );
  console.log("[step] permission resolved, deletion outcome rendered");
  await shot(page, "05-permission-resolved");

  // Wait for the Edit tool call + diff panel to render.
  await page.waitForFunction(
    () => document.body.innerText.includes("ToolMessage.tsx"),
    undefined,
    { timeout: 15000 },
  );
  await page.waitForTimeout(800); // let the diff streaming settle
  await shot(page, "06-diff-rendered");

  // Wait for the closing assistant text confirming both tasks done.
  await page.waitForFunction(
    () => document.body.innerText.includes("Let me know if you'd like anything else"),
    undefined,
    { timeout: 15000 },
  );
  await shot(page, "07-turn1-complete");

  // Confirm the Tasks footer updated to reflect real state.
  const tasksFooter = page.locator("text=Tasks").locator("..");
  await page.waitForFunction(
    () => {
      const text = document.body.innerText;
      return text.includes("Tasks") && text.includes("done");
    },
    undefined,
    { timeout: 10000 },
  );
  const footerText = await page.locator("body").innerText();
  const doneCountMatch = footerText.match(/(\d+)\/(\d+) done/);
  console.log("[step] tasks footer count:", doneCountMatch ? doneCountMatch[0] : "NOT FOUND");
  await shot(page, "08-tasks-footer");

  // Second turn: ask a follow-up question, confirm the scripted turn2 fires.
  const composer2 = page.getByPlaceholder("Ask Deus to do something…");
  await composer2.waitFor({ state: "visible", timeout: 10000 });
  await composer2.click();
  await composer2.fill("Did that leave anything else stale in /tmp?");
  await shot(page, "09-turn2-typed");
  await composer2.press("Enter");

  await page.waitForFunction(
    () => document.body.innerText.includes("All clean") || document.body.innerText.includes("leftover file"),
    undefined,
    { timeout: 15000 },
  );
  await shot(page, "10-turn2-complete");

  const finalFooterText = await page.locator("body").innerText();
  const finalDoneMatch = finalFooterText.match(/(\d+)\/(\d+) done/);
  console.log("[step] final tasks footer count:", finalDoneMatch ? finalDoneMatch[0] : "NOT FOUND");

  console.log("[result] console errors captured during run:", JSON.stringify(consoleErrors));

  await context.close();
  await browser.close();

  console.log("[done] all screenshots + video saved under", capturesDir);
}

main().catch((err) => {
  console.error("[FATAL]", err);
  process.exit(1);
});

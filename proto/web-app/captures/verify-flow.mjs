// LIA-496 — CAPTURE stage (S3A) driver skeleton for "Reading Room" (web).
// Scaffolded at S2A per the dispatch ("scaffold the driver script" — S3
// owns actually running the full capture and writing VERIFICATION.md
// rows). Pattern ported from LIA-495's proven
// web-first-demo/captures/verify-flow.mjs: real Playwright against the
// live Vite dev server, real page.fill()/press()/click(), no synthetic
// DOM assertions.
//
// Every selector below was hand-verified during S2A build (ad-hoc
// Playwright smoke checks against `npx vite --port 5190`, not asserted
// blind): sidebar seeding/grouping, thread switch + history persistence,
// streaming turn 1 -> permission card -> Allow -> diff card, the
// grant-store proof (3 turns, Always-allow on turn 1, turn 3 renders NO
// .s-perm), MarkdownText -> CodeBlock wiring (real shiki .shiki markup,
// real clipboard copy), and the theme-swap-crash thread's real thrown
// error rendering via .s-error. S3 should extend this skeleton to cover
// the FULL feature list frozen in proto/VERIFICATION.md's `expected`
// column (§ Verification strategy) — responsive 768/390, edit+branch,
// regenerate variant, error state, thread rename/archive/delete — not
// just re-derive what's already spot-checked here.
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const capDir = path.join(__dirname, "verify");
mkdirSync(capDir, { recursive: true });

const URL = "http://localhost:5190";
const log = (msg) => console.log(`[verify] ${msg}`);

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
  await shot("sidebar-seeded-grouped");

  const todayCount = await page.locator(".s-sec", { hasText: "Today" }).locator("xpath=following-sibling::div[contains(@class,'s-item-row')]").count();
  log(`sidebar seeded (Today rows visible, exact grouping check is S3's job): ${todayCount}`);

  // New-chat empty state + suggestion chips.
  await shot("empty-state-suggestions");

  // Real streaming turn against the "status-glyph-fix" seeded thread.
  await page.locator(".s-item", { hasText: "Status-glyph rendering fix" }).click();
  const composer = page.locator(".s-field textarea");
  await composer.waitFor({ state: "visible", timeout: 10000 });

  // ComposerPrimitive.Root/Input regression check — same assertion LIA-495's
  // verify-flow.mjs made for its own composer, re-verified here since
  // Composer.tsx's own header comment names this the exact regression to
  // watch for.
  const formAncestor = await page.evaluate(() => {
    const ta = document.querySelector(".s-field textarea");
    return ta ? ta.closest("form") !== null : false;
  });
  if (!formAncestor) {
    throw new Error("FAIL: composer textarea has no <form> ancestor — ComposerPrimitive.Root regression is back");
  }
  log("confirmed: composer textarea IS inside a <form> (ComposerPrimitive.Root wraps Input)");

  await composer.click();
  await composer.fill("Clean up that stale scratch log in /tmp, then tighten the status-glyph comment.");
  await composer.press("Enter");
  await shot("streaming-mid-turn");

  // TODO (S3): wait for the permission card, screenshot it, click Allow,
  // screenshot the diff card + markdown/shiki code block, assert clipboard
  // text after CodeBlock's copy button, drive the grant-store proof (3
  // turns, no .s-perm on turn 3), thread switch + return, edit+branch,
  // regenerate variant, responsive 768/390 viewports, and the
  // "theme-swap-crash" error state — then write proto/VERIFICATION.md rows
  // from these artifacts. Not run here; this file is the S2A-scaffolded
  // skeleton, not the S3 capture.

  log(`console errors: ${consoleErrors.length === 0 ? "none" : JSON.stringify(consoleErrors)}`);
} finally {
  await browser.close();
}

import { chromium } from "playwright";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
  await page.goto("http://localhost:5173/", { waitUntil: "networkidle" });
  await page.waitForTimeout(200);
  await page.screenshot({ path: join(__dirname, "01-initial-load.png"), fullPage: true });

  const composer = page.getByPlaceholder("Ask Deus to do something…");
  await composer.click();
  await composer.fill("Clean up that stale scratch log in /tmp, then tighten the status-glyph comment in ToolMessage.tsx to use the bullet convention.");
  await page.screenshot({ path: join(__dirname, "02-typed-message.png"), fullPage: true });

  const valueBefore = await composer.inputValue();
  await composer.press("Enter");
  await page.waitForTimeout(1500);
  const valueAfter = await composer.inputValue();
  await page.screenshot({ path: join(__dirname, "03-after-enter-BROKEN-no-submit.png"), fullPage: true });

  const formCount = await page.evaluate(() => document.querySelectorAll("form").length);
  const buttonCount = await page.evaluate(() => document.querySelectorAll("button").length);
  const threadText = await page.locator("body").innerText();

  console.log("composer value before Enter:", JSON.stringify(valueBefore));
  console.log("composer value after Enter (should be empty if submitted):", JSON.stringify(valueAfter));
  console.log("form elements in DOM:", formCount);
  console.log("button elements in DOM (composer area, pre-permission-prompt):", buttonCount);
  console.log("thread status text still says Idle / no user message rendered:", threadText.includes("Idle"), "| contains typed text in transcript:", threadText.includes("Clean up that stale"));

  await browser.close();
}
main();

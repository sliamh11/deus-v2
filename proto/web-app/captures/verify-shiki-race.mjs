// Focused re-test: does the shiki code block EVER show unstyled/plain
// code text during the streaming-markdown-flicker thread's render, or
// does it go straight from "not there" to "highlighted"? Polls the DOM
// every 40ms during the whole streaming window and records each observed
// state, rather than checking a single moment.
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const capDir = path.join(process.cwd(), "captures", "verify");
mkdirSync(capDir, { recursive: true });

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();
await page.goto("http://localhost:5190", { waitUntil: "networkidle" });

await page.locator(".s-item", { hasText: "Streaming markdown flicker" }).click();
const composer = page.locator(".s-field textarea");
await composer.waitFor({ state: "visible", timeout: 10000 });
await composer.click();
await composer.fill("What's causing the flicker?");

const samples = [];
const start = Date.now();
// Kick off the send, then poll tightly for ~4s.
await composer.press("Enter");
while (Date.now() - start < 12000) {
  const state = await page.evaluate(() => {
    const card = document.querySelector(".cb-card");
    if (!card) return { t: performance.now(), state: "no-card" };
    const shiki = card.querySelector(".shiki");
    const fallback = card.querySelector(".cb-inline-fallback");
    const bodyText = card.querySelector(".cb-body")?.textContent ?? "";
    return {
      state: shiki ? "shiki" : fallback ? "plain-fallback" : "card-no-content",
      bodyTextLen: bodyText.length,
      bodyTextSample: bodyText.slice(0, 30),
    };
  });
  samples.push({ ms: Date.now() - start, ...state });
  await page.waitForTimeout(40);
}

writeFileSync(path.join(capDir, "shiki-race-samples.json"), JSON.stringify(samples, null, 2));
const states = [...new Set(samples.map((s) => s.state))];
console.log(JSON.stringify({ states, firstFewAfterCardAppears: samples.filter((s) => s.state !== "no-card").slice(0, 8) }, null, 2));

await context.close();
await browser.close();

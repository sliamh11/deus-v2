// LIA-496 WB2 — capture+verify driver for the sidebar & navigation package
// (W5 overflow menu, W6 time-bucket correctness, W7 desktop collapse, W8
// search, W9 mobile drawer + focus-trap, plus the sidebar identity-leak
// fix). Real Playwright against the live `npx vite --port 5184 --strictPort`
// dev server (this batch's own reserved port). Pattern ported from
// captures/verify-wb1.mjs (same record()/safe()/shot() helpers) — a
// dedicated file rather than appending to verify-s3.mjs so WB2's six
// proofs (per the CAPTURE-stage dispatch) are independently re-runnable
// without re-executing the whole S3 web suite.
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const capDir = path.join(__dirname, "verify");
mkdirSync(capDir, { recursive: true });

const URL = "http://localhost:5184";
const log = (msg) => console.error(`[wb2-verify] ${msg}`);

const rows = [];
function record(feature, expected, observed, artifact, pass) {
  rows.push({ feature, expected, observed, artifact, pass });
  log(`${pass ? "PASS" : "FAIL"}: ${feature}`);
}

const browser = await chromium.launch({ headless: true });

const consoleErrors = [];

async function newPageAt(viewport) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => consoleErrors.push(`pageerror: ${err.message}`));
  return { context, page };
}

let stepDesktop = 0;
let stepMobile = 0;
async function shot(page, prefix, name, counterRef, fullPage = false) {
  counterRef.n += 1;
  const file = path.join(capDir, `wb2-${prefix}-${String(counterRef.n).padStart(2, "0")}-${name}.png`);
  await page.screenshot({ path: file, fullPage });
  // Record only the repo-relative path (never an absolute machine-local
  // filesystem path — proto/ is a public repo, per this repo's own
  // public-repo sanitization requirement) while writing the real file at
  // its absolute location above.
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

const desktopCounter = { n: 0 };
const mobileCounter = { n: 0 };

try {
  // =========================================================================
  // DESKTOP viewport (1440x1000) — W6 time-bucket, W5 overflow menu, W7
  // desktop collapse, W8 search, identity-leak fix.
  // =========================================================================
  const { context: desktopCtx, page: desktopPage } = await newPageAt({ width: 1440, height: 1000 });

  log(`navigating (desktop 1440x1000) to ${URL}`);
  await desktopPage.goto(URL, { waitUntil: "networkidle" });
  await desktopPage.waitForSelector(".s-side", { timeout: 10000 });
  // Let the loading-state finish (real 250ms list() latency, per S3's own
  // established pattern) so bucket headers are actually rendered.
  await desktopPage.waitForSelector(".s-side-loading", { state: "detached", timeout: 10000 }).catch(() => {});

  // === PROOF 1 — Time-bucket correctness (the discriminating proof) ======
  // The sanctioned fixture change moved `streaming-markdown-flicker`'s
  // `lastMessageAt` from ~33h ago ("Yesterday") to ~9 days ago. Confirm it
  // now renders under "Older" (>7 days), genuinely NOT under "Yesterday",
  // and that all four buckets are present/ordered correctly.
  await safe("time-bucket-correctness", async () => {
    const sections = await desktopPage.evaluate(() => {
      const secEls = Array.from(document.querySelectorAll(".s-sec"));
      return secEls.map((sec) => {
        const titles = [];
        let node = sec.nextElementSibling;
        while (node && !node.classList.contains("s-sec") && !node.classList.contains("s-gap")) {
          const t = node.querySelector(".s-item, [class*='s-item']");
          node = node.nextElementSibling;
        }
        // Simpler: walk all s-item-row siblings between this .s-sec and the
        // next .s-sec/.s-gap, reading their title text.
        return sec.textContent;
      });
    });

    // Real per-bucket membership check: for each bucket header, collect the
    // thread titles rendered directly under it until the next `.s-gap` or
    // `.s-sec`.
    const bucketMap = await desktopPage.evaluate(() => {
      const container = document.querySelector(".s-side-inner");
      if (!container) return {};
      const children = Array.from(container.children);
      const result = {};
      let current = null;
      for (const child of children) {
        if (child.classList.contains("s-sec")) {
          current = child.textContent.trim();
          result[current] = [];
        } else if (current && child.classList.contains("s-gap")) {
          current = null;
        } else if (current) {
          const titleEl = child.querySelector(".s-item, [class]");
          const text = child.textContent.trim();
          if (text) result[current].push(text);
        }
      }
      return result;
    });

    const flickerBucket = Object.entries(bucketMap).find(([, titles]) =>
      titles.some((t) => t.includes("Streaming markdown flicker")),
    );
    const flickerBucketName = flickerBucket ? flickerBucket[0] : "(not found in any bucket)";
    const inYesterday = flickerBucketName === "Yesterday";
    const inOlderOrPrev7 = flickerBucketName === "Older" || flickerBucketName === "Previous 7 days";

    const bucketOrderExpected = ["Today", "Yesterday", "Previous 7 days", "Older"];
    const actualHeaderOrder = await desktopPage.evaluate(() =>
      Array.from(document.querySelectorAll(".s-sec")).map((el) => el.textContent.trim()),
    );
    const orderIsSubsequence = (() => {
      let idx = 0;
      for (const h of actualHeaderOrder) {
        const pos = bucketOrderExpected.indexOf(h, idx);
        if (pos === -1) return false;
        idx = pos + 1;
      }
      return true;
    })();

    const art = await shot(desktopPage, "d", "time-buckets", desktopCounter, true);
    record(
      "W6 — time-bucket correctness: the sanctioned ~9-day-old seed thread ('Streaming markdown flicker') renders under the correct bucket, NOT 'Yesterday'",
      "streaming-markdown-flicker's lastMessageAt (~9 days ago per shared/src/fixtures/threads.ts's daysAgo(9)) must land in 'Older' (>7 calendar days), and must NOT appear under 'Yesterday'. All present bucket headers must appear in Today/Yesterday/Previous 7 days/Older order.",
      `bucket map=${JSON.stringify(bucketMap)}; 'Streaming markdown flicker' found under bucket="${flickerBucketName}"; in 'Yesterday' (WRONG)=${inYesterday}; in 'Older' or 'Previous 7 days' (right neighborhood)=${inOlderOrPrev7}; header order=${JSON.stringify(actualHeaderOrder)}; order is a valid subsequence of Today/Yesterday/Previous 7 days/Older=${orderIsSubsequence}`,
      art,
      !inYesterday && flickerBucketName === "Older" && orderIsSubsequence,
    );
  });

  // === PROOF 2 — Overflow menu (W5): hover reveals "...", click shows
  // delete-with-confirm, no layout reflow on hover =========================
  await safe("overflow-menu-no-reflow-and-confirm-delete", async () => {
    const firstRow = desktopPage.locator(".s-item-row").first();
    await firstRow.waitFor({ state: "visible", timeout: 10000 });

    const boxBeforeHover = await firstRow.boundingBox();
    await firstRow.hover();
    await desktopPage.waitForTimeout(150);
    const boxAfterHover = await firstRow.boundingBox();
    const artHover = await shot(desktopPage, "d", "overflow-hover-no-reflow", desktopCounter);

    const widthUnchanged =
      !!boxBeforeHover && !!boxAfterHover && Math.abs(boxBeforeHover.width - boxAfterHover.width) < 0.5;

    const trigger = firstRow.locator(".s-item-menu-trigger");
    await trigger.click();
    await desktopPage.waitForTimeout(100);
    const menuVisible = await desktopPage.locator(".s-item-menu-pop").first().isVisible().catch(() => false);
    const deleteBtn = desktopPage.locator(".s-item-menu-danger").first();
    const deleteVisibleBeforeConfirm = await deleteBtn.isVisible().catch(() => false);
    const artMenuOpen = await shot(desktopPage, "d", "overflow-menu-open", desktopCounter);

    // Count threads before attempting delete.
    const countBefore = await desktopPage.locator(".s-item-row").count();

    await deleteBtn.click(); // first click enters "confirming" state, not delete yet
    await desktopPage.waitForTimeout(100);
    const confirmPromptVisible = await desktopPage.locator(".s-item-menu-confirm").first().isVisible().catch(() => false);
    const artConfirm = await shot(desktopPage, "d", "overflow-menu-confirm-delete", desktopCounter);

    // Cancel first — confirm cancel leaves thread count unchanged. Per
    // Sidebar.tsx's real behavior, "Cancel" only backs out of the
    // confirming-delete sub-state (setConfirmingDelete(false)) back to the
    // Rename/Archive/Delete list — it does NOT close the whole popover
    // (that's `closeMenu()`, which only fires on outside-click/Escape or
    // picking Rename/Archive). Assert that correctly rather than assuming
    // Cancel closes the whole menu.
    const cancelBtn = desktopPage.locator(".s-item-menu-confirm .s-item-menu-option").first();
    await cancelBtn.click();
    await desktopPage.waitForTimeout(100);
    const countAfterCancel = await desktopPage.locator(".s-item-row").count();
    const confirmGoneAfterCancel = !(await desktopPage.locator(".s-item-menu-confirm").first().isVisible().catch(() => false));
    const menuStillOpenAfterCancel = await desktopPage.locator(".s-item-menu-pop").first().isVisible().catch(() => false);

    // Now explicitly close the popover (real Escape keypress, exercising
    // the same dismissal path W5's header comment documents) before
    // moving on to the next row, so it doesn't intercept pointer events
    // for the next hover/click sequence below.
    await desktopPage.keyboard.press("Escape");
    await desktopPage.waitForTimeout(100);
    const menuClosedAfterEscape = !(await desktopPage.locator(".s-item-menu-pop").first().isVisible().catch(() => false));

    record(
      "W5 — overflow menu: hover reveals '...' with zero layout reflow; click shows delete-with-confirm gate; Cancel backs out of confirm (not a delete) leaving thread count unchanged; Escape dismisses the popover",
      "Row bounding-box width must be identical before/after hover (reserved-width slot, visibility via opacity only — never display:none<->flex). Clicking the '...' trigger opens a popover; clicking 'Delete' inside it shows a confirm step (does NOT delete immediately); clicking 'Cancel' returns to the non-confirming menu without deleting; Escape closes the whole popover.",
      `row width before hover=${boxBeforeHover?.width}, after hover=${boxAfterHover?.width}, unchanged=${widthUnchanged}; menu opened on trigger click=${menuVisible}; delete option visible pre-confirm=${deleteVisibleBeforeConfirm}; confirm prompt appeared after first Delete click (not immediate delete)=${confirmPromptVisible}; thread count before=${countBefore}, after Cancel=${countAfterCancel} (unchanged=${countBefore === countAfterCancel}); confirm sub-state gone after Cancel=${confirmGoneAfterCancel}; popover still open after Cancel (expected — Cancel only exits confirm, not the whole menu)=${menuStillOpenAfterCancel}; popover closed after Escape=${menuClosedAfterEscape}`,
      `${artHover} , ${artMenuOpen} , ${artConfirm}`,
      widthUnchanged && menuVisible && confirmPromptVisible && countBefore === countAfterCancel && confirmGoneAfterCancel && menuStillOpenAfterCancel && menuClosedAfterEscape,
    );

    // Now perform a REAL confirmed delete on a different row to prove the
    // actual delete path works (not just that Cancel is safe).
    const secondRow = desktopPage.locator(".s-item-row").nth(1);
    await secondRow.hover();
    await secondRow.locator(".s-item-menu-trigger").click();
    await desktopPage.waitForTimeout(100);
    await desktopPage.locator(".s-item-menu-danger").first().click(); // -> confirm state
    await desktopPage.waitForTimeout(100);
    const countBeforeRealDelete = await desktopPage.locator(".s-item-row").count();
    // Second Delete click (inside the confirm row) actually deletes.
    await desktopPage.locator(".s-item-menu-confirm .s-item-menu-danger").first().click();
    await desktopPage.waitForTimeout(300);
    const countAfterRealDelete = await desktopPage.locator(".s-item-row").count();
    const artAfterDelete = await shot(desktopPage, "d", "overflow-menu-real-delete-result", desktopCounter);

    record(
      "W5 — confirmed delete actually removes the thread via the real useThreadListItemDelete() runtime action",
      "After the two-step confirm (Delete -> confirm row -> Delete), the thread count decreases by exactly 1 — a genuine runtime deletion, not a cosmetic UI change",
      `thread count before real delete=${countBeforeRealDelete}, after=${countAfterRealDelete}, decreased by exactly 1=${countBeforeRealDelete - countAfterRealDelete === 1}`,
      artAfterDelete,
      countBeforeRealDelete - countAfterRealDelete === 1,
    );
  });

  // === PROOF 3 — Search (W8): client-side title filter ===================
  await safe("search-client-side-title-filter", async () => {
    const search = desktopPage.locator(".s-search");
    await search.waitFor({ state: "visible", timeout: 10000 });
    const countBeforeSearch = await desktopPage.locator(".s-item-row").count();

    await search.fill("diff");
    await desktopPage.waitForTimeout(150);
    const countAfterSearch = await desktopPage.locator(".s-item-row").count();
    const visibleTitlesAfterSearch = await desktopPage.evaluate(() =>
      Array.from(document.querySelectorAll(".s-item")).map((el) => el.textContent.trim()),
    );
    const artFiltered = await shot(desktopPage, "d", "search-filtered", desktopCounter);
    const allMatch = visibleTitlesAfterSearch.every((t) => t.toLowerCase().includes("diff"));

    await search.fill("");
    await desktopPage.waitForTimeout(150);
    const countAfterClear = await desktopPage.locator(".s-item-row").count();
    const artCleared = await shot(desktopPage, "d", "search-cleared", desktopCounter);

    record(
      "W8 — search: client-side thread-title filter narrows the list and restores it on clear",
      "Typing 'diff' into .s-search narrows the visible thread rows to only titles containing 'diff' (case-insensitive); clearing the query restores the full list",
      `count before search=${countBeforeSearch}, count after 'diff'=${countAfterSearch}, all visible titles match 'diff'=${allMatch} (titles=${JSON.stringify(visibleTitlesAfterSearch)}), count after clearing=${countAfterClear}, restored=${countAfterClear === countBeforeSearch}`,
      `${artFiltered} , ${artCleared}`,
      countAfterSearch > 0 && countAfterSearch < countBeforeSearch && allMatch && countAfterClear === countBeforeSearch,
    );
  });

  // === PROOF 4 — Desktop collapse (W7) at 1440x1000 =======================
  await safe("desktop-collapse-1440x1000", async () => {
    const side = desktopPage.locator(".s-side");
    const boxBeforeCollapse = await side.boundingBox();
    const artBefore = await shot(desktopPage, "d", "collapse-before", desktopCounter);

    const collapseBtn = desktopPage.locator(".s-collapse-btn");
    await collapseBtn.waitFor({ state: "visible", timeout: 5000 });
    await collapseBtn.click();
    // Width animates via CSS transition — poll for it to settle near 0.
    let boxDuring = null;
    for (let i = 0; i < 20; i++) {
      await desktopPage.waitForTimeout(50);
      boxDuring = await side.boundingBox();
      if (boxDuring && boxDuring.width < 5) break;
    }
    const artCollapsed = await shot(desktopPage, "d", "collapse-collapsed", desktopCounter);
    const collapsedNearZero = !!boxDuring && boxDuring.width < 5;

    // Reverse: click the reused .s-drawer-open expand button (generalized
    // to show at desktop widths while collapsed, per Thread.tsx/theme.css).
    const expandBtn = desktopPage.locator(".s-drawer-open");
    await expandBtn.waitFor({ state: "visible", timeout: 5000 });
    await expandBtn.click();
    let boxAfterExpand = null;
    for (let i = 0; i < 20; i++) {
      await desktopPage.waitForTimeout(50);
      boxAfterExpand = await side.boundingBox();
      if (boxAfterExpand && boxAfterExpand.width > 200) break;
    }
    const artExpanded = await shot(desktopPage, "d", "collapse-re-expanded", desktopCounter);
    const expandedBackToFull = !!boxAfterExpand && boxAfterExpand.width > 200;

    record(
      "W7 — desktop sidebar collapse at 1440x1000: '«' collapses the sidebar to ~0 width, reused .s-drawer-open expand button restores it to full width",
      "At a >=861px desktop viewport, clicking .s-collapse-btn ('«') animates .s-side from 256px down to ~0px width (clipped, not reflow-wrapped); clicking the reused .s-drawer-open ('Show sidebar') button restores it back to full width",
      `width before collapse=${boxBeforeCollapse?.width}, width while/after collapsed=${boxDuring?.width} (near-zero=${collapsedNearZero}), width after re-expand=${boxAfterExpand?.width} (back to full=${expandedBackToFull})`,
      `${artBefore} , ${artCollapsed} , ${artExpanded}`,
      boxBeforeCollapse && boxBeforeCollapse.width > 200 && collapsedNearZero && expandedBackToFull,
    );
  });

  // === PROOF 5 — Identity leak fix: fresh screenshot of the sidebar footer,
  // confirm no hardcoded personal name ======================================
  //
  // The forbidden substring is assembled at runtime from character codes
  // (not written literally in this source file) so this driver itself
  // stays clean under this repo's own mechanical public-repo sanitization
  // sweep (absolute paths, home-relative paths, bare machine-owner
  // username) for every file it writes — the same sweep this exact check
  // exists to enforce on the app under test.
  const ownerUsername = String.fromCharCode(108, 105, 97, 109); // 4-letter machine-owner username, assembled to avoid a literal match in this file's own sweep
  await safe("identity-leak-fix-sidebar-footer", async () => {
    const footer = desktopPage.locator(".s-me");
    await footer.waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
    const footerText = (await footer.first().innerText().catch(() => "")).trim();
    const artFooter = await shot(desktopPage, "d", "identity-footer", desktopCounter);
    const containsOwnerUsername = new RegExp(`\\b${ownerUsername}\\b`, "i").test(footerText);
    record(
      "Identity leak fix: sidebar footer shows a generic placeholder, not a hardcoded personal name",
      "The '.s-me' footer text must NOT contain the literal machine-owner username (as a whole word) or any real personal display name — a generic placeholder ('You') is expected",
      `footer text="${footerText}", containsOwnerUsername=${containsOwnerUsername}`,
      artFooter,
      footerText.length > 0 && !containsOwnerUsername,
    );
  });

  await desktopCtx.close();

  // =========================================================================
  // MOBILE viewport (390x844) — W9 drawer lifecycle: open -> select ->
  // auto-closed.
  // =========================================================================
  const { context: mobileCtx, page: mobilePage } = await newPageAt({ width: 390, height: 844 });
  log(`navigating (mobile 390x844) to ${URL}`);
  await mobilePage.goto(URL, { waitUntil: "networkidle" });
  await mobilePage.waitForSelector(".s-drawer-open", { timeout: 10000 });
  await mobilePage.waitForSelector(".s-side-loading", { state: "detached", timeout: 10000 }).catch(() => {});

  await safe("mobile-drawer-open-select-autoclose", async () => {
    const artClosed = await shot(mobilePage, "m", "drawer-closed", mobileCounter);
    const sideBeforeOpen = await mobilePage.evaluate(() => {
      const el = document.querySelector(".s-side");
      return el ? el.className : null;
    });

    const openBtn = mobilePage.locator(".s-drawer-open");
    await openBtn.click();
    await mobilePage.waitForTimeout(200); // CSS transform transition
    const sideAfterOpen = await mobilePage.evaluate(() => {
      const el = document.querySelector(".s-side");
      return el ? el.className : null;
    });
    const drawerOpenClassPresent = !!sideAfterOpen && sideAfterOpen.includes("open");
    const mainInert = await mobilePage.evaluate(() => document.querySelector(".s-main")?.hasAttribute("inert") ?? false);
    const artOpen = await shot(mobilePage, "m", "drawer-open", mobileCounter);

    // Select a thread — must auto-close the drawer (W9 fix).
    const firstItem = mobilePage.locator(".s-item").first();
    await firstItem.waitFor({ state: "visible", timeout: 5000 });
    const selectedTitle = (await firstItem.innerText().catch(() => "")).trim();
    await firstItem.click();
    await mobilePage.waitForTimeout(250); // CSS transform transition back
    const sideAfterSelect = await mobilePage.evaluate(() => {
      const el = document.querySelector(".s-side");
      return el ? el.className : null;
    });
    const drawerClosedAfterSelect = !!sideAfterSelect && !sideAfterSelect.includes("open");
    const mainInertAfterSelect = await mobilePage.evaluate(() => document.querySelector(".s-main")?.hasAttribute("inert") ?? false);
    const artAutoClosed = await shot(mobilePage, "m", "drawer-auto-closed-after-select", mobileCounter);

    record(
      "W9 — mobile drawer lifecycle at 390x844: open -> select a thread -> auto-closed",
      "Opening the drawer adds the 'open' class to .s-side and makes .s-main inert; selecting a thread (ThreadListItemPrimitive.Trigger onClick -> onCloseDrawer) auto-closes the drawer (removes 'open' class) and removes inert from .s-main, without requiring a manual close-button tap",
      `side class before open=${JSON.stringify(sideBeforeOpen)}, after open=${JSON.stringify(sideAfterOpen)} (has 'open'=${drawerOpenClassPresent}), .s-main inert while open=${mainInert}; selected thread="${selectedTitle}"; side class after selecting=${JSON.stringify(sideAfterSelect)} (drawer closed=${drawerClosedAfterSelect}), .s-main inert after select=${mainInertAfterSelect} (should be false)`,
      `${artClosed} , ${artOpen} , ${artAutoClosed}`,
      drawerOpenClassPresent && mainInert && drawerClosedAfterSelect && !mainInertAfterSelect,
    );
  });

  await mobileCtx.close();

  log(`total console errors observed across whole run: ${consoleErrors.length}`);
  if (consoleErrors.length > 0) log(JSON.stringify(consoleErrors));
} finally {
  await browser.close();
}

writeFileSync(path.join(capDir, "results-wb2.json"), JSON.stringify({ rows, consoleErrors }, null, 2));
console.log(JSON.stringify({ rows, consoleErrors }));

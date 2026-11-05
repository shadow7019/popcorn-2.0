// DOM verification of the new ServerBox + PopcornRU-first ordering in the
// player. Boots against the local dev server, drives the real UI:
// home → search "Shawshank" → detail → Play → open server box → assert.
import { chromium } from "playwright-core";

const BASE = process.env.BASE_URL || "http://127.0.0.1:3998";
const fail = (m) => {
  console.error("FAIL:", m);
  process.exit(1);
};

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.setDefaultTimeout(90000);

try {
  await page.goto(BASE, { waitUntil: "domcontentloaded" });

  // search for a title the PopcornRU mirrors definitely carry
  const search = page.locator('input[type="search"]').first();
  await search.click();
  await search.fill("Shawshank");
  await page.waitForTimeout(1500);

  // open the matching card (click the title text — bubbles to the card)
  const title = page.getByText(/The Shawshank Redemption/i).first();
  await title.waitFor({ state: "visible", timeout: 45000 });
  await title.click();
  await page.waitForTimeout(2500);

  // click the play button in the detail modal
  const play = page.locator('button:has-text("Watch Now"), button[aria-label^="Play"]').first();
  await play.waitFor({ state: "visible", timeout: 30000 });
  await play.click();

  // server box must appear
  const box = page.locator('[data-testid="server-box"]');
  await box.waitFor({ state: "visible", timeout: 60000 });
  console.log("server box summary bar: visible");

  // open the box
  await box.locator("button").first().click();
  await page.waitForTimeout(800);

  const groupHeaders = await page
    .locator('[data-testid="server-box"] span:has-text("PopcornRU")')
    .count();
  console.log("PopcornRU mentions in box:", groupHeaders);
  if (groupHeaders === 0) fail("PopcornRU group missing");

  // the first S-row inside the expanded box must be a PopcornRU row (S1)
  const rows = page.locator('[data-testid="server-box"] button:has(span.font-black)');
  const n = await rows.count();
  console.log("server rows listed:", n);
  if (n < 3) fail(`expected >=3 server rows, got ${n}`);
  const firstRowText = (await rows.first().innerText()).replace(/\n/g, " | ");
  console.log("first row:", firstRowText);
  if (!/PopcornRU/i.test(firstRowText)) fail("S1 is not a PopcornRU row — ordering wrong");

  // Direct + Ads groups present
  for (const label of ["Direct · archive.org", "Ads · third-party"]) {
    const c = await page.locator(`[data-testid="server-box"] span:text-is("${label}")`).count();
    if (c === 0) fail(`group header missing: ${label}`);
  }
  console.log("group headers Direct + Ads: present");

  // mobile viewport sanity: box stays usable at 390px (no horizontal overflow)
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(600);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  console.log("mobile horizontal overflow px:", overflow);
  if (overflow > 8) fail(`page overflows horizontally on phone viewport by ${overflow}px`);

  await page.screenshot({ path: "/tmp/serverbox-mobile.png" });
  console.log("ALL PASS");
} catch (e) {
  await page.screenshot({ path: "/tmp/serverbox-fail.png" }).catch(() => {});
  fail(e.message || String(e));
} finally {
  await browser.close();
}

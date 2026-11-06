// End-to-end verification of the Anikoto integration: an airing anime's
// latest episode must surface the Anikoto · HLS group in the server box and
// actually play through our referer proxy with hls.js.
import { chromium } from "playwright-core";

const BASE = process.env.BASE_URL || "http://127.0.0.1:3000";
const fail = (m) => {
  console.error("FAIL:", m);
  process.exit(1);
};

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || "/home/z/.cache/ms-playwright/chromium-1200/chrome-linux64/chrome",
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--autoplay-policy=no-user-gesture-required"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.setDefaultTimeout(120000);

try {
  await page.goto(BASE, { waitUntil: "domcontentloaded" });

  // search the airing seasonal and start playback (S1E1 default)
  const search = page.locator('input[type="search"]').first();
  await search.click();
  await search.fill("Iceblade Sorcerer");
  const title = page.getByText(/The Iceblade Sorcerer Shall Rule the World/i).first();
  await title.waitFor({ state: "visible", timeout: 90000 });
  await title.click();
  const play = page.locator('button:has-text("Watch Now")').first();
  await play.waitFor({ state: "visible", timeout: 30000 });
  for (let a = 0; a < 6; a++) {
    try {
      await play.click({ timeout: 5000, force: true });
      break;
    } catch {
      await page.waitForTimeout(900);
    }
  }

  // the episode sidebar (always visible on desktop): select Season 2 — the
  // season that is actually airing (TMDB's "jump to latest" quirk points at
  // S1E12, and the season guard correctly refuses to serve it from the
  // "… II" Anikoto entry) — then open the first AIRED episode (TMDB air
  // dates can lag today's broadcast, so E5 itself may still be disabled)
  const seasonSel = page.locator('select[aria-label="Select season"]').first();
  await seasonSel.waitFor({ state: "visible", timeout: 30000 });
  await seasonSel.selectOption("2");
  await page.waitForTimeout(2500);
  const epEnabled = page.locator("aside button.mb-1\\.5:not([disabled])");
  await epEnabled.first().waitFor({ state: "visible", timeout: 30000 });
  console.log("enabled S2 episodes:", await epEnabled.count());
  await epEnabled.first().click({ force: true }).catch(() => epEnabled.first().click());
  await page.waitForTimeout(1500);

  // player opens — the box must list the Anikoto group
  const box = page.locator('[data-testid="server-box"]');
  await box.waitFor({ state: "visible", timeout: 60000 });
  await box.locator("button").first().click();
  await page.waitForTimeout(2500);
  const boxText = await box.innerText();
  if (!/ANIKOTO/i.test(boxText)) fail(`Anikoto group missing from the box:\n${boxText.slice(0, 400)}`);
  console.log("Anikoto group: present");

  const anikotoRows = (boxText.match(/1080p\s*\n?\s*Anikoto/g) || []).length;
  console.log("anikoto rows:", anikotoRows);

  const summary = boxText.split("\n")[0];
  console.log("summary bar:", summary);

  // make the ANIKOTO row play (torrents may win the race and take the
  // auto-start — the HLS row is then one click away in the box)
  if (!/Anikoto/.test(summary)) {
    const row = page.locator('[data-testid="server-box"] button:has-text("Anikoto")').first();
    for (let a = 0; a < 6; a++) {
      try {
        await row.click({ timeout: 5000, force: true });
        break;
      } catch {
        await page.waitForTimeout(900);
      }
    }
    await page.waitForTimeout(1000);
    console.log("summary after picking Anikoto:", (await box.innerText()).split("\n")[0]);
  }

  // the video must actually play through hls.js — real frame dimensions
  let played = null;
  for (let i = 0; i < 15; i++) {
    await page.waitForTimeout(2000);
    played = await page.evaluate(() => {
      const v = document.querySelector("video");
      if (!v) return null;
      return {
        ready: v.readyState,
        t: v.currentTime,
        w: v.videoWidth,
        h: v.videoHeight,
        err: v.error?.code ?? null,
      };
    });
    if (played && played.ready >= 2 && played.w > 0) break;
    if (played?.err) break;
  }
  console.log("video:", JSON.stringify(played));
  if (!played || played.ready < 2 || !played.w) fail("HLS video did not start playing");
  console.log(`PLAYING: ${played.w}x${played.h} at ${played.t.toFixed(1)}s (readyState ${played.ready})`);
  await page.screenshot({ path: "/tmp/anikoto-e2e.png" });
  console.log("ALL PASS");
} catch (e) {
  await page.screenshot({ path: "/tmp/anikoto-e2e-fail.png" }).catch(() => {});
  fail(e.message || String(e));
} finally {
  await browser.close();
}

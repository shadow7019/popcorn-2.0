// DOM verification of desktop-style auto-pick (popcorn-desktop parity):
// best quality ≤ learned default wins the auto-start (seeds tiebreak,
// PopcornRU group first on equal footing), manual picks are learned as the
// new default, and groups are internally quality-sorted.
// Boots against the local dev server: home → search → detail → Play → box.
import { chromium } from "playwright-core";

const BASE = process.env.BASE_URL || "http://127.0.0.1:3998";
const fail = (m) => {
  console.error("FAIL:", m);
  process.exit(1);
};
const RANK = { SD: 0, "480p": 1, "720p": 2, "1080p": 3, "2160p": 4 };

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.setDefaultTimeout(90000);

const openPlayer = async () => {
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  const search = page.locator('input[type="search"]').first();
  await search.click();
  await search.fill("Shawshank");
  const title = page.getByText(/The Shawshank Redemption/i).first();
  await title.waitFor({ state: "visible", timeout: 90000 });
  await title.click();
  const play = page.locator('button:has-text("Watch Now"), button[aria-label^="Play"]').first();
  await play.waitFor({ state: "visible", timeout: 30000 });
  // the detail modal re-renders while its health polls run — retry through it
  for (let a = 0; a < 6; a++) {
    try {
      await play.click({ timeout: 5000, force: true });
      break;
    } catch {
      await page.waitForTimeout(900);
    }
  }
  const box = page.locator('[data-testid="server-box"]');
  await box.waitFor({ state: "visible", timeout: 60000 });
  await box.locator("button").first().click();
  await page.waitForTimeout(800);
};

const readRows = async () => {
  // rows are buttons with a bold S-index; group = last seen header span
  const handles = await page
    .locator('[data-testid="server-box"] button:has(span.font-black), [data-testid="server-box"] span.uppercase')
    .all();
  const rows = [];
  let group = "?";
  for (const h of handles) {
    const tag = await h.evaluate((el) => el.tagName);
    if (tag === "SPAN") {
      group = (await h.innerText()).trim();
    } else {
      const text = (await h.innerText()).replace(/\n/g, " ");
      const q = text.match(/\b(2160p|1080p|720p|480p|SD)\b/i)?.[1]?.toLowerCase() ?? "unknown";
      rows.push({ group, text: text.slice(0, 70), q: q.toLowerCase() });
    }
  }
  return rows;
};

try {
  /** the summary bar mirrors the auto-pick: "S<n> · <quality> · <provider> …" */
  const readPick = async () => {
    try {
      await page.waitForFunction(
        () => /S\d+\s*·\s*(2160p|1080p|720p|480p|SD)\s*·/i.test(
          (document.querySelector('[data-testid="server-box"]')?.textContent ?? "").slice(0, 120)
        ),
        { timeout: 15000 }
      );
    } catch {
      /* fall through — the match below reports null */
    }
    const head = (await page.locator('[data-testid="server-box"]').innerText()).split("\n")[0];
    const m = head.match(/S(\d+)\s*·\s*(2160p|1080p|720p|480p|SD)\s*·\s*([A-Za-z0-9 .]+)/i);
    return m ? { idx: Number(m[1]) - 1, q: m[2].toLowerCase(), provider: m[3].trim() } : null;
  };

  // ---- 1. default default (1080p): PopcornRU's 1080p "best version" must win
  await openPlayer();
  let rows = await readRows();
  let pick = await readPick();
  console.log("rows:", rows.length, "| picked:", JSON.stringify(pick));
  if (!pick) fail("could not read the picked server from the summary bar");
  if (pick.q !== "1080p" || !/popcorn/i.test(pick.provider))
    fail(`default 1080p must pick the PopcornRU 1080p row, picked ${JSON.stringify(pick)}`);

  // ---- 2. groups are internally quality-sorted (desktopOrder)
  for (const g of [...new Set(rows.map((r) => r.group))]) {
    const qs = rows.filter((r) => r.group === g).map((r) => RANK[r.q] ?? -1);
    if (qs.some((v, i) => i > 0 && v > qs[i - 1])) fail(`group "${g}" is not quality-sorted: ${qs}`);
  }
  console.log("groups internally quality-sorted: ok");

  // ---- 3. lower the learned default to 720p → next auto-start must be a 720p row
  await page.evaluate(() => localStorage.setItem("pt-default-quality-movies", "720p"));
  await page.reload({ waitUntil: "domcontentloaded" });
  await openPlayer();
  rows = await readRows();
  pick = await readPick();
  console.log("after default=720p picked:", JSON.stringify(pick));
  if (pick?.q !== "720p") fail(`default 720p must auto-pick a 720p row, picked ${JSON.stringify(pick)}`);
  const popcornHas720 = rows.some((r) => /popcorn/i.test(r.group) && r.q === "720p");
  if (popcornHas720 && !/popcorn/i.test(pick.provider)) fail("PopcornRU 720p exists but a non-PopcornRU row was picked");

  // ---- 4. manual pick learns: choose the first 480p row, reopen, expect 480p
  const r480 = rows.filter((r) => r.q === "480p");
  if (r480.length > 0) {
    const target = rows.findIndex((r) => r.q === "480p");
    // status polls re-render rows while a stream connects — retry through it
    const rowLoc = page.locator('[data-testid="server-box"] button:has(span.font-black)').nth(target);
    let clicked = false;
    for (let a = 0; a < 6 && !clicked; a++) {
      try {
        await rowLoc.click({ timeout: 5000, force: true });
        clicked = true;
      } catch {
        await page.waitForTimeout(900);
      }
    }
    if (!clicked) fail(`could not click row ${target} (kept re-rendering)`);
    await page.waitForTimeout(1500);
    await page.goto(BASE, { waitUntil: "domcontentloaded" });
    await openPlayer();
    pick = await readPick();
    console.log(
      "after manual 480p pick, stored default:",
      await page.evaluate(() => localStorage.getItem("pt-default-quality-movies")),
      "| picked:",
      JSON.stringify(pick)
    );
    if (pick?.q !== "480p") fail(`manual 480p pick was not learned (picked ${JSON.stringify(pick)})`);
  } else {
    console.log("no 480p row available — learning test skipped (covered by 720p set)");
  }

  await page.screenshot({ path: "/tmp/desktop-pick.png" });
  console.log("ALL PASS");
} catch (e) {
  await page.screenshot({ path: "/tmp/desktop-pick-fail.png" }).catch(() => {});
  fail(e.message || String(e));
} finally {
  await browser.close();
}

import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Cloudflare clearance layer for scrapers whose targets sit behind a JS
 * challenge (1337x mirrors). Plain fetch/curl gets a "Just a moment…" page
 * from those hosts; the fix is a headless Chromium pass that solves the
 * challenge once, hands back the page HTML plus the cf_clearance cookie, and
 * caches the cookie for later replays through curl (same UA + same egress IP
 * — clearance is bound to both, which holds because the mint and every
 * replay happen inside the same deployment container).
 *
 * Everything degrades to a no-op when playwright-core or a Chromium binary is
 * missing (local dev, images without it): the callers just fall back to the
 * providers that answer.
 *
 * Mints are serialized per host and rate-limited (one attempt per 60 s) — a
 * challenge that beats the headless browser must not turn into a hammer.
 */

interface Clearance {
  cookie: string;
  ua: string;
  /** epoch ms after which the cached cookie is presumed dead */
  until: number;
}

const clearanceCache = new Map<string, Clearance>();
const minting = new Map<string, Promise<Clearance | null>>();
const lastMintAt = new Map<string, number>();
const MINT_MIN_INTERVAL_MS = 60_000;
const DEFAULT_COOKIE_TTL_MS = 30 * 60_000;

/** last mint failure reason — surfaced by /api/torrent/cfdebug so a silent
 *  no-op on the deployment is diagnosable from the outside */
let lastError: string | null = null;
let moduleState: "unchecked" | "ok" | "missing" = "unchecked";

export interface CfDebug {
  moduleState: string;
  chromiumPath: string | null;
  chromiumPresent: boolean;
  lastError: string | null;
  cachedHosts: string[];
  ua: string;
}

export function cfDebug(): CfDebug {
  const p = chromiumPath();
  return {
    moduleState,
    chromiumPath: p,
    chromiumPresent: !!p,
    lastError,
    cachedHosts: [...clearanceCache.keys()],
    ua: "",
  };
}

function hostOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

function chromiumPath(): string {
  const fromEnv = process.env.PLAYWRIGHT_CHROMIUM_PATH?.trim();
  if (fromEnv) return fromEnv;
  try {
    const fs = require("node:fs") as typeof import("node:fs");
    const path = require("node:path") as typeof import("node:path");
    if (fs.existsSync("/usr/bin/chromium")) return "/usr/bin/chromium";
    // browsers fetched by `playwright-core install chromium` with
    // PLAYWRIGHT_BROWSERS_PATH=0 land inside the package — the layout the
    // runtime bootstrap in this module produces on the deployment
    const dir = path.join(process.cwd(), "node_modules", "playwright-core", ".local-browsers");
    if (!fs.existsSync(dir)) return "";
    // prefer the full chrome binary over the more-detectable headless shell;
    // layout moved chrome-linux/ → chrome-linux64/ in playwright 1248+
    for (const pattern of ["chromium-", "chromium_headless_shell-"]) {
      const versions = fs
        .readdirSync(dir)
        .filter((d) => d.startsWith(pattern))
        .sort()
        .reverse();
      for (const v of versions) {
        for (const bin of [
          "chrome-linux64/chrome",
          "chrome-linux/chrome",
          "chrome-linux64/headless_shell",
          "chrome-linux/headless_shell",
        ]) {
          const p = path.join(dir, v, bin);
          if (fs.existsSync(p)) return p;
        }
      }
    }
    return "";
  } catch {
    return "";
  }
}

/** curl replay of a cached clearance cookie — cheap, no browser needed. */
function curlWithClearance(url: string, ua: string, cookie: string): Promise<string> {
  return new Promise<string>((resolve) => {
    execFile(
      "curl",
      ["-sL", "-m", "10", "-A", ua, "-b", `cf_clearance=${cookie}`, url],
      { timeout: 14000, maxBuffer: 6 << 20 },
      (err, stdout) => resolve(err ? "" : String(stdout))
    );
  });
}

const isChallenge = (html: string) =>
  !html || html.includes("Just a moment") || /cf-chl|challenge-platform/.test(html.slice(0, 4000));

/**
 * Solve the challenge for one URL in headless Chromium and cache the
 * clearance cookie for the whole host. Resolves null when no browser is
 * available or the challenge holds.
 */
async function mint(url: string, ua: string, waitMs: number): Promise<Clearance | null> {
  const host = hostOf(url);
  if (!host) return null;
  const execPath = chromiumPath();
  if (!execPath) {
    lastError = `chromium binary not found (PLAYWRIGHT_CHROMIUM_PATH=${
      process.env.PLAYWRIGHT_CHROMIUM_PATH || "unset"
    })`;
    return null;
  }
  let pw: typeof import("playwright-core");
  try {
    pw = await import("playwright-core");
    moduleState = "ok";
  } catch (e) {
    moduleState = "missing";
    lastError = `playwright-core import failed: ${e instanceof Error ? e.message.slice(0, 120) : "?"}`;
    return null; // playwright-core not installed
  }
  let browser: import("playwright-core").Browser | null = null;
  try {
    browser = await pw.chromium.launch({
      executablePath: execPath,
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--disable-blink-features=AutomationControlled",
        "--window-size=1366,850",
        "--lang=en-US",
      ],
    });
    const ctx = await browser.newContext({
      userAgent: ua,
      viewport: { width: 1366, height: 850 },
      locale: "en-US",
    });
    const page = await ctx.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20_000 });

    // wait out the JS challenge: the page stops being "Just a moment…" and
    // real content (links) appears
    const deadline = Date.now() + waitMs;
    let html = "";
    while (Date.now() < deadline) {
      await page.waitForTimeout(700);
      html = await page.content().catch(() => "");
      if (html && !isChallenge(html)) break;
    }
    html = html || (await page.content().catch(() => ""));
    if (isChallenge(html)) {
      lastError = "challenge held: headless browser did not clear it";
      return null;
    }

    const cookies = await ctx.cookies();
    const clearance = cookies.find((c) => c.name === "cf_clearance");
    if (!clearance) {
      lastError = "challenge passed but no cf_clearance cookie was issued";
      return null;
    }
    const ttl =
      clearance.expires > 0
        ? clearance.expires * 1000 - Date.now() - 60_000
        : DEFAULT_COOKIE_TTL_MS;
    const rec: Clearance = {
      cookie: clearance.value,
      ua,
      until: Date.now() + Math.min(Math.max(ttl, 5 * 60_000), 6 * 3600_000),
    };
    clearanceCache.set(host, rec);
    lastError = null;
    return rec;
  } catch (e) {
    lastError = `browser launch/navigation failed: ${
      e instanceof Error ? e.message.slice(0, 160) : "?"
    }`;
    return null;
  } finally {
    await browser?.close().catch(() => undefined);
  }
}

/**
 * Fetch a CF-walled page: replay a cached clearance cookie through curl when
 * fresh, otherwise mint a new one in the browser and return the solved page
 * HTML directly. Returns "" when everything is challenged or unavailable.
 */
export async function clearancedPage(
  url: string,
  ua: string,
  waitMs = 12_000
): Promise<string> {
  const host = hostOf(url);
  if (!host) return "";

  const cached = clearanceCache.get(host);
  if (cached && cached.until > Date.now()) {
    const html = await curlWithClearance(url, cached.ua, cached.cookie);
    if (!isChallenge(html)) return html;
    clearanceCache.delete(host); // stale cookie — fall through to a re-mint
  }

  if (Date.now() - (lastMintAt.get(host) ?? 0) < MINT_MIN_INTERVAL_MS) return "";
  lastMintAt.set(host, Date.now());

  let p = minting.get(host);
  if (!p) {
    p = mint(url, ua, waitMs).finally(() => minting.delete(host));
    minting.set(host, p);
  }
  const rec = await p;
  if (!rec) return "";
  // the mint itself may have solved a different path on the same host —
  // replay this exact URL with the fresh cookie
  const html = await curlWithClearance(url, rec.ua, rec.cookie);
  return isChallenge(html) ? "" : html;
}

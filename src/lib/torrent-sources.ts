/**
 * Multi-provider torrent search with strict content matching.
 *
 * Providers are tried in parallel and merged — if one is unreachable
 * (Cloudflare, DNS block, rate limit) it is simply skipped and the others
 * still answer. Every result is normalized to a common shape, validated
 * against the requested title/year/season/episode (so same-named movies and
 * series episodes never get mixed) and scored so the player can pick the
 * best server automatically.
 */
import { execFile } from "node:child_process";
import { getAbsoluteEpisode, getImdbId, getTitleMeta, tmdbServer } from "./tmdb-server";
import {
  bestTitleMatch,
  countryPenalty,
  matchMovie,
  matchTv,
  parseRelease,
  subtitleWords,
  type MatchClass,
  type ParsedRelease,
} from "./torrent-match";
import { mapPool, pacedFetch, pacedJson } from "./net-pacer";

export interface TorrentSource {
  /** BitTorrent info hash (40 hex chars) — doubles as the server id */
  id: string;
  releaseName: string;
  seeders: number;
  peers: number;
  sizeBytes: number;
  provider: string;
  quality: string;
  /** provider-hinted video file index (used by multi-file episode packs) */
  fileIdx: number | null;
  /** how tightly the release name matches the requested content */
  match: MatchClass;
  /** negative when the release is tagged with a country the show isn't from */
  countryPenalty?: number;
  /** broadcast-order episode of the requested anime episode (TMDB season
   *  math) — lets the stream route pick "S17E14" inside a pack that answers
   *  a S02E01 request */
  absEpisode?: number | null;
  score: number;
}

/* ---------- parsing helpers ---------- */

function parseCount(raw: string | undefined | null): number {
  if (!raw) return 0;
  const m = raw.replace(/,/g, "").trim().match(/^([\d.]+)\s*([KM])?$/i);
  if (!m) return 0;
  const n = parseFloat(m[1]);
  const mult = m[2]?.toUpperCase() === "K" ? 1e3 : m[2]?.toUpperCase() === "M" ? 1e6 : 1;
  return Math.round((isFinite(n) ? n : 0) * mult);
}

function parseSizeBytes(raw: string | undefined | null): number {
  if (!raw) return 0;
  const m = raw.replace(/,/g, "").match(/([\d.]+)\s*(B|KB|MB|GB|TB)/i);
  if (!m) return 0;
  const n = parseFloat(m[1]);
  const unit = m[2].toUpperCase();
  const mult = unit === "TB" ? 1e12 : unit === "GB" ? 1e9 : unit === "MB" ? 1e6 : unit === "KB" ? 1e3 : 1;
  return Math.round((isFinite(n) ? n : 0) * mult);
}

function detectQuality(name: string): string {
  const n = name.toLowerCase();
  if (/\b(2160p|4k)\b/.test(n)) return "2160p";
  if (/\b1080p\b/.test(n)) return "1080p";
  if (/\b720p\b/.test(n)) return "720p";
  if (/\b480p\b|\bdvdrip\b|\bdvd\b/.test(n)) return "480p";
  if (/\b(360p|sd)\b/.test(n)) return "SD";
  return "unknown";
}

async function fetchJson<T>(url: string, timeoutMs = 8000): Promise<T | null> {
  // paced per host + global cap; slow indexers get at least 12s before the
  // abort fires — cutting them off early just wasted the request
  return pacedJson<T>(url, Math.max(timeoutMs, 12000));
}

/* ---------- strict validation ---------- */

/**
 * Name-based sanity check applied even to IMDb-keyed providers: indexers
 * sometimes attach wrong IMDb ids to uploads, so a release whose own name
 * contradicts the request (wrong year / wrong episode) is dropped no matter
 * which provider supplied it.
 */
function sanityOk(
  p: ParsedRelease,
  type: "movie" | "tv",
  year: string,
  season: number,
  episode: number
): boolean {
  if (type === "movie") {
    if (p.year !== null && year && Math.abs(p.year - Number(year)) > 1) return false;
    return true;
  }
  if (p.season !== null && p.season !== season) return false;
  if (p.episode !== null && p.episode !== episode) return false;
  return true;
}

/* ---------- providers ---------- */

interface TorrentioStream {
  name?: string;
  title?: string;
  infoHash?: string;
  fileIdx?: number;
  behaviorHints?: { filename?: string };
}

/** IMDb-keyed — but indexers mislabel ids, so names are still cross-checked. */
async function providerTorrentio(
  type: "movie" | "tv",
  imdbId: string,
  ctx: BayContext,
  year: string,
  airDate: string | null
): Promise<TorrentSource[]> {
  const season = ctx.season;
  const episode = ctx.episode;
  // Stremio addon stream ids are single segments: `tt…:season:episode`.
  // (slash-separated paths 404 since the 2026 addon API tightening)
  const path =
    type === "movie"
      ? `stream/movie/${imdbId}.json`
      : `stream/series/${imdbId}:${season}:${episode}.json`;
  const data = await fetchJson<{ streams?: TorrentioStream[] }>(
    `https://torrentio.strem.fun/${path}`
  );
  const streams = data?.streams ?? [];
  const out: TorrentSource[] = [];
  for (const s of streams) {
    if (!s.infoHash || !/^[0-9a-f]{40}$/i.test(s.infoHash)) continue;
    const titleLines = (s.title ?? "").split("\n");
    const releaseName = (titleLines[0] || s.behaviorHints?.filename || "Torrent").trim();
    // indexers occasionally attach a wrong IMDb id — cross-check the name
    const parsed = parseRelease(releaseName);
    if (!sanityOk(parsed, type, year, season, episode)) continue;
    // full name-level validation: same title, right episode, plausible air
    // year — "ONE PIECE 2023" (the live action) must never answer for the anime
    const match =
      type === "tv"
        ? matchTv(parsed, season, episode, ctx.title, ctx.originalTitle, {
            airDate,
            showLang: ctx.showLang ?? null,
            absEpisode: ctx.absEpisode ?? null,
            relEpisode: ctx.relEpisode ?? null,
          })
        : matchMovie(parsed, ctx.title, ctx.originalTitle, ctx.year);
    if (!match) continue;
    const metaLine = titleLines.find((l) => l.includes("👤")) ?? "";
    const seeders = parseCount(metaLine.match(/👤\s*([\d.,]+\s*[KM]?)/)?.[1]);
    const sizeBytes = parseSizeBytes(metaLine.match(/💾\s*([\d.,]+\s*[KMGTB]+)/i)?.[1]);
    const provider = metaLine.match(/⚙️\s*([^\n]+)/)?.[1]?.trim() || "Torrentio";
    const hintName = s.name ?? "";
    const quality =
      /4k/i.test(hintName) && !/1080p/.test(releaseName)
        ? "2160p"
        : detectQuality(releaseName);
    out.push({
      id: s.infoHash.toLowerCase(),
      releaseName,
      seeders,
      peers: 0,
      sizeBytes,
      provider,
      quality,
      fileIdx: typeof s.fileIdx === "number" ? s.fileIdx : null,
      match,
      score: 0,
    });
  }
  return out;
}

/** TMDB original_language code → the word Indian releases use for it */
export const LANG_WORD: Record<string, string> = {
  ta: "tamil",
  te: "telugu",
  hi: "hindi",
  ml: "malayalam",
  kn: "kannada",
  mr: "marathi",
  bn: "bengali",
  pa: "punjabi",
};

const pad = (n: number) => String(n).padStart(2, "0");

/** Air date (YYYY-MM-DD) of one episode — short TTL so brand-new daily-show
 *  episodes (Bigg Boss S20E55…) get their date as soon as TMDB publishes it. */
const seasonCache = new Map<string, { dates: Map<number, string | null>; ts: number }>();
const SEASON_TTL = 30 * 60 * 1000;

export async function getEpisodeAirDate(
  tmdbId: number,
  season: number,
  episode: number
): Promise<string | null> {
  const key = `tv:${tmdbId}:${season}`;
  let hit = seasonCache.get(key);
  if (!hit || Date.now() - hit.ts > SEASON_TTL) {
    try {
      const data = await tmdbServer<{
        episodes?: { episode_number: number; air_date: string | null }[];
      }>(`tv/${tmdbId}/season/${season}`);
      const dates = new Map<number, string | null>();
      for (const e of data.episodes ?? []) dates.set(e.episode_number, e.air_date ?? null);
      hit = { dates, ts: Date.now() };
      seasonCache.set(key, hit);
    } catch {
      return null;
    }
  }
  return hit.dates.get(episode) ?? null;
}

interface BayContext {
  title: string;
  originalTitle?: string;
  year?: string;
  countries: string[];
  season: number;
  episode: number;
  airDate?: string | null;
  showLang?: string | null;
  /** broadcast-order episode number (anime) */
  absEpisode?: number | null;
  /** fansub-relative episode for merged sequel seasons (anime: TMDB
   *  "Bleach" S02 = Thousand-Year Blood War, fansubs number it from 1) */
  relEpisode?: number | null;
  /** Japanese-language title → fansub indexers (Nyaa) get queried too */
  isAnime?: boolean;
}

interface BitsearchCard {
  hash: string;
  name: string;
  seeders: number;
  peers: number;
  sizeBytes: number;
}

/**
 * BitSearch (bitsearch.eu) — HTML search, the last live indexer when the
 * JSON APIs are down or blocked. It indexes Indian release groups
 * (1TamilBlasters, TamilMV, 3MovieRulz…) that upload daily-show episodes
 * ("Bigg Boss (2026) S09E101 …") hours after broadcast. Every row is
 * validated with the same strict matcher as the keyword providers.
 */
async function providerBitSearch(type: "movie" | "tv", ctx: BayContext): Promise<TorrentSource[]> {
  const { title, originalTitle, year, season, episode } = ctx;
  const queries =
    type === "movie"
      ? [`${title} ${year ?? ""}`.trim(), title]
      : [
          `${title} s${pad(season)}e${pad(episode)}`,
          `${title} season ${season}`, // dated daily shows + season packs
        ];
  // language picked in the player → also scan for dubs of that language

  const cards = new Map<string, BitsearchCard>();
  const scrape = async (q: string) => {
    try {
      const res = await pacedFetch(`https://bitsearch.eu/search?q=${encodeURIComponent(q)}`, {
        headers: {
          accept: "text/html,application/xhtml+xml",
          "user-agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        },
        timeoutMs: 13000,
        redirect: "follow",
      });
      if (!res.ok) return;
      const html = (await res.text()).replace(/\s+/g, " ");
      const re = /\/download\/torrent\/([0-9a-fA-F]{40})\?title=([^">]+)/g;
      for (const m of html.matchAll(re)) {
        const hash = m[1].toLowerCase();
        if (cards.has(hash)) continue;
        let name = m[2];
        try { name = decodeURIComponent(name); } catch { /* raw text fallback */ }
        name = name
          .replace(/&amp;/g, "&")
          .replace(/&#x3D;|&#61;/gi, "=")
          .replace(/&quot;/gi, '"')
          .replace(/&#39;/g, "'")
          .trim();
        const win = html.slice(Math.max(0, m.index - 2200), m.index);
        const seeders = Number(win.match(/font-medium">(\d+)<\/span>\s*<span>\s*seeders/)?.[1] ?? 0);
        const peers = Number(win.match(/font-medium">(\d+)<\/span>\s*<span>\s*leechers/)?.[1] ?? 0);
        const sizeBytes = parseSizeBytes(
          win.match(/fa-download"><\/i>\s*<span>\s*([\d.]+\s*[KMGT]?B)</i)?.[1] ?? null
        );
        cards.set(hash, { hash, name, seeders, peers, sizeBytes });
      }
    } catch {
      // blocked / timed out — the other providers still answer
    }
  };

  // bitsearch is the most rate-limit-sensitive scraper: one query at a time,
  // spaced by the pacer — a parallel burst here got the whole site to choke
  await mapPool(queries, 1, scrape);

  const out: TorrentSource[] = [];
  for (const c of cards.values()) {
    const p = parseRelease(c.name);
    const match =
      type === "movie"
        ? matchMovie(p, title, originalTitle, year)
        : matchTv(p, season, episode, title, originalTitle, {
            airDate: ctx.airDate,
            showLang: ctx.showLang,
            absEpisode: ctx.absEpisode,
          });
    if (!match) continue; // same name, wrong season/episode/year — reject
    if (type === "tv" && countryPenalty(p, ctx.countries) < 0) continue;
    out.push({
      id: c.hash,
      releaseName: c.name,
      seeders: c.seeders,
      peers: c.peers,
      sizeBytes: c.sizeBytes,
      provider: "BitSearch",
      quality: detectQuality(c.name),
      fileIdx: null,
      match,
      score: 0,
    });
  }
  return out;
}

interface TorrentsCsvRow {
  infohash?: string;
  name?: string;
  size_bytes?: number;
  seeders?: number;
  leechers?: number;
}

/**
 * torrents-csv.com — open torrent database with a JSON API. It indexes the
 * Indian release groups (TamilMV / TamilBlasters / 5MovieRulz …) that publish
 * daily-show episodes hours after broadcast ("BIGG BOSS (Telugu) S10 EP21 …"),
 * which the western trackers are slow to pick up. Every row is validated with
 * the same strict matcher as the other keyword providers.
 */
async function providerTorrentsCsv(type: "movie" | "tv", ctx: BayContext): Promise<TorrentSource[]> {
  const { title, originalTitle, year, season, episode } = ctx;
  const queries =
    type === "movie"
      ? [`${title} ${year ?? ""}`.trim(), title]
      : [
          `${title} ${ctx.showLang ?? ""}`.trim(), // "Bigg Boss Telugu" — current-season uploads
          `${title} s${pad(season)}e${pad(episode)}`,
          `${title} season ${season}`,
          title,
        ];
  const seen = new Map<string, TorrentSource>();
  for (const q of queries) {
    if (seen.size >= 15) break;
    const data = await fetchJson<{ torrents?: TorrentsCsvRow[] }>(
      `https://torrents-csv.com/service/search?q=${encodeURIComponent(q)}&size=100`,
      8000
    );
    for (const r of data?.torrents ?? []) {
      if (!r.infohash || !/^[0-9a-f]{40}$/i.test(r.infohash)) continue;
      const name = (r.name ?? "Torrent").trim();
      const p = parseRelease(name);
      const match =
        type === "movie"
          ? matchMovie(p, title, originalTitle, year)
          : matchTv(p, season, episode, title, originalTitle, {
              airDate: ctx.airDate,
              showLang: ctx.showLang,
              absEpisode: ctx.absEpisode,
            });
      if (!match) continue; // same name, different film/episode/language — reject
      if (type === "tv" && countryPenalty(p, ctx.countries) < 0) continue;
      const key = r.infohash.toLowerCase();
      if (seen.has(key)) continue;
      seen.set(key, {
        id: key,
        releaseName: name,
        seeders: r.seeders ?? 0,
        peers: r.leechers ?? 0,
        sizeBytes: r.size_bytes ?? 0,
        provider: "TorrentsCSV",
        quality: detectQuality(name),
        fileIdx: null,
        match,
        score: 0,
      });
    }
  }
  return [...seen.values()];
}

interface SolidTorrentsRow {
  infohash?: string;
  title?: string;
  size?: number;
  /** older API responses carried a swarm object; newer ones may omit it */
  swarm?: { seeders?: number; leechers?: number } | null;
  seeders?: number;
  leechers?: number;
}

/**
 * SolidTorrents — JSON API index (solidtorrents.eu; the .to domain redirects
 * and answers the same shape). Infohash-keyed so results stream directly from
 * the engine. Seed counts are often absent — unknown-seeder rows rank low in
 * merge() but still give the player a working backup pipe when the big
 * indexers are walled. Verified reachable 2026-11-01.
 */
const SOLID_HOSTS = ["solidtorrents.eu", "solidtorrents.to"];

async function providerSolidTorrents(
  type: "movie" | "tv",
  ctx: BayContext
): Promise<TorrentSource[]> {
  const { title, originalTitle, year, season, episode } = ctx;
  const queries =
    type === "movie"
      ? [`${title} ${year ?? ""}`.trim(), title]
      : [
          `${title} s${pad(season)}e${pad(episode)}`,
          `${title} ${ctx.showLang ?? ""}`.trim(),
          title,
        ];
  const seen = new Map<string, TorrentSource>();
  for (const q of queries) {
    if (seen.size >= 15) break;
    let data: { results?: SolidTorrentsRow[] } | null = null;
    for (const host of SOLID_HOSTS) {
      data = await fetchJson<{ results?: SolidTorrentsRow[] }>(
        `https://${host}/api/v1/search?q=${encodeURIComponent(q)}`,
        8000
      );
      if (data) break; // any well-formed answer ends the chain
    }
    for (const r of data?.results ?? []) {
      if (!r.infohash || !/^[0-9a-f]{40}$/i.test(r.infohash)) continue;
      const name = (r.title ?? "Torrent").trim();
      const p = parseRelease(name);
      const match =
        type === "movie"
          ? matchMovie(p, title, originalTitle, year)
          : matchTv(p, season, episode, title, originalTitle, {
              airDate: ctx.airDate,
              showLang: ctx.showLang,
              absEpisode: ctx.absEpisode,
            });
      if (!match) continue;
      if (type === "tv" && countryPenalty(p, ctx.countries) < 0) continue;
      const key = r.infohash.toLowerCase();
      if (seen.has(key)) continue;
      seen.set(key, {
        id: key,
        releaseName: name,
        seeders: r.swarm?.seeders ?? r.seeders ?? 0,
        peers: r.swarm?.leechers ?? r.leechers ?? 0,
        sizeBytes: r.size ?? 0,
        provider: "SolidTorrents",
        quality: detectQuality(name),
        fileIdx: null,
        match,
        score: 0,
      });
    }
  }
  return [...seen.values()];
}

/* ---------- the pirate bay (apibay.org — official TPB API) ---------- */

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

interface ApibayRow {
  name?: string;
  info_hash?: string;
  leechers?: string;
  seeders?: string;
  /** bytes as a string */
  size?: string;
  /** "tt1375666" — present on movie rows, empty on most TV rows */
  imdb?: string;
  category?: string;
}

/**
 * The Pirate Bay via apibay.org (the API the TPB front-ends run on). Sits
 * behind Cloudflare and rate-limits hard — requests go through the per-host
 * pacer with a browser UA, and a challenge page ("Just a moment…") is treated
 * as "provider down", never parsed. Rows on movie searches carry the upload's
 * IMDb id, which pins the torrent to the requested title exactly like YTS.
 */
async function apibayQuery(q: string): Promise<ApibayRow[]> {
  const url = `https://apibay.org/q.php?q=${encodeURIComponent(q)}`;
  // apibay's Cloudflare challenges non-browser TLS fingerprints — BOTH undici
  // (Node) and bun get "Just a moment…" regardless of UA (verified 2026-11-03:
  // curl answers clean JSON where fetch gets a 5.6 KB challenge page). So the
  // fetch path is attempted first and, on a challenge, the same request is
  // retried through curl, whose TLS fingerprint CF reliably lets through.
  // curl ships in the Debian-based images the site deploys on; when it is
  // missing the provider simply goes quiet like any other dead source.
  let text = "";
  try {
    const res = await pacedFetch(url, {
      headers: { accept: "application/json", "user-agent": BROWSER_UA },
      timeoutMs: 12000,
    });
    if (res.ok) text = await res.text();
  } catch {
    // fall through to the curl retry
  }
  if (!text.trim().startsWith("[")) {
    text = await new Promise<string>((resolve) => {
      execFile(
        "curl",
        ["-s", "-m", "12", "-A", BROWSER_UA, "-H", "accept: application/json", url],
        { timeout: 15000, maxBuffer: 4 << 20 },
        (err, stdout) => resolve(err ? "" : String(stdout))
      );
    });
  }
  if (!text.trim().startsWith("[")) return []; // still challenged / HTML error
  try {
    const rows = JSON.parse(text) as ApibayRow[];
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

async function providerApibay(
  type: "movie" | "tv",
  imdbId: string | null,
  ctx: BayContext
): Promise<TorrentSource[]> {
  const { title, originalTitle, year, season, episode } = ctx;
  const queries =
    type === "movie"
      ? [`${title} ${year ?? ""}`.trim(), title]
      : [
          `${title} s${pad(season)}e${pad(episode)}`,
          `${title} season ${season}`,
          title,
        ];
  const seen = new Map<string, TorrentSource>();
  for (const q of queries) {
    if (seen.size >= 15) break;
    for (const r of await apibayQuery(q)) {
      if (!r.info_hash || !/^[0-9a-f]{40}$/i.test(r.info_hash)) continue; // "No results" row too
      // a row tagged with a DIFFERENT imdb id is a different film — drop it
      if (r.imdb && imdbId && r.imdb.toLowerCase() !== imdbId.toLowerCase()) continue;
      const name = (r.name ?? "Torrent").trim();
      const p = parseRelease(name);
      const match =
        type === "movie"
          ? matchMovie(p, title, originalTitle, year)
          : matchTv(p, season, episode, title, originalTitle, {
              airDate: ctx.airDate,
              showLang: ctx.showLang,
              absEpisode: ctx.absEpisode,
            });
      if (!match) continue;
      if (type === "tv" && countryPenalty(p, ctx.countries) < 0) continue;
      const key = r.info_hash.toLowerCase();
      if (seen.has(key)) continue;
      seen.set(key, {
        id: key,
        releaseName: name,
        seeders: Number(r.seeders) || 0,
        peers: Number(r.leechers) || 0,
        sizeBytes: Number(r.size) || 0,
        provider: "PirateBay",
        quality: detectQuality(name),
        fileIdx: null,
        match,
        score: 0,
      });
    }
  }
  return [...seen.values()];
}

interface YtsTorrent {  hash?: string;
  quality?: string;
  type?: string;
  size?: string;
  size_bytes?: number;
  seeds?: number;
  peers?: number;
}

interface YtsMovie {
  title?: string;
  year?: number;
  imdb_code?: string;
  torrents?: YtsTorrent[];
}

interface YtsResponse {
  data?: { movies?: YtsMovie[] | null; movie_count?: number };
}

/**
 * YTS — the clean-encode movie tracker (1080p/2160p x264, universally
 * browser-playable). The official yts.mx is unreachable from this deployment
 * and several mirror domains are CF-walled, but yts.rs mirrors the same
 * api-v2 shape and answers fine (verified 2026-11-01). Keyword search is
 * mirrored but IMDb search is not, so we query by title and pin the movie
 * down by its imdb_code; every release name is still passed through the
 * strict movie matcher like any keyword provider.
 */
const YTS_HOSTS = ["yts.rs", "yts.mx", "yts.bz"];

async function ytsMovies(query: string): Promise<YtsMovie[]> {
  for (const host of YTS_HOSTS) {
    const data = await fetchJson<YtsResponse>(
      `https://${host}/api/v2/list_movies.json?query_term=${encodeURIComponent(query)}&limit=50&sort_by=seeders&order_by=desc`,
      8000
    );
    if (data) return data.data?.movies ?? []; // any well-formed answer ends the chain
  }
  return [];
}

async function providerYts(
  type: "movie" | "tv",
  imdbId: string,
  ctx: BayContext
): Promise<TorrentSource[]> {
  if (type !== "movie") return []; // YTS carries movies only
  const { title, originalTitle, year } = ctx;
  const out: TorrentSource[] = [];
  for (const q of [title, ...(originalTitle && originalTitle !== title ? [originalTitle] : [])]) {
    const movies = await ytsMovies(q);
    for (const m of movies) {
      if (!m.imdb_code || m.imdb_code.toLowerCase() !== imdbId.toLowerCase()) continue;
      const movieYear = m.year ? String(m.year) : year || "";
      for (const t of m.torrents ?? []) {
        if (!t.hash || !/^[0-9a-f]{40}$/i.test(t.hash)) continue;
        // reconstruct a scene-style release name (YTS API exposes quality but
        // not the scene name) so parseRelease/matchMovie can validate it
        const releaseName = [
          m.title ?? title,
          movieYear,
          t.quality ?? "",
          t.type === "web" ? "WEB" : "BluRay",
          "x264",
          "YIFY",
        ]
          .filter(Boolean)
          .join(".")
          .replace(/[:']/g, "")
          .replace(/\s+/g, ".");
        const parsed = parseRelease(releaseName);
        if (!sanityOk(parsed, "movie", year || movieYear, 1, 1)) continue;
        const match = matchMovie(parsed, title, originalTitle, year || movieYear);
        if (!match) continue; // mislabeled imdb_code — same-name different film
        out.push({
          id: t.hash.toLowerCase(),
          releaseName,
          seeders: t.seeds ?? 0,
          peers: t.peers ?? 0,
          sizeBytes: t.size_bytes ?? parseSizeBytes(t.size),
          provider: "YTS",
          quality: t.quality ?? detectQuality(releaseName),
          fileIdx: null,
          match,
          score: 0,
        });
      }
    }
    if (out.length > 0) break; // first query that identifies the movie wins
  }
  return out;
}

/* ---------- knaben (aggregator over 1337x, TorrentGalaxy, TPB …) ---------- */

interface KnabenRow {
  title?: string;
  infoHash?: string;
  seeders?: number;
  peers?: number;
  sizeBytes?: number | string;
}

/**
 * Knaben — a public JSON search API over a dozen trackers (1337x,
 * TorrentGalaxy, TPB mirrors …), so one call covers indexers that each sit
 * behind their own Cloudflare wall. The service flaps between hosts
 * (api.knaben.eu 503s while knaben.eu answers); both are tried and the
 * circuit breaker benches the provider when neither answers.
 */
async function knabenSearch(query: string): Promise<KnabenRow[]> {
  for (const host of ["https://api.knaben.eu", "https://knaben.eu"]) {
    try {
      const res = await pacedFetch(`${host}/api/v1/search`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          "user-agent": BROWSER_UA,
        },
        body: JSON.stringify({ query, limit: 40 }),
        // two hosts × 5 s keeps the double-retry inside the 10 s provider
        // deadline — a flapping Knaben must not stretch every search
        timeoutMs: 5000,
      });
      if (!res.ok) continue;
      const data = (await res.json()) as { torrents?: KnabenRow[] };
      const rows = data.torrents;
      if (Array.isArray(rows) && rows.length) return rows;
    } catch {
      // try the next host
    }
  }
  return [];
}

async function providerKnaben(type: "movie" | "tv", ctx: BayContext): Promise<TorrentSource[]> {
  const { title, originalTitle, year, season, episode } = ctx;
  if (!title) return [];
  const queries =
    type === "movie"
      ? [`${title} ${year ?? ""}`.trim()]
      : [`${title} s${pad(season)}e${pad(episode)}`, `${title} ${year ?? ""}`.trim()];
  const out: TorrentSource[] = [];
  const seen = new Set<string>();
  for (const q of queries) {
    if (out.length >= 25) break;
    for (const r of await knabenSearch(q)) {
      const infoHash = (r.infoHash ?? "").toLowerCase();
      const name = (r.title ?? "").trim();
      if (!/^[0-9a-f]{40}$/.test(infoHash) || !name || seen.has(infoHash)) continue;
      seen.add(infoHash);
      const p = parseRelease(name);
      const match =
        type === "movie"
          ? matchMovie(p, title, originalTitle, year ?? "")
          : matchTv(p, season, episode, title, originalTitle, {
              airDate: ctx.airDate,
              showLang: ctx.showLang,
              absEpisode: ctx.absEpisode,
            });
      if (!match) continue;
      if (type === "tv" && countryPenalty(p, ctx.countries) < 0) continue;
      out.push({
        id: infoHash,
        releaseName: name,
        seeders: Math.max(0, Number(r.seeders) || 0),
        peers: Math.max(0, Number(r.peers) || 0),
        sizeBytes: Number(r.sizeBytes) || 0,
        provider: "Knaben",
        quality: detectQuality(name),
        fileIdx: null,
        match,
        score: 0,
      });
    }
  }
  return out;
}

/* ---------- 1337x (mirror rotation + detail-page magnets) ---------- */

const X1337_HOSTS = [
  "https://1337x.to",
  "https://1337xx.to",
  "https://x1337x.ws",
  "https://1337x.gd",
];

function decodeHtml(s: string): string {
  return s
    .replace(/&#0?39;|&apos;|&#x27;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** 1337x pages through fetch first; on a Cloudflare challenge the same URL is
 *  retried via curl — whose TLS fingerprint CF lets through on several of the
 *  mirrors (the same trick that keeps apibay alive). */
async function x1337Page(url: string): Promise<string> {
  try {
    const res = await pacedFetch(url, {
      headers: { accept: "text/html", "user-agent": BROWSER_UA },
      timeoutMs: 8000,
    });
    if (res.ok) {
      const t = await res.text();
      if (!t.includes("Just a moment")) return t;
    }
  } catch {
    // fall through to the curl retry
  }
  return new Promise<string>((resolve) => {
    execFile(
      "curl",
      ["-sL", "-m", "8", "-A", BROWSER_UA, url],
      { timeout: 12000, maxBuffer: 4 << 20 },
      (err, stdout) => resolve(err ? "" : String(stdout))
    );
  });
}

/**
 * 1337x — one of the largest public trackers. No API: search rows carry only
 * a detail-page link; the info hash lives on that detail page. So the search
 * page is scraped for rows (name, seeders, size), then the top few detail
 * pages are fetched for their magnet hash. Capped at 4 rows per search to
 * stay inside the 10 s provider deadline; the strict matcher filters junk.
 */
async function provider1337x(type: "movie" | "tv", ctx: BayContext): Promise<TorrentSource[]> {
  const { title, originalTitle, year, season, episode } = ctx;
  if (!title) return [];
  const slug = encodeURIComponent(
    (type === "movie" ? `${title} ${year ?? ""}` : `${title} s${pad(season)}e${pad(episode)}`).trim()
  ).replace(/%20/g, "+");
  let html = "";
  for (const host of X1337_HOSTS) {
    html = await x1337Page(`${host}/search/${slug}/1/`);
    if (html) break;
  }
  if (!html) return [];

  interface X1337Row {
    href: string;
    name: string;
    seeders: number;
    peers: number;
    sizeBytes: number;
  }
  const rows: X1337Row[] = [];
  const seenHref = new Set<string>();
  for (const trChunk of html.split("<tr>")) {
    const href = trChunk.match(/href="(\/torrent\/[^"]+\/)"/)?.[1];
    if (!href || seenHref.has(href)) continue;
    const rawName =
      trChunk.match(/<a[^>]+href="\/torrent\/[^"]+\/"[^>]*title="([^"]+)"/)?.[1] ??
      trChunk.match(/<a[^>]+href="\/torrent\/[^"]+\/"[^>]*>([\s\S]*?)<\/a>/)?.[1] ??
      "";
    const name = decodeHtml(rawName.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
    if (!name || name.length < 6) continue;
    seenHref.add(href);
    const cell = (cls: string) =>
      trChunk.match(new RegExp(`class="${cls}[^"]*"[^>]*>([\\d,.]+)`))?.[1] ?? "";
    const sizeRaw = trChunk.match(/class="coll-4[^"]*"[^>]*>([\d.]+\s*[KMGTP]?B?)</i)?.[1] ?? "";
    rows.push({
      href,
      name,
      seeders: Number(cell("coll-2").replace(/[,.]/g, "")) || 0,
      peers: Number(cell("coll-3").replace(/[,.]/g, "")) || 0,
      sizeBytes: parseSizeBytes(sizeRaw.replace(/i/g, "")),
    });
    if (rows.length >= 12) break;
  }

  // resolve hashes: fetch detail pages for the top candidates, 2 at a time
  const out: TorrentSource[] = [];
  await mapPool(rows.slice(0, 6), 2, async (row) => {
    if (out.length >= 4) return;
    const detailHost = X1337_HOSTS[0];
    const page = await x1337Page(`${detailHost}${row.href}`);
    const infoHash = page.match(/magnet:\?xt=urn:btih:([0-9a-fA-F]{40})/)?.[1]?.toLowerCase();
    if (!infoHash) return;
    const p = parseRelease(row.name);
    const match =
      type === "movie"
        ? matchMovie(p, title, originalTitle, year ?? "")
        : matchTv(p, season, episode, title, originalTitle, {
            airDate: ctx.airDate,
            showLang: ctx.showLang,
            absEpisode: ctx.absEpisode,
          });
    if (!match) return;
    if (type === "tv" && countryPenalty(p, ctx.countries) < 0) return;
    out.push({
      id: infoHash,
      releaseName: row.name,
      seeders: row.seeders,
      peers: row.peers,
      sizeBytes: row.sizeBytes,
      provider: "1337x",
      quality: detectQuality(row.name),
      fileIdx: null,
      match,
      score: 0,
    });
  });
  return out;
}

/* ---------- EZTV (eztvx.re — imdb-pinned TV episode API) ---------- */

interface EztvRow {
  hash?: string;
  filename?: string;
  season_number?: number;
  episode_number?: number;
  seeds?: number;
  peers?: number;
  size_bytes?: number;
}

async function eztvSearch(imdbId: string): Promise<EztvRow[]> {
  for (const host of ["https://eztvx.re", "https://eztvz.xyz"]) {
    try {
      const res = await pacedFetch(
        `${host}/api/get-torrents?imdb_id=${encodeURIComponent(imdbId)}&limit=100`,
        { headers: { accept: "application/json", "user-agent": BROWSER_UA }, timeoutMs: 9000 }
      );
      if (!res.ok) continue;
      const data = (await res.json()) as { torrents?: EztvRow[] };
      if (Array.isArray(data.torrents)) return data.torrents;
    } catch {
      // try the next host
    }
  }
  return [];
}

/**
 * EZTV — TV episode specialist with a JSON API keyed by IMDb id (the API the
 * old eztv front-ends ran on; eztvx.re is the current host). One call lists
 * the whole show, so rows are pre-filtered by the API's own season/episode
 * numbers before the strict matcher validates the release name.
 */
async function providerEztv(
  type: "movie" | "tv",
  imdbId: string,
  ctx: BayContext
): Promise<TorrentSource[]> {
  if (type !== "tv" || !imdbId || !ctx.title) return [];
  const { title, originalTitle, season, episode } = ctx;
  const out: TorrentSource[] = [];
  for (const r of await eztvSearch(imdbId)) {
    const infoHash = (r.hash ?? "").toLowerCase();
    // eztv double-escapes filenames in the API payload
    const name = decodeHtml(r.filename ?? "").trim();
    if (!/^[0-9a-f]{40}$/.test(infoHash) || !name) continue;
    if (r.season_number != null && r.season_number > 0 && r.season_number !== season) continue;
    if (r.episode_number != null && r.episode_number > 0 && r.episode_number !== episode) continue;
    const p = parseRelease(name);
    const match = matchTv(p, season, episode, title, originalTitle, {
      airDate: ctx.airDate,
      showLang: ctx.showLang,
      absEpisode: ctx.absEpisode,
    });
    if (!match) continue;
    out.push({
      id: infoHash,
      releaseName: name,
      seeders: Math.max(0, Number(r.seeds) || 0),
      peers: Math.max(0, Number(r.peers) || 0),
      sizeBytes: Math.max(0, Number(r.size_bytes) || 0),
      provider: "EZTV",
      quality: detectQuality(name),
      fileIdx: null,
      match,
      score: 0,
    });
    if (out.length >= 20) break;
  }
  return out;
}

/* ---------- anime: nyaa.si (fansub indexers) ---------- */

interface NyaaItem {
  title: string;
  infoHash: string;
  seeders: number;
  leechers: number;
  sizeBytes: number;
  /** upload date (epoch ms) — identifies fresh sequel-episode fansubs */
  pubDate: number | null;
}

/** RSS search on nyaa.si — the primary public index for fansubbed anime. */
async function nyaaSearch(query: string): Promise<NyaaItem[]> {
  try {
    const res = await pacedFetch(
      `https://nyaa.si/?page=rss&f=0&c=0_0&q=${encodeURIComponent(query)}`,
      {
        headers: {
          accept: "application/rss+xml",
          "user-agent": "Mozilla/5.0 (X11; Linux x86_64) PopcornTime/1.0",
        },
        timeoutMs: 12000,
      }
    );
    if (!res.ok) return [];
    const xml = await res.text();
    const items: NyaaItem[] = [];
    for (const chunk of xml.split("<item>").slice(1)) {
      const pick = (re: RegExp) => chunk.match(re)?.[1]?.trim() ?? "";
      const title = pick(/<title>([\s\S]*?)<\/title>/);
      const infoHash = pick(/<nyaa:infoHash>([0-9a-fA-F]{40})<\/nyaa:infoHash>/).toLowerCase();
      if (!title || !infoHash) continue;
      // "1.4 GiB" → "1.4 GB" so the shared size parser understands it
      const sizeRaw = pick(/<nyaa:size>([\d.]+\s*[KMGTP]i?B)<\/nyaa:size>/).replace(/i/g, "");
      const pubRaw = pick(/<pubDate>([\s\S]*?)<\/pubDate>/);
      const pubMs = pubRaw ? new Date(pubRaw).getTime() : NaN;
      items.push({
        title,
        infoHash,
        seeders: parseInt(pick(/<nyaa:seeders>(\d+)<\/nyaa:seeders>/), 10) || 0,
        leechers: parseInt(pick(/<nyaa:leechers>(\d+)<\/nyaa:leechers>/), 10) || 0,
        sizeBytes: parseSizeBytes(sizeRaw),
        pubDate: Number.isFinite(pubMs) ? pubMs : null,
      });
    }
    return items;
  } catch {
    return [];
  }
}

/** "892-1085" / "1078.5-1085" / "E01-E52" batch range inside a fansub
 *  release name. */
export function batchRange(name: string): [number, number] | null {
  const m = name.match(/(\d{1,4})(?:\.\d)?\s*(?:[-–—~]|to)\s*E?(\d{1,4})\b/i);
  if (!m) return null;
  const a = Number(m[1]);
  const b = Number(m[2]);
  return b > a && b - a <= 400 ? [a, b] : null;
}

/**
 * Nyaa — fansubbed anime releases. Names use broadcast-order episode numbers
 * ("One Piece - 1085"), season/episode tags ("S02E05") or batch ranges
 * ("Season 20 (892-1085) Batch"), all handled via the strict matcher plus an
 * explicit absolute-episode check. Only enabled for Japanese titles.
 */
async function providerNyaa(type: "movie" | "tv", ctx: BayContext): Promise<TorrentSource[]> {
  const { title, originalTitle, season, episode, absEpisode, relEpisode, isAnime } = ctx;
  if (type !== "movie" && !isAnime && !title) return [];
  const wanted = absEpisode ?? episode;
  const relWanted = relEpisode ?? null;
  const queries =
    type === "movie"
      ? [`${title} ${ctx.year ?? ""}`.trim(), title, ...(originalTitle ? [originalTitle] : [])]
        : isAnime
          ? [
              // bare season tag ("…Blood War S02") — the weekly singles of the
              // whole season carry exactly this tag; proven largest yield
              `${title} S${pad(season)}`,
              `${title} s${pad(season)}e${pad(episode)}`,
              `${title} ${wanted}`,
              // merged sequel seasons are numbered CONTINUOUSLY from the
              // sequel series start by many groups ("Sennen Kessen-hen
              // S01E14" = the 14th TYBW episode = TMDB S02E01) — a different
              // number space from the per-season one
              ...(relWanted != null && relWanted !== wanted ? [`${title} ${relWanted}`] : []),
              ...(originalTitle ? [`${originalTitle} ${wanted}`] : []),
            ]
        : // western shows on Nyaa use standard SxxEyy naming — bare episode
          // numbers ("Friends 8") would just return noise
          [`${title} s${pad(season)}e${pad(episode)}`, title];
  const seen = new Map<string, TorrentSource>();
  // the matcher, not the fetch, is the filter — collect a real pool (each
  // query is a single RSS call) and let validation drop the wrong episodes
  for (const q of queries) {
    if (seen.size >= 40) break;
    const rows = await nyaaSearch(q);
    for (const r of rows) {
      if (seen.has(r.infoHash)) continue;
      const p = parseRelease(r.title);
      let match: MatchClass | null;
      if (type === "movie") {
        match = matchMovie(p, title, originalTitle, ctx.year);
      } else {
        match = matchTv(p, season, episode, title, originalTitle, {
          airDate: ctx.airDate,
          absEpisode,
          relEpisode: relWanted,
          pubDate: r.pubDate,
        });
        if (!match) {
          // multi-episode batch: keep it as a pack — the stream route picks
          // the right file inside the torrent by episode number. The release
          // must actually carry the show's title (Nyaa results for one anime
          // routinely contain other shows' batches — "名探偵コナン 第01-105巻"
          // must never answer a Bleach query just because 1-105 spans the
          // wanted episode). The relative number is only accepted inside a
          // SUBTITLED release (>= 2 unconsumed title words — "Sennen
          // Kessen-hen 1-52 Batch"), so the base show's batches ("Bleach
          // 001~366", "BLEACH Kai 1~366") can never answer a sequel-season
          // request.
          const br = batchRange(r.title);
          if (br) {
            const tm = bestTitleMatch(p, [title, originalTitle].filter(Boolean) as string[]);
            // cleanExtras: everything the title match left over is a numeral
            // or a release/tech tag — a sequel subtitle ("Thousand Year Blood
            // War", "Sennen Kessen-hen") marks DIFFERENT content, which must
            // only answer a sequel-season request via its relative number
            const cleanExtras = subtitleWords(p, [title, originalTitle]).length === 0;
            if (tm.ratio >= 0.5) {
              const inAbs = wanted >= br[0] && wanted <= br[1];
              const inRel =
                relWanted != null && relWanted >= br[0] && relWanted <= br[1];
              if (
                (inAbs && cleanExtras) ||
                (inRel && subtitleWords(p, [title, originalTitle]).length >= 2)
              ) {
                match = "pack";
              }
            }
          }
        }
      }
      if (!match) continue;
      seen.set(r.infoHash, {
        id: r.infoHash,
        releaseName: r.title,
        seeders: r.seeders,
        peers: r.leechers,
        sizeBytes: r.sizeBytes,
        provider: "Nyaa",
        quality: detectQuality(r.title),
        fileIdx: null,
        match,
        score: 0,
      });
    }
  }
  return [...seen.values()];
}

/* ---------- scoring ---------- */

export function scoreTorrent(t: TorrentSource): number {
  let s = Math.min(Math.log10(t.seeders + 1) * 4, 13);
  if (t.quality === "1080p") s += 5;
  else if (t.quality === "720p") s += 4;
  else if (t.quality === "2160p") s += 2;
  else if (t.quality === "480p") s += 1;
  const n = t.releaseName.toLowerCase();
  // Browser codec reality gates the whole list: 10-bit H.264 (Hi10P — the
  // anime-scene default re-encode) has NO browser software decoder and HEVC
  // only plays where hardware support exists, so a heavily 10bit/HEVC top of
  // the strip means every "server" errors out instantly. Sink them far below
  // any playable release; they only surface when nothing playable was found.
  if (/x265|h\.?265|hevc/.test(n)) s -= 10;
  if (/10[\s._-]?bit|hi10\w*/.test(n)) s -= 20;
  if (/av1/.test(n)) s += 1;
  if (/x264|h\.?264|xvid/.test(n) && !/10[\s._-]?bit|hi10/.test(n)) s += 2;
  if (/\b(cam|ts|telesync|screener|dvdscr|hdts|\btc\b)\b/.test(n)) s -= 12;
  if (/\b3d\b/.test(n)) s -= 6;
  if (/\.mp4\b/.test(n) || /yts/i.test(t.releaseName)) s += 1.5;
  if (t.sizeBytes > 0 && t.sizeBytes < 120 * 1024 * 1024) s -= 2;
  if (t.sizeBytes > 25 * 1024 * 1024 * 1024) s -= 3;
  return Math.round(s * 10) / 10;
}

/** Bonus/penalty applied for how tightly a release matches the request. */
const MATCH_RANK: Record<MatchClass, number> = {
  verified: 8,
  pack: 2.5,
  weak: -6,
};

/** Trust adjustment per indexer, added on top of the content score. Measured
 * on 2026-11-01: BitSearch's top "167 seeders" hit for Bleach S02E01 failed
 * to resolve metadata at all (stale scrape counts), while Nyaa's 67-seeder
 * result streamed at 1.2 MB/s — curated/indexed sources rank above scrapers.
 * Unknown providers get 0 (neutral). */
const PROVIDER_TRUST: Record<string, number> = {
  Nyaa: 4,
  // Torrentio rows carry their upstream tracker's name in `provider`
  // (parsed from its "⚙️ <tracker>" meta line) — Nyaa-fed rows arrive as
  // "NyaaSi" and must get the same trust as direct Nyaa results
  NyaaSi: 4,
  Torrentio: 3,
  PirateBay: 2,
  EZTV: 2,
  YTS: 2,
  SolidTorrents: 1,
  TorrentsCSV: 0,
  BitSearch: -3,
};

function merge(sources: TorrentSource[]): TorrentSource[] {
  const best = new Map<string, TorrentSource>();
  for (const t of sources) {
    const prev = best.get(t.id);
    if (!prev || t.seeders > prev.seeders) best.set(t.id, t);
  }
  const list = [...best.values()];
  for (const t of list) {
    let s =
      scoreTorrent(t) + MATCH_RANK[t.match] + (t.countryPenalty ?? 0) + (PROVIDER_TRUST[t.provider] ?? 0);
    t.score = Math.round(s * 10) / 10;
  }
  // only fall back to unverified (no-year) releases when nothing better exists
  const confident = list.filter((t) => t.match !== "weak");
  const final = confident.length ? confident : list;
  return final.sort((a, b) => b.score - a.score || b.seeders - a.seeders).slice(0, 14);
}

/* ---------- public API ---------- */

/**
 * Stable numeric id for a catalog title (FNV-1a over its slug). The legal
 * sources view builds its URL ids from these (season = id*100+n, episode =
 * id*1000+e), so the mapping must be deterministic across builds and hosts.
 */
export function catalogNumericId(title: { slug: string }): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < title.slug.length; i++) {
    h ^= title.slug.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export interface SearchArgs {
  type: "movie" | "tv";
  tmdbId: number;
  title: string;
  year: string;
  season: number;
  episode: number;
}

/** Per-provider outcome of a scan — surfaced in the search payload so an
 *  empty result on the deployed host is diagnosable (egress blocked vs
 *  genuinely no sources). `ok` means "the network answered": a provider
 *  that answers with zero results is healthy, one that times out is not. */
export interface ProviderStat {
  name: string;
  ms: number;
  count: number;
  ok: boolean;
  error?: string;
}

/** Hard ceiling per provider. One hung indexer (CF wall, dead mirror) must
 *  never stretch the scan past a couple of waves of these — every fetch
 *  inside has its own timeouts, this catches the multi-query stacks. */
const PROVIDER_DEADLINE_MS = 10_000;

/* ---------- provider circuit breaker ---------- */

/**
 * Rolling provider health. A provider that keeps timing out or erroring gets
 * a cooldown instead of being re-tried on every search — one dead indexer
 * must not stretch every scan to its full deadline (the "dead servers" UX:
 * slow, half-empty results even though the healthy providers answer fast).
 * One failure = 60 s cooldown, doubling per consecutive failure, capped at
 * 10 min. Any clean answer resets the streak. Zero results is NOT a failure
 * — an empty-but-healthy provider stays in rotation.
 */
const providerCooldown = new Map<string, { fails: number; until: number }>();
const COOLDOWN_BASE_MS = 60_000;
const COOLDOWN_MAX_MS = 10 * 60_000;

function providerOnCooldown(name: string): boolean {
  const c = providerCooldown.get(name);
  return !!c && c.until > Date.now();
}

function providerOutcome(name: string, ok: boolean): void {
  if (ok) {
    providerCooldown.delete(name);
    return;
  }
  const c = providerCooldown.get(name) ?? { fails: 0, until: 0 };
  c.fails += 1;
  c.until = Date.now() + Math.min(COOLDOWN_BASE_MS * 2 ** (c.fails - 1), COOLDOWN_MAX_MS);
  providerCooldown.set(name, c);
}

export async function searchTorrentSources(
  args: SearchArgs,
  onProvider?: (stat: ProviderStat) => void
): Promise<TorrentSource[]> {
  const { type, tmdbId, title, season, episode } = args;
  const [imdbId, meta] = await Promise.all([getImdbId(type, tmdbId), getTitleMeta(type, tmdbId)]);
  // TMDB's own year is canonical (guards against stale/rounded client data)
  const year = meta.year || args.year || "";
  // Indian daily shows (Bigg Boss…) name episodes by broadcast date and tag
  // language versions — both are needed to match them without mixing content
  const airDate = type === "tv" ? await getEpisodeAirDate(tmdbId, season, episode) : null;
  const showLang = meta.originalLanguage ? LANG_WORD[meta.originalLanguage] ?? null : null;
  // "Bigg Boss Tamil" uploads are named "Bigg Boss (2026) S09E101 [Tamil …]":
  // the language moves into the tag area, so match against the base title and
  // let the release's language tag pick the right version (mismatch = reject)
  const matchTitle =
    type === "tv" && showLang
      ? title.replace(new RegExp(`\\s+${showLang}$`, "i"), "").trim() || title
      : title;

  // Anime detection. TMDB's original_language flag is the trusted signal,
  // but several anime entries are stubs with wrong data — "Bleach:
  // Thousand-Year Blood War" (340620) is flagged "en" and ships a single
  // 1-episode season. When the entry cannot even describe the requested
  // season, its metadata is unusable and fansub indexers are the only
  // source that can identify the episodes — treat it as anime, minus the
  // absolute-episode math, which would compute garbage from the stub.
  const langJa = (meta.originalLanguage ?? "") === "ja";
  const seasonsCoverSeason =
    type !== "tv" ||
    (meta.seasons ?? []).some((s) => s.season_number === season && s.episode_count >= episode);
  const isAnime = type === "tv" && (langJa || !seasonsCoverSeason);
  const absEpisode = type === "tv" && langJa ? await getAbsoluteEpisode(tmdbId, season, episode) : null;
  const relEpisode = type === "tv" && isAnime && season >= 2 ? episode : null;

  const jobs: { name: string; run: () => Promise<TorrentSource[]> }[] = [];
  const bayCtx: BayContext = {
    title: matchTitle || title,
    originalTitle: meta.originalTitle ?? undefined,
    year: year || undefined,
    countries: meta.countries,
    season,
    episode,
    airDate,
    showLang,
    absEpisode,
    relEpisode,
    isAnime,
  };
  if (matchTitle) {
    jobs.push({ name: "PirateBay", run: () => providerApibay(type, imdbId, bayCtx) });
    jobs.push({ name: "BitSearch", run: () => providerBitSearch(type, bayCtx) });
    jobs.push({ name: "TorrentsCSV", run: () => providerTorrentsCsv(type, bayCtx) });
    jobs.push({ name: "SolidTorrents", run: () => providerSolidTorrents(type, bayCtx) });
    jobs.push({ name: "Knaben", run: () => providerKnaben(type, bayCtx) });
    jobs.push({ name: "1337x", run: () => provider1337x(type, bayCtx) });
    if (type === "tv" && imdbId) {
      jobs.push({ name: "EZTV", run: () => providerEztv(type, imdbId, bayCtx) });
    }
    // Nyaa carries more than Japanese anime — western animation and
    // fansub-adjacent shows live there too. One or two cheap RSS calls;
    // the strict matcher rejects everything that isn't this show.
    if (type === "tv") jobs.push({ name: "Nyaa", run: () => providerNyaa(type, bayCtx) });
  }
  if (imdbId) {
    jobs.push({
      name: "Torrentio",
      run: () => providerTorrentio(type, imdbId, bayCtx, year, airDate),
    });
    jobs.push({ name: "YTS", run: () => providerYts(type, imdbId, bayCtx) });
  }

  // every provider is independent: one being down (CF wall, DNS block, rate
  // limit) never fails the scan.
  // Providers run 3 at a time (not 8 at once) — a full parallel burst made
  // the indexers throttle this IP, which then read as "all sources dead".
  // Each job catches its own errors, so the pool always resolves.
  const settled = await mapPool(jobs, 3, async (j): Promise<TorrentSource[]> => {
    const t0 = Date.now();
    if (providerOnCooldown(j.name)) {
      onProvider?.({
        name: j.name,
        ms: 0,
        count: 0,
        ok: true,
        error: "cooldown (skipped after recent failures)",
      });
      return [];
    }
    try {
      const r = await Promise.race([
        j.run(),
        new Promise<TorrentSource[]>((res) => setTimeout(() => res([]), PROVIDER_DEADLINE_MS)),
      ]);
      const ms = Date.now() - t0;
      const timedOut = ms >= PROVIDER_DEADLINE_MS;
      providerOutcome(j.name, !timedOut);
      onProvider?.({
        name: j.name,
        ms,
        count: r.length,
        ok: !timedOut,
        error: timedOut ? "timeout" : undefined,
      });
      return r;
    } catch (err) {
      providerOutcome(j.name, false);
      onProvider?.({
        name: j.name,
        ms: Date.now() - t0,
        count: 0,
        ok: false,
        error: err instanceof Error ? err.message.slice(0, 100) : "error",
      });
      return [];
    }
  });
  const all: TorrentSource[] = settled.flat();
  // the broadcast-order episode is a property of the REQUEST, not of a
  // provider — stamp it on every anime candidate so the stream route can
  // steer inside merged-sequel packs ("S17E14" files for a S02E01 request)
  if (type === "tv" && isAnime && absEpisode != null) {
    for (const t of all) t.absEpisode = absEpisode;
  }
  return merge(all);
}

/** Cheap availability probe for the auto-content pipeline (Torrentio only). */
const availCache = new Map<string, { n: number; ts: number }>();
const AVAIL_TTL = 30 * 60 * 1000;

export async function quickAvailability(
  type: "movie" | "tv",
  imdbId: string,
  season: number,
  episode: number
): Promise<number> {
  const key = `${type}:${imdbId}:${season}:${episode}`;
  const hit = availCache.get(key);
  if (hit && Date.now() - hit.ts < AVAIL_TTL) return hit.n;
  const data = await fetchJson<{ streams?: TorrentioStream[] }>(
    type === "movie"
      ? `https://torrentio.strem.fun/stream/movie/${imdbId}.json`
      : `https://torrentio.strem.fun/stream/series/${imdbId}:${season}:${episode}.json`,
    8000
  );
  const n = (data?.streams ?? []).length;
  availCache.set(key, { n, ts: Date.now() });
  return n;
}

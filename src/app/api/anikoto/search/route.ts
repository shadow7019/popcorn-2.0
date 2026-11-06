import { NextRequest, NextResponse } from "next/server";

/**
 * Anikoto (anikotoapi.site) — free anime API the user found, serving a fresh
 * catalog (rows updated daily, airing seasonals included) with per-episode
 * megaplay.buzz embed links (sub + dub).
 *
 * Verified pipeline (2026-11-06):
 *  1. GET /recent-anime?page=N&per_page=50  → fresh catalog with titles
 *  2. GET /series/{id}                      → episodes + embed_url.sub/dub
 *  3. GET {embed}   (Referer: anikototv.to) → HTML with data-id="fileId"
 *  4. GET /stream/getSources?id={fileId}    → JSON whose subtitle track URL
 *     carries the same /anime/{h1}/{h2}/ path as the video — no decryption
 *     needed, the HLS master is derivable:
 *     https://fetch.nexabloom.top/anime/{h1}/{h2}/master.m3u8
 *     (serves 1080p/720p/480p variants; requires Referer megaplay.buzz,
 *     which only our server-side stream proxy supplies)
 *
 * Rate limit upstream: 60 req/IP/120 s — everything here is cached; browsers
 * never hit anikotoapi directly.
 */

export const dynamic = "force-dynamic";

const API = "https://anikotoapi.site";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const TTL_CATALOG = 10 * 60 * 1000;
const TTL_SERIES = 10 * 60 * 1000;
const TTL_EXTRACT = 30 * 60 * 1000;

interface AnikotoEntry {
  id: number;
  title: string;
  titles?: string;
  status?: string;
  year?: number;
}
interface AnikotoEpisode {
  id: number;
  number: number;
  title?: string;
  embed_url?: { sub?: string; dub?: string };
  updated_at?: string;
}

const cache = new Map<string, { at: number; data: unknown }>();
async function cached<T>(key: string, ttl: number, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.data as T;
  const data = await load();
  cache.set(key, { at: Date.now(), data });
  return data;
}

async function fetchJson<T>(url: string, referer?: string, timeoutMs = 12000): Promise<T | null> {
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "application/json,text/html", ...(referer ? { Referer: referer } : {}) },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch {
    return null;
  }
}

/** recent catalog, a few pages deep — Anikoto exposes no search endpoint,
 *  so title matching runs against the recent window (that is its purpose:
 *  keeping up with currently-airing shows) */
async function catalog(): Promise<AnikotoEntry[]> {
  return cached("catalog", TTL_CATALOG, async () => {
    const pages = await Promise.all(
      [1, 2, 3, 4].map((p) =>
        fetchJson<{ data?: AnikotoEntry[] }>(`${API}/recent-anime?page=${p}&per_page=50`)
      )
    );
    const seen = new Set<number>();
    const out: AnikotoEntry[] = [];
    for (const pg of pages)
      for (const e of pg?.data ?? [])
        if (!seen.has(e.id)) {
          seen.add(e.id);
          out.push(e);
        }
    return out;
  });
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
/** strip a trailing season marker: "… world ii" / "… 2nd season" / "… season 2" */
const normNoSeason = (s: string) =>
  norm(s)
    .replace(/ (?:\d+(?:st|nd|rd|th)|[ivx]{1,4})? ?season \d+$/, "")
    .replace(/ (\d+(?:st|nd|rd|th) season)$/, "")
    .replace(/ (season \d+)$/, "")
    .replace(/ (ii|iii|iv|v|part \d+)$/, "")
    .trim();

async function series(id: number): Promise<{ anime?: AnikotoEntry; episodes?: AnikotoEpisode[] } | null> {
  return cached(`series-${id}`, TTL_SERIES, async () => {
    const j = await fetchJson<{ data?: { anime?: AnikotoEntry; episodes?: AnikotoEpisode[] } }>(
      `${API}/series/${id}`
    );
    return j?.data ?? null;
  });
}

/** embed page → fileId → getSources → subtitle-track path hashes → HLS master */
async function extractMaster(embedUrl: string): Promise<string | null> {
  return cached(`extract-${embedUrl}`, TTL_EXTRACT, async () => {
    // 1. embed page (the referer anikototv.to is what makes megaplay resolve the file)
    let html: string;
    try {
      const r = await fetch(embedUrl, {
        headers: { "User-Agent": UA, Referer: "https://anikototv.to/" },
        signal: AbortSignal.timeout(12000),
      });
      if (!r.ok) return null;
      html = await r.text();
    } catch {
      return null;
    }
    const fileId = html.match(/data-id="(\d+)"/)?.[1];
    if (!fileId) return null;

    // 2. getSources — subtitle track URLs share the video's /anime/{h1}/{h2}/ path
    const gs = await fetchJson<{ tracks?: { file?: string }[] }>(
      `https://megaplay.buzz/stream/getSources?id=${fileId}&platform=OTHER`,
      embedUrl
    );
    const hashes = (gs?.tracks ?? [])
      .map((t) => t.file ?? "")
      .map((f) => f.match(/\/anime\/([0-9a-f]{32})\/([0-9a-f]{32})\//))
      .find(Boolean);
    if (!hashes) return null;

    // 3. build the master URL and VERIFY it answers a real playlist
    const master = `https://fetch.nexabloom.top/anime/${hashes[1]}/${hashes[2]}/master.m3u8`;
    try {
      const r = await fetch(master, {
        headers: { "User-Agent": UA, Referer: "https://megaplay.buzz/" },
        signal: AbortSignal.timeout(12000),
      });
      if (!r.ok) return null;
      const body = await r.text();
      return body.includes("#EXTM3U") ? master : null;
    } catch {
      return null;
    }
  });
}

/** season marker in an Anikoto title: "… II" / "… 2nd Season" / "… Season 2" / "… Part 2" */
function seasonOf(title: string): number | null {
  const m = norm(title).match(/(?:\d+(?:st|nd|rd|th) |season |part )(\d+)$/) ?? norm(title).match(/ (ii|iii|iv|v)$/);
  if (!m) return null;
  if (/^\d+$/.test(m[1])) return Number(m[1]);
  return { ii: 2, iii: 3, iv: 4, v: 5 }[m[1] as "ii" | "iii" | "iv" | "v"] ?? null;
}

export async function GET(req: NextRequest) {
  const title = req.nextUrl.searchParams.get("title") ?? "";
  const season = Number(req.nextUrl.searchParams.get("season") || 1);
  const episode = Number(req.nextUrl.searchParams.get("episode") || 0);
  const abs = Number(req.nextUrl.searchParams.get("abs") || 0);
  if (!title || episode <= 0)
    return NextResponse.json({ results: [] }, { headers: { "Cache-Control": "no-store" } });

  const cat = await catalog();
  const nTitle = norm(title);
  const nTitleShort = normNoSeason(title);
  const entry = cat.find((e) => norm(e.title) === nTitle) ??
    cat.find((e) => normNoSeason(e.title) === nTitleShort && nTitleShort.length > 6) ??
    cat.find(
      (e) =>
        (norm(e.title).includes(nTitleShort) || nTitleShort.includes(norm(e.title))) &&
        Math.min(nTitleShort.length, norm(e.title).length) > 8
    );
  if (!entry) return NextResponse.json({ results: [] }, { headers: { "Cache-Control": "no-store" } });
  // an entry marked "… II" is that season only — never answer an S1 request with it
  const entrySeason = seasonOf(entry.title);
  if (entrySeason && entrySeason !== season)
    return NextResponse.json({ results: [] }, { headers: { "Cache-Control": "no-store" } });

  const s = await series(entry.id);
  const eps = s?.episodes ?? [];
  const ep = eps.find((e) => e.number === (abs || episode));
  if (!ep) return NextResponse.json({ results: [] }, { headers: { "Cache-Control": "no-store" } });

  const rows = await Promise.all(
    (["sub", "dub"] as const)
      .filter((lang) => ep.embed_url?.[lang])
      .map(async (lang) => {
        const master = await extractMaster(ep.embed_url![lang]!);
        if (!master) return null;
        return {
          id: `anikoto-${ep.id}-${lang}`,
          releaseName: `${entry.title} — ${ep.title ?? `Episode ${ep.number}`} (${lang})`,
          seeders: 0,
          peers: 0,
          sizeBytes: 0,
          provider: "Anikoto",
          quality: "1080p",
          fileIdx: null,
          match: "verified" as const,
          lang,
          hls: `/api/anikoto/stream?u=${Buffer.from(master).toString("base64url")}`,
          score: 100,
        };
      })
  );

  return NextResponse.json(
    { results: rows.filter(Boolean), seriesTitle: entry.title, episode: ep.number },
    { headers: { "Cache-Control": "no-store" } }
  );
}

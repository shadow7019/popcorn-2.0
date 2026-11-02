/**
 * Legal source resolver — the replacement for the pirate torrent-provider
 * stack. Every "server" the player can pick is a curated, verified source:
 *
 *  1. Otama Direct  — the title's archive.org file over HTTPS (public
 *     domain / CC-licensed copy, verified reachable at curation time)
 *  2. IA Torrent    — the archive.org item torrent via the built-in
 *     WebTorrent engine; archive.org runs HTTP webseeds on every item, so
 *     the swarm always has at least the archive itself as a seed
 *  3. Blender Torrent — official webtorrent.io torrents for the Blender
 *     open movies (genuinely seeded community swarm + official webseed)
 *  4. IA Mirror     — the item's additional datanode webseed URLs (the same
 *     mirrors the torrent itself uses) as plain direct streams
 *
 * There is nothing to scrape and nothing to validate at request time beyond
 * a cached torrent-file parse: the catalog is fixed and every entry was
 * verified during curation.
 */
import { CATALOG, type Title, type Episode as CatalogEpisode } from "./catalog";
import {
  BLENDER_TORRENTS,
  catalogEpisode,
  mediaTypeOf,
  numericId,
  titleByNumericId,
} from "./catalog-adapter";

export interface TorrentSource {
  /** torrent: 40-hex infohash · direct: "direct:<n>-<iaId>" */
  id: string;
  releaseName: string;
  seeders: number;
  peers: number;
  sizeBytes: number;
  provider: string;
  quality: string;
  fileIdx: number | null;
  match: "verified" | "pack" | "weak";
  score: number;
  /** torrent = streamed by our WebTorrent engine · direct = plain HTTPS file */
  kind: "torrent" | "direct";
  /** direct servers: the playable URL */
  fileUrl?: string;
  /** torrent server whose swarm is backed by archive.org / official webseeds */
  webseed?: boolean;
}

export interface SourceStat {
  name: string;
  ms: number;
  count: number;
  ok: boolean;
}

const IA = "https://archive.org";

/* ---------- quality label ---------- */

function detectQuality(name: string): string {
  const n = name.toLowerCase();
  if (/\b(2160p|4k)\b/.test(n)) return "2160p";
  if (/\b1080p\b/.test(n)) return "1080p";
  if (/\b720p\b/.test(n)) return "720p";
  if (/\b480p\b|\bdvdrip\b|\bdvd\b/.test(n)) return "480p";
  if (/512kb|512\b/.test(n)) return "512kb";
  return "HD";
}

/* ---------- item torrent cache ---------- */

interface ItemTorrent {
  iaId: string;
  infoHash: string | null;
  /** video files inside the torrent: index → {name, length} */
  files: { index: number; name: string; length: number }[];
  /** http/ftp webseeds (mirrors + the archive itself) */
  urlList: string[];
  length: number;
}

const torCache = new Map<string, { data: ItemTorrent | null; ts: number }>();
const TOR_TTL = 6 * 60 * 60 * 1000;
const TOR_NEG_TTL = 60 * 60 * 1000;

const VID_RE = /\.(mp4|m4v|mkv|ogv|avi|webm|mpg|mpeg|mov)$/i;
const VID_EXT_SCORE: Record<string, number> = {
  mp4: 6, m4v: 5, webm: 5, mkv: 4, mov: 3, avi: 2, ogv: 1, mpg: 1, mpeg: 1,
};

function extOf(name: string): string {
  const m = name.toLowerCase().match(/\.([a-z0-9]{2,4})$/);
  return m ? m[1] : "";
}

/** Parse the item's `_archive.torrent` (infohash, video files, webseeds). */
async function itemTorrent(iaId: string): Promise<ItemTorrent | null> {
  const hit = torCache.get(iaId);
  if (hit && Date.now() - hit.ts < (hit.data ? TOR_TTL : TOR_NEG_TTL)) return hit.data;

  const result = await (async (): Promise<ItemTorrent | null> => {
    const url = `${IA}/download/${encodeURIComponent(iaId)}/${encodeURIComponent(iaId)}_archive.torrent`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      const ptMod = await import("parse-torrent");
      const t = await (ptMod.default ?? ptMod)(buf);
      if (!t?.infoHash) return null;
      const files = (t.files ?? [])
        .map((f: { name: string; length: number }, i: number) => ({
          index: i,
          name: f.name,
          length: f.length,
        }))
        .filter((f) => VID_RE.test(f.name) && f.length > 1024 * 1024);
      return {
        iaId,
        infoHash: t.infoHash,
        files,
        urlList: (t.urlList ?? []).filter((u: unknown): u is string => typeof u === "string" && !!u),
        length: t.length ?? 0,
      };
    } catch {
      return null;
    }
  })();

  torCache.set(iaId, { data: result, ts: Date.now() });
  return result;
}

/** Pick the torrent file that corresponds to the catalog's primary file. */
function matchTorrentFile(
  tor: ItemTorrent,
  primaryName: string
): { index: number; name: string; length: number } | null {
  if (!tor.files.length) return null;
  const base = primaryName.split("/").pop()!.toLowerCase();
  const byName = tor.files.find((f) => f.name.toLowerCase() === base);
  if (byName) return byName;
  // fall back to the most browser-friendly, then the largest
  return [...tor.files].sort(
    (a, b) =>
      (VID_EXT_SCORE[extOf(b.name)] ?? 0) - (VID_EXT_SCORE[extOf(a.name)] ?? 0) || b.length - a.length
  )[0];
}

/** Datanode mirrors for items whose torrent is missing (metadata API). */
async function nodeMirrors(iaId: string): Promise<string[]> {
  try {
    const res = await fetch(`${IA}/metadata/${encodeURIComponent(iaId)}`, {
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return [];
    const j = (await res.json()) as { server?: string; dir?: string };
    if (!j.server || !j.dir) return [];
    return [`https://${j.server.replace(/^\/+/, "")}/${j.dir.replace(/^\/+|\/+$/g, "")}/`];
  } catch {
    return [];
  }
}

/* ---------- server construction ---------- */

function directServers(
  iaId: string,
  iaFile: string,
  seed: number
): TorrentSource[] {
  const out: TorrentSource[] = [
    {
      id: `direct-${seed}-${iaId}`.slice(0, 60),
      releaseName: iaFile,
      seeders: 1,
      peers: 0,
      sizeBytes: 0,
      provider: "Otama Direct",
      quality: detectQuality(iaFile),
      fileIdx: null,
      match: "verified",
      score: 100,
      kind: "direct",
      fileUrl: `${IA}/download/${encodeURIComponent(iaId)}/${encodeURIComponent(iaFile)}`,
    },
  ];
  return out;
}

/** All playable servers for one catalog title (movie/short) or episode. */
async function serversFor(
  iaId: string,
  iaFile: string,
  label: string,
  slug: string,
  seed: number
): Promise<TorrentSource[]> {
  const out: TorrentSource[] = directServers(iaId, iaFile, seed);

  // official Blender torrent — a real, well-seeded community swarm
  const blenderUrl = BLENDER_TORRENTS[slug];
  if (blenderUrl) {
    const tor = await itemTorrentFromUrl(blenderUrl);
    if (tor?.infoHash) {
      const f = matchTorrentFile(tor, iaFile);
      out.push({
        id: tor.infoHash,
        releaseName: `${label} — official Blender torrent`,
        seeders: 10,
        peers: 2,
        sizeBytes: f?.length ?? 0,
        provider: "Blender Torrent",
        quality: f ? detectQuality(f.name) : "HD",
        fileIdx: f?.index ?? null,
        match: "verified",
        score: 90,
        kind: "torrent",
        webseed: true,
      });
    }
  }

  // archive.org item torrent — the archive webseeds every item it hosts
  const tor = await itemTorrent(iaId);
  if (tor?.infoHash) {
    const f = matchTorrentFile(tor, iaFile);
    out.push({
      id: tor.infoHash,
      releaseName: `${label} — archive.org item torrent`,
      seeders: Math.max(tor.urlList.length, 1),
      peers: 0,
      sizeBytes: f?.length ?? 0,
      provider: "IA Torrent",
      quality: f ? detectQuality(f.name) : detectQuality(iaFile),
      fileIdx: f?.index ?? null,
      match: "verified",
      score: 80,
      kind: "torrent",
      webseed: true,
    });
    // extra datanode mirrors — the same URLs the torrent itself seeds from
    const primaryUrl = `${IA}/download/${encodeURIComponent(iaId)}/${encodeURIComponent(iaFile)}`;
    let mirrorSeed = 0;
    for (const ws of tor.urlList) {
      if (mirrorSeed >= 2) break;
      if (!ws.startsWith("http")) continue;
      if (ws === primaryUrl || ws === `${primaryUrl}`) continue;
      if (ws.includes("/download/")) continue; // plain archive.org link = dup of server 1
      mirrorSeed++;
      out.push({
        id: `direct-${seed}00${mirrorSeed}-${iaId}`.slice(0, 60),
        releaseName: iaFile,
        seeders: 1,
        peers: 0,
        sizeBytes: f?.length ?? 0,
        provider: "IA Mirror",
        quality: detectQuality(iaFile),
        fileIdx: null,
        match: "verified",
        score: 60 - mirrorSeed,
        kind: "direct",
        fileUrl: `${ws.replace(/\/$/, "")}/${encodeURIComponent(iaFile)}`,
      });
    }
  } else {
    // no item torrent — derive one node mirror from the metadata API
    for (const node of await nodeMirrors(iaId)) {
      out.push({
        id: `direct-${seed}900-${iaId}`.slice(0, 60),
        releaseName: iaFile,
        seeders: 1,
        peers: 0,
        sizeBytes: 0,
        provider: "IA Mirror",
        quality: detectQuality(iaFile),
        fileIdx: null,
        match: "verified",
        score: 60,
        kind: "direct",
        fileUrl: `${node.replace(/\/$/, "")}/${encodeURIComponent(iaFile)}`,
      });
    }
  }

  return out;
}

/** Parse an arbitrary .torrent URL (used for the official Blender files). */
async function itemTorrentFromUrl(url: string): Promise<ItemTorrent | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    const ptMod = await import("parse-torrent");
    const t = await (ptMod.default ?? ptMod)(buf);
    if (!t?.infoHash) return null;
    const files = (t.files ?? [])
      .map((f: { name: string; length: number }, i: number) => ({
        index: i,
        name: f.name,
        length: f.length,
      }))
      .filter((f) => VID_RE.test(f.name) && f.length > 1024 * 1024);
    return {
      iaId: "external",
      infoHash: t.infoHash,
      files,
      urlList: (t.urlList ?? []).filter((u: unknown): u is string => typeof u === "string" && !!u),
      length: t.length ?? 0,
    };
  } catch {
    return null;
  }
}

/* ---------- public API ---------- */

export interface LegalSearchArgs {
  type: "movie" | "tv";
  id: number;
  title: string;
  year: string;
  season: number;
  episode: number;
}

/**
 * Resolve every legal server for a catalog title. `id` is the stable numeric
 * catalog id (see catalog-adapter); title/year are accepted for parity with
 * the old API but the catalog is the single source of truth.
 */
export async function searchLegalSources(
  args: LegalSearchArgs,
  onStat?: (s: SourceStat) => void
): Promise<TorrentSource[]> {
  const t = titleByNumericId(args.id);
  if (!t) return [];
  const label = t.name;
  const seed = numericId(t);

  if (mediaTypeOf(t) === "tv") {
    const ep: CatalogEpisode | undefined =
      catalogEpisode(t, args.season, args.episode) ?? (t.episodes ?? [])[0];
    if (ep) {
      return serversFor(ep.iaId, ep.iaFile, `${label} — ${ep.title}`, t.slug, seed + ep.episode);
    }
    // show without per-episode entries: stream the title-level item
    return serversFor(t.iaId, t.iaFile, label, t.slug, seed);
  }

  const s0 = performance.now();
  const servers = await serversFor(t.iaId, t.iaFile, label, t.slug, seed);
  onStat?.({ name: "legal-catalog", ms: Math.round(performance.now() - s0), count: servers.length, ok: true });
  return servers;
}

/** Catalog helpers re-exported for the search route's "searchedWith" block. */
export function catalogTitleById(id: number): Title | undefined {
  return titleByNumericId(id);
}

export function catalogSize(): number {
  return CATALOG.length;
}

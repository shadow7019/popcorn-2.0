/**
 * Torrent source health analyzer.
 *
 * Runs a lightweight REAL query against every torrent provider (the same
 * endpoints the search uses), classifies each as ok / degraded (reachable
 * but empty) / down, measures latency and keeps a rolling history so the UI
 * can show which sources are actually working right now — and which have
 * been flaky over time. Real search telemetry feeds the same history, so
 * the analysis reflects production traffic, not just synthetic probes.
 *
 * State lives in process memory: one server instance, reset on deploy —
 * exactly the granularity "which mirror is up right now" needs.
 */

export type SourceState = "ok" | "degraded" | "down";

import { mapPool, pacedFetch } from "./net-pacer";

export interface SourceStatus {
  name: string;
  /** what content the source is useful for */
  role: string;
  state: SourceState;
  latencyMs: number;
  /** rows returned by the probe query */
  results: number;
  /** mirror / endpoint that actually answered (rotating sources) */
  host?: string;
  error?: string;
  checkedAt: number;
  /** share of recent runs that produced results (0-100, null when <2 runs) */
  uptimePct: number | null;
  runs: number;
}

export interface SourceAnalysis {
  sources: SourceStatus[];
  checkedAt: number;
  durationMs: number;
  /** true when served from the TTL cache */
  cached: boolean;
  summary: { ok: number; degraded: number; down: number; total: number };
}

/* ---------- history ---------- */

interface HistoryEntry {
  state: SourceState;
  ms: number;
}

const HISTORY_LIMIT = 20;
/** how long a full analysis is served from cache (sites are slow — probing
 *  them often just burns goodwill with the indexers) */
const ANALYSIS_TTL = 10 * 60 * 1000;
/** ?refresh=1 is honored at most this often; sooner callers get the cache */
const FORCE_COOLDOWN_MS = 2 * 60 * 1000;

const history = new Map<string, HistoryEntry[]>();

function pushHistory(name: string, state: SourceState, ms: number): void {
  const list = history.get(name) ?? [];
  list.push({ state, ms });
  if (list.length > HISTORY_LIMIT) list.splice(0, list.length - HISTORY_LIMIT);
  history.set(name, list);
}

function uptimeFor(name: string): { pct: number | null; runs: number } {
  const list = history.get(name);
  if (!list || list.length === 0) return { pct: null, runs: 0 };
  const ok = list.filter((e) => e.state !== "down").length;
  return { pct: Math.round((ok / list.length) * 100), runs: list.length };
}

/** Feed real-search telemetry (from /api/torrent/search) into the history. */
export function recordSearchStats(stats: { name: string; count: number; ok: boolean }[]): void {
  for (const s of stats) {
    pushHistory(s.name, !s.ok ? "down" : s.count > 0 ? "ok" : "degraded", 0);
  }
}

/* ---------- probes ---------- */

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

async function fetchWithTimeout(url: string, timeoutMs: number, accept: string): Promise<string> {
  // pacedFetch: per-host spacing + global cap + bench on 429/5xx, so the
  // analysis never contributes to the throttling it is trying to observe
  const res = await pacedFetch(url, {
    headers: { accept, "user-agent": UA },
    timeoutMs: Math.max(timeoutMs, 12000),
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

interface ProbeResult {
  results: number;
  host?: string;
}

async function firstHost(
  hosts: string[],
  urlOf: (host: string) => string,
  parse: (body: string) => number
): Promise<ProbeResult> {
  let lastErr: unknown = null;
  for (const host of hosts) {
    try {
      const body = await fetchWithTimeout(urlOf(host), 9000, "application/json,text/html");
      return { results: parse(body), host };
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("all mirrors failed");
}

const PROBE_ORDER = [
  "PopcornRU",
  "Torrentio",
  "ThePirateBay",
  "YTS",
  "EZTV",
  "BitSearch",
  "TorrentsCSV",
  "SolidTorrents",
  "Nyaa",
] as const;

const ROLES: Record<(typeof PROBE_ORDER)[number], string> = {
  PopcornRU: "movies · tv · preferred first pick",
  Torrentio: "movies · tv · anime",
  ThePirateBay: "movies · tv",
  YTS: "movies",
  EZTV: "tv",
  BitSearch: "movies · tv",
  TorrentsCSV: "movies · tv",
  SolidTorrents: "movies · tv · anime",
  Nyaa: "anime · tv",
};

async function probe(name: string): Promise<ProbeResult> {
  switch (name) {
    case "PopcornRU": {
      // the four .link mirrors back one deployment — probe the Shawshank
      // magnet map the same way the provider's failover does (first host to
      // answer wins; a healthy mirror carries magnet rows for it)
      const body = await fetchWithTimeout(
        "https://fusme.link/movie/tt0111161",
        9000,
        "application/json"
      );
      const torrents = (JSON.parse(body).torrents ?? {}) as Record<
        string,
        Record<string, unknown>
      >;
      return {
        results: Object.values(torrents).reduce(
          (n, q) => n + Object.keys(q ?? {}).length,
          0
        ),
      };
    }
    case "Torrentio": {
      // popular movie — a healthy Torrentio always carries streams for it
      const body = await fetchWithTimeout(
        "https://torrentio.strem.fun/stream/movie/tt1375666.json",
        9000,
        "application/json"
      );
      return { results: (JSON.parse(body).streams ?? []).length };
    }
    case "ThePirateBay": {
      const body = await fetchWithTimeout(
        "https://apibay.org/q.php?q=inception&cat=",
        8000,
        "application/json"
      );
      const rows = JSON.parse(body) as { name?: string }[];
      const rowsArr = Array.isArray(rows) ? rows : [];
      return { results: rowsArr.filter((r) => r.name && r.name !== "No results").length };
    }
    case "YTS": {
      return firstHost(
        ["yts.rs", "yts.mx", "yts.bz"],
        (h) => `https://${h}/api/v2/list_movies.json?query_term=inception&limit=10&sort_by=seeders`,
        (body) => ((JSON.parse(body).data?.movies ?? []) as unknown[]).length
      );
    }
    case "EZTV": {
      return firstHost(
        ["eztvx.to", "eztv.wf", "eztv.tf"],
        (h) => `https://${h}/api/get-torrents?imdb_id=0411008&limit=5&page=1`,
        (body) => ((JSON.parse(body).torrents ?? []) as unknown[]).length
      );
    }
    case "BitSearch": {
      const body = (await fetchWithTimeout("https://bitsearch.eu/search?q=inception", 9000, "text/html"))
        .replace(/\s+/g, " ");
      const hashes = new Set(body.match(/\/download\/torrent\/[0-9a-fA-F]{40}/g) ?? []);
      return { results: hashes.size };
    }
    case "TorrentsCSV": {
      const body = await fetchWithTimeout(
        "https://torrents-csv.com/service/search?q=inception&size=20",
        9000,
        "application/json"
      );
      return { results: ((JSON.parse(body).torrents ?? []) as unknown[]).length };
    }
    case "SolidTorrents": {
      return firstHost(
        ["solidtorrents.eu", "solidtorrents.to"],
        (h) => `https://${h}/api/v1/search?q=inception`,
        (body) => ((JSON.parse(body).results ?? []) as unknown[]).length
      );
    }
    case "Nyaa": {
      const body = await fetchWithTimeout(
        "https://nyaa.si/?page=rss&f=0&c=0_0&q=one+piece",
        9000,
        "application/rss+xml"
      );
      return { results: body.split("<item>").length - 1 };
    }
    default:
      throw new Error(`unknown source: ${name}`);
  }
}

/* ---------- analysis runner ---------- */

let lastAnalysis: SourceAnalysis | null = null;
let inFlight: Promise<SourceAnalysis> | null = null;

async function runAnalysis(): Promise<SourceAnalysis> {
  const t0 = Date.now();
  // two probes at a time with per-host pacing — eight at once was exactly
  // the burst that made the indexers throttle us (sites are slow; treat
  // them accordingly). Each probe catches its own errors, so the pool
  // always resolves with one entry per source.
  const probeResults = await mapPool(PROBE_ORDER, 2, async (name): Promise<SourceStatus> => {
    const pt0 = Date.now();
    const { pct, runs } = uptimeFor(name);
    try {
      const r = await probe(name);
      const state: SourceState = r.results > 0 ? "ok" : "degraded";
      pushHistory(name, state, Date.now() - pt0);
      return {
        name,
        role: ROLES[name],
        state,
        latencyMs: Date.now() - pt0,
        results: r.results,
        host: r.host,
        checkedAt: Date.now(),
        uptimePct: pct,
        runs,
      };
    } catch (err) {
      pushHistory(name, "down", Date.now() - pt0);
      return {
        name,
        role: ROLES[name],
        state: "down",
        latencyMs: Date.now() - pt0,
        results: 0,
        error: String(err instanceof Error ? err.message : err).slice(0, 120),
        checkedAt: Date.now(),
        uptimePct: pct,
        runs,
      };
    }
  });
  const sources: SourceStatus[] = probeResults;
  return {
    sources,
    checkedAt: Date.now(),
    durationMs: Date.now() - t0,
    cached: false,
    summary: {
      ok: sources.filter((s) => s.state === "ok").length,
      degraded: sources.filter((s) => s.state === "degraded").length,
      down: sources.filter((s) => s.state === "down").length,
      total: sources.length,
    },
  };
}

export async function getAnalysis(force = false): Promise<SourceAnalysis> {
  const fresh = lastAnalysis && Date.now() - lastAnalysis.checkedAt < ANALYSIS_TTL;
  const canForce =
    force && (!lastAnalysis || Date.now() - lastAnalysis.checkedAt > FORCE_COOLDOWN_MS);
  if (!canForce && fresh) {
    return { ...lastAnalysis!, cached: true };
  }
  // concurrent callers share one probe run
  if (!inFlight) {
    inFlight = runAnalysis()
      .then((a) => {
        lastAnalysis = a;
        return a;
      })
      .finally(() => {
        inFlight = null;
      });
  }
  return inFlight;
}

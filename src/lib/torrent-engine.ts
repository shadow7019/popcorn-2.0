/**
 * Server-side BitTorrent engine (singleton across hot reloads).
 *
 * Downloads happen on the Node server (full DHT + TCP + UDP trackers, so we
 * reach normal BitTorrent swarms, not just WebRTC peers) and are re-served to
 * the browser as ordinary progressive HTTP video with Range support.
 * The browser never touches an ad-serving third party — zero iframes.
 */
import fs, { statfsSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

/* ---------- minimal structural types (webtorrent ships no usable types) ---------- */

export interface TorrentFile {
  name: string;
  /** path inside the torrent including folders (may contain S01/Season 2) */
  path?: string;
  length: number;
  index: number;
  /** byte offset of this file inside the torrent */
  offset: number;
  /** webtorrent fills both at runtime; typed optional — the structural type
   *  above is the minimum the streaming path needs */
  progress?: number;
  downloaded?: number;
  createReadStream(opts: { start: number; end: number }): NodeJS.ReadableStream;
  /** start downloading this file (whole range, normal priority) */
  select?(start?: number, end?: number): void;
  /** stop downloading this file (used to idle pre-warmed torrents) */
  deselect?(): void;
}

export interface Torrent {
  infoHash: string;
  name: string;
  ready: boolean;
  progress: number;
  numPeers: number;
  downloadSpeed: number;
  pieceLength: number;
  files: TorrentFile[];
  /** piece hashes (length = piece count); only needed for deselect ranges */
  pieces?: unknown[];
  destroy(opts?: { destroyStore?: boolean }, cb?: () => void): void;
  on(ev: string, cb: () => void): void;
  /** mark pieces as critical so they are fetched first (used for instant-start) */
  critical(start: number, end: number): void;
  /** remove the whole-torrent selection webtorrent adds on metadata */
  deselect?(start: number, end: number): void;
}

interface TorrentClient {
  torrents: Torrent[];
  add(magnet: string, opts: { path: string; announce?: string[] }, cb: (t: Torrent) => void): Torrent;
  get(infoHash: string): Torrent | null;
  on(ev: string, cb: (e?: unknown) => void): void;
  destroyed?: boolean;
}

/* ---------- config ---------- */

const TRACKERS = [
  // top public trackers (ngosang/trackerslist best) — obscure swarms (Indian
  // daily-show releases) only announce here, so broad coverage matters
  "udp://tracker.opentrackr.org:1337/announce",
  "udp://open.stealth.si:80/announce",
  "udp://tracker.torrent.eu.org:451/announce",
  "udp://open.demonii.com:1337/announce",
  "udp://open.tracker.cl:1337/announce",
  "udp://exodus.desync.com:6969/announce",
  "udp://tracker.skynetcloud.site:6969/announce",
  "udp://tracker.qu.ax:6969/announce",
  "udp://tracker.corpscorp.online:80/announce",
  "udp://tracker.ducks.party:1984/announce",
  "udp://tracker-udp.gbitt.info:80/announce",
  "udp://explodie.org:6969/announce",
  "udp://tracker.nyaa.vc:6969/announce",
  "udp://tracker.gmi.gd:6969/announce",
  "udp://tracker.peerfect.org:6969/announce",
  "http://tracker.dler.org:6969/announce",
  "http://tracker.openbittorrent.com/announce",
  "http://tracker.renfei.net:8080/announce",
  "https://tracker.tiny-vps.com:443/announce",
  "wss://tracker.openwebtorrent.com",
];

// active stream + 2 pre-warmed fallbacks + idled leftovers + headroom
const MAX_TORRENTS = 8;
// 60 min: a viewer pausing for half an hour must come back to the pieces
// they already paid for — re-downloading after a pause reads as the player
// "switching servers". Sweeping reclaims bandwidth only after a full hour
// with zero stream activity.
const IDLE_DESTROY_MS = 60 * 60 * 1000;
/** After a stream response closes, keep the torrent eviction/sweep-immune for
 *  this long. The browser issues range requests in 12 MB windows and often
 *  stops requesting entirely once its buffer is large ("half the show
 *  buffered") — without a grace window the playing torrent looked idle, a
 *  warm-triggered LRU pass destroyed it (destroyStore wipes the downloaded
 *  pieces), status went not-found, and the player "unnecessarily" switched
 *  servers mid-playback. */
const STREAM_GRACE_MS = 10 * 60 * 1000;
// DHT-only and thin swarms routinely need 30-60s to answer a metadata
// request; killing them at 40s turned "slow" into "dead" for the player
const METADATA_TIMEOUT_MS = 90_000;

try {
  fs.mkdirSync(downloadDir(), { recursive: true });
} catch {
  /* tmp dir may already exist */
}

/* ---------- disk headroom ----------
 * Downloaded pieces land on the host disk. When that disk fills up, piece
 * writes start failing SILENTLY: streams stall mid-play, metadata never
 * resolves, and the player reads it as dead servers and switches forever.
 * This was observed in production (8+ GB of orphaned piece caches). The
 * guards below keep the cache bounded no matter what happens upstream.
 *
 * Thresholds scale to the ACTUAL volume: hosting platforms ship small
 * ephemeral volumes (a ~500 MB /tmp is common), where fixed multi-GB
 * thresholds refuse every torrent forever and the player cycles servers
 * until the end of time — the exact "stuck loading, switching servers,
 * never plays" outage. Percentages keep big hosts at the old absolute
 * values (capped) and small hosts playable (floored). */

/** where pieces may land — the writable candidate with the most free space
 *  wins (a tiny tmpfs must not beat a large app volume) */
const DOWNLOAD_DIR_CANDIDATES = [
  path.join(os.tmpdir(), "otama-torrents"),
  "/var/tmp/otama-torrents",
  path.join(process.cwd(), ".torrent-cache"),
];

let chosenDownloadDir: string | null = null;

function downloadDir(): string {
  if (!chosenDownloadDir) {
    let best: { dir: string; free: number } | null = null;
    for (const dir of DOWNLOAD_DIR_CANDIDATES) {
      try {
        fs.mkdirSync(dir, { recursive: true });
        const probe = path.join(dir, ".write-test");
        fs.writeFileSync(probe, "ok");
        fs.rmSync(probe, { force: true });
        const st = statfsSync(dir);
        const free = st.bavail * st.bsize;
        if (!best || free > best.free) best = { dir, free };
      } catch {
        /* not writable / statfs missing — try the next candidate */
      }
    }
    chosenDownloadDir = best?.dir ?? DOWNLOAD_DIR_CANDIDATES[0];
  }
  return chosenDownloadDir;
}

/** eviction target: keep ~20% of the volume free (2 GB cap on big hosts,
 *  300 MB floor so a small volume still has an eviction trigger) */
const ABS_MIN_FREE = 2 * 1024 * 1024 * 1024;
const MIN_FREE_FLOOR = 300 * 1024 * 1024;
/** below this even NEW torrents are refused until space is reclaimed
 *  (750 MB cap on big hosts; 12% with a 150 MB floor on small ones — below
 *  the floor piece writes, logs and the platform itself start failing) */
const ABS_CRITICAL_FREE = 750 * 1024 * 1024;
const CRITICAL_FREE_FLOOR = 150 * 1024 * 1024;

interface FsStats {
  free: number;
  total: number;
}

function fsStats(): FsStats | null {
  try {
    const s = statfsSync(downloadDir());
    return { free: s.bavail * s.bsize, total: s.blocks * s.bsize };
  } catch {
    return null; // statfs unavailable on this platform — guards disabled
  }
}

export function freeDiskBytes(): number | null {
  return fsStats()?.free ?? null;
}

/** eviction target: keep ~20% of the volume free (2 GB cap on big hosts,
 *  300 MB floor so a small volume still has an eviction trigger) */
export function minFreeBytes(): number {
  const total = fsStats()?.total ?? 0;
  if (!total) return ABS_MIN_FREE;
  return Math.min(ABS_MIN_FREE, Math.max(Math.floor(total * 0.2), MIN_FREE_FLOOR));
}

export function criticalFreeBytes(): number {
  const total = fsStats()?.total ?? 0;
  if (!total) return ABS_CRITICAL_FREE;
  return Math.min(ABS_CRITICAL_FREE, Math.max(Math.floor(total * 0.12), CRITICAL_FREE_FLOOR));
}

/** bytes occupied by the piece cache itself (memoised — walked at most once
 *  per 15 s no matter how often /status polls) */
let cacheStatsMemo: { at: number; bytes: number } | null = null;

export function cacheBytes(): number | null {
  if (cacheStatsMemo && Date.now() - cacheStatsMemo.at < 15_000) return cacheStatsMemo.bytes;
  let bytes = 0;
  const walk = (dir: string, depth: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === ".write-test") continue;
      try {
        const full = path.join(dir, e.name);
        if (e.isDirectory() && depth < 4) walk(full, depth + 1);
        else if (e.isFile()) bytes += fs.statSync(full).size;
      } catch {
        /* raced with a delete — ignore this entry */
      }
    }
  };
  walk(downloadDir(), 0);
  cacheStatsMemo = { at: Date.now(), bytes };
  return bytes;
}

/** A fresh server process owns no torrents, so anything left in the piece
 *  cache is an orphan from a previous process or deploy. Wiping it at engine
 *  boot guarantees the process never starts against a disk already filled by
 *  old data. Only called right before a NEW client is created (no torrent of
 *  this process can be in use at that point). */
function wipeOrphanCache(): void {
  try {
    for (const entry of fs.readdirSync(downloadDir())) {
      fs.rmSync(path.join(downloadDir(), entry), { recursive: true, force: true });
    }
  } catch {
    /* best effort */
  }
}

/** Reclaim cache entries no torrent of the CURRENT client owns — crash /
 *  deploy leftovers the LRU evictor cannot see (it only tracks live torrent
 *  objects). Runs under disk pressure, before new work is refused. Entries
 *  younger than 10 minutes are spared: an add that just started may not be
 *  visible in client.torrents yet. */
function wipeOrphanEntries(): void {
  const client = state().client;
  const dir = downloadDir();
  const live = new Set<string>(["otama-torrents"]);
  for (const t of client?.torrents ?? []) {
    const tPath = (t as { path?: string }).path;
    if (tPath) live.add(path.basename(tPath));
    if (t.name) live.add(t.name);
  }
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (live.has(entry)) continue;
    try {
      const full = path.join(dir, entry);
      if (Date.now() - fs.statSync(full).mtimeMs < 10 * 60 * 1000) continue;
      fs.rmSync(full, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}

/** Reclaim disk by destroying torrents without an open browser stream —
 *  oldest-access first — until headroom is restored. An open stream is never
 *  touched: under disk pressure the active stream is the thing to protect. */
function evictForDisk(): void {
  const st = state();
  const client = st.client;
  if (!client) return;
  let free = freeDiskBytes();
  if (free === null || free >= minFreeBytes()) return;
  // leftovers from crashed/earlier processes are invisible to the LRU —
  // clear them before sacrificing any live torrent
  wipeOrphanEntries();
  free = freeDiskBytes();
  if (free === null || free >= minFreeBytes()) return;
  const victims = client.torrents
    .filter((t) => !st.active.has(t.infoHash.toLowerCase()))
    .sort(
      (a, b) =>
        (st.meta.get(a.infoHash)?.lastAccess ?? 0) -
        (st.meta.get(b.infoHash)?.lastAccess ?? 0)
    );
  for (const t of victims) {
    free = freeDiskBytes();
    if (free === null || free >= minFreeBytes()) break;
    try {
      t.destroy({ destroyStore: true });
    } catch {
      /* already gone */
    }
    st.meta.delete(t.infoHash);
    st.recentStreams.delete(t.infoHash.toLowerCase());
  }
}

/* ---------- engine state (survives Next.js hot reloads) ---------- */

/** Per-torrent bookkeeping. `streamFileIdx` is the file the stream route is
 *  currently serving — /api/torrent/status reports progress relative to THAT
 *  file, because for a 170-episode season pack the whole-torrent number crawls
 *  forever while the episode being played is still at 0% (the player's stall
 *  watchdog must look at the file, not the torrent). */
interface MetaEntry {
  addedAt: number;
  lastAccess: number;
  streamFileIdx?: number;
}

interface EngineState {
  client: TorrentClient | null;
  meta: Map<string, MetaEntry>;
  sweeper: ReturnType<typeof setInterval> | null;
  /** in-flight kickEngineLoad() — awaited by ensureTorrent before use */
  loading: Promise<void> | null;
  /** infoHashes with an open browser stream — eviction must never kill these */
  active: Set<string>;
  /** infoHash → when its last stream response closed. Within STREAM_GRACE_MS
   *  the torrent stays protected: the browser pauses range requests while it
   *  plays from (or holds) a large buffer, and those gaps must not look idle */
  recentStreams: Map<string, number>;
  /** set when the engine could not start (native module / fs failure on the
   *  host) — routes surface it instead of throwing opaque 500s */
  engineError: string | null;
}

const g = globalThis as unknown as { __otamaTorrentEngine?: EngineState };

function state(): EngineState {
  if (!g.__otamaTorrentEngine) {
    g.__otamaTorrentEngine = {
      client: null,
      meta: new Map(),
      sweeper: null,
      loading: null,
      active: new Set(),
      recentStreams: new Map(),
      engineError: null,
    };
  }
  const st = g.__otamaTorrentEngine;
  // the singleton survives Next.js hot reloads (and deploys) with the shape
  // it was first created with — backfill fields this module version expects
  if (!st.active) st.active = new Set<string>();
  if (!st.recentStreams) st.recentStreams = new Map<string, number>();
  if (!st.meta) st.meta = new Map();
  // singletons created before this field existed (hot reload / deploy) lack it
  st.engineError ??= null;
  st.loading ??= null;
  return st;
}

/**
 * Load the WebTorrent constructor without going through the bundler's
 * synthetic-external machinery when it is broken.
 *
 * Why two channels: Turbopack compiles `import("webtorrent")` to
 * `import("webtorrent-<hash>")` and maps it back with a Node module hook.
 * The deployed runtime starts server.js with **bun**, whose hook
 * implementation loses the referrer — the native binding
 * (node-datachannel) is then resolved relative to "" and every engine
 * route dies with an opaque 500 (reproduced locally under bun; node is
 * fine). So: try the normal dynamic import first (node path), and on
 * failure fall back to a real CJS require — bun accepts require() of an
 * ESM graph with top-level await, and its own resolver loads the .node
 * binary correctly.
 */
let cachedCtor: (new (opts: { maxConns: number }) => unknown) | null = null;
/** detailed failures of the last load attempt — surfaced via engineError */
let lastLoadErrors: string[] = [];
/** set the first time ANY torrent connects a peer. A host whose egress
 *  firewall blocks peer traffic (random high TCP ports, UDP) never sets it —
 *  every torrent then fails identically, which is the "all servers dead"
 *  signature. Surfaced via /status so the player can name the real cause. */
let peersEverConnectedFlag = false;

/**
 * bun + Next standalone: the server's module hooks lose the referrer for
 * node-datachannel's internal `require("../../../build/Release/….node")`
 * ("Cannot find module … from ''"), which kills webtorrent at load time even
 * through a plain require(). Intercept that one request and resolve it by
 * absolute path (original resolution is tried first; the fallback only fires
 * when it throws).
 */
function patchBindingResolution(): void {
  const g2 = globalThis as unknown as { __otamaBindingPatch?: boolean };
  if (g2.__otamaBindingPatch) return;
  g2.__otamaBindingPatch = true;
  try {
    const req = createRequire(path.join(process.cwd(), "engine-load.js"));
    const Module = req("node:module") as {
      _resolveFilename?: (request: string, parent: { filename?: string } | null, ...rest: unknown[]) => string;
    };
    const pkgDir = path.dirname(req.resolve("node-datachannel/package.json"));
    const bindingAbs = path.join(pkgDir, "build", "Release", "node_datachannel.node");
    if (typeof Module._resolveFilename !== "function" || !fs.existsSync(bindingAbs)) return;
    const orig = Module._resolveFilename;
    Module._resolveFilename = function (request, parent, ...rest) {
      if (typeof request === "string" && request.endsWith("node_datachannel.node")) {
        try {
          return orig.call(this, request, parent, ...rest);
        } catch {
          return bindingAbs;
        }
      }
      return orig.call(this, request, parent, ...rest);
    };
  } catch {
    /* best effort — the normal loader may work without the patch (node does) */
  }
}

async function loadWebTorrentCtor(): Promise<(new (opts: { maxConns: number }) => unknown) | null> {
  if (cachedCtor) return cachedCtor;
  const errs: string[] = [];
  try {
    const mod = (await import("webtorrent")) as
      | { default?: unknown }
      | (new (opts: { maxConns: number }) => unknown);
    const ctor = (mod as { default?: unknown }).default ?? mod;
    cachedCtor = ctor as new (opts: { maxConns: number }) => unknown;
    return cachedCtor;
  } catch (err) {
    errs.push(`import(): ${err instanceof Error ? err.message : String(err)}`);
    /* bundler/hook path failed — try the runtime's own resolver below */
  }
  try {
    // base path is opaque to the bundler; resolution walks up from cwd
    // (standalone / next-service-dist both carry node_modules)
    patchBindingResolution();
    const req = createRequire(path.join(process.cwd(), "engine-load.js"));
    const mod = req("webtorrent") as { default?: unknown };
    const ctor = (mod?.default ?? mod) as new (opts: { maxConns: number }) => unknown;
    cachedCtor = ctor;
    return cachedCtor;
  } catch (err) {
    errs.push(`require(): ${err instanceof Error ? err.message : String(err)}`);
    console.error("[engine] webtorrent load failed:", ...errs);
    lastLoadErrors = errs;
    return null;
  }
}

function getClient(): TorrentClient | null {
  const st = state();
  if (st.engineError) return null;
  if (!st.client || st.client.destroyed) {
    // loading is kicked off by kickEngineLoad(); until it resolves we report
    // "no client yet" and the caller surfaces the loading/error state
    return null;
  }
  return st.client;
}

/** Start engine creation once; safe to call on every request. */
function kickEngineLoad(): void {
  const st = state();
  if (st.loading || st.client || st.engineError) return;
  st.loading = (async () => {
    try {
      const Ctor = await loadWebTorrentCtor();
      if (!Ctor) {
        st.engineError = `webtorrent could not be loaded — ${lastLoadErrors.join(" | ").slice(0, 300)}`;
        return;
      }
      // no client existed in this process — every cached piece file is an
      // orphan from an earlier process/deploy and only wastes disk
      wipeOrphanCache();
      const client = new (Ctor as new (opts: { maxConns: number }) => TorrentClient)({
        maxConns: 120,
      });
      client.on("error", () => {
        /* per-torrent errors are handled where they surface */
      });
      st.client = client;
      if (!st.sweeper) {
        st.sweeper = setInterval(() => {
          try {
            sweep();
          } catch {
            /* keep the interval alive no matter what */
          }
        }, 60_000);
        st.sweeper.unref?.();
      }
    } catch (err) {
      // some runtimes cannot load webtorrent's native peers (old glibc /
      // musl images, missing libstdc++). A hard throw here turned every
      // engine route into an opaque 500 — record the reason instead and let
      // routes answer honestly.
      st.client = null;
      st.engineError =
        err instanceof Error ? err.message : "webtorrent failed to initialize";
    }
  })();
}

/** Why the engine cannot run on this host, if it cannot (null = healthy). */
export function engineFailure(): string | null {
  return state().engineError;
}

/** Whether any torrent has connected a single peer since server start.
 *  false across multiple failed servers means the host's network blocks
 *  torrent peer traffic — no source can play, and saying so beats an
 *  endless "switching servers" loop. */
export function peersEverConnected(): boolean {
  return peersEverConnectedFlag;
}

function buildMagnet(infoHash: string, name: string): string {
  // NB: build manually — URLSearchParams percent-encodes the colons in
  // "urn:btih:" and webtorrent v3 then rejects the magnet as invalid.
  const parts = [`xt=urn:btih:${infoHash}`];
  if (name) parts.push(`dn=${encodeURIComponent(name)}`);
  for (const tr of TRACKERS) parts.push(`tr=${encodeURIComponent(tr)}`);
  return `magnet:?${parts.join("&")}`;
}

function waitForMetadata(client: TorrentClient, magnet: string): Promise<Torrent> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (err: Error | null, torrent?: Torrent) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err || !torrent) {
        // a lookup that never resolved must not keep holding client slots,
        // DHT/peer connections and re-announce timers (zombie torrent)
        try {
          added?.destroy({ destroyStore: true });
        } catch {
          /* already gone */
        }
        reject(err ?? new Error("failed to add torrent"));
      } else {
        // metadata just resolved: webtorrent has already selected EVERY file
        // for download — drop that default immediately so a warm or idle
        // torrent pulls nothing until a stream asks for one file
        dropDefaultSelection(torrent);
        resolve(torrent);
      }
    };
    const timer = setTimeout(
      () => finish(new Error("No peers responded for this torrent — it may have no seeders right now")),
      METADATA_TIMEOUT_MS
    );
    let added: Torrent | null = null;
    try {
      // webtorrent v3 returns the Torrent synchronously from add()
      added = (client.add(magnet, { path: downloadDir(), announce: TRACKERS }, (t) => {
        touchMeta(t.infoHash);
        finish(null, t);
      }) as Torrent | null | undefined) ?? null;
      if (added) {
        // register the slot IMMEDIATELY, not only when metadata arrives: the
        // meta entry's lastAccess is what shields a torrent from the LRU
        // evictor, and a resolving torrent (15-40 s) would otherwise look like
        // the oldest entry (ts 0) and get destroyed by a concurrent warm /
        // ensure call — e.g. pre-warming the next candidates right after the
        // user manually picked this server
        touchMeta(added.infoHash);
      }
      if (added && typeof added.on === "function") {
        added.on("error", (e?: unknown) =>
          finish(e instanceof Error ? e : new Error("Torrent client error"))
        );
        // first inbound or outbound wire = the host CAN reach peers
        added.on("wire", () => {
          peersEverConnectedFlag = true;
        });
      }
    } catch (err) {
      finish(err instanceof Error ? err : new Error("failed to add torrent"));
    }
  });
}

function touchMeta(infoHash: string) {
  const st = state();
  const m = st.meta.get(infoHash);
  if (m) m.lastAccess = Date.now();
  else st.meta.set(infoHash, { addedAt: Date.now(), lastAccess: Date.now() });
}

/** Free capacity by destroying the least-recently-used torrents. */
function evictIfNeeded(client: TorrentClient, keepHash?: string) {
  const st = state();
  const now = Date.now();
  const pickOldest = (respectGrace: boolean): Torrent | null => {
    let oldest: Torrent | null = null;
    let oldestTs = Infinity;
    for (const t of client.torrents) {
      if (t.infoHash === keepHash) continue;
      // a torrent with an open — or recently closed — browser stream is
      // NEVER a candidate: killing it cuts playback the user is watching
      // right now (both passes; there is no "least bad" exception)
      if (streamProtected(st, t.infoHash)) continue;
      const m = st.meta.get(t.infoHash);
      // torrents still resolving their metadata (just added) are protected —
      // they are the ones a concurrent ensure/warm is waiting on
      if (respectGrace && now - (m?.addedAt ?? 0) < 90_000) continue;
      const ts = m?.lastAccess ?? 0;
      if (ts < oldestTs) {
        oldestTs = ts;
        oldest = t;
      }
    }
    return oldest;
  };
  while (client.torrents.length >= MAX_TORRENTS) {
    const oldest = pickOldest(true) ?? pickOldest(false);
    // nothing evictable: every torrent is stream-protected or resolving.
    // Exceeding MAX_TORRENTS briefly beats destroying a torrent the user is
    // watching — the sweeper frees capacity once protection lapses.
    if (!oldest) break;
    try {
      oldest.destroy({ destroyStore: true });
    } catch {
      /* already gone */
    }
    st.meta.delete(oldest.infoHash);
    st.recentStreams.delete(oldest.infoHash);
  }
}

/** The stream route registers every open video stream so eviction and the
 *  idle sweeper spare the torrent that is actually playing. `fileIndex`
 *  records which file is being served for file-relative progress reporting. */
export function markStreamActive(infoHash: string, fileIndex?: number): void {
  const st = state();
  const h = infoHash.toLowerCase();
  st.active.add(h);
  st.recentStreams.delete(h); // streaming again — the grace clock resets
  touchMeta(h); // every range request refreshes the sweeper's idle clock
  if (typeof fileIndex === "number" && Number.isFinite(fileIndex)) {
    const m = st.meta.get(h);
    if (m) m.streamFileIdx = Math.floor(fileIndex);
  }
}

/** Progress (0..1) of the file being streamed, or null when nothing is being
 *  served / the file is gone. This is the number the player's stall watchdog
 *  needs: whole-torrent progress lies on big packs. */
export function streamFileProgress(infoHash: string): number | null {
  const st = state();
  const idx = st.meta.get(infoHash.toLowerCase())?.streamFileIdx;
  if (typeof idx !== "number") return null;
  const t = findTorrent(infoHash);
  const f = t?.files?.[idx];
  if (!f || !f.length) return null;
  if (typeof f.progress === "number") return Math.min(1, Math.max(0, f.progress));
  if (typeof f.downloaded === "number") return Math.min(1, Math.max(0, f.downloaded / f.length));
  return null;
}

/** Kill webtorrent's default "download everything" selection (it is added the
 *  moment metadata resolves) so a torrent only pulls what a stream asks for.
 *  Without this a warmed 170-episode season pack downloads the whole pack in
 *  the background — starving the episode the user is actually watching and
 *  filling the piece cache with episodes nobody opened. */
function dropDefaultSelection(t: Torrent): void {
  try {
    t.deselect?.(0, (t.pieces?.length ?? 1) - 1);
  } catch {
    /* best-effort */
  }
}

/** Make the torrent stream exactly one file: drop the default select-all,
 *  stop any previously streamed file, select the picked one. Re-streaming the
 *  same file is a no-op, so the browser's next 12 MB range request doesn't
 *  churn selections. Pair with markStreamActive(id, fileIndex) —
 *  streamFileProgress() reads the index it stores. */
export function selectStreamFile(torrent: Torrent, file: TorrentFile, fileIndex: number): void {
  // every request: webtorrent's default select-all is dead weight if it is
  // somehow back (torrents added before this fix, race with metadata) — and
  // removing a selection that is already gone is a no-op
  dropDefaultSelection(torrent);
  const m = state().meta.get(torrent.infoHash.toLowerCase());
  if (m?.streamFileIdx === fileIndex) return; // already streaming this file
  if (typeof m?.streamFileIdx === "number") {
    try {
      torrent.files?.[m.streamFileIdx]?.deselect?.();
    } catch {
      /* best-effort */
    }
  }
  dropDefaultSelection(torrent);
  try {
    file.select?.();
  } catch {
    /* best-effort */
  }
  if (m) m.streamFileIdx = fileIndex;
}

export function markStreamDone(infoHash: string): void {
  const st = state();
  const h = infoHash.toLowerCase();
  st.active.delete(h);
  // NOT unprotected yet: the browser closes each 12 MB range response and
  // simply may not ask again for minutes while it plays from its buffer.
  // Keep the torrent immune until STREAM_GRACE_MS passes without a request.
  st.recentStreams.set(h, Date.now());
  touchMeta(h);
}

/** True while a torrent may not be evicted or swept: an open browser stream,
 *  or one whose last stream request is inside the grace window. */
function streamProtected(st: EngineState, infoHash: string): boolean {
  const h = infoHash.toLowerCase();
  if (st.active.has(h)) return true;
  const ended = st.recentStreams.get(h);
  return ended !== undefined && Date.now() - ended < STREAM_GRACE_MS;
}

export function isValidInfoHash(id: string): boolean {
  return /^[0-9a-f]{40}$/i.test(id);
}

export function findTorrent(infoHash: string): Torrent | null {
  const torrents = state().client?.torrents ?? [];
  // NB: webtorrent v3's client.get() returns a Promise — scan the array instead
  return torrents.find((t) => t.infoHash === infoHash) ?? null;
}

/** Add (or reuse) a torrent and wait until its metadata is ready. */
export async function ensureTorrent(infoHash: string, displayName: string): Promise<Torrent> {
  if (!isValidInfoHash(infoHash)) throw new Error("Invalid torrent id");
  kickEngineLoad();
  const st = state();
  if (st.loading) await st.loading;
  const client = getClient();
  if (!client) {
    throw new Error(
      `Streaming engine unavailable on this host: ${engineFailure() ?? "unknown reason"}`
    );
  }
  const existing = findTorrent(infoHash);
  if (existing) {
    const m = state().meta.get(infoHash);
    if (m) m.lastAccess = Date.now();
    if (!existing.ready) {
      await new Promise<void>((resolve, reject) => {
        // aligned with METADATA_TIMEOUT_MS: a torrent mid-resolution gets the
        // same patience here as a fresh add would
        const timer = setTimeout(() => reject(new Error("Timed out waiting for torrent metadata")), 75_000);
        existing.on("ready", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    dropDefaultSelection(existing);
    return existing;
  }
  // disk pressure: reclaim headroom before taking on another download —
  // a full disk breaks piece writes for EVERY stream, so refusing one new
  // add beats wedging the active ones
  let free = freeDiskBytes();
  if (free !== null && free < minFreeBytes()) {
    evictForDisk();
    free = freeDiskBytes();
    if (free !== null && free < criticalFreeBytes()) {
      const total = fsStats()?.total ?? 0;
      const gb = (n: number) => `${(n / 1024 ** 3).toFixed(2)} GB`;
      throw new Error(
        `Server storage is full — ${gb(free)} free of ${total ? gb(total) : "?"} on the host volume; the piece cache is being cleared, try again in a minute`
      );
    }
  }
  evictIfNeeded(client, infoHash);
  return waitForMetadata(client, buildMagnet(infoHash, displayName));
}

const VIDEO_EXT_SCORE: Record<string, number> = {
  mp4: 6,
  m4v: 5,
  webm: 5,
  mkv: 4,
  mov: 3,
  avi: 2,
  mpg: 1,
  mpeg: 1,
  wmv: 1,
  ts: 1,
  flv: 0,
};

function extOf(name: string): string {
  const m = name.toLowerCase().match(/\.([a-z0-9]{2,4})$/);
  return m ? m[1] : "";
}

export interface EpisodeHint {
  season: number;
  episode: number;
  /** broadcast-order episode for merged-sequel / long-runner anime
   *  ("Sennen Kessen-hen S01E14" = TMDB S02E01) — providers stamp it on
   *  every candidate so pack files number-matched by it can play */
  abs?: number | null;
}

/**
 * Does this file (including its folder path) look like the requested episode?
 * Returns 2 for a full SxxEyy match, 1 for an episode-only match, 0 for no.
 */
function epMatchScore(name: string, hint: EpisodeHint): 0 | 1 | 2 {
  const n = `${name}`.toLowerCase();
  let m = n.match(/\bs(\d{1,2})[\s._-]*e(\d{1,3})\b/);
  if (m) {
    if (Number(m[1]) === hint.season && Number(m[2]) === hint.episode) return 2;
  } else {
    m = n.match(/\b(\d{1,2})x(\d{1,3})\b/);
    if (m && Number(m[1]) === hint.season && Number(m[2]) === hint.episode) return 2;
  }
  // Merged-sequel / long-runner packs number files by the broadcast-order
  // episode ("Sennen Kessen-hen S01E14", "Bleach - 14.mkv", "[EP: 14]") —
  // providers stamp that number on every candidate, so steer by it when the
  // direct SxxEyy match above missed
  if (hint.abs != null && Number.isFinite(hint.abs)) {
    if (new RegExp(`\\bs\\d{1,2}[\\s._-]*e0*${hint.abs}\\b`).test(n)) return 1;
    if (new RegExp(`\\be(?:p)?[\\s._:]*0*${hint.abs}\\b`, "i").test(n)) return 1;
    if (new RegExp(`(?:^|[\\s._\\[(~-])0*${hint.abs}(?!\\d)`, "i").test(n)) return 1;
  }
  const hasSeason = new RegExp(`\\b(?:s|season[\\s._-]*)0*${hint.season}\\b`).test(n);
  m = n.match(/\be(?:p)?[\s._-]*(\d{1,3})\b/);
  if (m) {
    if (Number(m[1]) !== hint.episode) return 0;
    return hasSeason ? 2 : 1;
  }
  m = n.match(/\bepisode[\s._-]*(\d{1,3})\b/);
  if (m) return Number(m[1]) === hint.episode ? 1 : 0;
  // bare trailing episode number ("Blood War - 01 [1080p]") — the per-season
  // fansub convention inside packs
  if (new RegExp(`(?:^|[\\s._\\[(~-])0*${hint.episode}(?!\\d)`, "i").test(n)) return 1;
  return 0;
}

/**
 * Movie collections ("It 2017 + Chapter Two 2019") — prefer the file whose
 * own name carries the requested year (±1). 1 = plausible year match.
 */
function yearMatchScore(name: string, year: number): 0 | 1 {
  const years = `${name}`.match(/\b(19|20)\d{2}\b/g) ?? [];
  return years.some((y) => Math.abs(Number(y) - year) <= 1) ? 1 : 0;
}

/**
 * Choose the most browser-playable video file in the torrent.
 * For season packs, `episodeHint` steers selection to the requested SxxEyy
 * file; for multi-year movie collections `yearHint` prefers the file carrying
 * the requested year — instead of just the biggest one.
 */
export function pickVideoFile(
  torrent: Torrent,
  hintIdx: number | null,
  episodeHint?: EpisodeHint | null,
  yearHint?: number | null
): { file: TorrentFile; index: number } {
  if (hintIdx !== null && hintIdx >= 0 && hintIdx < torrent.files.length) {
    const hinted = torrent.files[hintIdx];
    if (VIDEO_EXT_SCORE[extOf(hinted.name)] !== undefined) {
      return { file: hinted, index: hintIdx };
    }
  }
  let best: { file: TorrentFile; index: number; score: number } | null = null;
  for (let index = 0; index < torrent.files.length; index++) {
    const file = torrent.files[index];
    const name = file.path ?? file.name;
    const ext = extOf(file.name);
    const extScore = VIDEO_EXT_SCORE[ext];
    if (extScore === undefined) continue;
    if (file.length < 15 * 1024 * 1024) continue; // skip samples / intros
    if (/\bsample\b|\.nfo|\.url|extras?\//.test(name)) continue;
    // an exact SxxEyy / year-matched file outranks any other candidate;
    // when nothing matches we fall back to plain size/codec ranking
    const epScore = episodeHint ? epMatchScore(name, episodeHint) * 1e15 : 0;
    const yrScore = !episodeHint && yearHint ? yearMatchScore(name, yearHint) * 1e15 : 0;
    const score = epScore + yrScore + extScore * 1e12 + file.length; // prefer episode/year, then playable container, then biggest
    if (!best || score > best.score) best = { file, index, score };
  }
  if (best) return { file: best.file, index: best.index };
  // desperate fallback: largest file whatever it is
  let largestIdx = 0;
  torrent.files.forEach((f, i) => {
    if (f.length > torrent.files[largestIdx].length) largestIdx = i;
  });
  return { file: torrent.files[largestIdx], index: largestIdx };
}

/**
 * Ask the swarm to fetch the pieces around `byteStart` FIRST so the video can
 * start playing within seconds instead of waiting for rarest-first random
 * pieces (BitTorrent downloads the start of a file last by default).
 */
export function prioritizeRange(torrent: Torrent, file: TorrentFile, byteStart: number, bytes: number) {
  try {
    const pieceLen = torrent.pieceLength || 262144;
    const from = file.offset + byteStart;
    const to = from + Math.min(bytes, Math.max(file.length - byteStart, pieceLen));
    torrent.critical(Math.floor(from / pieceLen), Math.floor(to / pieceLen));
  } catch {
    /* priority is best-effort */
  }
}

export function contentTypeFor(name: string): string {
  switch (extOf(name)) {
    case "mp4":
    case "m4v":
      return "video/mp4";
    case "webm":
      return "video/webm";
    case "mkv":
      return "video/x-matroska";
    case "avi":
      return "video/x-msvideo";
    case "mov":
      return "video/quicktime";
    default:
      return "video/mp4";
  }
}

export function stopTorrent(infoHash: string): boolean {
  const st = state();
  const t = findTorrent(infoHash);
  if (!t) return false;
  try {
    t.destroy({ destroyStore: true });
  } catch {
    /* already destroyed */
  }
  st.meta.delete(infoHash);
  st.active.delete(infoHash.toLowerCase());
  // deliberate teardown (unmount / real stop) — no grace for a dead id
  st.recentStreams.delete(infoHash.toLowerCase());
  return true;
}

/**
 * Put a pre-warmed torrent in idle mode: metadata + peer connections are
 * kept (that's the expensive part of startup) but no file is selected, so
 * it pulls no data while another server streams. When the stream route
 * later serves a file it re-selects it.
 */
export function idleTorrent(t: Torrent): void {
  try {
    for (const f of t.files ?? []) f.deselect?.();
  } catch {
    /* best-effort */
  }
  // forget which file was streaming: the next stream request must re-select
  // (idling deselected it — the "already streaming this file" shortcut in
  // selectStreamFile would otherwise skip the select and stall the stream)
  const m = state().meta.get(t.infoHash.toLowerCase());
  if (m) m.streamFileIdx = undefined;
}

/** Idle a torrent by id — same as idleTorrent but callable from the API
 *  routes. Keeps metadata, peers and downloaded pieces so a retry (e.g. the
 *  user reviving a failed server chip) starts without paying either the
 *  metadata wait or the bytes again. */
export function idleTorrentById(infoHash: string): boolean {
  const t = findTorrent(infoHash);
  if (!t) return false;
  idleTorrent(t);
  const m = state().meta.get(infoHash.toLowerCase());
  if (m) m.lastAccess = Date.now();
  return true;
}

/** Destroy idle torrents to free bandwidth, connections and disk. */
function sweep() {
  const st = state();
  const client = st.client;
  if (!client) return;
  evictForDisk();
  const now = Date.now();
  for (const t of [...client.torrents]) {
    if (streamProtected(st, t.infoHash)) continue; // open or recently played stream is never idle
    const last = st.meta.get(t.infoHash)?.lastAccess ?? now;
    if (now - last > IDLE_DESTROY_MS) stopTorrent(t.infoHash);
  }
}

/** Free disk bytes for the piece cache (null = unknown) — surfaced by /status */
export function diskHeadroom(): number | null {
  return freeDiskBytes();
}

/** Volume picture for /status: free vs total, the refusal threshold in force,
 *  where the cache lives. Lets the player (and the operator) tell "host disk
 *  small but playable" apart from "host disk full — nothing will play". */
export function diskInfo(): {
  free: number | null;
  total: number | null;
  critical: number;
  cacheBytes: number | null;
  dir: string;
} {
  const s = fsStats();
  return {
    free: s?.free ?? null,
    total: s?.total ?? null,
    critical: criticalFreeBytes(),
    cacheBytes: cacheBytes(),
    dir: downloadDir(),
  };
}

export function engineStats(): { torrents: number; cacheDir: string } {
  const client = state().client;
  return { torrents: client?.torrents.length ?? 0, cacheDir: downloadDir() };
}

/* ---------- swarm health probes (used by /api/torrent/health) ---------- */

export interface ProbeSnapshot {
  status: "live" | "dead";
  peers: number;
  ts: number;
}

const probeCache = new Map<string, { last: ProbeSnapshot; strikes: number }>();

/**
 * Metadata probe: add the torrent to the shared engine, wait up to timeoutMs
 * for metadata/peers, then idle it (no file selected) so it never competes
 * with a real stream. An already-warm torrent answers instantly. The raced
 * ensure keeps its own catch — a late 75 s metadata timeout must never become
 * an unhandled rejection.
 */
export async function probeTorrent(
  infoHash: string,
  displayName: string,
  timeoutMs: number,
  _sourceUrl?: string | null
): Promise<{ status: "live" | "dead"; peers: number }> {
  let live = false;
  let peers = 0;
  try {
    const ensuring = ensureTorrent(infoHash, displayName || infoHash).catch(() => null);
    const t = await Promise.race([
      ensuring,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), Math.max(timeoutMs, 1000))),
    ]);
    if (t) {
      live = t.ready || t.numPeers > 0;
      peers = t.numPeers;
      idleTorrent(t);
    }
  } catch {
    live = false;
  }
  const last: ProbeSnapshot = { status: live ? "live" : "dead", peers, ts: Date.now() };
  const rec = probeCache.get(infoHash) ?? { last, strikes: 0 };
  rec.last = last;
  rec.strikes = live ? 0 : rec.strikes + 1;
  probeCache.set(infoHash, rec);
  return { status: last.status, peers: last.peers };
}

/** Consecutive silent-probe count for one info hash (the route's two-strike rule). */
export function probeFailures(infoHash: string): number {
  return probeCache.get(infoHash)?.strikes ?? 0;
}

/** Last probe verdict for one info hash (debug GET). */
export function cachedProbe(infoHash: string): ProbeSnapshot | null {
  return probeCache.get(infoHash)?.last ?? null;
}

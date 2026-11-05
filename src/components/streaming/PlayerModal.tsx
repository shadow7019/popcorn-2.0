"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  X,
  ChevronLeft,
  ChevronRight,
  Plus,
  Check,
  List,
  Info,
  Loader2,
  AlertTriangle,
  RefreshCw,
  ShieldCheck,
  Zap,
  Magnet,
  Play,
  FastForward,
  Globe,
  Repeat,
} from "lucide-react";
import {
  MediaDetails,
  MediaItem,
  Episode,
  Video,
  getTitle,
  getMediaType,
  getYear,
  img,
  tmdb,
  trailerOf,
  formatDate,
  WEB_SOURCES,
  WebSource,
} from "@/lib/tmdb";
import { useMediaStore, useMounted } from "@/hooks/use-media-store";
import { MediaActions } from "./types";
import { ServerBox } from "./ServerBox";

interface PlayerModalProps {
  target: { item: MediaItem; season?: number; episode?: number } | null;
  actions: MediaActions;
  onClose: () => void;
}

/**
 * A torrent "server" = one ranked source returned by /api/torrent/search
 * (ThePirateBay, Torrentio/1337x, YTS, EZTV …). We download it on our own
 * backend and stream it to the native <video> element — no third-party
 * iframe, therefore no pop-ups, no tab redirects, no injected ads.
 */
export interface TorrentServer {
  id: string;
  releaseName: string;
  seeders: number;
  peers: number;
  sizeBytes: number;
  provider: string;
  quality: string;
  fileIdx: number | null;
  /** broadcast-order episode of merged-sequel anime (TMDB S02E01 = TYBW 14)
   *  — lets the stream route pick "S17E14" inside a pack answering S02E01 */
  absEpisode?: number | null;
  /** verified = exact title/episode match · pack = season pack (right file auto-picked) · weak = title-only match */
  match: "verified" | "pack" | "weak";
  score: number;
}

/* ---------- desktop-style source selection (popcorn-desktop parity) ----------
 * The desktop app picks the best quality at or below the user's saved default
 * (a natural-ordered 480p→2160p ladder, seeds as the health tiebreak), rotates
 * to the next quality when a torrent dies, and LEARNS the default from every
 * manual quality choice (AdvSettings default_quality). Same semantics here,
 * on our flat server list. */
const QUALITY_RANK: Record<string, number> = {
  SD: 0,
  "480p": 1,
  "720p": 2,
  "1080p": 3,
  "2160p": 4,
};

const defaultQualityKey = (type: string) => `pt-default-quality-${type === "tv" ? "shows" : "movies"}`;

const loadDefaultQuality = (type: string): string => {
  try {
    const saved = localStorage.getItem(defaultQualityKey(type));
    if (saved && saved in QUALITY_RANK) return saved;
  } catch {
    /* private mode — fall through to the desktop default */
  }
  return "1080p";
};

const saveDefaultQuality = (type: string, quality: string) => {
  if (!(quality in QUALITY_RANK)) return;
  try {
    localStorage.setItem(defaultQualityKey(type), quality);
  } catch {
    /* storage unavailable — the preference just won't persist */
  }
};

/** desktop tiebreak inside a quality tier: health (seeders), then provider score */
const desktopOrder = (rows: TorrentServer[]): TorrentServer[] =>
  [...rows].sort(
    (a, b) =>
      (QUALITY_RANK[b.quality] ?? -1) - (QUALITY_RANK[a.quality] ?? -1) ||
      b.seeders - a.seeders ||
      b.score - a.score
  );

/** best quality ≤ the saved default (falling to the lowest available above
 *  it, exactly like the desktop's initQuality) — PopcornRU-first is preserved
 *  because rows are ordered popcorn-group-first before this runs */
const pickDesktop = (rows: TorrentServer[], preferred: string): TorrentServer | null => {
  if (rows.length === 0) return null;
  const pref = QUALITY_RANK[preferred] ?? 3;
  const below = rows.filter((s) => (QUALITY_RANK[s.quality] ?? -1) <= pref);
  if (below.length > 0) {
    const best = Math.max(...below.map((s) => QUALITY_RANK[s.quality] ?? -1));
    return below.filter((s) => (QUALITY_RANK[s.quality] ?? -1) === best)[0];
  }
  const worst = Math.min(...rows.map((s) => QUALITY_RANK[s.quality] ?? 9));
  return rows.filter((s) => (QUALITY_RANK[s.quality] ?? 9) === worst)[0];
};

interface TorrentStatus {
  found: boolean;
  ready?: boolean;
  /** progress of the WHOLE torrent — on season packs this crawls forever */
  progress?: number;
  /** progress of the file actually being streamed (the stall watchdog's truth) */
  fileProgress?: number | null;
  peers?: number;
  speed?: number;
  /** host-level health: false means NO torrent can play on this server */
  engineOk?: boolean;
  engineError?: string;
  /** false across failed servers = the host's network blocks P2P traffic */
  everConnectedPeers?: boolean;
  /** piece-cache volume picture (bytes) — free below diskCritical = refusals */
  diskFree?: number | null;
  diskTotal?: number | null;
  diskCritical?: number | null;
  cacheBytes?: number | null;
}

interface ArchiveMatchClient {
  identifier: string;
  title: string;
  year: number | null;
  creator: string;
  description: string;
  license: string;
  fileUrl: string;
  fileSize: number;
  kind: "movie" | "tv";
}

/** live result of probing one web embed server via /api/embed-check */
export interface EmbedHealth {
  ok: boolean;
  frameable: boolean;
  status: number;
}

const ARCHIVE_ID = "otama-direct";
/** Mark a server failed when the swarm gives us nothing at all. Trackers
 * usually announce within 10-30 s — a healthy server still looks peer-less at
 * 18 s, so the window must outlast the announce cycle before calling a server
 * dead. Nothing switches automatically: the panel explains and the user picks. */
const NO_PEER_FAIL_MS = 45000;
/** Mark failed only when progress has not moved ONE BIT for this long. A slow
 * server that is still delivering data is working — torrent sites are slow,
 * and abandoning a buffering server throws away everything it downloaded. */
const STALL_FAIL_MS = 60000;

const fmtSize = (b: number) =>
  b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : b >= 1e6 ? `${Math.round(b / 1e6)} MB` : b > 0 ? `${Math.round(b / 1e3)} KB` : "—";
const fmtSpeed = (bps: number) =>
  bps >= 1e6 ? `${(bps / 1e6).toFixed(1)} MB/s` : `${Math.round(bps / 1e3)} KB/s`;

export function PlayerModal({ target, actions, onClose }: PlayerModalProps) {
  // remounted per target via key — initial state is safe to derive from props
  const type = target ? getMediaType(target.item) : "movie";
  const itemId = target?.item.id ?? null;

  /* ---------------- servers (torrent sources) ---------------- */
  const [servers, setServers] = useState<TorrentServer[]>([]);
  const [serversState, setServersState] = useState<"loading" | "ready" | "error">("loading");
  const [searchNonce, setSearchNonce] = useState(0); // bump = manual re-search
  const [activeIdx, setActiveIdx] = useState<number | null>(null);
  /** what the user picked by hand: torrent index · "archive" · "trailer" ·
   *  `web-${i}` = one of the opt-in third-party Ads web servers */
  const [manualIdx, setManualIdx] = useState<
    number | "archive" | "trailer" | `web-${number}` | null
  >(null);
  const [videoState, setVideoState] = useState<"loading" | "playing" | "error">("loading");
  const [needsTap, setNeedsTap] = useState(false);
  const [status, setStatus] = useState<TorrentStatus | null>(null);
  const [videoNonce, setVideoNonce] = useState(0);
  const [banner, setBanner] = useState<string | null>(null);
  /** host-fatal reason (storage full / engine broken / P2P blocked): switching
   *  servers cannot help, so the panel explains instead of cycling */
  const [hostFatal, setHostFatal] = useState<string | null>(null);
  /** why the CURRENT server is not playing — direct playback never rotates
   *  on its own; the user picks the next server from the strip */
  const [serverFail, setServerFail] = useState<string | null>(null);
  /** failure reason per server id — red dots + tooltips on the chips */
  const [failedIds, setFailedIds] = useState<Record<string, string>>({});
  /** auto-switch notice — shown while the auto-picked server loads */
  const [autoNote, setAutoNote] = useState<string | null>(null);
  /** automatic re-searches done for the CURRENT episode (reset on ep change) */
  const [autoRetries, setAutoRetries] = useState(0);

  /* ---------------- archive.org direct fallback (movies) ---------------- */
  const [archive, setArchive] = useState<ArchiveMatchClient | null>(null);
  const [archiveState, setArchiveState] = useState<"loading" | "found" | "none">("loading");

  /* ---------------- ads web servers (opt-in third-party embeds) ---------------- */
  const [webHealth, setWebHealth] = useState<Record<string, EmbedHealth>>({});

  /* ---------------- TV navigation ---------------- */
  const [season, setSeason] = useState(() => target?.season ?? 1);
  const [episode, setEpisode] = useState(() => target?.episode ?? 1);
  const [episodes, setEpisodes] = useState<Episode[]>([]);
  const [epLoading, setEpLoading] = useState(() => type === "tv");
  const [details, setDetails] = useState<MediaDetails | null>(null);
  const [showEpisodes, setShowEpisodes] = useState(false);

  const mounted = useMounted();
  const addContinue = useMediaStore((s) => s.addContinue);
  const toggleWatchlist = useMediaStore((s) => s.toggleWatchlist);
  const watchlist = useMediaStore((s) => s.watchlist);

  // refs so callbacks/effects always read the latest values
  const serversRef = useRef(servers);
  serversRef.current = servers;
  const activeIdxRef = useRef(activeIdx);
  activeIdxRef.current = activeIdx;
  const videoStateRef = useRef(videoState);
  videoStateRef.current = videoState;
  const hostFatalRef = useRef(hostFatal);
  hostFatalRef.current = hostFatal;
  const failedIdsRef = useRef(failedIds);
  failedIdsRef.current = failedIds;
  const webHealthRef = useRef(webHealth);
  webHealthRef.current = webHealth;
  const serverFailRef = useRef(serverFail);
  serverFailRef.current = serverFail;
  const streamStartRef = useRef(0);
  /** last progress seen from the status poll — drives the stall clock */
  const lastProgressRef = useRef(0);
  /** when progress last moved — a server that moves data is never "too slow" */
  const lastProgressAtRef = useRef(0);
  const currentIdRef = useRef<string | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  /** servers that already burned their full no-peer window while the host
   *  reported zero peers ever — 2 distinct ones ⇒ P2P is blocked host-wide */
  const peerlessRef = useRef<Set<string>>(new Set());

  // When the browser blocks autoplay we surface a tap-to-play overlay instead
  // of a stuck black frame (video data is already buffered at that point).
  const handleCanPlay = (e: React.SyntheticEvent<HTMLVideoElement>) => {
    setVideoState((s) => (s === "loading" ? "playing" : s));
    const v = e.currentTarget;
    if (v.paused) {
      v.play().then(() => setNeedsTap(false)).catch(() => setNeedsTap(true));
    }
  };

  const activeServer = activeIdx !== null ? servers[activeIdx] ?? null : null;
  const isArchive = manualIdx === "archive" && archiveState === "found" && !!archive;
  const showTrailer = manualIdx === "trailer";

  /** manually selected Ads web server (`web-${i}`) → the provider + iframe url */
  const webSel =
    typeof manualIdx === "string" && manualIdx.startsWith("web-")
      ? Number(manualIdx.slice(4))
      : null;
  const activeWeb = webSel !== null ? WEB_SOURCES[webSel] ?? null : null;
  const webUrl =
    activeWeb && target
      ? type === "movie"
        ? activeWeb.movie(target.item.id)
        : activeWeb.tv(target.item.id, season, episode)
      : null;

  const trailer: Video | null = useMemo(() => (details ? trailerOf(details) : null), [details]);

  const stopId = useCallback((id: string | null) => {
    if (!id) return;
    fetch("/api/torrent/stop", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
      keepalive: true,
    }).catch(() => {});
  }, []);

  const serverLabel = useCallback((s: TorrentServer) => `${s.quality} · ${s.provider}`, []);

  /** hand playback to the best Ads web server — used when every torrent
   *  server has failed (or the host itself cannot do P2P). Preference:
   *  reachable + embeddable → unprobed → anything; never a known-bad one.
   *  Returns false when no web server is worth opening. */
  const takeoverAds = useCallback(
    (why: string): boolean => {
      const h = webHealthRef.current;
      let pick = -1;
      let rank = -1;
      WEB_SOURCES.forEach((w, i) => {
        const st = h[w.id];
        const r = !st ? 1 : st.ok && st.frameable ? 2 : 0; // unknown=1, good=2, bad=0
        if (r > rank) {
          rank = r;
          pick = i;
        }
      });
      if (pick === -1 || rank === 0) return false;
      const cur = activeIdxRef.current;
      const failed = cur !== null ? serversRef.current[cur] : null;
      if (failed) stopId(failed.id);
      setManualIdx(`web-${pick}`);
      setActiveIdx(null);
      setServerFail(null);
      setHostFatal(null);
      setNeedsTap(false);
      setVideoState("loading");
      setAutoNote(`All ${serversRef.current.length} torrent servers failed (${why.toLowerCase()}) — switched to the S${serversRef.current.length + pick + 1} · ${WEB_SOURCES[pick].name} web server`);
      return true;
    },
    [stopId]
  );

  /* ---------------- server failed → auto-switch to the next best ----------
   * The player starts on the top-ranked server. When it cannot play, the
   * failure is recorded and the player moves to the next best server in
   * rank order on its own (skipping the ones already burned); a manual
   * pick that also fails keeps rotating. The reason stays on the chip as a
   * red dot and the panel only appears when NO server is left to try. */
  const markServerFailed = useCallback(
    (reason: string) => {
      // a host-fatal condition outranks per-server failures — the fatal panel
      // stays up until the user retries or picks something else
      if (hostFatalRef.current) return;
      const cur = activeIdxRef.current;
      const failed = cur !== null ? serversRef.current[cur] : null;
      const newFailed = { ...failedIdsRef.current };
      if (failed) {
        newFailed[failed.id] = reason;
        setFailedIds(newFailed);
        stopId(failed.id);
      }
      // next best = the highest-ranked server not yet tried and failed
      const list = serversRef.current;
      let next = -1;
      for (let i = cur !== null ? cur + 1 : 0; i < list.length; i++) {
        if (!newFailed[list[i].id]) {
          next = i;
          break;
        }
      }
      if (next === -1) {
        // every torrent server burned — hand over to an Ads web server
        // instead of showing a dead end; the panel only returns if none is
        // worth opening
        if (takeoverAds(reason)) return;
        setServerFail(reason);
        setVideoState("error");
        return;
      }
      const s = list[next];
      // reasons carry manual-era instructions ("… — pick another one below");
      // the note only needs the first clause
      const why = (failed ? reason : "first attempt failed").split(" — ")[0].toLowerCase();
      setAutoNote(`Auto-switched to S${next + 1} · ${s.provider} — ${why}`);
      setServerFail(null);
      setVideoState("loading");
      setActiveIdx(next);
      streamStartRef.current = Date.now();
    },
    [stopId, takeoverAds]
  );

  /* ---------------- load servers for this title/episode ---------------- */
  useEffect(() => {
    if (!target) return;
    let cancelled = false;
    setServers([]);
    setServersState("loading");
    setServerFail(null);
      setAutoNote(null);
    serverFailRef.current = null;
    setFailedIds({});
    peerlessRef.current = new Set();
    setActiveIdx(null);
    setManualIdx(null);
    setVideoState("loading");
    setStatus(null);
    setBanner(null);

    const params = new URLSearchParams({
      type,
      id: String(target.item.id),
      title: getTitle(target.item),
      year: getYear(target.item),
    });
    if (type === "tv") {
      params.set("season", String(season));
      params.set("episode", String(episode));
    }
    fetch(`/api/torrent/search?${params.toString()}`)
      .then((r) => r.json())
      .then((j: { results?: TorrentServer[] }) => {
        if (cancelled) return;
        const found = Array.isArray(j.results) ? j.results : [];
        // PopcornRU (the four .link mirrors) is the user-chosen first pick:
        // it takes S1 and the auto-start, and if its magnets cannot play the
        // rotation walks the rest in rank order (markServerFailed) and
        // finally hands over to the Ads web servers. Inside each group the
        // desktop-app order applies: best quality at-or-below the learned
        // default first, then health (seeders), then provider score.
        const popcorn = desktopOrder(found.filter((s) => s.provider === "PopcornRU"));
        const ordered =
          popcorn.length > 0
            ? [...popcorn, ...desktopOrder(found.filter((s) => s.provider !== "PopcornRU"))]
            : desktopOrder(found);
        setServers(ordered);
        setServersState("ready");
        // Pre-resolve metadata for the first candidates right now
        // (fire-and-forget). Metadata alone costs 15-90 s on a cold torrent,
        // and paying that while the video element is already waiting is what
        // looks like "stuck on buffering". Warmed, the stream starts
        // delivering the instant it opens — direct-player startup speed.
        const warmables = ordered.slice(0, 3).map((s) => ({ id: s.id, dn: s.releaseName }));
        if (warmables.length) {
          fetch("/api/torrent/warm", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ids: warmables }),
            keepalive: true,
          }).catch(() => {});
        }
      })
      .catch(() => {
        if (!cancelled) setServersState("error");
      });

    // Popcorn Direct: movies → public-domain copy; TV episodes → episode lookup
    // (Indian daily shows surface on archive.org hours after broadcast, long
    // before the public trackers list them)
    setArchiveState("loading");
    const archiveUrl =
      type === "movie"
        ? `/api/archive?title=${encodeURIComponent(getTitle(target.item))}&year=${encodeURIComponent(getYear(target.item))}`
        : `/api/archive?type=tv&id=${target.item.id}&season=${season}&episode=${episode}&title=${encodeURIComponent(getTitle(target.item))}`;
    fetch(archiveUrl)
      .then((r) => r.json())
      .then((j: { match: ArchiveMatchClient | null }) => {
        if (cancelled) return;
        setArchive(j.match);
        setArchiveState(j.match ? "found" : "none");
      })
      .catch(() => {
        if (!cancelled) setArchiveState("none");
      });
    return () => {
      cancelled = true;
    };
  }, [target, type, season, episode, searchNonce]);
  // automatic retries are per-episode: a manual "Search again" must not reset them
  useEffect(() => {
    setAutoRetries(0);
  }, [target, type, season, episode]);

  /* ---------------- ads server health (probe once per open) ----------------
   * Each Ads chip gets a live dot: green = answers + allows embedding, red =
   * unreachable or framing-restricted. Probed once per open with a fixed
   * episode — the result reflects host reachability, not per-episode supply. */
  useEffect(() => {
    if (!target) return;
    let cancelled = false;
    setWebHealth({});
    WEB_SOURCES.forEach((w) => {
      const probe =
        type === "movie" ? w.movie(target.item.id) : w.tv(target.item.id, 1, 1);
      fetch(`/api/embed-check?url=${encodeURIComponent(probe)}`, {
        signal: AbortSignal.timeout(15000),
      })
        .then((r) => r.json())
        .then((j: EmbedHealth) => {
          if (!cancelled && typeof j?.ok === "boolean")
            setWebHealth((m) => ({ ...m, [w.id]: j }));
        })
        .catch(() => {});
    });
    return () => {
      cancelled = true;
    };
  }, [target, type]);

  /* ---------------- pick the best server to start ----------------
   * Desktop-app semantics: the best quality at or below the learned default
   * wins the auto-start (seeds as health tiebreak), not merely the first row.
   * No automatic failover beyond the rotation — if it cannot play, the reason
   * panel opens and the user picks another server from the strip. */
  useEffect(() => {
    if (serversState !== "ready") return;
    if (manualIdx !== null || activeIdx !== null) return;
    if (servers.length > 0) {
      const best = pickDesktop(servers, loadDefaultQuality(type));
      const idx = best ? servers.indexOf(best) : 0;
      setActiveIdx(idx);
      setVideoState("loading");
      streamStartRef.current = Date.now();
    }
  }, [serversState, servers, activeIdx, manualIdx, type]);

  /** <video> onError: the stream request failed. Probe it once — a JSON
   *  error body (storage full / engine unavailable / release too large) is a
   *  host-fatal condition no server choice can fix; anything else
   *  (undecodable media, dead swarm) marks this server failed. */
  const handleStreamError = () => {
    if (!streamUrl || hostFatalRef.current) return;
    fetch(streamUrl, { headers: { Range: "bytes=0-1" } })
      .then(async (r) => {
        const ct = r.headers.get("content-type") ?? "";
        if (r.ok || !ct.includes("application/json")) {
          markServerFailed("Stream failed on this server — pick another one below");
          return;
        }
        const j = (await r.json().catch(() => null)) as {
          detail?: string;
          error?: string;
          fatal?: string;
        } | null;
        const detail = [j?.detail, j?.error].filter((x) => typeof x === "string").join(" — ");
        if (
          j?.fatal === "storage" ||
          /storage is full|engine unavailable|too large for server storage/i.test(detail)
        ) {
          setHostFatal(detail || "The streaming backend refused this stream");
          return;
        }
        markServerFailed("Stream failed on this server — pick another one below");
      })
      .catch(() => markServerFailed("Stream failed on this server — pick another one below"));
  };

  /* ---------------- Popcorn Direct for episodes with no torrent sources ----------------
   * Daily-show episodes (Bigg Boss Hindi…) are usually absent from public
   * trackers but uploaded to archive.org within hours of broadcast. When the
   * torrent scan comes up empty and a direct episode stream exists, play it. */
  useEffect(() => {
    if (type !== "tv" || serversState !== "ready") return;
    if (servers.length > 0 || manualIdx !== null) return;
    if (archiveState !== "found" || !archive) return;
    setManualIdx("archive");
    setVideoState("loading");
  }, [type, serversState, servers.length, manualIdx, archiveState, archive]);

  /* ---------------- stream URL ---------------- */
  const streamUrl = useMemo(() => {
    if (!activeServer || !target) return null;
    const file = activeServer.fileIdx != null ? `&file=${activeServer.fileIdx}` : "";
    // season/episode steer file selection inside season packs and year
    // steers multi-year movie collections — so the exact requested content
    // plays instead of the pack's biggest file. absEpisode additionally
    // steers packs that number files by broadcast order ("S17E14" for a
    // S02E01 request of a merged-sequel anime).
    const abs = activeServer.absEpisode != null ? `&abs=${activeServer.absEpisode}` : "";
    const hints =
      type === "tv"
        ? `&season=${season}&episode=${episode}${abs}`
        : `&year=${getYear(target.item)}`;
    return `/api/torrent/stream?id=${activeServer.id}&dn=${encodeURIComponent(activeServer.releaseName)}${file}${hints}`;
  }, [activeServer, type, season, episode, target?.item]);

  useEffect(() => {
    streamStartRef.current = Date.now();
    lastProgressRef.current = 0;
    lastProgressAtRef.current = Date.now();
    setStatus(null);
    setNeedsTap(false);
    setHostFatal(null);
  }, [streamUrl, videoNonce]);

  /* ---------------- live status + watchdog (reports, never switches) ---------------- */
  useEffect(() => {
    if (!streamUrl || !activeServer) {
      setStatus(null);
      return;
    }
    let cancelled = false;
    const tick = async () => {
      if (cancelled || hostFatalRef.current || serverFailRef.current) return;
      try {
        const r = await fetch(`/api/torrent/status?id=${activeServer.id}`);
        const j: TorrentStatus = await r.json();
        if (cancelled || hostFatalRef.current) return;
        setStatus(j);
        if (j.engineOk === false) {
          setHostFatal(
            j.engineError
              ? `Streaming engine unavailable on this host: ${j.engineError}`
              : "Streaming engine unavailable on this host"
          );
          return;
        }
        // storage refusal: the engine reports the volume is below its refusal
        // threshold — no torrent can be added, so switching servers is noise
        if (
          j.found === false &&
          typeof j.diskFree === "number" &&
          typeof j.diskCritical === "number" &&
          j.diskFree < j.diskCritical &&
          Date.now() - streamStartRef.current > 8000
        ) {
          setHostFatal(
            `Server storage is full — ${(j.diskFree / 1024 ** 3).toFixed(2)} GB free, ` +
              `${(j.diskCritical / 1024 ** 3).toFixed(2)} GB required. The piece cache is ` +
              `being cleared; retry in a minute or pick a smaller server.`
          );
          return;
        }
        if (j.found === false) {
          // a freshly opened stream can poll before the backend registers the
          // torrent — that is transient, never a reason to give up. Trust it
          // only once the stream has been open long enough to mean a real drop.
          if (Date.now() - streamStartRef.current > 8000) {
            markServerFailed("The stream dropped — this server stopped serving the torrent");
          }
          return;
        }
        if (videoStateRef.current === "playing") return;
        // file-relative progress: on a season pack the whole-torrent number
        // crawls while the played episode is still at 0 — the stall clock must
        // only trust the file actually being streamed
        const progress =
          typeof j.fileProgress === "number" ? j.fileProgress : (j.progress ?? 0);
        // ANY forward movement proves the server is delivering and resets the
        // stall clock — buffering patiently beats switching into another
        // server that would start its download from zero
        if (progress > lastProgressRef.current) {
          lastProgressRef.current = progress;
          lastProgressAtRef.current = Date.now();
        }
        const elapsed = Date.now() - streamStartRef.current;
        // a list where every source reported 0 seeders gets a shorter
        // no-peer window — there is no swarm that could announce late
        const allDead =
          serversRef.current.length > 0 && serversRef.current.every((s) => s.seeders === 0);
        const noPeerMs = allDead ? 20000 : NO_PEER_FAIL_MS;
        if (elapsed > noPeerMs && (j.peers ?? 0) === 0 && progress === 0) {
          // this process has never connected a single peer AND two distinct
          // servers both burned their whole no-peer window ⇒ the host's egress
          // blocks P2P — every server would fail identically, so say so.
          if (j.everConnectedPeers === false) {
            peerlessRef.current.add(activeServer.id);
            if (peerlessRef.current.size >= 2) {
              // the host itself cannot do P2P — no torrent server can ever
              // play, so hand straight over to an Ads web server and only
              // show the explanation if that also fails
              if (!takeoverAds("P2P traffic blocked on the host")) {
                setHostFatal(
                  "The streaming backend cannot reach torrent peers — its network is blocking P2P traffic, and no Ads web server is reachable right now. Retry later."
                );
              }
              return;
            }
          }
          markServerFailed(
            j.everConnectedPeers === false
              ? "No peers connected — this swarm looks dead, and the backend may block P2P. Pick another server."
              : "No peers connected on this server — its swarm looks dead. Pick another one."
          );
        } else if (Date.now() - lastProgressAtRef.current > STALL_FAIL_MS) {
          // not one new piece for the whole window — the swarm is truly dead
          markServerFailed("Too slow — not a single piece arrived in 60 s. Pick another server.");
        }
      } catch {
        /* transient — next tick retries */
      }
    };
    tick();
    const iv = setInterval(tick, 2000);
    return () => {
      cancelled = true;
      clearInterval(iv);
    };
  }, [streamUrl, activeServer, markServerFailed]);

  /* ---------------- stop torrents on switch / unmount ---------------- */
  useEffect(() => {
    const id = activeServer?.id ?? null;
    if (currentIdRef.current && currentIdRef.current !== id) stopId(currentIdRef.current);
    currentIdRef.current = id;
  }, [activeServer?.id, stopId]);
  useEffect(() => {
    return () => {
      if (currentIdRef.current) stopId(currentIdRef.current);
    };
  }, [stopId]);

  /* ---------------- record progress for Continue Watching ---------------- */
  useEffect(() => {
    if (!target || !mounted) return;
    const t = getMediaType(target.item);
    addContinue(target.item, t === "tv" ? season : undefined, t === "tv" ? episode : undefined);
  }, [target, mounted, addContinue, season, episode]);

  /* ---------------- details (season list + trailer fallback) ---------------- */
  useEffect(() => {
    if (!target) return;
    let cancelled = false;
    tmdb<MediaDetails>(`${type}/${target.item.id}`)
      .then((d) => !cancelled && setDetails(d))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [target, type]);

  useEffect(() => {
    if (!target || type !== "tv") return;
    let cancelled = false;
    tmdb<{ episodes: Episode[] }>(`tv/${target.item.id}/season/${season}`)
      .then((res) => {
        if (!cancelled) {
          setEpisodes(res.episodes ?? []);
          setEpLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setEpisodes([]);
          setEpLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [target, type, season]);

  /* ---------------- auto-refresh episodes while open ----------------
   * Daily shows (Bigg Boss…) publish a new episode every day: re-pull the
   * season when the tab regains focus and every few minutes, so the latest
   * episode appears on its own — no reload needed. */
  const epRefreshRef = useRef(0);
  useEffect(() => {
    if (!target || type !== "tv") return;
    const refresh = () => {
      if (Date.now() - epRefreshRef.current < 90_000) return; // throttle
      epRefreshRef.current = Date.now();
      tmdb<{ episodes: Episode[] }>(`tv/${target.item.id}/season/${season}`, { _fresh: 1 })
        .then((res) => setEpisodes(res.episodes ?? []))
        .catch(() => {});
    };
    const onVis = () => {
      if (document.visibilityState === "visible") refresh();
    };
    const iv = setInterval(onVis, 3 * 60_000);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      clearInterval(iv);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [target, type, season]);

  /* ---------------- banner auto-dismiss ---------------- */
  useEffect(() => {
    if (!banner) return;
    const t = setTimeout(() => setBanner(null), 7000);
    return () => clearTimeout(t);
  }, [banner]);

  /* ---------------- scroll lock + escape ---------------- */
  useEffect(() => {
    if (!target) return;
    const original = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = original;
      window.removeEventListener("keydown", onKey);
    };
  }, [target, onClose]);

  const seasonsList = (details?.seasons ?? []).filter(
    (s) => s.season_number > 0 && s.episode_count > 0
  );
  const maxEpisode =
    episodes.length ||
    details?.seasons?.find((s) => s.season_number === season)?.episode_count ||
    1;

  /* -------- episode freshness (daily shows like Bigg Boss) -------- */
  const now = new Date();
  const todayYmd = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(
    now.getDate()
  ).padStart(2, "0")}`;
  const epAired = (ep: Episode) => !!ep.air_date && ep.air_date <= todayYmd;
  const latestAired = useMemo(() => {
    for (let i = episodes.length - 1; i >= 0; i--) {
      if (epAired(episodes[i])) return episodes[i];
    }
    return null;
  }, [episodes]);
  const currentEpisode = episodes.find((ep) => ep.episode_number === episode);

  /* ---------------- auto-research when an episode has no sources yet ----------------
   * Brand-new daily-show episodes (Bigg Boss…) are often indexed only hours
   * after broadcast. When the first scan comes up empty and the episode has
   * already aired, re-scan automatically every 90s (max 5 tries) so the
   * torrent appears the moment indexers list it — no manual refresh needed. */
  const noSourcesYet = serversState === "ready" && servers.length === 0;
  const episodeAired =
    type !== "tv" || !currentEpisode?.air_date || currentEpisode.air_date <= todayYmd;
  useEffect(() => {
    if (!noSourcesYet || !episodeAired || autoRetries >= 5) return;
    // a direct episode stream that is already playing must not be interrupted
    if (manualIdx === "archive" && archiveState === "found") return;
    const t = setTimeout(() => {
      setAutoRetries((n) => n + 1);
      setSearchNonce((n) => n + 1);
    }, 90_000);
    return () => clearTimeout(t);
  }, [noSourcesYet, episodeAired, autoRetries, searchNonce, manualIdx, archiveState]);

  if (!target) return null;

  const item = target.item;
  const title = getTitle(item);

  const goEpisode = (s: number, e: number) => {
    setSeason(s);
    setEpisode(e);
    setShowEpisodes(false);
  };
  const nextEpisode = () => {
    // never step into episodes that haven't aired yet (TMDB publishes
    // placeholders days ahead for daily shows)
    const cap = latestAired?.episode_number ?? maxEpisode;
    if (episode < cap) goEpisode(season, episode + 1);
    else if (seasonsList.some((s) => s.season_number === season + 1)) goEpisode(season + 1, 1);
  };
  const prevEpisode = () => {
    if (episode > 1) goEpisode(season, episode - 1);
    else if (season > 1) goEpisode(season - 1, 1);
  };

  const inList = mounted
    ? watchlist.some((w) => w.id === item.id && w.media_type === type)
    : false;

  /* ---------------- user actions ---------------- */
  const selectTorrent = (idx: number) => {
    if (idx === activeIdx) {
      // re-selecting the active server = manual retry
      setVideoState("loading");
      setServerFail(null);
      setAutoNote(null);
      setVideoNonce((n) => n + 1);
      return;
    }
    setManualIdx(idx);
    // desktop parity: a manual pick is a quality vote — it becomes the new
    // default the next auto-start obeys
    if (servers[idx]) saveDefaultQuality(type, servers[idx].quality);
    setServerFail(null);
      setAutoNote(null);
    setHostFatal(null);
    setVideoState("loading");
    setActiveIdx(idx);
    streamStartRef.current = Date.now();
  };

  const selectArchive = () => {
    if (archiveState !== "found" || !archive) return;
    if (manualIdx === "archive") {
      setVideoNonce((n) => n + 1);
      return;
    }
    if (activeServer) stopId(activeServer.id);
    setManualIdx("archive");
    setServerFail(null);
    setVideoState("loading");
  };

  const playTrailer = () => {
    if (!trailer) return;
    if (activeServer) stopId(activeServer.id);
    setManualIdx("trailer");
    setServerFail(null);
      setAutoNote(null);
  };

  /** open an Ads web server — by hand from the strip, or automatically from
   *  takeoverAds() when every torrent server has failed */
  const selectWeb = (i: number) => {
    if (manualIdx === `web-${i}`) return;
    if (activeServer) stopId(activeServer.id);
    setManualIdx(`web-${i}`);
    setActiveIdx(null); // stops the torrent stream and the status poll
    setServerFail(null);
      setAutoNote(null);
    setHostFatal(null);
    setNeedsTap(false);
    setBanner(null);
  };

  /** start over: clear every failure and pick the best server again */
  const retryAll = () => {
    setFailedIds({});
    peerlessRef.current = new Set();
    setServerFail(null);
      setAutoNote(null);
    serverFailRef.current = null;
    setHostFatal(null);
    setManualIdx(null);
    setActiveIdx(null);
    setVideoState("loading");
    setBanner(null);
  };

  const retryCurrent = () => {
    setServerFail(null);
    setVideoState("loading");
    setVideoNonce((n) => n + 1);
  };

  /** amber chip for one Ads web server — numbered into the same S-series as
   *  the torrent servers (the photo's layout) but kept amber to mark the
   *  third-party group apart */
  const adsChip = (w: WebSource, i: number) => {
    const h = webHealth[w.id];
    const dot = !h
      ? "bg-zinc-600 animate-pulse"
      : h.ok && h.frameable
        ? "bg-emerald-400"
        : "bg-red-500";
    const active = manualIdx === `web-${i}`;
    return (
      <button
        key={w.id}
        type="button"
        onClick={() => selectWeb(i)}
        title={`${w.name} — third-party web server · carries the provider's own ads\n${
          h
            ? h.ok
              ? `Reachable${h.frameable ? " · embeddable" : " · blocks embedding"}`
              : "Not responding right now"
            : "checking…"
        }`}
        className={`flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold transition ${
          active
            ? "bg-amber-500 text-black"
            : "bg-amber-500/10 text-amber-200 ring-1 ring-amber-500/30 hover:bg-amber-500/20"
        }`}
      >
        <Globe className="h-3 w-3" />
        S{servers.length + i + 1} · {w.name}
        <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
      </button>
    );
  };

  /* ---------------- derived render state ---------------- */
  const noSources =
    (serversState === "ready" && servers.length === 0) || serversState === "error";
  // the current server gave a reason it cannot play — direct playback shows
  // that reason instead of rotating; the no-source panel owns the zero-source
  // case so both panels never appear at once
  const showFailPanel =
    !noSources && !activeWeb && !hostFatal && !!serverFail && !isArchive && !showTrailer;
  const showNoSourcePanel =
    noSources && !isArchive && !showTrailer && !activeWeb && archiveState !== "found";

  // the number the UI shows as "buffered": the streamed file's progress when
  // the engine knows which file it is serving (season packs), the whole-
  // torrent one otherwise — "0.1% buffered" on a 200 GB pack is meaningless
  const fileProg =
    typeof status?.fileProgress === "number" ? status.fileProgress : (status?.progress ?? 0);
  const downloading = status && fileProg < 0.999;
  const videoKey = `${streamUrl ?? "none"}-${videoNonce}`;

  return (
    <div
      className="fixed inset-0 z-[80] flex flex-col bg-black"
      role="dialog"
      aria-modal="true"
      aria-label={`Playing ${title}`}
    >
      {/* Top bar */}
      <div className="flex items-center justify-between gap-3 px-3 py-2.5 md:px-5">
        <div className="flex min-w-0 items-center gap-3">
          <button
            type="button"
            onClick={onClose}
            aria-label="Close player"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white/10 text-white transition hover:bg-red-600"
          >
            <X className="h-5 w-5" />
          </button>
          <div className="min-w-0">
            <h2 className="truncate text-sm font-bold text-white md:text-base">
              {title}
              {type === "tv" && (
                <span className="ml-2 font-normal text-zinc-400">
                  S{season}:{episode < 10 ? `0${episode}` : episode}
                </span>
              )}
            </h2>
            {type === "tv" && currentEpisode?.name && currentEpisode.name !== "TBD" && (
              <p className="truncate text-xs text-zinc-500">{currentEpisode.name}</p>
            )}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={() =>
              toggleWatchlist(item, type === "tv" ? season : undefined, type === "tv" ? episode : undefined)
            }
            className={`hidden h-9 items-center gap-1.5 rounded-full px-3 text-xs font-semibold sm:flex ${
              inList
                ? "bg-emerald-600/20 text-emerald-400 ring-1 ring-emerald-600/50"
                : "bg-white/10 text-zinc-200 hover:bg-white/20"
            }`}
          >
            {inList ? <Check className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5" />}
            {inList ? "Saved" : "Save"}
          </button>
          {type === "tv" && (
            <button
              type="button"
              onClick={() => setShowEpisodes((v) => !v)}
              className="flex h-9 items-center gap-1.5 rounded-full bg-white/10 px-3 text-xs font-semibold text-zinc-200 transition hover:bg-white/20 lg:hidden"
            >
              <List className="h-4 w-4" /> Episodes
            </button>
          )}
        </div>
      </div>

      {/* Server box — one collapsible panel listing every server, grouped in
          priority order: PopcornRU (the .link mirrors, preferred first pick),
          the ad-free Direct stream, the other torrent servers in rank order,
          and the opt-in third-party Ads web servers. Starts on the
          best-ranked server and auto-switches to the next one whenever a
          server fails. */}
      {autoNote && (
        <div className="flex items-center gap-1.5 px-3 pb-1 text-[11px] font-medium text-sky-400 md:px-5">
          <Repeat className="h-3 w-3 shrink-0" />
          {autoNote}
        </div>
      )}
      <ServerBox
        servers={servers}
        serversState={serversState}
        activeIdx={activeIdx}
        activeWebIdx={webSel}
        archiveActive={isArchive}
        archiveState={archiveState}
        onSelectArchive={selectArchive}
        onSelectTorrent={selectTorrent}
        onSelectWeb={selectWeb}
        failedIds={failedIds}
        webHealth={webHealth}
      />

      {/* every source found is dead — set expectations before playback stalls */}
      {serversState === "ready" && servers.length > 0 && servers.every((s) => s.seeders === 0) && (
        <div className="mx-3 mb-2 flex items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-200 md:mx-5">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          Only dead torrents found for this episode right now (0 seeders on every
          source). Playback will likely fail — check back later; daily-show
          episodes usually get seeded within days.
        </div>
      )}

      {/* failover banner */}
      {banner && (
        <div className="mx-3 mb-2 flex items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-200 md:mx-5">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          {banner}
        </div>
      )}

      {/* Main area */}
      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="relative w-full bg-black lg:flex-1">
            <div className="relative mx-auto aspect-video max-h-[calc(100vh-160px)] w-full max-w-[calc((100vh-160px)*16/9)]">
              {/* ---------- Ads web server: opt-in third-party iframe ---------- */}
              {activeWeb && webUrl ? (
                <>
                  <iframe
                    key={`${activeWeb.id}-${itemId}-${
                      type === "tv" ? `${season}-${episode}` : "movie"
                    }`}
                    src={webUrl}
                    title={`${title} — ${activeWeb.name}`}
                    allow="autoplay; fullscreen; encrypted-media; picture-in-picture"
                    allowFullScreen
                    className="h-full w-full border-0"
                  />
                  <div className="pointer-events-none absolute left-3 top-3 z-20 flex items-center gap-1.5 rounded-full bg-amber-500 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide text-black">
                    <Globe className="h-3 w-3" /> Ads · {activeWeb.name}
                  </div>
                </>
              ) : showTrailer && trailer ? (
                <iframe
                  key={trailer.key}
                  src={`https://www.youtube-nocookie.com/embed/${trailer.key}?autoplay=1`}
                  title={`${title} trailer`}
                  allow="autoplay; fullscreen; encrypted-media; picture-in-picture"
                  allowFullScreen
                  className="h-full w-full border-0"
                />
              ) : isArchive && archive ? (
                /* ---------- Popcorn Direct: public-domain native stream ---------- */
                <>
                  <video
                    key={`${archive.identifier}-${videoNonce}`}
                    src={archive.fileUrl}
                    poster={img(item.backdrop_path, "w1280") ?? undefined}
                    controls
                    autoPlay
                    playsInline
                    preload="auto"
                    onCanPlay={handleCanPlay}
                    onPlaying={() => {
                      setVideoState("playing");
                      setNeedsTap(false);
                    }}
                    onError={() => {
                      setVideoState("error");
                      setServerFail("The direct archive.org stream failed to load");
                    }}
                    className="h-full w-full bg-black"
                  />
                  <div className="absolute left-3 top-3 flex items-center gap-1.5 rounded-full bg-emerald-600/90 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide text-white">
                    <ShieldCheck className="h-3 w-3" />{" "}
                    {archive.kind === "tv" ? "Ad-free · Direct episode" : "Ad-free · Public domain"}
                  </div>
                  <p className="absolute inset-x-3 bottom-2 truncate text-[10px] text-zinc-500">
                    {archive.title}
                    {archive.year ? ` (${archive.year})` : ""} · archive.org
                    {archive.kind === "movie" ? ` · ${archive.license}` : ""}
                  </p>
                </>
              ) : streamUrl ? (
                /* ---------- torrent stream: native video, HTTP Range, no iframe ---------- */
                <>
                  <video
                    ref={videoRef}
                    key={videoKey}
                    src={streamUrl}
                    poster={img(item.backdrop_path, "w1280") ?? undefined}
                    controls
                    autoPlay
                    playsInline
                    preload="auto"
                    onCanPlay={handleCanPlay}
                    onPlaying={() => {
                      setVideoState("playing");
                      setNeedsTap(false);
                    }}
                    onError={handleStreamError}
                    className="h-full w-full bg-black"
                  />
                  <div className="absolute left-3 top-3 flex items-center gap-1.5 rounded-full bg-emerald-600/90 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide text-white">
                    <ShieldCheck className="h-3 w-3" /> Ad-free · P2P direct
                  </div>
                  {videoState === "playing" && downloading && (
                    <div className="absolute bottom-2 left-3 flex items-center gap-2 rounded-full bg-black/70 px-2.5 py-1 text-[10px] font-semibold text-zinc-200 backdrop-blur">
                      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />
                      P2P ↓ {Math.round(fileProg * 100)}% · {fmtSpeed(status?.speed ?? 0)} ·{" "}
                      {status?.peers ?? 0} peers
                    </div>
                  )}
                </>
              ) : null}

              {/* ---------- tap to play (browser blocked autoplay) ---------- */}
              {needsTap && !showTrailer && !activeWeb && (
                <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/50">
                  <button
                    type="button"
                    onClick={() => {
                      videoRef.current?.play().catch(() => {});
                      setNeedsTap(false);
                    }}
                    aria-label="Play"
                    className="flex h-20 w-20 items-center justify-center rounded-full bg-red-600 text-white shadow-2xl transition hover:scale-105 hover:bg-red-500"
                  >
                    <Play className="h-9 w-9" />
                  </button>
                </div>
              )}

              {/* ---------- connecting overlay ---------- */}
              {streamUrl && videoState === "loading" && !showTrailer && !isArchive && !hostFatal && (
                <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-black px-6 text-center">
                  <Loader2 className="h-10 w-10 animate-spin text-red-600" />
                  <p className="text-sm text-zinc-400">
                    Connecting to{" "}
                    <span className="font-semibold text-zinc-200">
                      {activeServer ? `S${activeIdx! + 1} · ${serverLabel(activeServer)}` : "best server"}
                    </span>
                    …
                  </p>
                  {activeServer && (
                    <p className="max-w-md truncate text-[11px] text-zinc-600">
                      {activeServer.releaseName} · {fmtSize(activeServer.sizeBytes)}
                    </p>
                  )}
                  {status && fileProg > 0 && (
                    <div className="w-56">
                      <div className="h-1.5 overflow-hidden rounded-full bg-white/10">
                        <div
                          className="h-full rounded-full bg-red-600 transition-all"
                          style={{ width: `${Math.max(2, fileProg * 100)}%` }}
                        />
                      </div>
                      <p className="mt-1.5 text-[11px] text-zinc-400">
                        {Math.round(fileProg * 100)}% buffered ·{" "}
                        {fmtSpeed(status?.speed ?? 0)} · {status?.peers ?? 0} peers
                      </p>
                    </div>
                  )}
                  <div className="flex flex-wrap items-center justify-center gap-2 pt-1">
                    <button
                      type="button"
                      onClick={() => {
                        const start = (activeIdx ?? -1) + 1;
                        for (let k = 0; k < servers.length; k++) {
                          const idx = (start + k) % servers.length;
                          if (idx !== activeIdx) {
                            selectTorrent(idx);
                            return;
                          }
                        }
                        retryCurrent();
                      }}
                      className="rounded-full bg-white/10 px-3.5 py-1.5 text-xs font-semibold text-zinc-200 transition hover:bg-white/20"
                    >
                      Next server
                    </button>
                    <button
                      type="button"
                      onClick={retryCurrent}
                      className="rounded-full bg-white/10 px-3.5 py-1.5 text-xs font-semibold text-zinc-200 transition hover:bg-white/20"
                    >
                      Retry
                    </button>
                  </div>
                </div>
              )}

              {/* ---------- host-fatal panel (storage full / engine broken / P2P blocked) ----------
                   switching torrent servers cannot fix these, so the cycle stops and
                   the actual reason is shown; Retry re-arms everything. */}
              {hostFatal && !showTrailer && !activeWeb && (
                <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-4 bg-black/95 px-6 text-center">
                  <AlertTriangle className="h-10 w-10 text-amber-400" />
                  <div>
                    <p className="text-base font-bold text-white">
                      The streaming backend can&apos;t play right now
                    </p>
                    <p className="mx-auto mt-1 max-w-md text-xs leading-relaxed text-zinc-400">
                      {hostFatal}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center justify-center gap-2.5">
                    <button
                      type="button"
                      onClick={retryCurrent}
                      className="flex items-center gap-1.5 rounded-md bg-white/10 px-4 py-2 text-xs font-semibold text-zinc-200 transition hover:bg-white/20"
                    >
                      <RefreshCw className="h-3.5 w-3.5" /> Retry
                    </button>
                    {trailer && (
                      <button
                        type="button"
                        onClick={playTrailer}
                        className="flex items-center gap-1.5 rounded-md bg-red-600 px-4 py-2 text-xs font-bold text-white transition hover:bg-red-500"
                      >
                        <Play className="h-3.5 w-3.5" /> Play trailer
                      </button>
                    )}
                  </div>
                  <div className="flex max-w-xl flex-col items-center gap-1.5 pt-1">
                    <span className="text-[10px] font-bold uppercase tracking-wider text-amber-500/90">
                      or open an Ads server — third-party page, carries its own ads
                    </span>
                    <div className="flex flex-wrap items-center justify-center gap-1.5">
                      {WEB_SOURCES.map((w, i) => adsChip(w, i))}
                    </div>
                  </div>
                </div>
              )}

              {/* ---------- no sources panel ---------- */}
              {showNoSourcePanel && (
                <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-4 bg-black/95 px-6 text-center">
                  <Magnet className="h-10 w-10 text-zinc-600" />
                  <div>
                    <p className="text-base font-bold text-white">
                      No playable source found for this episode yet
                    </p>
                    <p className="mx-auto mt-1 max-w-md text-xs leading-relaxed text-zinc-400">
                      We searched ThePirateBay, Torrentio, TorrentsCSV, BitSearch, EZTV and
                      archive.org — no healthy source for it right now. Brand-new episodes of
                      daily shows usually surface within hours to a few days. The episode list
                      and servers refresh automatically, so simply retry later.
                    </p>
                    {type === "tv" && noSourcesYet && autoRetries < 5 && episodeAired && (
                      <p
                        className="mx-auto mt-2 flex items-center justify-center gap-1.5 text-[11px] font-semibold text-sky-300"
                        data-testid="auto-research-note"
                      >
                        <Loader2 className="h-3 w-3 animate-spin" />
                        Auto-checking again in ~90 s (attempt {autoRetries + 1} of 5) — the stream
                        will start on its own once a source appears
                      </p>
                    )}
                    {type === "tv" && latestAired && latestAired.episode_number !== episode && (
                      <button
                        type="button"
                        onClick={() =>
                          goEpisode(latestAired.season_number || season, latestAired.episode_number)
                        }
                        className="mx-auto mt-2 block text-[11px] font-semibold text-zinc-400 underline decoration-dotted transition hover:text-zinc-200"
                      >
                        Episode {latestAired.episode_number} (aired{" "}
                        {formatDate(latestAired.air_date) || "recently"}) — try it, older
                        episodes are usually seeded first
                      </button>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center justify-center gap-2.5">
                    <button
                      type="button"
                      onClick={() => setSearchNonce((n) => n + 1)}
                      className="flex items-center gap-1.5 rounded-md bg-white/10 px-4 py-2 text-xs font-semibold text-zinc-200 transition hover:bg-white/20"
                    >
                      <RefreshCw className="h-3.5 w-3.5" /> Search again
                    </button>
                    {trailer && (
                      <button
                        type="button"
                        onClick={playTrailer}
                        className="flex items-center gap-1.5 rounded-md bg-red-600 px-4 py-2 text-xs font-bold text-white transition hover:bg-red-500"
                      >
                        <Play className="h-3.5 w-3.5" /> Play trailer
                      </button>
                    )}
                  </div>
                  <div className="flex max-w-xl flex-col items-center gap-1.5 pt-1">
                    <span className="text-[10px] font-bold uppercase tracking-wider text-amber-500/90">
                      or open an Ads server — third-party page, carries its own ads
                    </span>
                    <div className="flex flex-wrap items-center justify-center gap-1.5">
                      {WEB_SOURCES.map((w, i) => adsChip(w, i))}
                    </div>
                  </div>
                </div>
              )}

              {/* ---------- this server failed (direct playback, no auto-switch) ---------- */}
              {showFailPanel && (
                <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-4 bg-black/95 px-6 text-center">
                  <AlertTriangle className="h-10 w-10 text-amber-400" />
                  <div>
                    <p className="text-base font-bold text-white">
                      {activeServer
                        ? `Server ${activeIdx! + 1} (${serverLabel(activeServer)}) couldn't play`
                        : "This server couldn't play"}
                    </p>
                    <p className="mx-auto mt-1 max-w-md text-xs leading-relaxed text-zinc-400">
                      {serverFail} Nothing switched on its own — open the server box above and
                      pick another server (red-dotted rows failed earlier), or retry:
                      swarms change by the minute.
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center justify-center gap-2.5">
                    <button
                      type="button"
                      onClick={retryCurrent}
                      className="flex items-center gap-1.5 rounded-md bg-white/10 px-4 py-2 text-xs font-semibold text-zinc-200 transition hover:bg-white/20"
                    >
                      <RefreshCw className="h-3.5 w-3.5" /> Retry this server
                    </button>
                    <button
                      type="button"
                      onClick={retryAll}
                      className="flex items-center gap-1.5 rounded-md bg-white/10 px-4 py-2 text-xs font-semibold text-zinc-200 transition hover:bg-white/20"
                    >
                      <Zap className="h-3.5 w-3.5" /> Start over (best server)
                    </button>
                    {trailer && (
                      <button
                        type="button"
                        onClick={playTrailer}
                        className="flex items-center gap-1.5 rounded-md bg-red-600 px-4 py-2 text-xs font-bold text-white transition hover:bg-red-500"
                      >
                        <Play className="h-3.5 w-3.5" /> Play trailer
                      </button>
                    )}
                  </div>
                  <div className="flex max-w-xl flex-col items-center gap-1.5 pt-1">
                    <span className="text-[10px] font-bold uppercase tracking-wider text-amber-500/90">
                      or open an Ads server — third-party page, carries its own ads
                    </span>
                    <div className="flex flex-wrap items-center justify-center gap-1.5">
                      {WEB_SOURCES.map((w, i) => adsChip(w, i))}
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Controls under player */}
          <div className="flex items-center justify-center gap-3 border-t border-white/5 px-4 py-3">
            {type === "tv" ? (
              <>
                <button
                  type="button"
                  onClick={prevEpisode}
                  disabled={season === 1 && episode === 1}
                  className="flex items-center gap-1.5 rounded-md bg-white/10 px-4 py-2 text-xs font-semibold text-zinc-200 transition hover:bg-white/20 disabled:opacity-30"
                >
                  <ChevronLeft className="h-3.5 w-3.5" /> Prev Ep
                </button>
                <span className="text-xs text-zinc-500">
                  Season {season} · Episode {episode}
                </span>
                <button
                  type="button"
                  onClick={nextEpisode}
                  disabled={
                    episode === maxEpisode &&
                    !seasonsList.some((s) => s.season_number === season + 1)
                  }
                  className="flex items-center gap-1.5 rounded-md bg-white/10 px-4 py-2 text-xs font-semibold text-zinc-200 transition hover:bg-white/20 disabled:opacity-30"
                >
                  Next Ep <ChevronRight className="h-3.5 w-3.5" />
                </button>
              </>
            ) : (
              <p className="flex items-center gap-2 text-center text-xs text-zinc-600">
                <Info className="h-3.5 w-3.5 shrink-0" />
                <span>
                  <span className="font-semibold text-zinc-400">You pick the server</span> — the
                  box lists everything, and failed servers rotate on their own.{" "}
                  <span className="text-emerald-400">Ad-free</span> servers run on our own
                  player; amber <span className="text-amber-400">Ads</span> servers are
                  third-party pages that carry the providers&apos; own advertising.
                </span>
              </p>
            )}
          </div>
        </div>

        {/* Episode sidebar (TV) */}
        {type === "tv" && (
          <aside
            className={`${
              showEpisodes ? "flex" : "hidden"
            } max-h-full w-full shrink-0 flex-col border-t border-white/10 bg-[#0d0d14] lg:flex lg:w-[340px] lg:border-l lg:border-t-0`}
          >
            <div className="border-b border-white/5 p-3">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-bold text-white">Episodes</h3>
                <button
                  type="button"
                  onClick={() => setShowEpisodes(false)}
                  className="text-zinc-500 hover:text-white lg:hidden"
                  aria-label="Hide episode list"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <select
                value={season}
                onChange={(e) => {
                  setSeason(Number(e.target.value));
                  setEpLoading(true);
                }}
                aria-label="Select season"
                className="mt-2 w-full rounded-md border border-white/10 bg-white/5 px-3 py-2 text-sm text-zinc-200 focus:border-red-600 focus:outline-none"
              >
                {seasonsList.length > 0
                  ? seasonsList.map((s) => (
                      <option key={s.id} value={s.season_number} className="bg-[#12121a]">
                        {s.name} ({s.episode_count} eps)
                      </option>
                    ))
                  : [...Array(20)].map((_, i) => (
                      <option key={i + 1} value={i + 1} className="bg-[#12121a]">
                        Season {i + 1}
                      </option>
                    ))}
              </select>
              {latestAired && (
                <button
                  type="button"
                  onClick={() =>
                    goEpisode(latestAired.season_number || season, latestAired.episode_number)
                  }
                  className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-md bg-red-600/20 px-3 py-1.5 text-xs font-semibold text-red-300 ring-1 ring-red-600/40 transition hover:bg-red-600/30"
                >
                  <FastForward className="h-3.5 w-3.5" />
                  Jump to latest · E{latestAired.episode_number}
                  {latestAired.air_date ? ` · ${formatDate(latestAired.air_date)}` : ""}
                </button>
              )}
            </div>

            <div className="thin-scrollbar min-h-0 flex-1 overflow-y-auto p-2">
              {epLoading && (
                <div className="space-y-2 p-2">
                  {[...Array(6)].map((_, i) => (
                    <div key={i} className="h-16 animate-pulse rounded-lg bg-zinc-800/60" />
                  ))}
                </div>
              )}
              {!epLoading &&
                episodes.map((ep) => {
                  const active = ep.episode_number === episode;
                  const aired = epAired(ep);
                  // TMDB fills brand-new daily-show episodes with "TBD"
                  // (Bigg Boss S20E55 airs with no title yet) — show a real
                  // label and the broadcast date instead
                  const name =
                    ep.name && ep.name !== "TBD" ? ep.name : `Episode ${ep.episode_number}`;
                  const isNew =
                    !!ep.air_date &&
                    ep.air_date <= todayYmd &&
                    (Date.parse(todayYmd) - Date.parse(ep.air_date)) / 86400000 <= 2;
                  return (
                    <button
                      key={`${ep.id}-${ep.episode_number}`}
                      type="button"
                      onClick={() => goEpisode(season, ep.episode_number)}
                      disabled={!aired}
                      title={
                        aired
                          ? undefined
                          : `Airs ${formatDate(ep.air_date) || "TBA"} — not playable yet`
                      }
                      className={`mb-1.5 flex w-full items-start gap-3 rounded-lg p-2 text-left transition ${
                        active
                          ? "bg-red-600/20 ring-1 ring-red-600/60"
                          : aired
                            ? "ring-1 ring-transparent hover:bg-white/5"
                            : "cursor-not-allowed opacity-45 ring-1 ring-transparent"
                      }`}
                    >
                      <div className="relative h-14 w-24 shrink-0 overflow-hidden rounded-md bg-zinc-800">
                        {img(ep.still_path, "w300") ? (
                          <img
                            src={img(ep.still_path, "w300") as string}
                            alt={ep.name}
                            loading="lazy"
                            className="h-full w-full object-cover"
                          />
                        ) : (
                          <div className="flex h-full w-full items-center justify-center text-xs text-zinc-600">
                            E{ep.episode_number}
                          </div>
                        )}
                        {active && (
                          <span className="absolute inset-0 flex items-center justify-center bg-black/50 text-red-400">
                            <ChevronRight className="h-5 w-5" />
                          </span>
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p
                          className={`truncate text-xs font-semibold ${
                            active ? "text-red-400" : "text-zinc-200"
                          }`}
                        >
                          {ep.episode_number}. {name}
                          {isNew && (
                            <span className="ml-1.5 rounded bg-red-600 px-1 py-0.5 align-middle text-[9px] font-bold uppercase text-white">
                              New
                            </span>
                          )}
                        </p>
                        <p className="mt-0.5 text-[11px] leading-snug text-zinc-500">
                          {!aired
                            ? `Airs ${formatDate(ep.air_date) || "TBA"}`
                            : `Aired ${formatDate(ep.air_date) || "—"}${
                                ep.overview ? "" : " · details pending"
                              }`}
                        </p>
                        {aired && ep.overview && (
                          <p className="mt-0.5 line-clamp-1 text-[11px] leading-snug text-zinc-600">
                            {ep.overview}
                          </p>
                        )}
                      </div>
                    </button>
                  );
                })}
              {!epLoading && !episodes.length && (
                <p className="p-4 text-center text-xs text-zinc-600">
                  No episode data for this season yet. New episodes appear here automatically
                  as soon as they are published.
                </p>
              )}
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}

import { NextRequest, NextResponse } from "next/server";
import { tmdbServer } from "@/lib/tmdb-server";
import { img, type MediaItem, type MediaType } from "@/lib/tmdb-constants";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/watch/resolve?type=movie|tv&id=<tmdbId>&season=&episode=
 *
 * Playback resolver for titles without a torrent source: picks the best
 * YouTube preview (episode → season → show for TV) and returns the show's
 * season/episode map so the player can render the episode picker. Full-title
 * public-domain streaming is handled separately by /api/archive, which does
 * its own title-keyed archive.org search with a strict legality gate.
 *
 * Written against tmdbServer (the server-side TMDB client) — an earlier
 * revision imported the browser client's internals (normalizeItem / pickVideo
 * / pdFor / Raw* types) which don't exist in that module, so the route
 * 404'd/500'd in every deployment.
 */

interface RawVideo {
  key?: string;
  name?: string;
  type?: string;
  site?: string;
  official?: boolean;
  published_at?: string;
}
interface RawVideos {
  results?: RawVideo[];
}
interface RawMovieDetail {
  id?: number;
  title?: string;
  tagline?: string;
  runtime?: number;
  vote_average?: number;
  poster_path?: string | null;
  backdrop_path?: string | null;
  overview?: string;
  release_date?: string;
  videos?: RawVideos;
}
interface RawTvDetail {
  id?: number;
  name?: string;
  tagline?: string;
  vote_average?: number;
  poster_path?: string | null;
  backdrop_path?: string | null;
  overview?: string;
  first_air_date?: string;
  episode_run_time?: number[];
  seasons?: { season_number: number; name: string; episode_count: number }[];
  videos?: RawVideos;
}
interface RawSeason {
  episodes?: {
    episode_number: number;
    name?: string;
    still_path?: string | null;
    runtime?: number | null;
    air_date?: string | null;
    overview?: string | null;
  }[];
}

type ResolveResult = {
  kind: "youtube" | "none";
  ytKey?: string;
  ytName?: string;
  sourceLabel: string;
  full: boolean;
  item: MediaItem | null;
  tagline?: string;
  runtime?: number;
  seasons?: { number: number; name: string; episodeCount: number }[];
  seasonNumber?: number;
  episodes?: {
    number: number;
    name: string;
    still: string;
    runtime?: number;
    airDate?: string;
    overview?: string;
  }[];
};

/** Route-local TMDB cache — tmdbServer itself is cacheless and the resolve
 *  payloads (season episode lists) are heavy and stable for hours. */
const resolveCache = new Map<string, { data: unknown; ts: number }>();
const TTL_MS = 6 * 3600_000;
const MAX_CACHE = 200;

async function tmdbCached<T>(path: string, params: Record<string, string | number> = {}): Promise<T> {
  const key = path + JSON.stringify(params);
  const hit = resolveCache.get(key);
  if (hit && Date.now() - hit.ts < TTL_MS) return hit.data as T;
  const data = await tmdbServer<T>(path, params);
  if (resolveCache.size > MAX_CACHE) {
    const oldest = resolveCache.keys().next().value;
    if (oldest) resolveCache.delete(oldest);
  }
  resolveCache.set(key, { data, ts: Date.now() });
  return data;
}

function normalizeItem(
  detail: RawMovieDetail | RawTvDetail,
  type: MediaType
): MediaItem | null {
  const md = detail as RawMovieDetail;
  const td = detail as RawTvDetail;
  const date = type === "movie" ? md.release_date : td.first_air_date;
  const name = (type === "movie" ? md.title : td.name) || "";
  const id = detail.id;
  if (!id || !name) return null;
  return {
    id,
    type,
    name,
    year: date ? Number(String(date).slice(0, 4)) || null : null,
    rating: detail.vote_average ?? 0,
    poster: img(detail.poster_path ?? "", "w342"),
    backdrop: img(detail.backdrop_path ?? "", "w780"),
    overview: detail.overview ?? "",
  };
}

/** Trailer > Teaser > Clip > anything else YouTube-offers, official first. */
const VIDEO_TYPE_RANK: Record<string, number> = {
  Trailer: 0,
  Teaser: 1,
  Clip: 2,
  Featurette: 3,
  Highlight: 4,
  "Behind the Scenes": 5,
  "Opening Credits": 6,
  Bloopers: 7,
};

function pickVideo(videos?: RawVideos): { key: string; name: string; type: string } | null {
  const list = (videos?.results ?? []).filter((v) => v.site === "YouTube" && v.key);
  if (!list.length) return null;
  list.sort((a, b) => {
    const rank = (VIDEO_TYPE_RANK[a.type ?? ""] ?? 9) - (VIDEO_TYPE_RANK[b.type ?? ""] ?? 9);
    if (rank !== 0) return rank;
    if (!!b.official !== !!a.official) return b.official ? 1 : -1;
    return (b.published_at ?? "").localeCompare(a.published_at ?? "");
  });
  const v = list[0];
  return { key: v.key as string, name: v.name ?? "", type: v.type ?? "Trailer" };
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const type: MediaType = sp.get("type") === "tv" ? "tv" : "movie";
  const id = Number(sp.get("id"));
  const seasonNumber = Math.max(1, Number(sp.get("season")) || 1);
  const episodeNumber = Math.max(1, Number(sp.get("episode")) || 1);

  if (!Number.isFinite(id) || id <= 0) {
    return NextResponse.json({ error: "Valid id required" }, { status: 400 });
  }

  try {
    if (type === "movie") {
      const detail = await tmdbCached<RawMovieDetail>(`movie/${id}`, {
        append_to_response: "videos",
      });
      const item = normalizeItem(detail, "movie");
      const video = pickVideo(detail.videos);
      const out: ResolveResult = {
        kind: video ? "youtube" : "none",
        ytKey: video?.key,
        ytName: video?.name,
        sourceLabel: video ? `${video.type} · YouTube` : "No preview available",
        full: false,
        item,
        tagline: detail.tagline || undefined,
        runtime: detail.runtime || undefined,
      };
      return NextResponse.json(out, { headers: { "Cache-Control": "no-store" } });
    }

    // ---- TV ----
    const detail = await tmdbCached<RawTvDetail>(`tv/${id}`, { append_to_response: "videos" });
    const item = normalizeItem(detail, "tv");

    const seasons = (detail.seasons || [])
      .filter((s) => s.episode_count > 0)
      .map((s) => ({ number: s.season_number, name: s.name, episodeCount: s.episode_count }));

    const seasonData = await tmdbCached<RawSeason>(`tv/${id}/season/${seasonNumber}`);
    const episodes = (seasonData.episodes || []).map((e) => ({
      number: e.episode_number,
      name: e.name || `Episode ${e.episode_number}`,
      still: img(e.still_path ?? "", "w300"),
      runtime: e.runtime || undefined,
      airDate: e.air_date || undefined,
      overview: e.overview || undefined,
    }));

    // episode videos → season videos → show videos
    const epVideos = await tmdbCached<RawVideos>(
      `tv/${id}/season/${seasonNumber}/episode/${episodeNumber}/videos`
    ).catch(() => undefined as unknown as RawVideos);
    let video = pickVideo(epVideos);
    if (!video) {
      const sVideos = await tmdbCached<RawVideos>(`tv/${id}/season/${seasonNumber}/videos`).catch(
        () => undefined as unknown as RawVideos
      );
      video = pickVideo(sVideos);
    }
    if (!video) {
      video = pickVideo(detail.videos);
    }

    const epMeta = episodes.find((e) => e.number === episodeNumber);
    const avgRuntime = detail.episode_run_time?.[0] || epMeta?.runtime || undefined;

    const out: ResolveResult = {
      kind: video ? "youtube" : "none",
      ytKey: video?.key,
      ytName: video?.name,
      sourceLabel: video
        ? epMeta
          ? `S${seasonNumber} E${episodeNumber} preview · ${video.type}`
          : `${video.type} · YouTube`
        : "No preview available",
      full: false,
      item,
      tagline: detail.tagline || undefined,
      runtime: avgRuntime,
      seasons,
      seasonNumber,
      episodes,
    };
    return NextResponse.json(out, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Resolve failed";
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}

import { NextRequest, NextResponse } from "next/server";
import {
  tmdb,
  normalizeItem,
  pickVideo,
  pdFor,
  type RawVideos,
  type RawSeason,
  type RawMovieDetail,
  type RawTvDetail,
} from "@/lib/tmdb";
import { img, type MediaItem } from "@/lib/tmdb-constants";

export const dynamic = "force-dynamic";

type ResolveResult = {
  kind: "file" | "youtube" | "none";
  url?: string;
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

function archiveUrl(iaId: string, iaFile: string): string {
  return `https://archive.org/download/${iaId}/${iaFile
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`;
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const type = sp.get("type") === "tv" ? "tv" : "movie";
  const id = Number(sp.get("id"));
  const seasonParam = sp.get("season");
  const episodeParam = sp.get("episode");

  if (!Number.isFinite(id) || id <= 0) {
    return NextResponse.json({ error: "Valid id required" }, { status: 400 });
  }

  try {
    const out = await resolve({ type, id, seasonParam, episodeParam });
    return NextResponse.json(out, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Resolve failed";
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}

async function resolve(opts: {
  type: "movie" | "tv";
  id: number;
  seasonParam: string | null;
  episodeParam: string | null;
}): Promise<ResolveResult> {
  const { type, id } = opts;

  if (type === "movie") {
    const detail = await tmdb<RawMovieDetail & { videos?: RawVideos }>(
      `movie/${id}`,
      { append_to_response: "videos" },
      30 * 60_000
    );
    const item = normalizeItem(detail, "movie");

    // 1) public-domain full movie?
    const pd = await pdFor(id);
    if (pd) {
      return {
        kind: "file",
        url: archiveUrl(pd.iaId, pd.iaFile),
        sourceLabel: "Full movie · Internet Archive (public domain)",
        full: true,
        item,
        tagline: detail.tagline || undefined,
        runtime: detail.runtime || undefined,
      };
    }

    // 2) trailer on YouTube
    const video = pickVideo(detail.videos);
    return {
      kind: video ? "youtube" : "none",
      ytKey: video?.key,
      ytName: video?.name,
      sourceLabel: video ? `${video.type} · YouTube` : "No preview available",
      full: false,
      item,
      tagline: detail.tagline || undefined,
      runtime: detail.runtime || undefined,
    };
  }

  // ---- TV ----
  const detail = await tmdb<RawTvDetail & { videos?: RawVideos }>(
    `tv/${id}`,
    { append_to_response: "videos" },
    30 * 60_000
  );
  const item = normalizeItem(detail, "tv");

  const seasons = (detail.seasons || [])
    .filter((s) => s.episode_count > 0)
    .map((s) => ({ number: s.season_number, name: s.name, episodeCount: s.episode_count }));

  const seasonNumber = Math.max(1, Number(opts.seasonParam || 1)) || 1;
  const episodeNumber = Math.max(1, Number(opts.episodeParam || 1)) || 1;

  // Season data for the episode list
  const seasonData = await tmdb<RawSeason>(`tv/${id}/season/${seasonNumber}`, {}, 6 * 3600_000);
  const episodes = (seasonData.episodes || []).map((e) => ({
    number: e.episode_number,
    name: e.name || `Episode ${e.episode_number}`,
    still: img(e.still_path, "w300"),
    runtime: e.runtime || undefined,
    airDate: e.air_date || undefined,
    overview: e.overview || undefined,
  }));

  // Try: episode videos → season videos → show videos
  const epVideos = await tmdb<RawVideos>(
    `tv/${id}/season/${seasonNumber}/episode/${episodeNumber}/videos`,
    {},
    6 * 3600_000
  ).catch(() => undefined as unknown as RawVideos);
  let video = pickVideo(epVideos);

  if (!video) {
    const sVideos = await tmdb<RawVideos>(`tv/${id}/season/${seasonNumber}/videos`, {}, 6 * 3600_000).catch(
      () => undefined as unknown as RawVideos
    );
    video = pickVideo(sVideos);
  }
  if (!video) {
    video = pickVideo(detail.videos);
  }

  const epMeta = episodes.find((e) => e.number === episodeNumber);
  const avgRuntime = detail.episode_run_time?.[0] || epMeta?.runtime || undefined;

  return {
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
}

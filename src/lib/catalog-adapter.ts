/**
 * Catalog adapter — bridges the curated public-domain / Creative-Commons
 * catalog to the MediaItem shapes the UI already speaks.
 *
 * Every title is a verified legal source: a full-length film or episode
 * hosted on archive.org (public domain or open license) or an official
 * Blender Foundation open-movie torrent. Numeric ids are stable (index in
 * the CATALOG array + 1000) so watchlist / progress entries survive restarts.
 */
import { CATALOG, getTitle as getCatalogTitle, type Title, type Episode as CatalogEpisode } from "./catalog";
import type { Episode, MediaDetails, MediaItem, Season } from "./tmdb";

/** Stable numeric id for a catalog title (MediaItem.id is number everywhere). */
export function numericId(t: Title): number {
  const idx = CATALOG.findIndex((c) => c.id === t.id);
  return 1000 + (idx >= 0 ? idx : 0);
}

export function titleByNumericId(id: number): Title | undefined {
  if (!Number.isFinite(id) || id < 1000) return undefined;
  return CATALOG[id - 1000];
}

export function titleBySlug(slug: string): Title | undefined {
  return CATALOG.find((t) => t.slug === slug);
}

/** Catalog kind → the two media types the player pipeline understands. */
export function mediaTypeOf(t: Title): "movie" | "tv" {
  return t.kind === "show" ? "tv" : "movie";
}

/** Title → the raw TMDB-ish MediaItem shape used across the UI. */
export function toMediaItem(t: Title): MediaItem {
  const type = mediaTypeOf(t);
  const date = `${t.year}-01-01`;
  return {
    id: numericId(t),
    media_type: type,
    title: t.name,
    name: type === "tv" ? t.name : undefined,
    original_title: t.name,
    poster_path: t.poster,
    backdrop_path: t.backdrop ?? null,
    overview: t.synopsis,
    vote_average: t.rating,
    vote_count: 100,
    release_date: type === "movie" ? date : undefined,
    first_air_date: type === "tv" ? date : undefined,
  };
}

export const MEDIA_ITEMS: MediaItem[] = CATALOG.map(toMediaItem);

/* ---------- genres ---------- */

/** Deterministic genre id (stable across restarts; no TMDB ids needed). */
export function genreId(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return (h % 90000) + 1;
}

export const GENRE_LIST = [...new Set(CATALOG.flatMap((t) => t.genres))].sort().map((name) => ({
  id: genreId(name),
  name,
}));

const GENRE_BY_ID = new Map(GENRE_LIST.map((g) => [g.id, g.name]));

/* ---------- seasons & episodes (TV) ---------- */

/** Catalog episodes → TMDB episode shape the player already renders. */
export function episodesOfTmdb(t: Title): Episode[] {
  return (t.episodes ?? []).map((e) => ({
    id: 100000 + CATALOG.findIndex((c) => c.id === t.id) * 100 + e.episode,
    name: e.title,
    episode_number: e.episode,
    season_number: e.season,
    air_date: undefined,
    runtime: e.runtime,
    overview: e.synopsis,
    still_path: null,
  }));
}

export function seasonsOfTmdb(t: Title): Season[] {
  const bySeason = new Map<number, Episode[]>();
  for (const e of episodesOfTmdb(t)) {
    const list = bySeason.get(e.season_number) ?? [];
    list.push(e);
    bySeason.set(e.season_number, list);
  }
  return [...bySeason.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([num, eps]) => ({
      id: numericId(t) * 10 + num,
      name: `Season ${num}`,
      season_number: num,
      episode_count: eps.length,
      air_date: undefined,
      poster_path: t.poster,
      overview: null,
    }));
}

export function episodeOfTmdb(t: Title, season: number, episode: number): Episode | undefined {
  return episodesOfTmdb(t).find((e) => e.season_number === season && e.episode_number === episode);
}

/** The catalog episode row (has the iaId/iaFile used for direct streams). */
export function catalogEpisode(
  t: Title,
  season: number,
  episode: number
): CatalogEpisode | undefined {
  return getCatalogEpisode(t, season, episode);
}

function getCatalogEpisode(t: Title, season: number, episode: number) {
  return (t.episodes ?? []).find((e) => e.season === season && e.episode === episode);
}

/* ---------- details ---------- */

export function toMediaDetails(t: Title): MediaDetails {
  const item = toMediaItem(t);
  return {
    ...item,
    tagline: t.tagline,
    runtime: t.runtime,
    episode_run_time: t.kind === "show" ? [t.runtime] : undefined,
    genres: t.genres.map((g) => ({ id: genreId(g), name: g })),
    status: "Released",
    homepage: "",
    number_of_seasons: seasonsOfTmdb(t).length || undefined,
    number_of_episodes: (t.episodes ?? []).length || undefined,
    credits: {
      cast: t.cast.map((name, i) => ({
        id: i + 1,
        name,
        character: "",
        profile_path: null,
        order: i,
      })),
      crew: [],
    },
    videos: { results: [] },
    similar: { results: [] },
    recommendations: { results: [] },
    seasons: t.kind === "show" ? seasonsOfTmdb(t) : undefined,
    production_companies: [],
  };
}

/* ---------- rows ---------- */

export function rowByRating(items = CATALOG): MediaItem[] {
  return [...items].sort((a, b) => b.rating - a.rating).map(toMediaItem);
}

export function rowByYear(items = CATALOG): MediaItem[] {
  return [...items].sort((a, b) => b.year - a.year).map(toMediaItem);
}

export function rowOfKind(kind: Title["kind"]): MediaItem[] {
  return rowByRating(CATALOG.filter((t) => t.kind === kind));
}

export function rowOfGenre(genre: string): MediaItem[] {
  return rowByRating(CATALOG.filter((t) => t.genres.includes(genre)));
}

export function rowOfAnimation(): MediaItem[] {
  return rowByRating(CATALOG.filter((t) => t.type === "Animation" || t.kind === "anime"));
}

export function searchCatalog(query: string): MediaItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const words = q.split(/\s+/);
  return CATALOG.map((t) => {
    const hay = `${t.name} ${t.genres.join(" ")} ${t.director} ${t.cast.join(" ")} ${t.year}`.toLowerCase();
    let score = 0;
    if (t.name.toLowerCase().includes(q)) score += 100;
    for (const w of words) if (hay.includes(w)) score += 10;
    return { t, score };
  })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || b.t.rating - a.t.rating)
    .map((x) => toMediaItem(x.t));
}

/** discover/… with a genre filter (AnimeView passes with_original_language=ja;
 *  the legal catalog answers that with the early-anime section). */
export function discoverRow(kind: "movie" | "tv", params: Record<string, string>): MediaItem[] {
  const genreName = params.with_genres ? GENRE_BY_ID.get(Number(params.with_genres)) : undefined;
  const ja = params.with_original_language === "ja";
  let pool: Title[];
  if (ja) pool = CATALOG.filter((t) => t.language === "Japanese");
  else if (genreName) pool = CATALOG.filter((t) => t.genres.includes(genreName));
  else pool = CATALOG.filter((t) => mediaTypeOf(t) === kind);
  const sort = params.sort_by ?? "popularity.desc";
  const sorted = [...pool];
  if (sort.includes("vote_average")) sorted.sort((a, b) => b.rating - a.rating);
  else if (sort.includes("primary_release_date") || sort.includes("first_air_date"))
    sorted.sort((a, b) => b.year - a.year);
  else sorted.sort((a, b) => b.rating - a.rating);
  return sorted.map(toMediaItem);
}

/** Official Blender Foundation torrents — permanent webseed + real P2P swarm. */
export const BLENDER_TORRENTS: Record<string, string> = {
  "big-buck-bunny": "https://webtorrent.io/torrents/big-buck-bunny.torrent",
  sintel: "https://webtorrent.io/torrents/sintel.torrent",
  "tears-of-steel": "https://webtorrent.io/torrents/tears-of-steel.torrent",
  "cosmos-laundromat": "https://webtorrent.io/torrents/cosmos-laundromat.torrent",
};

export { CATALOG };

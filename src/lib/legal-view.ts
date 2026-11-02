/**
 * Catalog → TMDB-shape adapters. The UI components (cards, rows, detail
 * modal, player) speak the TMDB item shape, so the legal catalog is served
 * through it. Catalog ids are stable numbers ≥ 900000 that never collide
 * with real TMDB ids; the /api/tmdb proxy recognizes them and answers from
 * the catalog instead of TMDB.
 */
import type { Episode as CatEpisode, Title } from "./catalog";
import { CATALOG, episodesOf, relatedTo } from "./catalog";
import { catalogNumericId } from "./torrent-sources";
import type { Episode, MediaDetails, MediaItem, Season } from "./tmdb";

export const numericIdOf = catalogNumericId;

const BY_NUMERIC_ID = new Map<number, Title>(CATALOG.map((t) => [numericIdOf(t), t]));

export function catalogTitleById(id: number): Title | undefined {
  return BY_NUMERIC_ID.get(id);
}

export function toMediaItem(t: Title): MediaItem {
  const isShow = t.kind !== "movie";
  return {
    id: numericIdOf(t),
    media_type: isShow ? "tv" : "movie",
    title: t.name,
    poster_path: t.poster,
    backdrop_path: t.backdrop ?? "",
    vote_average: t.rating,
    overview: t.synopsis,
    release_date: isShow ? undefined : `${t.year}-01-01`,
    first_air_date: isShow ? `${t.year}-01-01` : undefined,
    /** public-domain / CC title that streams in full on Otama */
    full: true,
  };
}

export function toMediaDetails(t: Title): MediaDetails {
  const isShow = t.kind !== "movie";
  const seasons = seasonsOf(t);
  return {
    ...toMediaItem(t),
    tagline: t.tagline,
    runtime: isShow ? null : t.runtime,
    episode_run_time: isShow ? [t.runtime] : undefined,
    genres: t.genres.map((name, i) => ({ id: 9000 + i, name })),
    status: "Released",
    number_of_seasons: isShow ? seasons.length : undefined,
    number_of_episodes: isShow ? episodesOf(t).length : undefined,
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
    similar: { results: relatedTo(t, 12).map((r) => toMediaItem(r)) },
    recommendations: { results: [] },
    seasons: isShow ? seasons : undefined,
    production_companies: t.director
      ? [{ id: 1, name: t.director, logo_path: null }]
      : undefined,
  };
}

function seasonsOf(t: Title): Season[] {
  const bySeason = new Map<number, CatEpisode[]>();
  for (const e of episodesOf(t)) {
    const list = bySeason.get(e.season) ?? [];
    list.push(e);
    bySeason.set(e.season, list);
  }
  return [...bySeason.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([n, eps]) => ({
      id: numericIdOf(t) * 100 + n,
      name: n === 1 ? `Season ${n}` : `Season ${n}`,
      season_number: n,
      episode_count: eps.length,
      air_date: `${t.year}-01-01`,
      overview: undefined,
    }));
}

export function toSeasonEpisodes(t: Title, season: number): Episode[] {
  return episodesOf(t)
    .filter((e) => e.season === season)
    .map((e) => ({
      id: numericIdOf(t) * 1000 + e.episode,
      name: e.title,
      episode_number: e.episode,
      season_number: e.season,
      air_date: null,
      still_path: null,
      overview: e.synopsis,
      runtime: e.runtime,
    }));
}

/** case-insensitive catalog search for /api/tmdb search/multi interception */
export function searchCatalog(query: string, limit = 20): MediaItem[] {
  const q = query.toLowerCase().trim();
  if (!q) return [];
  const scored = CATALOG.map((t) => {
    const name = t.name.toLowerCase();
    let score = 0;
    if (name === q) score = 100;
    else if (name.startsWith(q)) score = 80;
    else if (name.includes(q)) score = 60;
    else if (t.genres.some((g) => g.toLowerCase().includes(q))) score = 30;
    else if (t.cast.some((c) => c.toLowerCase().includes(q))) score = 25;
    else if (t.director.toLowerCase().includes(q)) score = 25;
    return { t, score };
  })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || b.t.rating - a.t.rating)
    .slice(0, limit);
  return scored.map((s) => toMediaItem(s.t));
}

"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import { MediaItem } from "@/lib/tmdb";
import { Header } from "@/components/streaming/Header";
import { HeroCarousel } from "@/components/streaming/HeroCarousel";
import { HomeView } from "@/components/streaming/HomeView";
import { BrowseGrid } from "@/components/streaming/BrowseGrid";
import { StudiosView } from "@/components/streaming/StudiosView";
import { BrandView } from "@/components/streaming/BrandView";
import { AnimeView } from "@/components/streaming/AnimeView";
import { DetailModal } from "@/components/streaming/DetailModal";
import { PlayerModal } from "@/components/streaming/PlayerModal";
import { ViewType, MediaActions, PlayerTarget } from "@/components/streaming/types";
import { Brand } from "@/lib/brands";

interface TrailerState {
  item: MediaItem;
  key: string;
}

export default function Home() {
  const [view, setView] = useState<ViewType>("home");
  const [query, setQuery] = useState("");
  const [brand, setBrand] = useState<Brand | null>(null);
  const [detail, setDetail] = useState<MediaItem | null>(null);
  const [player, setPlayer] = useState<PlayerTarget | null>(null);
  const [trailer, setTrailer] = useState<TrailerState | null>(null);

  const openDetail = useCallback((item: MediaItem) => setDetail(item), []);
  const openPlayer = useCallback(
    (item: MediaItem, s?: number, e?: number) => {
      setPlayer({ item, season: s, episode: e });
    },
    []
  );

  const actions: MediaActions = useMemo(
    () => ({ openDetail, openPlayer }),
    [openDetail, openPlayer]
  );

  const navigate = useCallback((v: ViewType) => {
    setView(v);
    if (v === "studios") setBrand(null); // Studios nav always returns to the hub
    if (v !== "search") setQuery("");
    window.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior });
  }, []);

  const openBrand = useCallback((b: Brand) => {
    setBrand(b);
    window.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior });
  }, []);

  const search = useCallback((q: string) => {
    setQuery(q);
    setView(q.trim() ? "search" : "home");
    if (q.trim()) window.scrollTo({ top: 0 });
  }, []);

  // ESC closes topmost layer
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (trailer) setTrailer(null);
      else if (detail) setDetail(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [trailer, detail]);

  // Android hardware back (Capacitor shell): pop the topmost UI layer — the
  // player returns to the content page beneath it — and only exit the app
  // when the home view is showing and nothing else can go back. Without this
  // listener the WebView's default back handling closes the whole app from
  // inside the player. No-op in plain browsers (no native Capacitor bridge).
  const layersRef = useRef({ player, trailer, detail, brand, view, query });
  layersRef.current = { player, trailer, detail, brand, view, query };
  useEffect(() => {
    const cap = (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } })
      .Capacitor;
    if (!cap?.isNativePlatform?.()) return;
    let disposed = false;
    let handle: { remove: () => void } | null = null;
    void import("@capacitor/app")
      .then(({ App }) =>
        App.addListener("backButton", (data: { canGoBack: boolean }) => {
          const l = layersRef.current;
          if (l.player) setPlayer(null);
          else if (l.trailer) setTrailer(null);
          else if (l.detail) setDetail(null);
          else if (l.brand) setBrand(null);
          else if (l.view !== "home" || l.query) {
            navigate("home");
            setBrand(null);
          } else if (data.canGoBack) {
            window.history.back();
          } else {
            void App.exitApp();
          }
        })
      )
      .then((h) => {
        if (disposed) h?.remove();
        else handle = h ?? null;
      })
      .catch(() => {});
    return () => {
      disposed = true;
      handle?.remove();
    };
  }, [navigate]);

  return (
    <div className="flex min-h-screen flex-col bg-[#0b0b10] text-zinc-100">
      <Header active={view} query={query} onNavigate={navigate} onSearch={search} />

      <main className="min-h-[60vh] flex-1">
        {view === "home" && <HomeView actions={actions} onTrailer={(item, key) => setTrailer({ item, key })} />}
        {view === "movies" && <BrowseGrid kind="movie" title="Movies" actions={actions} />}
        {view === "tv" && <BrowseGrid kind="tv" title="TV Shows" actions={actions} />}
        {view === "anime" && <AnimeView actions={actions} />}
        {view === "studios" &&
          (brand ? (
            <BrandView
              key={`${brand.param}-${brand.id}`}
              brand={brand}
              actions={actions}
              onBack={() => setBrand(null)}
            />
          ) : (
            <StudiosView onSelect={openBrand} />
          ))}
        {view === "search" && (
          <BrowseGrid kind="search" query={query} title={query ? `Results for "${query}"` : "Search"} actions={actions} />
        )}
        {view === "mylist" && <BrowseGrid kind="mylist" title="My List" actions={actions} />}
      </main>

      {/* Footer */}
      <footer className="mt-auto border-t border-white/5 bg-black/40 px-4 py-10 md:px-8">
        <div className="mx-auto max-w-6xl">
          <div className="flex flex-col items-start justify-between gap-6 md:flex-row md:items-center">
            <div>
              <p className="text-lg font-black tracking-tight text-white">
                <span className="text-red-500">O</span>tama
              </p>
              <p className="mt-1 max-w-md text-xs leading-relaxed text-zinc-500">
                Your gateway to movies, TV shows and anime. Browse trending titles, watch official
                trailers and stream through your own built-in P2P player — all in one place.
              </p>
            </div>
            <nav className="flex flex-wrap gap-x-6 gap-y-2 text-xs text-zinc-400" aria-label="Footer">
              {(
                [
                  ["home", "Home"],
                  ["movies", "Movies"],
                  ["tv", "TV Shows"],
                  ["anime", "Anime"],
                  ["studios", "Studios"],
                  ["mylist", "My List"],
                ] as [ViewType, string][]
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => navigate(id)}
                  className="transition hover:text-red-400"
                >
                  {label}
                </button>
              ))}
            </nav>
          </div>
          <div className="mt-8 space-y-2 border-t border-white/5 pt-6 text-[11px] leading-relaxed text-zinc-600">
            <p>
              This product uses the TMDB API but is not endorsed or certified by TMDB. Data and
              images courtesy of The Movie Database (www.themoviedb.org).
            </p>
            <p>
              Popcorn Time does not host any media files. Playback streams directly from public
              peer-to-peer networks through the built-in ad-free player; availability depends on
              the public swarm.
            </p>
          </div>

          {/* About Us */}
          <section className="mt-10 border-t border-white/5 pt-8" aria-labelledby="about-us-heading">
            <h2
              id="about-us-heading"
              className="text-sm font-bold uppercase tracking-wider text-zinc-300"
            >
              About Us
            </h2>
            <div className="mt-3 max-w-3xl space-y-3 text-xs leading-relaxed text-zinc-500">
              <p>
                Popcorn Time is a free, browser-based discovery and playback app for movies, TV shows and
                anime. The catalog, posters, ratings and episode guides are powered by The Movie
                Database (TMDB), and every title page gathers every way to watch it in one place —
                trailers, a built-in player, direct streams and third-party web servers — so you
                never have to dig through a dozen tabs again.
              </p>
              <p>
                Playback is organised into two clearly separated groups. The{" "}
                <span className="font-semibold text-emerald-400">Ad-free</span> group runs through
                our own player: sources are found on public peer-to-peer networks and streamed by
                the built-in player, and <span className="font-semibold text-emerald-400">
                Popcorn Direct</span> serves public-domain and freely licensed copies straight from
                archive.org. The <span className="font-semibold text-amber-400">Ads</span> group
                lists third-party web servers — those pages carry the providers&apos; own
                advertising. The player always tries the best ad-free source first, and whenever
                the ad-free sources come up empty or fail, a healthy Ads server opens on its own
                (marked with an amber badge); the amber chips in the same server row, each with a
                live health dot, let you pick one yourself at any time.
              </p>
              <p>
                There is nothing to install and nothing to pay. Pick up where you left off with
                Continue Watching and build a watchlist in My List — your list and progress are
                stored in your own browser, not on our servers.
              </p>
            </div>
          </section>
        </div>
      </footer>

      {/* Modals — keyed so each target gets fresh state on open */}
      <DetailModal
        key={`detail-${detail?.id ?? "none"}`}
        item={detail}
        actions={actions}
        onClose={() => setDetail(null)}
      />
      <PlayerModal
        key={`player-${player?.item.id ?? "none"}-${player?.season ?? ""}-${player?.episode ?? ""}`}
        target={player}
        actions={actions}
        onClose={() => setPlayer(null)}
      />

      {/* Trailer overlay */}
      {trailer && (
        <div
          className="fixed inset-0 z-[90] flex items-center justify-center bg-black/90 backdrop-blur-sm p-4"
          onClick={() => setTrailer(null)}
          role="dialog"
          aria-modal="true"
          aria-label="Trailer player"
        >
          <div
            className="w-full max-w-4xl overflow-hidden rounded-xl shadow-2xl ring-1 ring-white/10"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between bg-[#12121a] px-4 py-2.5">
              <p className="truncate text-sm font-bold text-white">{trailer.item.title || trailer.item.name} — Trailer</p>
              <button
                type="button"
                onClick={() => setTrailer(null)}
                aria-label="Close trailer"
                className="flex h-8 w-8 items-center justify-center rounded-full bg-white/10 text-white transition hover:bg-red-600"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="aspect-video w-full bg-black">
              <iframe
                src={`https://www.youtube-nocookie.com/embed/${trailer.key}?autoplay=1&rel=0`}
                title="Trailer"
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                allowFullScreen
                className="h-full w-full"
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

"use client";

import { useMemo } from "react";
import { Clapperboard, Ghost, Tv, Rocket, Popcorn, Sparkles, Baby, Landmark } from "lucide-react";
import { CATALOG, toMediaItem } from "@/lib/catalog-adapter";
import type { MediaItem } from "@/lib/tmdb";
import { MediaActions, ViewType } from "./types";
import { MediaRow } from "./MediaRow";

/**
 * Collections — the catalog grouped by era and origin. Replaces the old
 * TMDB-brand "Studios" hub: everything here is a curated slice of the
 * public-domain / open-licensed catalog.
 */

interface Collection {
  id: string;
  name: string;
  blurb: string;
  icon: React.ReactNode;
  accent: string;
  pick: () => typeof CATALOG;
}

const COLLECTIONS: Collection[] = [
  {
    id: "silent-era",
    name: "Silent Era Masterpieces",
    blurb: "Lang, Murnau, Keaton and Chaplin — the foundations of cinema, free forever.",
    icon: <Landmark className="h-5 w-5" />,
    accent: "from-amber-500/20 to-amber-900/10",
    pick: () => CATALOG.filter((t) => t.year < 1930),
  },
  {
    id: "horror",
    name: "Lights Off: Horror Classics",
    blurb: "From Nosferatu's plague shadows to Romero's undead — the genre's origins.",
    icon: <Ghost className="h-5 w-5" />,
    accent: "from-emerald-500/20 to-emerald-900/10",
    pick: () => CATALOG.filter((t) => t.genres.includes("Horror")),
  },
  {
    id: "blender",
    name: "Blender Open Movies",
    blurb: "The Blender Foundation's open-licensed films — modern animation, free to remix.",
    icon: <Sparkles className="h-5 w-5" />,
    accent: "from-orange-500/20 to-orange-900/10",
    pick: () => CATALOG.filter((t) => t.quality.includes("CC-BY")),
  },
  {
    id: "cartoons",
    name: "Golden-Age Cartoons",
    blurb: "Fleischer's Superman, Betty Boop and Popeye — hand-drawn jazz-age animation.",
    icon: <Popcorn className="h-5 w-5" />,
    accent: "from-red-500/20 to-red-900/10",
    pick: () => CATALOG.filter((t) => t.type === "Animation" && t.kind === "movie"),
  },
  {
    id: "anime",
    name: "The First Anime",
    blurb: "Japan's earliest surviving animation, 1917–1943 — silent national treasures.",
    icon: <Baby className="h-5 w-5" />,
    accent: "from-pink-500/20 to-pink-900/10",
    pick: () => CATALOG.filter((t) => t.kind === "anime"),
  },
  {
    id: "tv",
    name: "Classic TV, Free & Legal",
    blurb: "Sherlock Holmes, Lucille Ball and the Clampetts — public-domain episodes.",
    icon: <Tv className="h-5 w-5" />,
    accent: "from-sky-500/20 to-sky-900/10",
    pick: () => CATALOG.filter((t) => t.kind === "show"),
  },
  {
    id: "scifi",
    name: "Retro Sci-Fi",
    blurb: "Metropolis to Ed Wood — yesterday's visions of the future.",
    icon: <Rocket className="h-5 w-5" />,
    accent: "from-violet-500/20 to-violet-900/10",
    pick: () => CATALOG.filter((t) => t.genres.includes("Sci-Fi")),
  },
  {
    id: "laugh",
    name: "Laugh Track: Comedy",
    blurb: "Keaton's deadpan, the screwball newsroom and Lucy at her most chaotic.",
    icon: <Clapperboard className="h-5 w-5" />,
    accent: "from-lime-500/20 to-lime-900/10",
    pick: () => CATALOG.filter((t) => t.genres.includes("Comedy")),
  },
];

export function CollectionsView({ actions }: { actions: MediaActions }) {
  const rows = useMemo(
    () =>
      COLLECTIONS.map((c) => ({
        ...c,
        items: c
          .pick()
          .map(toMediaItem)
          .filter((m): m is MediaItem => !!m),
      })).filter((c) => c.items.length > 0),
    []
  );

  return (
    <div className="mx-auto max-w-6xl px-4 pb-16 pt-8 md:px-8">
      <header className="mb-8">
        <h1 className="text-2xl font-black tracking-tight text-white">Collections</h1>
        <p className="mt-1 max-w-2xl text-sm text-zinc-400">
          Curated slices of the catalog — every title is public domain,
          Creative-Commons licensed or an official open-movie release.
        </p>
      </header>
      <div className="grid gap-4 sm:grid-cols-2">
        {rows.map((c) => (
          <button
            key={c.id}
            type="button"
            onClick={() => {
              const el = document.getElementById(`col-${c.id}`);
              el?.scrollIntoView({ behavior: "smooth", block: "start" });
            }}
            className={`group relative overflow-hidden rounded-2xl border border-white/5 bg-gradient-to-br ${c.accent} p-5 text-left transition hover:border-white/20`}
          >
            <div className="flex items-center gap-2 text-zinc-200">
              {c.icon}
              <h2 className="text-base font-bold text-white">{c.name}</h2>
            </div>
            <p className="mt-2 text-xs leading-relaxed text-zinc-400">{c.blurb}</p>
            <p className="mt-3 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
              {c.pick().length} titles
            </p>
          </button>
        ))}
      </div>
      <div className="mt-10 space-y-8">
        {rows.map((c) => (
          <div key={`row-${c.id}`} id={`col-${c.id}`} className="scroll-mt-24">
            <MediaRow title={c.name} items={c.items} actions={actions} icon={c.icon} />
          </div>
        ))}
      </div>
    </div>
  );
}

export type { ViewType };

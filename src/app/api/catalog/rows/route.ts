import { NextRequest, NextResponse } from "next/server";
import { CATALOG, FEATURED_IDS, byId, newArrivals, trending } from "@/lib/catalog";
import { toMediaItem } from "@/lib/legal-view";

export const dynamic = "force-dynamic";

/**
 * GET /api/catalog/rows?name=<row>
 *
 * Named rows for the home screen, built entirely from the legal catalog
 * (public-domain / Creative Commons titles + Blender open movies). Names map
 * to the row configs in HomeView; unknown names answer an empty list.
 */
export async function GET(req: NextRequest) {
  const name = req.nextUrl.searchParams.get("name") ?? "";
  const n = Math.min(20, Math.max(2, Number(req.nextUrl.searchParams.get("n")) || 14));

  let titles;
  switch (name) {
    case "featured":
      titles = FEATURED_IDS.map((id) => byId.get(id)).filter(Boolean);
      break;
    case "trending":
      titles = trending(n);
      break;
    case "recent":
      titles = newArrivals(n);
      break;
    case "top":
      titles = [...CATALOG].sort((a, b) => b.rating - a.rating).slice(0, n);
      break;
    case "shows":
      titles = CATALOG.filter((t) => t.kind !== "movie").slice(0, n);
      break;
    case "featured-genre": {
      const g = req.nextUrl.searchParams.get("genre") ?? "";
      titles = CATALOG.filter((t) => t.genres.includes(g)).slice(0, n);
      break;
    }
    default:
      titles = [];
  }

  return NextResponse.json(
    { results: (titles as typeof CATALOG).map(toMediaItem) },
    { headers: { "Cache-Control": "no-store" } }
  );
}

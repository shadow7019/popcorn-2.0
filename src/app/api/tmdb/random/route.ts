import { NextResponse } from "next/server";
import { CATALOG, toMediaItem } from "@/lib/catalog-adapter";

export const runtime = "nodejs";

/** Random pick from the legal catalog (used by the header "Random" button). */
export async function GET() {
  const t = CATALOG[Math.floor(Math.random() * CATALOG.length)];
  return NextResponse.json(toMediaItem(t), {
    headers: { "Cache-Control": "no-store" },
  });
}

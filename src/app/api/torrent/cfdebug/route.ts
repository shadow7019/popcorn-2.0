import { NextResponse } from "next/server";
import { cfDebug, clearancedPage } from "@/lib/cf-clearance";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PROBE_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/**
 * GET /api/torrent/cfdebug          — report the clearance layer's state.
 * GET /api/torrent/cfdebug?probe=1  — additionally attempt one live mint
 *   against a 1337x mirror and report what happened. Diagnostic only.
 */
export async function GET(req: Request) {
  const probe = new URL(req.url).searchParams.get("probe");
  const state = cfDebug();
  if (!probe) return NextResponse.json(state);

  const started = Date.now();
  const url = "https://1337x.to/search/inception/1/";
  const html = await clearancedPage(url, PROBE_UA, 14_000);
  return NextResponse.json({
    ...state,
    probe: {
      url,
      ms: Date.now() - started,
      gotHtml: html.length,
      lookedLikeSearch: html.includes("/torrent/"),
      error: cfDebug().lastError,
    },
  });
}

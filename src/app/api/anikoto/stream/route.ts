import { NextRequest, NextResponse } from "next/server";
import { signProxyUrl, verifyProxyUrl, isPublicHttpsUrl } from "@/lib/anikoto-proxy";

/**
 * Anikoto HLS proxy — the megaplay CDN answers 403 unless the request
 * carries Referer https://megaplay.buzz/ , which browsers on our origin
 * cannot send cross-origin. The server fetches playlists and segments with
 * that referer, rewrites playlist URIs back through this route (signed —
 * see anikoto-proxy.ts; CDN hosts rotate, so the signature is the
 * capability, not a host list), and streams segments through untouched
 * (Range included).
 *
 * ?u= base64url of the upstream URL · ?s= its signature
 */

export const dynamic = "force-dynamic";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

function decode(urlParam: string, sig: string | null): URL | null {
  try {
    const raw = Buffer.from(urlParam, "base64url").toString("utf8");
    if (!isPublicHttpsUrl(raw)) return null;
    if (!sig || !verifyProxyUrl(raw, sig)) return null;
    return new URL(raw);
  } catch {
    return null;
  }
}

/** absolute-ize a playlist URI and route it back through this proxy, signed */
function proxied(uri: string, base: URL): string {
  const abs = new URL(uri, base).href;
  return `/api/anikoto/stream?u=${Buffer.from(abs).toString("base64url")}&s=${signProxyUrl(abs)}`;
}

async function upstream(u: URL, range: string | null) {
  return fetch(u.href, {
    headers: {
      "User-Agent": UA,
      Referer: "https://megaplay.buzz/",
      Accept: "*/*",
      ...(range ? { Range: range } : {}),
    },
    signal: AbortSignal.timeout(20000),
  });
}

export async function GET(req: NextRequest) {
  const u = decode(
    req.nextUrl.searchParams.get("u") ?? "",
    req.nextUrl.searchParams.get("s")
  );
  if (!u) return new NextResponse("bad or untrusted url", { status: 400 });
  const range = req.headers.get("range");

  let r: Response;
  try {
    r = await upstream(u, range);
  } catch {
    return new NextResponse("upstream unreachable", { status: 502 });
  }

  const ct = r.headers.get("content-type") ?? "";
  if (/mpegurl|vnd\.apple/i.test(ct) || u.pathname.endsWith(".m3u8") || u.pathname.endsWith(".m3u")) {
    // playlist: rewrite every URI (variant lines, segments, keys, maps) through us
    const base = u;
    const body = (await r.text())
      .split("\n")
      .map((line) => {
        const t = line.trim();
        if (!t) return line;
        if (!t.startsWith("#")) return proxied(t, base);
        return t.replace(/URI="([^"]+)"/g, (_m, uri) => `URI="${proxied(uri, base)}"`);
      })
      .join("\n");
    return new NextResponse(body, {
      status: r.status,
      headers: {
        "Content-Type": "application/vnd.apple.mpegurl",
        "Cache-Control": "no-store",
      },
    });
  }

  // segment / subtitle / key: stream through with Range passthrough
  const headers = new Headers();
  for (const h of ["Content-Type", "Content-Length", "Content-Range", "Accept-Ranges"])
    if (r.headers.get(h)) headers.set(h, r.headers.get(h)!);
  if (!headers.has("Content-Type")) headers.set("Content-Type", "video/mp2t");
  headers.set("Cache-Control", "no-store");
  return new NextResponse(r.body, { status: r.status, headers });
}

import { createHmac, timingSafeEqual } from "crypto";

/**
 * Proxy capability tokens for the Anikoto HLS route. Segment/variant hosts
 * rotate (fetch.nexabloom.top today, per-CDN domains like *.silentvoyage.*
 * tomorrow) so a static allowlist breaks the moment the CDN shuffles —
 * instead every proxy URL is signed by us when we rewrite a playlist, and
 * the route only forwards URLs carrying a valid signature. Nothing that
 * didn't come out of one of our own playlists can be proxied.
 */

const SECRET = "pt-anikoto-hls-v1:do-not-reuse-elsewhere";

export function signProxyUrl(url: string): string {
  const mac = createHmac("sha256", SECRET).update(url).digest("base64url").slice(0, 22);
  return mac;
}

export function verifyProxyUrl(url: string, sig: string): boolean {
  const expected = Buffer.from(signProxyUrl(url));
  let got: Buffer;
  try {
    got = Buffer.from(sig);
  } catch {
    return false;
  }
  return got.length === expected.length && timingSafeEqual(got, expected);
}

/** basic SSRF guard — signed URLs still must be public https */
export function isPublicHttpsUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:") return false;
    const h = u.hostname;
    if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal")) return false;
    if (/^127\.|^10\.|^192\.168\.|^169\.254\.|^0\.|^::1$|^\[?fd/i.test(h)) return false;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return false;
    return true;
  } catch {
    return false;
  }
}

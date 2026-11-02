import { NextRequest, NextResponse } from "next/server";
import { cachedProbe, findTorrent, isValidInfoHash, probeFailures, probeTorrent } from "@/lib/torrent-engine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface HealthRequest {
  servers?: { id?: string; name?: string; url?: string }[];
}

interface HealthRow {
  id: string;
  status: "live" | "dead";
  peers: number;
  /** torrent was already streaming in the engine — no probe was needed */
  active?: boolean;
}

/**
 * POST /api/torrent/health   { servers: [{ id: infoHash, name, url? }] }
 *
 * Server auto-checker: asks the swarm (DHT + trackers + .torrent mirrors)
 * whether each source is actually reachable right now. The player uses this to
 *   - badge every server ✓ live / ✗ dead,
 *   - skip dead servers when auto-picking / failing over,
 *   - auto-remove dead links (they stay filtered out until they re-verify).
 *
 * A single failed probe is NOT enough to condemn a server — a swarm can be
 * momentarily busy — so a "dead" verdict requires two consecutive silent
 * probes. That keeps good servers from being buried by one bad moment, while
 * genuinely dead links still drop out automatically.
 */
const MAX_BATCH = 10;
const CONCURRENCY = 2;
/** .torrent-file metadata lands in ~1s; magnets may need the full window */
const PROBE_TIMEOUT = 12000;

export async function POST(req: NextRequest) {
  let body: HealthRequest;
  try {
    body = (await req.json()) as HealthRequest;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const list = (body.servers ?? [])
    .filter((s) => s && typeof s.id === "string" && isValidInfoHash(s.id))
    .slice(0, MAX_BATCH);

  if (!list.length) {
    return NextResponse.json({ results: [] as HealthRow[] });
  }

  const results: HealthRow[] = [];
  const queue = [...list];
  const worker = async () => {
    for (;;) {
      const item = queue.shift();
      if (!item) return;
      const id = (item.id as string).toLowerCase();
      const name = (item.name ?? "").slice(0, 160);
      const url = typeof item.url === "string" && /^https:\/\//.test(item.url) ? item.url : null;
      try {
        const active = findTorrent(id);
        if (active && (active.ready || active.numPeers > 0)) {
          results.push({ id, status: "live", peers: active.numPeers, active: true });
          continue;
        }
        let probe = await probeTorrent(id, name, PROBE_TIMEOUT, url);
        // two-strike rule: the first silent probe gets one immediate retry —
        // with cached metadata / .torrent files this retry is cheap and stops
        // transient DHT cold-starts from demoting healthy servers
        if (probe.status === "dead" && probeFailures(id) <= 1) {
          probe = await probeTorrent(id, name, PROBE_TIMEOUT, url);
        }
        results.push({ id, status: probe.status, peers: probe.peers });
      } catch {
        results.push({ id, status: "dead", peers: 0 });
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  return NextResponse.json({ results });
}

/** GET /api/torrent/health?id=<infoHash> — single cached lookup (debugging). */
export async function GET(req: NextRequest) {
  const id = (req.nextUrl.searchParams.get("id") ?? "").toLowerCase();
  if (!isValidInfoHash(id)) {
    return NextResponse.json({ error: "Missing or invalid id" }, { status: 400 });
  }
  return NextResponse.json({ id, cached: cachedProbe(id) });
}

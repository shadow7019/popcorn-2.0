"use client";

import { useMemo, useState } from "react";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  Globe,
  Loader2,
  Magnet,
  ShieldCheck,
} from "lucide-react";
import { WEB_SOURCES, type WebSource } from "@/lib/tmdb";

/** mirrors the TorrentServer interface in PlayerModal (kept structural to
 *  avoid a circular import — PlayerModal imports this component) */
interface BoxTorrentServer {
  id: string;
  releaseName: string;
  seeders: number;
  sizeBytes: number;
  provider: string;
  quality: string;
  match: "verified" | "pack" | "weak";
  /** Anikoto HLS rows — plays through our referer proxy, not the engine */
  hls?: string;
  lang?: "sub" | "dub";
}

interface EmbedHealth {
  ok: boolean;
  frameable: boolean;
  status: number;
}

export interface ServerBoxProps {
  servers: BoxTorrentServer[];
  serversState: "loading" | "ready" | "error";
  /** index of the playing torrent row (null when a web/direct row is active) */
  activeIdx: number | null;
  /** index into WEB_SOURCES of the playing Ads row (null otherwise) */
  activeWebIdx: number | null;
  archiveActive: boolean;
  archiveState: "loading" | "found" | "none";
  onSelectArchive: () => void;
  onSelectTorrent: (i: number) => void;
  onSelectWeb: (i: number) => void;
  /** per-server failure reasons (red rows, newest first line) */
  failedIds: Record<string, string>;
  webHealth: Record<string, EmbedHealth>;
}

const fmtSize = (b: number) =>
  b >= 1e9
    ? `${(b / 1e9).toFixed(1)} GB`
    : b >= 1e6
      ? `${Math.round(b / 1e6)} MB`
      : b > 0
        ? `${Math.round(b / 1e3)} KB`
        : "—";
const fmtSeeders = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

const MATCH_BADGE: Record<BoxTorrentServer["match"], { label: string; cls: string }> = {
  verified: { label: "verified", cls: "text-emerald-400" },
  pack: { label: "pack", cls: "text-sky-400" },
  weak: { label: "unverified", cls: "text-amber-400" },
};

function GroupHeader({ text, cls, hint }: { text: string; cls: string; hint?: string }) {
  return (
    <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-white/5 bg-[#0e0e15]/95 px-3 py-2 backdrop-blur">
      <span className={`text-[10px] font-bold uppercase tracking-wider ${cls}`}>{text}</span>
      {hint && <span className="truncate text-[10px] font-normal text-zinc-500">{hint}</span>}
    </div>
  );
}

/**
 * The server box — one collapsible panel listing EVERY playback server for
 * the open title, grouped in priority order: PopcornRU (the four .link
 * mirrors, tried first), the ad-free Direct archive.org stream, the remaining
 * torrent servers in rank order, and the opt-in third-party Ads web servers.
 * Replaces the old horizontal chip strip (unreadable on phones once a title
 * had more than a handful of servers).
 */
export function ServerBox({
  servers,
  serversState,
  activeIdx,
  activeWebIdx,
  archiveActive,
  archiveState,
  onSelectArchive,
  onSelectTorrent,
  onSelectWeb,
  failedIds,
  webHealth,
}: ServerBoxProps) {
  const [open, setOpen] = useState(false);

  const popcornIdx = useMemo(
    () => servers.map((s, i) => (s.provider === "PopcornRU" ? i : -1)).filter((i) => i >= 0),
    [servers]
  );
  const anikotoIdx = useMemo(
    () => servers.map((s, i) => (s.provider === "Anikoto" ? i : -1)).filter((i) => i >= 0),
    [servers]
  );
  const otherIdx = useMemo(
    () =>
      servers
        .map((_, i) => i)
        .filter((i) => !popcornIdx.includes(i) && !anikotoIdx.includes(i)),
    [servers, popcornIdx, anikotoIdx]
  );
  const totalServers =
    servers.length + WEB_SOURCES.length + (archiveState === "found" ? 1 : 0);

  const activeTorrent = activeIdx !== null ? servers[activeIdx] ?? null : null;
  const activeSummary = archiveActive
    ? "S-Direct · archive.org"
    : activeWebIdx !== null
      ? `S${servers.length + activeWebIdx + 1} · ${WEB_SOURCES[activeWebIdx]?.name ?? "web"} (ads)`
      : activeTorrent
        ? `S${activeIdx! + 1} · ${activeTorrent.quality} · ${activeTorrent.provider}`
        : serversState === "loading"
          ? "Scanning servers…"
          : serversState === "error"
            ? "Server scan failed — tap to retry sources"
            : servers.length > 0
              ? `${servers.length} torrent servers found`
              : "No torrent servers for this title";

  const torrentRow = (i: number, preferred: boolean) => {
    const s = servers[i];
    const active = activeIdx === i;
    const failReason = failedIds[s.id] ?? null;
    const mb = MATCH_BADGE[s.match];
    return (
      <button
        key={s.id}
        type="button"
        onClick={() => onSelectTorrent(i)}
        title={`${failReason ? `⚠ Failed earlier: ${failReason}\n` : ""}${s.releaseName}\n${s.seeders} seeders · ${fmtSize(s.sizeBytes)} · ${s.provider}`}
        className={`flex w-full items-center gap-3 px-3 py-2.5 text-left transition ${
          active ? "bg-red-600/20" : "hover:bg-white/5 active:bg-white/10"
        }`}
      >
        <span
          className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-xs font-black ${
            active ? "bg-red-600 text-white" : "bg-white/5 text-zinc-300"
          }`}
        >
          S{i + 1}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="text-sm font-bold text-white">{s.quality}</span>
            <span className="truncate text-[11px] font-medium text-zinc-400">{s.provider}</span>
            {preferred && (
              <span className="shrink-0 rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-emerald-400">
                preferred
              </span>
            )}
            {s.hls ? (
              <span className="shrink-0 rounded-full bg-sky-500/15 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-sky-400">
                {s.lang ?? "hls"}
              </span>
            ) : (
              <span className={`hidden shrink-0 text-[9px] font-normal sm:inline ${mb.cls}`}>
                {mb.label}
              </span>
            )}
          </span>
          <span
            className={`block truncate text-[11px] ${failReason ? "text-red-400" : "text-zinc-500"}`}
          >
            {failReason
              ? `Failed: ${failReason}`
              : s.hls
                ? `${s.releaseName} · HLS direct · no ads`
                : `${s.releaseName} · 👤${fmtSeeders(s.seeders)} · ${fmtSize(s.sizeBytes)}`}
          </span>
        </span>
        {active ? (
          <span className="flex shrink-0 items-center gap-1 rounded-full bg-red-600 px-2 py-0.5 text-[10px] font-bold text-white">
            <Check className="h-3 w-3" /> Playing
          </span>
        ) : failReason ? (
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-red-500" />
        ) : null}
      </button>
    );
  };

  const webRow = (w: WebSource, i: number) => {
    const h = webHealth[w.id];
    const dot = !h
      ? "bg-zinc-600 animate-pulse"
      : h.ok && h.frameable
        ? "bg-emerald-400"
        : "bg-red-500";
    const active = activeWebIdx === i;
    return (
      <button
        key={w.id}
        type="button"
        onClick={() => onSelectWeb(i)}
        title={`${w.name} — third-party web server · carries the provider's own ads\n${
          h
            ? h.ok
              ? `Reachable${h.frameable ? " · embeddable" : " · blocks embedding"}`
              : "Not responding right now"
            : "checking…"
        }`}
        className={`flex w-full items-center gap-3 px-3 py-2.5 text-left transition ${
          active ? "bg-amber-500/15" : "hover:bg-white/5 active:bg-white/10"
        }`}
      >
        <span
          className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-xs font-black ${
            active ? "bg-amber-500 text-black" : "bg-amber-500/10 text-amber-300"
          }`}
        >
          S{servers.length + i + 1}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="text-sm font-bold text-white">{w.name}</span>
            <span className="truncate text-[11px] font-medium text-amber-300/70">web server</span>
          </span>
          <span className="block truncate text-[11px] text-zinc-500">
            Third-party player · carries its own ads
          </span>
        </span>
        <span className={`h-2 w-2 shrink-0 rounded-full ${dot}`} />
      </button>
    );
  };

  return (
    <div className="px-3 pb-2 md:px-5" data-testid="server-box">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2.5 rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2.5 text-left transition hover:bg-white/[0.07]"
      >
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-red-600/15 text-red-400">
          <Magnet className="h-4 w-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-bold text-white">{activeSummary}</span>
          <span className="block truncate text-[11px] text-zinc-500">
            Tap to list all servers · PopcornRU is tried first, others auto-take over
          </span>
        </span>
        {serversState === "loading" ? (
          <Loader2 className="h-4 w-4 shrink-0 animate-spin text-zinc-400" />
        ) : (
          <span className="shrink-0 rounded-full bg-white/5 px-2.5 py-1 text-[11px] font-semibold text-zinc-300">
            {open ? "Hide" : `All ${totalServers}`}
          </span>
        )}
        <ChevronDown
          className={`h-4 w-4 shrink-0 text-zinc-400 transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open && (
        <div
          className="mt-1.5 max-h-[56vh] overflow-y-auto overscroll-contain rounded-xl border border-white/10 bg-[#0e0e15] shadow-2xl"
          style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
        >
          {serversState === "loading" && (
            <div className="flex items-center gap-2 px-3 py-3 text-xs text-zinc-400">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Scanning torrent networks for
              servers…
            </div>
          )}
          {serversState === "error" && (
            <div className="px-3 py-3 text-xs text-red-300">
              The server scan failed — close and reopen the player, or check your connection.
            </div>
          )}

          {anikotoIdx.length > 0 && (
            <>
              <GroupHeader
                text="Anikoto · HLS"
                cls="text-sky-400"
                hint="fresh anime streams — sub & dub, instant start, no ads"
              />
              {anikotoIdx.map((i) => torrentRow(i, false))}
            </>
          )}

          {popcornIdx.length > 0 && (
            <>
              <GroupHeader
                text="PopcornRU"
                cls="text-emerald-400"
                hint="preferred — first choice, others take over if it stalls"
              />
              {popcornIdx.map((i) => torrentRow(i, true))}
            </>
          )}

          {serversState === "ready" && servers.length === 0 && (
            <div className="px-3 py-3 text-xs text-zinc-400">
              No torrent servers answered for this title — the Ads web servers below almost
              always carry it.
            </div>
          )}

          <>
            <GroupHeader text="Direct · archive.org" cls="text-emerald-500" hint="ad-free public-domain copies" />
            <button
              type="button"
              onClick={onSelectArchive}
              disabled={archiveState !== "found"}
              title={
                archiveState === "found"
                  ? "Built-in player, direct stream — 100% ad-free"
                  : archiveState === "loading"
                    ? "Checking archive.org for a direct copy…"
                    : "No direct copy found for this title"
              }
              className={`flex w-full items-center gap-3 px-3 py-2.5 text-left transition ${
                archiveActive ? "bg-emerald-600/20" : "hover:bg-white/5 active:bg-white/10"
              } ${archiveState !== "found" ? "cursor-not-allowed opacity-50" : ""}`}
            >
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-emerald-600/15 text-emerald-400">
                <ShieldCheck className="h-4 w-4" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-bold text-white">Direct stream</span>
                <span className="block truncate text-[11px] text-zinc-500">
                  {archiveState === "loading"
                    ? "Checking archive.org…"
                    : archiveState === "found"
                      ? "Public-domain copy available — 100% ad-free"
                      : "No direct copy found for this title"}
                </span>
              </span>
              {archiveActive && (
                <span className="flex shrink-0 items-center gap-1 rounded-full bg-emerald-600 px-2 py-0.5 text-[10px] font-bold text-white">
                  <Check className="h-3 w-3" /> Playing
                </span>
              )}
            </button>
          </>

          {otherIdx.length > 0 && (
            <>
              <GroupHeader text="Torrent servers" cls="text-zinc-400" hint="ranked by match & seeders" />
              {otherIdx.map((i) => torrentRow(i, false))}
            </>
          )}

          <GroupHeader text="Ads · third-party" cls="text-amber-500" hint="always available, carry their own ads" />
          {WEB_SOURCES.map((w, i) => webRow(w, i))}

          <p className="border-t border-white/5 px-3 py-2 text-[10px] leading-relaxed text-zinc-600">
            The player starts on the best server automatically (PopcornRU first) and moves to the
            next one on its own whenever a server cannot play. Green dots = reachable, red = down,
            grey = still checking.
          </p>
        </div>
      )}
    </div>
  );
}

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable } from "node:stream";
import fs from "node:fs";
import path from "node:path";

/**
 * Server-side remux fallback: when the picked torrent file carries audio the
 * app shells cannot decode (AC3/E-AC3/DTS/TrueHD — see BAD_AUDIO_RE) or a
 * Matroska container WebKit refuses outright, the stream route pipes the file
 * through ffmpeg instead of serving it raw:
 *
 *   video: stream copy (no CPU cost, no quality loss)
 *   audio: transcode to AAC 192k stereo (decoded by every engine we ship)
 *   container: fragmented MP4 (empty_moov + default_base_moof) so the
 *              <video> element can start playing before the file completes
 *
 * The output is a single progressive response WITHOUT HTTP Range support —
 * seeking backwards inside the buffer works, jumping ahead re-buffers. Raw
 * (decodable) files keep the full bounded-Range path, so only the releases
 * that were silent before pay this trade.
 */

let cachedFfmpegPath: string | null | undefined;

/** Locate an ffmpeg binary: explicit env override → ffmpeg-static → PATH. */
export function resolveFfmpegPath(): string | null {
  if (cachedFfmpegPath !== undefined) return cachedFfmpegPath;
  cachedFfmpegPath = null;
  const exe = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  const candidates: string[] = [];
  if (process.env.FFMPEG_PATH) candidates.push(process.env.FFMPEG_PATH);
  try {
    // serverExternalPackages keeps this a real runtime require; a plain
    // require is absent in ESM contexts, which the fallback below covers
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const ffmpegStatic = require("ffmpeg-static") as string | null;
    if (ffmpegStatic) candidates.push(ffmpegStatic);
  } catch {
    /* not require-able here — fall through */
  }
  // bundler-proof fallback: the npm package layout is stable, and both the
  // standalone desktop renderer and the hosted site run with node_modules
  // under the working directory
  candidates.push(path.join(process.cwd(), "node_modules", "ffmpeg-static", exe));
  for (const p of candidates) {
    try {
      fs.accessSync(p, fs.constants.X_OK);
      cachedFfmpegPath = p;
      break;
    } catch {
      /* try next candidate */
    }
  }
  return cachedFfmpegPath;
}

export interface RemuxHandle {
  /** fragmented-MP4 output stream — pipe into the HTTP response */
  output: Readable;
  /** stop ffmpeg and the upstream read (client abort / response close) */
  kill(): void;
  /** last stderr lines for diagnostics when the transcode dies */
  stderrTail(): string;
}

export function remuxToMp4(input: Readable): RemuxHandle {
  const ffmpegPath = resolveFfmpegPath();
  if (!ffmpegPath) throw new Error("ffmpeg binary not available");
  const child: ChildProcessWithoutNullStreams = spawn(
    ffmpegPath,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      "pipe:0",
      "-map",
      "0:v:0",
      "-map",
      "0:a:0?",
      "-sn",
      "-dn",
      "-c:v",
      "copy",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-ac",
      "2",
      // fragmented MP4 that starts playing while the torrent is still
      // downloading; default_base_moof is what WebKit requires
      "-movflags",
      "empty_moov+default_base_moof+frag_keyframe",
      "-f",
      "mp4",
      "pipe:1",
    ],
    { stdio: ["pipe", "pipe", "pipe"] }
  );

  const stderr: Buffer[] = [];
  child.stderr.on("data", (c: Buffer) => {
    stderr.push(c);
    if (stderr.length > 8) stderr.shift();
  });

  input.pipe(child.stdin);
  // an upstream error (peer stall, eviction) must not hang ffmpeg forever
  input.on("error", () => {
    try {
      child.stdin.destroy();
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  });

  return {
    output: child.stdout,
    kill() {
      try {
        input.destroy();
      } catch {
        /* already closed */
      }
      try {
        child.kill("SIGKILL");
      } catch {
        /* already exited */
      }
    },
    stderrTail() {
      return Buffer.concat(stderr).toString("utf8").slice(-800);
    },
  };
}

// End-to-end test of src/lib/remux.ts: feed an MKV with AC3 5.1 audio (the
// exact "video plays, no sound" case) through remuxToMp4 and verify the
// output is a decodable MP4 with AAC stereo audio.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";

const FFMPEG = "/home/z/my-project/node_modules/ffmpeg-static/ffmpeg";
const IN = "/tmp/remux-test-in.mkv";
const OUT = "/tmp/remux-test-out.mp4";

// 1. build a 6s 1080p MKV with AC3 5.1 audio — ffmpeg-static has no encoders
// for ac3? it does: ffmpeg static includes native ac3 encoder.
execFileSync(FFMPEG, [
  "-y", "-hide_banner", "-loglevel", "error",
  "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=24:duration=6",
  "-f", "lavfi", "-i", "sine=frequency=440:duration=6",
  "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
  "-c:a", "ac3", "-ac", "6", "-b:a", "448k",
  IN,
]);
console.log("input:", spawnSync(FFMPEG, ["-hide_banner", "-i", IN], { stdio: ["ignore", "ignore", "pipe"] }).stderr.toString().split("\n").filter(l => /Stream|Input/.test(l)).join(" | "));

// 2. run the REAL production code path (src/lib/remux.ts) via tsx-less
//    import — compile-free: use the built lib? remux.ts is TS. Load with
//    node --experimental-strip-types (Node 22+) or transpile inline.
const { remuxToMp4, resolveFfmpegPath } = await import("/home/z/my-project/src/lib/remux.ts");

console.log("resolveFfmpegPath():", resolveFfmpegPath());
const handle = remuxToMp4(Readable.from(createReadStream(IN)));
const chunks = [];
for await (const c of handle.output) chunks.push(c);
fs.writeFileSync(OUT, Buffer.concat(chunks));
console.log("output bytes:", fs.statSync(OUT).size);

// 3. verify: decode fully + inspect streams
const probe = spawnSync(FFMPEG, ["-hide_banner", "-i", OUT, "-f", "null", "-"], {
  stdio: ["ignore", "ignore", "pipe"],
}).stderr.toString();
const video = probe.match(/Video: ([^\s,]+)/)?.[1];
const audio = probe.match(/Audio: ([^\s,]+)/)?.[1];
const channels = probe.match(/(\d+) channels/)?.[1] ?? (/\bstereo\b/.test(probe) ? "2" : undefined);
console.log(`output streams → video=${video} audio=${audio} channels=${channels}`);
const ok = video === "h264" && audio === "aac" && channels === "2" && fs.statSync(OUT).size > 100000;
console.log(ok ? "REMUX TEST: PASS" : "REMUX TEST: FAIL");
process.exit(ok ? 0 : 1);

/* Verify the legal source layer:
 *  1. every catalog title's archive.org item is reachable and its primary
 *     file exists (direct-stream server)
 *  2. every item's <id>_archive.torrent parses (infohash, video file index,
 *     webseed URLs) — the P2P server
 *  3. Blender official torrents parse (well-seeded legal P2P)
 */
import * as fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

// catalog.ts is TS with no imports — transpile-lite: strip types via a regex
// would be fragile, so use the TypeScript compiler shipped with Next.
const ts = await import("/home/z/my-project/node_modules/typescript/lib/typescript.js");
const src = fs.readFileSync("/home/z/my-project/src/lib/catalog.ts", "utf8");
const js = ts.transpileModule(src, { compilerOptions: { module: "CommonJS", target: "ES2020" } }).outputText;
const mod = { exports: {} };
vm.runInNewContext(js, { module: mod, exports: mod.exports, require: (m) => {
  if (m === "client-only") return {};
  throw new Error("unexpected require " + m);
} });
const { CATALOG } = mod.exports;
console.log(`catalog titles: ${CATALOG.length}`);

const BUCKET = "https://archive.org";

async function head(url) {
  try {
    const r = await fetch(url, { method: "HEAD", redirect: "follow", signal: AbortSignal.timeout(15000) });
    return r.ok;
  } catch {
    return false;
  }
}

// parse-torrent is ESM/CJS hybrid; import it from node_modules
const parseTorrent = (await import("/home/z/my-project/node_modules/parse-torrent/index.js")).default ?? null;
if (!parseTorrent) throw new Error("parse-torrent failed to load");

const VID = /\.(mp4|m4v|mkv|ogv|avi|webm)$/i;

async function checkTorrent(torrentUrl, label) {
  try {
    const r = await fetch(torrentUrl, { signal: AbortSignal.timeout(20000) });
    if (!r.ok) return { label, ok: false, err: `HTTP ${r.status}` };
    const buf = Buffer.from(await r.arrayBuffer());
    const t = await parseTorrent(buf);
    const videoIdx = t.files.findIndex((f) => VID.test(f.name) && f.length > 15 * 1024 * 1024);
    const webseeds = (t.urlList ?? []).filter(Boolean);
    return {
      label,
      ok: true,
      infoHash: t.infoHash,
      files: t.files.length,
      videoIdx,
      videoName: videoIdx >= 0 ? t.files[videoIdx].name : null,
      sizeGB: (t.length / 1e9).toFixed(2),
      webseeds: webseeds.length,
    };
  } catch (e) {
    return { label, ok: false, err: String(e).slice(0, 120) };
  }
}

console.log("\n=== archive.org items ===");
const results = [];
for (const t of CATALOG) {
  const fileOk = await head(`${BUCKET}/download/${encodeURIComponent(t.iaId)}/${encodeURIComponent(t.iaFile)}`);
  const tor = await checkTorrent(`${BUCKET}/download/${encodeURIComponent(t.iaId)}/${encodeURIComponent(t.iaId)}_archive.torrent`, t.slug);
  results.push({ slug: t.slug, fileOk, tor });
  console.log(
    `${fileOk ? "FILE-OK " : "FILE-FAIL"} ${tor.ok ? `TOR-OK  ih=${tor.infoHash} files=${tor.files} videoIdx=${tor.videoIdx} seeds(web)=${tor.webseeds} ${tor.sizeGB}GB` : `TOR-FAIL ${tor.err ?? ""}`} :: ${t.slug}`
  );
}

console.log("\n=== blender official torrents (webtorrent.io) ===");
for (const name of ["big-buck-bunny", "sintel", "tears-of-steel", "elephants-dream", "cosmos-laundromat"]) {
  const r = await checkTorrent(`https://webtorrent.io/torrents/${name}.torrent`, name);
  console.log(`${r.ok ? "OK " : "FAIL"} ${name} ${r.ok ? `ih=${r.infoHash} videoIdx=${r.videoIdx} webseeds=${r.webseeds} ${r.sizeGB}GB ${r.videoName}` : r.err}`);
}

const fail = results.filter((r) => !r.fileOk || !r.tor.ok);
console.log(`\nSUMMARY: ${results.length - fail.length}/${results.length} catalog items fully OK; failures: ${fail.map((f) => f.slug).join(", ") || "none"}`);

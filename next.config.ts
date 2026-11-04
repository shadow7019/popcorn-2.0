import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // Desktop packaging (desktop/scripts/prepare-renderer.mjs) builds into
  // .next-pack so it never touches the live dev server's .next directory.
  ...(process.env.POPCORN_PACK_BUILD ? { distDir: ".next-pack" } : {}),
  // webtorrent must stay an external Node module (native bindings + dynamic
  // requires). Its transitive WebRTC backend (@thaunknown/simple-peer →
  // node-datachannel) loads a .node binary via a relative require that breaks
  // when bundled into a chunk, so the whole chain stays external too.
  serverExternalPackages: [
    "webtorrent",
    "@thaunknown/simple-peer",
    "webrtc-polyfill",
    "node-datachannel",
    // CF-clearance minter: playwright-core's dynamic internal requires break
    // when bundled into a chunk, and the standalone output must carry the
    // whole package for the runtime import in src/lib/cf-clearance.ts
    "playwright-core",
    // remux fallback: its index.js resolves the binary via __dirname, which
    // webpack rewriting would point inside the build chunks
    "ffmpeg-static",
  ],
  // output-file tracing copies only part of these packages (node-datachannel
  // loses dist/cjs — 7 of 172 files), which breaks a standalone deployment
  // that runs without the project-root node_modules beside it. Force the
  // full trees into the standalone output.
  outputFileTracingIncludes: {
    "/api/torrent/**": [
      "./node_modules/webtorrent/**",
      "./node_modules/node-datachannel/**",
      "./node_modules/@thaunknown/**",
      "./node_modules/webrtc-polyfill/**",
      "./node_modules/playwright-core/**",
      // the remux fallback's statically-linked ffmpeg binary (downloaded at
      // npm-install time into the package dir) — tracing would otherwise copy
      // only index.js and the stream route would silently lose ffmpeg
      "./node_modules/ffmpeg-static/**",
    ],
  },
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
};

export default nextConfig;

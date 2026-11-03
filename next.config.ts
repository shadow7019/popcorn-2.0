import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
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
    ],
  },
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
};

export default nextConfig;

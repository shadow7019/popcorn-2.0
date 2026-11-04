import type { CapacitorConfig } from "@capacitor/cli";

/**
 * PopcornTime mobile shell. The app loads the hosted web app via server.url, so
 * shipping an update is just redeploying the website — the store binary only
 * changes when the shell itself changes.
 *
 * CANONICAL_URL is the live Antideploy deployment (verified reachable). Earlier
 * shells pointed at pocorntime/otama.antideploy.app which are 404 — every shell
 * must use the same live domain or it opens an error page.
 */
const CANONICAL_URL = "https://popcorntime.antideploy.app";

const config: CapacitorConfig = {
  appId: "space.popcorntime.app",
  appName: "PopcornTime",
  webDir: "www",
  server: {
    url: CANONICAL_URL,
    androidScheme: "https",
    // navigation stays inside the app; anything else opens the browser
    allowNavigation: ["popcorntime.antideploy.app"],
    appendUserAgent: "PopcornTime/1.0.5",
  },
  ios: {
    contentInset: "always",
  },
  android: {
    allowMixedContent: false,
  },
};

export default config;

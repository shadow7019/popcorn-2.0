import type { CapacitorConfig } from "@capacitor/cli";

/**
 * PopcornTime mobile shell. The app loads the hosted web app via server.url, so
 * shipping an update is just redeploying the website — the store binary only
 * changes when the shell itself changes.
 *
 * CANONICAL_URL is the deployment that actually runs the fixed streaming
 * engine (Antideploy). otama2.space-z.ai still serves an older build until
 * the platform republishes it; switch server.url/allowNavigation back only
 * if that domain catches up.
 */
const CANONICAL_URL = "https://otama.antideploy.app";

const config: CapacitorConfig = {
  appId: "space.popcorntime.app",
  appName: "PopcornTime",
  webDir: "www",
  server: {
    url: CANONICAL_URL,
    androidScheme: "https",
    // navigation stays inside the app; anything else opens the browser
    allowNavigation: ["otama.antideploy.app", "otama2.space-z.ai"],
  },
  ios: {
    contentInset: "always",
  },
  android: {
    allowMixedContent: false,
  },
};

export default config;

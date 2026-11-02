# Popcorn Time apps — install guide

All shells load the hosted app at **https://otama.antideploy.app** (the
deployment with the fixed streaming engine), so site fixes reach every
installed app instantly — the binaries are thin native wrappers.

## What's in this folder

| File | What it is |
| --- | --- |
| `Popcorn Time-android-debug.apk` | Ready-to-install Android app (built here, verified) |
| `Popcorn Time-Android-source.zip` | Full Capacitor project (incl. committed `android/` platform + icons) |
| `Popcorn Time-Desktop-source.zip` | Full Tauri project (incl. macOS `.icns` / Windows `.ico` icons) |
| `build-apps.yml` | GitHub Actions workflow that builds Windows + Mac binaries |

## Android — install now

1. Copy `Popcorn Time-android-debug.apk` to the phone.
2. Open it → allow "Install unknown apps" for your file manager when asked.
3. Done — `space.otama.app` v1.0 ("Popcorn Time"), Android 6.0+ (minSdk 23, targetSdk 35),
   4.5 MB. Fullscreen, back-button handling, home-screen icon + splash.

Rebuild it yourself: `npm install && cd android && ./gradlew assembleDebug`
inside `Popcorn Time-Android-source.zip` (JDK 17+ + Android SDK required).

## Windows x64 — build on any Windows machine or via CI

Windows binaries cannot be compiled on this Linux sandbox, so either:

- **CI (no toolchain needed):** push this repo to GitHub, add
  `build-apps.yml` under `.github/workflows/`, run it manually → download
  `Popcorn Time-windows-x64` artifacts (`*.msi` + `*-setup.exe` installer); or
- **Locally:** unzip `Popcorn Time-Desktop-source.zip` on Windows, install
  [Rust](https://rustup.rs) + VS Build Tools (C++ workload), then
  `cargo install tauri-cli --version '^2' && cargo tauri build` →
  `src-tauri/target/release/bundle/{msi,nsis}/`.

Unsigned-binary note: SmartScreen → "More info" → "Run anyway".

## macOS (Apple Silicon M1/M2/M3/M4) — build via CI or on the Mac

- **CI:** same workflow → job `macos` on an M1 runner (`macos-14`) →
  `Popcorn Time-macos-apple-silicon` artifacts (`*.dmg`, aarch64).
- **Locally:** unzip `Popcorn Time-Desktop-source.zip`, then
  `cargo tauri build --target aarch64-apple-darwin` →
  `src-tauri/target/aarch64-apple-darwin/release/bundle/dmg/*.dmg`.

Unsigned-binary note: after copying to Applications, right-click → Open on
first launch, or `xattr -cr /Applications/Popcorn Time.app`.

## Desktop shell details

- 1280×760 dark window, system webview (WebView2 / WKWebView), ~5–10 MB.
- The window URL is `tauri.conf.json → app.windows[0].url` if you ever need
  to repoint it.
- Site updates need no rebuild; rebuild only for icon/name/config changes.

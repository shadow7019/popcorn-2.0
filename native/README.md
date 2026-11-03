# PopcornTime Apps — macOS · Windows · Android · iOS

Three ways to get PopcornTime as an app on every platform. All of them load the same
hosted app (`https://pocorntime.antideploy.app` — the deployment that runs the fixed
streaming engine), so playback, search, subtitles and continue-watching stay
identical everywhere.

## 0. PWA — install right now, no build step

The web app is a full PWA (offline shell + `beforeinstallprompt` chip).

| Platform | How to install | Result |
| --- | --- | --- |
| macOS | Chrome/Edge → address-bar install icon → "Install" | Dock app, own window |
| Windows | Chrome/Edge → address-bar install icon → "Install" | Start-menu app, own window |
| Android | Chrome → ⋮ menu → "Install app" / "Add to Home screen" | Home-screen app, fullscreen |
| iOS | Safari → Share → "Add to Home Screen" | Home-screen app, fullscreen |

For most users this is all they need.

## 0.5 CI — build all three binaries without any local toolchain

`.github/workflows/build-apps.yml` builds every artifact on its native runner
(manual trigger, or push a `v*` tag):

| Job | Runner | Artifacts |
| --- | --- | --- |
| Android | `ubuntu-latest` | `PopcornTime-debug.apk` (sideload-ready) |
| Windows x64 | `windows-latest` | `*.msi` + `*-setup.exe` (NSIS installer) |
| macOS Apple Silicon | `macos-14` (M1) | `*.dmg` + `*.app`, aarch64 → M1/M2/M3/M4 |

Download them from the run's **Artifacts** section. A debug APK is also built
inside this repo's sandbox — see `mobile-capacitor/README.md`.

## 1. Desktop — `desktop-tauri/` (Tauri, Rust)

Real `.dmg` (macOS), `.exe` installer (Windows), `.AppImage` (Linux) with a
tiny system-webview shell (~5 MB). Build on the target OS — see its README.

```bash
cd native/desktop-tauri && cargo tauri build
```

For **M-chip Macs** specifically:

```bash
cd native/desktop-tauri
cargo tauri build --target aarch64-apple-darwin
# → src-tauri/target/aarch64-apple-darwin/release/bundle/dmg/PopcornTime_1.0.1_aarch64.dmg
```

For **Windows x64**:

```powershell
cd native\desktop-tauri
cargo tauri build
# → src-tauri\target\release\bundle\msi\PopcornTime_1.0.1_x64_en-US.msi  (+ NSIS -setup.exe)
```

## 2. Mobile — `mobile-capacitor/` (Capacitor, Android/iOS)

Store-grade APK/AAB (Android) and IPA (iOS). The `android/` platform is
already committed, so building needs no scaffolding step — see its README.

```bash
cd native/mobile-capacitor
npm install
cd android && ./gradlew assembleDebug    # → app/build/outputs/apk/debug/app-debug.apk
npm run open:android                     # or open Android Studio
```

iOS requires a Mac with Xcode: `npx cap add ios && npm run open:ios`.

## Updating

Because every shell just wraps `https://pocorntime.antideploy.app`, site fixes ship
to all four platforms instantly — rebuild a shell only for icon/name/config
changes.

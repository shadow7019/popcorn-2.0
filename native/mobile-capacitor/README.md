# PopcornTime Mobile (Capacitor)

Native **Android** and **iOS** app shells around the hosted PopcornTime web app
(`https://pocorntime.antideploy.app`). Website updates ship to the installed apps
automatically; the store binary only changes when the shell config changes.
`capacitor.config.json` (plain JSON, not TS — the CLI's TS parser breaks with
modern TypeScript) points at the canonical deployment.

## One-time setup

```bash
cd native/mobile-capacitor
npm install
npm run assets          # regenerates icons + splash from assets/icon.png
```

## Android

The `android/` platform is committed (Capacitor 7 · Gradle 8.11 · AGP 8.7 ·
compileSdk 35), so no scaffolding step is needed.

Prereq: JDK 17+ and the Android SDK (or Android Studio, which bundles both).

```bash
npm run sync            # after any capacitor.config.ts change
cd android && ./gradlew assembleDebug   # → app/build/outputs/apk/debug/app-debug.apk
npm run open:android    # or build in Android Studio: Build → Build APK(s)
```

The debug APK installs on any Android 6+ device (Settings → allow
"Install unknown apps"). Play Store release needs a signing config →
`bundle/release/app-release.aab`. CI builds the same APK on every `v*` tag —
see `.github/workflows/build-apps.yml`.

## iOS

Prereq: a Mac with Xcode 15+.

```bash
npx cap add ios         # first time only (creates ios/)
npm run sync
npm run open:ios        # opens Xcode
```

Then in Xcode: set Team + bundle identifier (`space.popcorntime.app`) under the app
target, and **Product → Archive** for App Store / TestFlight.

## Where to change things

- Host URL: `capacitor.config.ts` → `server.url` + `server.allowNavigation`
- App name / id: `capacitor.config.ts` → `appName` / `appId`
- Icons & splash: `assets/icon.png` → rerun `npm run assets`

`android/` is committed (CI builds from it); `ios/` is generated on a Mac
and gitignored. Hand-edit `android/` only through Android Studio project
settings.

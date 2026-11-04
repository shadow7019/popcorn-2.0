#!/usr/bin/env python3
"""App rename: the app is called PopcornTime (one word).

- Display names (Tauri productName/window title, Capacitor appName) become
  PopcornTime.
- Package identifiers space.otama.app -> space.popcorntime.app (pre-release,
  no devices hold the old ID, so now is the only free moment).
- Tauri version bumps to 1.0.1 so the CI tag v1.0.1 produces fresh
  PopcornTime-named bundles.
- Deployment domains (otama.antideploy.app, otama2.space-z.ai) are URLs, not
  the app name — deliberately untouched.
"""
import sys

FILES = {
    "native/mobile-capacitor/capacitor.config.ts": [
        ("Popcorn Time mobile shell", "PopcornTime mobile shell"),
        ('appId: "space.otama.app"', 'appId: "space.popcorntime.app"'),
        ('appName: "Popcorn Time"', 'appName: "PopcornTime"'),
    ],
    "native/desktop-tauri/src-tauri/tauri.conf.json": [
        ('"productName": "Popcorn Time"', '"productName": "PopcornTime"'),
        ('"version": "1.0.0"', '"version": "1.0.1"'),
        ('"identifier": "space.otama.app"', '"identifier": "space.popcorntime.app"'),
        ('"title": "Popcorn Time"', '"title": "PopcornTime"'),
        ('"shortDescription": "Popcorn Time —', '"shortDescription": "PopcornTime —'),
        ('"longDescription": "Popcorn Time —', '"longDescription": "PopcornTime —'),
    ],
    "native/desktop-tauri/src-tauri/Cargo.toml": [
        ('description = "Otama — Stream Movies & TV Shows"',
         'description = "PopcornTime — Stream Movies & TV Shows"'),
        ('authors = ["Otama"]', 'authors = ["PopcornTime"]'),
    ],
    "native/desktop-tauri/src-tauri/src/main.rs": [
        ("Otama desktop shell", "PopcornTime desktop shell"),
        ("hosted Otama app", "hosted web app"),
        ("error while running Otama", "error while running PopcornTime"),
    ],
    "native/mobile-capacitor/README.md": [
        ("Popcorn Time Mobile", "PopcornTime Mobile"),
        ("hosted Popcorn Time web app", "hosted PopcornTime web app"),
        ("space.otama.app", "space.popcorntime.app"),
    ],
    "native/mobile-capacitor/www/index.html": [
        ("Popcorn Time", "PopcornTime"),
    ],
    "native/mobile-capacitor/package.json": [
        ("Popcorn Time Android/iOS shell", "PopcornTime Android/iOS shell"),
    ],
    "native/desktop-tauri/README.md": [
        ("Popcorn Time Desktop", "PopcornTime Desktop"),
        ("hosted Popcorn Time web app", "hosted PopcornTime web app"),
        ("/Applications/Popcorn Time.app", "/Applications/PopcornTime.app"),
        ("Popcorn Time_1.0.0_*.dmg", "PopcornTime_1.0.1_*.dmg"),
        ("Popcorn Time_1.0.0_*.exe", "PopcornTime_1.0.1_*.exe"),
    ],
    "native/README.md": [
        ("Popcorn Time Apps", "PopcornTime Apps"),
        ("get Popcorn Time as an app", "get PopcornTime as an app"),
        ("Popcorn Time-debug.apk", "PopcornTime-debug.apk"),
        ("Popcorn Time_1.0.0_x64_en-US.msi", "PopcornTime_1.0.1_x64_en-US.msi"),
        ("Popcorn Time_1.0.0_aarch64.dmg", "PopcornTime_1.0.1_aarch64.dmg"),
    ],
    ".github/workflows/build-apps.yml": [
        ("Popcorn Time native shells", "PopcornTime native shells"),
        ("Android APK (Popcorn Time)", "Android APK (PopcornTime)"),
    ],
}

failed = False
for path, pairs in FILES.items():
    with open(path, encoding="utf-8") as f:
        text = f.read()
    for old, new in pairs:
        if old not in text:
            if new in text:
                continue  # already applied on a previous run
            print(f"MISSING in {path}: {old!r}")
            failed = True
            continue
        text = text.replace(old, new)
        print(f"{path}: {old!r} -> {new!r}")
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)

# no stray old tokens left anywhere in the native/ trees or workflow
import subprocess
leftover = subprocess.run(
    ["grep", "-rnE", r"Popcorn Time|Otama|space\.otama\.app", "native/",
     ".github/workflows/build-apps.yml"],
    capture_output=True, text=True,
)
if leftover.stdout.strip():
    print("LEFTOVER TOKENS:\n" + leftover.stdout)
    failed = True

sys.exit(1 if failed else 0)

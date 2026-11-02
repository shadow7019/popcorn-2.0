#!/usr/bin/env python3
"""Rename display branding Otama → Popcorn Time across web + shells + docs.

Internal identifiers stay: ARCHIVE_ID "otama-direct", localStorage key
"otama-media-store", Android package space.otama.app, cache dir
/tmp/otama-torrents — renaming those would orphan user data / deployed state.
The SW cache version DOES bump (otama-v1 → popcorn-v1) so installed PWAs
pick up the new icons immediately.
"""
import re
import sys

ROOT = "/home/z/my-project"
edits = []

def sub(path, pairs, must=True):
    p = f"{ROOT}/{path}"
    s = open(p, encoding="utf-8").read()
    orig = s
    for old, new in pairs:
        if old not in s:
            # idempotent: already replaced in an earlier run is fine
            if new not in s:
                print(f"WARN not found in {path}: {old[:60]!r}")
            continue
        s = s.replace(old, new)
    if s != orig:
        open(p, "w", encoding="utf-8").write(s)
        edits.append(path)

# ---- web metadata ----
sub("src/app/layout.tsx", [
    ('title: "Otama — Stream Movies & TV Shows"', 'title: "Popcorn Time — Stream Movies & TV Shows"'),
    ('applicationName: "Otama"', 'applicationName: "Popcorn Time"'),
    ('title: "Otama",', 'title: "Popcorn Time",'),
])
sub("public/manifest.webmanifest", [
    ('"name": "Otama — Stream Movies & TV Shows"', '"name": "Popcorn Time — Stream Movies & TV Shows"'),
    ('"short_name": "Otama"', '"short_name": "Popcorn Time"'),
])
sub("public/offline.html", [
    ("<title>Otama — Offline</title>", "<title>Popcorn Time — Offline</title>"),
])
sub("public/sw.js", [
    (" * Otama service worker", " * Popcorn Time service worker"),
    ('const VERSION = "otama-v1";', 'const VERSION = "popcorn-v1";'),
])
sub("src/components/pwa-register.tsx", [
    ('aria-label="Install Otama as an app"', 'aria-label="Install Popcorn Time as an app"'),
])
sub("src/app/page.tsx", [
    ("Otama does not host any media files.", "Popcorn Time does not host any media files."),
    ("Otama is a free, browser-based discovery and playback app", "Popcorn Time is a free, browser-based discovery and playback app"),
    ("Otama Direct</span> serves public-domain", "Popcorn Direct</span> serves public-domain"),
])
sub("src/components/streaming/SourcesDialog.tsx", [
    ("every torrent source Otama searches", "every torrent source Popcorn Time searches"),
])
sub("src/app/globals.css", [
    ("/* ---------- Otama custom styles ---------- */", "/* ---------- Popcorn Time custom styles ---------- */"),
])

# ---- server user agents + comments (display-safe renames; ids untouched) ----
sub("src/lib/torrent-sources.ts", [
    ('"user-agent": "Mozilla/5.0 (X11; Linux x86_64) Otama/1.0"', '"user-agent": "Mozilla/5.0 (X11; Linux x86_64) PopcornTime/1.0"'),
])
sub("src/app/api/archive/route.ts", [
    (" * Otama Direct — direct-stream finder", " * Popcorn Direct — direct-stream finder"),
    ('"user-agent": "Otama/1.0 (public-domain lookup)"', '"user-agent": "PopcornTime/1.0 (public-domain lookup)"'),
])
sub("src/components/streaming/PlayerModal.tsx", [
    ("// Otama Direct: movies → public-domain copy", "// Popcorn Direct: movies → public-domain copy"),
    ("/* ---------------- Otama Direct for episodes", "/* ---------------- Popcorn Direct for episodes"),
    ("/* ---------- Otama Direct: public-domain native stream ---------- */", "/* ---------- Popcorn Direct: public-domain native stream ---------- */"),
])
sub("src/lib/tmdb.ts", [
    (" *  - Otama Direct: public-domain direct streams", " *  - Popcorn Direct: public-domain direct streams"),
])
sub("src/app/api/subtitles/file/route.ts", [
    ('(X11; Linux x86_64) Otama/1.0', '(X11; Linux x86_64) PopcornTime/1.0'),
])
sub("src/lib/subtitles-server.ts", [
    ('(X11; Linux x86_64) Otama/1.0', '(X11; Linux x86_64) PopcornTime/1.0'),
])
sub("src/lib/net-pacer.ts", [
    ('(X11; Linux x86_64) Otama/1.0', '(X11; Linux x86_64) PopcornTime/1.0'),
])

# ---- header: mascot logo + new wordmark (idempotent) ----
header = f"{ROOT}/src/components/streaming/Header.tsx"
s = open(header, encoding="utf-8").read()
old_logo = '''          aria-label="Otama home"
        >
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-red-600 to-red-800 shadow-lg shadow-red-600/30">
            <Clapperboard className="h-4.5 w-4.5 text-white" />
          </span>
          <span className="text-xl font-black tracking-tight text-white">
            <span className="text-red-500">O</span>tama
          </span>'''
new_logo = '''          aria-label="Popcorn Time home"
        >
          <img
            src="/icon-192.png"
            alt=""
            className="h-8 w-8 rounded-lg shadow-lg shadow-red-600/20"
          />
          <span className="text-xl font-black tracking-tight text-white">
            Popcorn<span className="text-red-500">Time</span>
          </span>'''
if old_logo in s:
    s = s.replace(old_logo, new_logo)
    if s.count("Clapperboard") <= 1:  # only the import left → drop it
        s = re.sub(r"import \{[^}]*\bClapperboard\b[^}]*\} from \"lucide-react\";\n", "", s)
        if "Clapperboard" in s:
            print("header still references Clapperboard — inspect"); sys.exit(1)
    open(header, "w", encoding="utf-8").write(s)
    edits.append("src/components/streaming/Header.tsx")
elif new_logo in s:
    pass  # already rebranded
else:
    print("WARN: header in unexpected state — inspect manually")

# ---- app shells ----
sub("native/mobile-capacitor/capacitor.config.ts", [
    (" * Otama mobile shell.", " * Popcorn Time mobile shell."),
    ('appName: "Otama",', 'appName: "Popcorn Time",'),
])
sub("native/desktop-tauri/src-tauri/tauri.conf.json", [
    ('"productName": "Otama"', '"productName": "Popcorn Time"'),
    ('"title": "Otama"', '"title": "Popcorn Time"'),
    ('"shortDescription": "Stream movies & TV shows"', '"shortDescription": "Popcorn Time — stream movies & TV shows"'),
    ('"longDescription": "Otama — browse trending movies and TV shows and stream instantly."',
     '"longDescription": "Popcorn Time — browse trending movies and TV shows and stream instantly."'),
])
sub("native/mobile-capacitor/www/index.html", [
    ("<title>Otama</title>", "<title>Popcorn Time</title>"),
])
sub("native/mobile-capacitor/package.json", [
    ('"description": "Otama Android/iOS shell', '"description": "Popcorn Time Android/iOS shell'),
])
sub("native/mobile-capacitor/android/app/src/main/res/values/strings.xml", [
    ('<string name="app_name">Otama</string>', '<string name="app_name">Popcorn Time</string>'),
    ('<string name="title_activity_main">Otama</string>', '<string name="title_activity_main">Popcorn Time</string>'),
])

# ---- docs (display mentions only; URLs stay) ----
for doc in ["native/README.md", "native/mobile-capacitor/README.md",
            "native/desktop-tauri/README.md", "download/otama-apps/README.md",
            "README.md"]:
    try:
        sub(doc.replace("README.md", "README.md") if False else doc,
            [("Otama", "Popcorn Time")], must=False)
    except FileNotFoundError:
        print(f"(no {doc})")

print("edited:", len(edits))
for e in edits:
    print(" ", e)

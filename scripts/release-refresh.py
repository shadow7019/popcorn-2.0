#!/usr/bin/env python3
"""Post-CI release refresh v2 for v1.0.0 — after the full Electron DMGs landed:
1. verify both full DMGs exist
2. download them into download/release-v1.0.0-macos-ios/
3. regenerate + upload SHA256SUMS.txt
4. rewrite the release body (full self-contained DMGs = primary macOS download)
"""
import json, os, urllib.request

REPO = "shadow7019/popcorn-2.0"
TOKEN = os.environ["GH_TOKEN"]
H = {"Authorization": f"Bearer {TOKEN}", "Accept": "application/vnd.github+json"}
OUT = "/home/z/my-project/download/release-v1.0.0-macos-ios"
FULL = ["PopcornTime-1.0.5-arm64.dmg", "PopcornTime-1.0.5-x64.dmg"]

def api(path, data=None, method=None):
    req = urllib.request.Request(f"https://api.github.com{path}", headers=H,
                                 data=json.dumps(data).encode() if data is not None else None,
                                 method=method)
    with urllib.request.urlopen(req) as r:
        body = r.read()
        return json.loads(body) if body else {}

rel = api(f"/repos/{REPO}/releases/tags/v1.0.0")
assets = {a["name"]: a for a in rel["assets"]}
missing = [n for n in FULL if n not in assets]
if missing:
    raise SystemExit(f"FATAL: full DMGs missing: {missing}")

# 2. download full DMGs locally
os.makedirs(OUT, exist_ok=True)
for n in FULL:
    url = f"https://github.com/{REPO}/releases/download/v1.0.0/{n}"
    dest = f"{OUT}/{n}"
    urllib.request.urlretrieve(url, dest)
    print(f"downloaded {n}: {os.path.getsize(dest)} bytes")

# 3. regenerate SHA256SUMS.txt from live assets
rel = api(f"/repos/{REPO}/releases/tags/v1.0.0")
assets = {a["name"]: a for a in rel["assets"]}
lines = [f"{a['digest'].replace('sha256:', '')}  {name}"
         for name, a in sorted(assets.items()) if name != "SHA256SUMS.txt"]
sums = "\n".join(lines) + "\n"
with open(f"{OUT}/SHA256SUMS.txt", "w") as f:
    f.write(sums)
for a in rel["assets"]:
    if a["name"] == "SHA256SUMS.txt":
        api(f"/repos/{REPO}/releases/assets/{a['id']}", method="DELETE")
req = urllib.request.Request(
    f"https://uploads.github.com/repos/{REPO}/releases/{rel['id']}/assets?name=SHA256SUMS.txt",
    data=sums.encode(), method="POST",
    headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "text/plain"})
print("SHA256SUMS.txt uploaded:", urllib.request.urlopen(req).status == 201)

# 4. rewrite release body
def mb(n): return f"{assets[n]['size']/1e6:.1f} MB"
body = f"""# PopcornTime v1.0.0 — Android · Windows · macOS (full + light) · iOS

Native apps around **https://popcorntime.antideploy.app**. Two macOS variants: a **full self-contained desktop app** (the old OTAMA-style build — everything bundled, ~210 MB) and a **tiny light shell** (~6 MB, needs internet).

## Downloads

| File | For | Size |
| --- | --- | --- |
| `PopcornTime-1.0.5-arm64.dmg` | **macOS — Apple Silicon M1–M5 (FULL self-contained app)** | {mb('PopcornTime-1.0.5-arm64.dmg')} |
| `PopcornTime-1.0.5-x64.dmg` | **macOS — Intel (FULL self-contained app)** | {mb('PopcornTime-1.0.5-x64.dmg')} |
| `PopcornTime-1.0.4-macos-universal.dmg` | macOS — light shell (Intel + Apple Silicon, needs internet) | {mb('PopcornTime-1.0.4-macos-universal.dmg')} |
| `PopcornTime-1.0.4-macos-universal.zip` | same light shell as a ZIP | {mb('PopcornTime-1.0.4-macos-universal.zip')} |
| `PopcornTime-1.0.5-ios-unsigned.ipa` | **iPhone/iPad (sideload)** | {mb('PopcornTime-1.0.5-ios-unsigned.ipa')} |
| `PopcornTime-1.0.0.apk` | Android 6+ | {mb('PopcornTime-1.0.0.apk')} |
| `PopcornTime-Setup-1.0.0.exe` / `PopcornTime-Portable-1.0.0.exe` | Windows 10/11 x64 | {mb('PopcornTime-Setup-1.0.0.exe')} |
| `PopcornTime-iOS-1.0.0-Xcode-project.zip` | iOS devs building with their own signing | {mb('PopcornTime-iOS-1.0.0-Xcode-project.zip')} |

Verify downloads with `SHA256SUMS.txt`.

## macOS — FULL app (recommended, this is the OTAMA-style build)

Everything is inside the app: its own Chromium browser, the complete site, the torrent engine, and its local database. No external services needed. Pick the DMG for your Mac — not sure which? Click  → About This Mac → "Chip": **Apple M1/M2/M3/M4/M5** → `arm64`; **Intel** → `x64`. Or run `uname -m` in Terminal (`arm64` / `x86_64`).

1. Open the DMG, drag **PopcornTime** into **Applications**.
2. First launch shows a one-time **""PopcornTime" Not Opened — Apple could not verify…"** dialog (the app is ad-hoc signed, not App-Store notarized — no paid Apple developer account). Bypass it ONCE:

**Way 1 — Open Anyway (GUI):**
1. When the dialog appears, click **Done**.
2. **System Settings → Privacy & Security** → scroll to **Security** → click **Open Anyway** → authenticate → **Open**.
3. The button only appears *after* a blocked launch attempt — if it is missing, launch the app once more and look again.

**Way 2 — Terminal one-liner (fastest):**
```bash
xattr -cr /Applications/PopcornTime.app
```
then open the app normally. ("Operation not permitted"? prefix with `sudo `.)

**Way 3 — never see the dialog at all** (files downloaded with `curl` are not quarantined):
```bash
cd ~/Downloads
curl -L -o PopcornTime.dmg https://github.com/shadow7019/popcorn-2.0/releases/download/v1.0.0/PopcornTime-1.0.5-arm64.dmg
hdiutil attach PopcornTime.dmg
cp -R /Volumes/PopcornTime/PopcornTime.app /Applications/
hdiutil detach /Volumes/PopcornTime
open /Applications/PopcornTime.app
```

The full app runs a local server on 127.0.0.1 — first launch shows a "starting local server…" splash for a few seconds. Your library works offline; posters/metadata and new torrents need internet.

## macOS — LIGHT shell (~6 MB alternative)

`PopcornTime-1.0.4-macos-universal.dmg` is a thin native shell (uses the WebKit engine already built into macOS) that loads the hosted site — same bypass steps as above. Choose it if you want a tiny download and always-current site content.

## iOS (no App Store / no developer account needed)

The `.ipa` is **unsigned** — sign it with your own free Apple ID, then install:

- **Sideloadly** (Windows/macOS): plug in the iPhone, drop the ipa, enter your Apple ID → signs & installs (free cert: re-sign every 7 days).
- **AltStore / SideStore**: same idea, can auto-refresh in background.
- **TrollStore** (iOS 14.0–16.6.1 where available): installs the unsigned ipa permanently, no re-signing.
- **Paid Apple Developer account?** Use the Xcode-project zip to build/install with your certificate — permanent install.

Requires iOS 14+.

## Android

Install the `.apk` directly (allow "install unknown apps").

## Windows

`PopcornTime-Setup-1.0.0.exe` = installer; `PopcornTime-Portable-1.0.0.exe` = run without installing.
"""
api(f"/repos/{REPO}/releases/{rel['id']}", {"body": body}, method="PATCH")
print("release body updated")
print("\n=== final assets ===")
for a in api(f"/repos/{REPO}/releases/tags/v1.0.0")["assets"]:
    print(f'  {a["name"]}  {a["size"]/1e6:8.1f} MB  {a.get("digest","")[:20]}')

#!/usr/bin/env python3
"""Post-CI release refresh for v1.0.0 (run after build-apps succeeds):
1. verify the new universal DMG+ZIP assets exist
2. delete the old arm64-only DMG
3. download new assets into download/release-v1.0.0-macos-ios/
4. regenerate + upload SHA256SUMS.txt
5. rewrite the release body (downloads table + macOS section)
"""
import json, os, urllib.request

REPO = "shadow7019/popcorn-2.0"
TOKEN = os.environ["GH_TOKEN"]
H = {"Authorization": f"Bearer {TOKEN}", "Accept": "application/vnd.github+json"}
OUT = "/home/z/my-project/download/release-v1.0.0-macos-ios"

def api(path, data=None, method=None):
    req = urllib.request.Request(f"https://api.github.com{path}", headers=H,
                                 data=json.dumps(data).encode() if data is not None else None,
                                 method=method)
    with urllib.request.urlopen(req) as r:
        body = r.read()
        return json.loads(body) if body else {}

rel = api(f"/repos/{REPO}/releases/tags/v1.0.0")
assets = {a["name"]: a for a in rel["assets"]}
NEW = ["PopcornTime-1.0.4-macos-universal.dmg", "PopcornTime-1.0.4-macos-universal.zip"]
OLD = "PopcornTime-1.0.3-macos-apple-silicon.dmg"

missing = [n for n in NEW if n not in assets]
if missing:
    raise SystemExit(f"FATAL: new assets missing: {missing}")

# 2. delete old arm64-only DMG
if OLD in assets:
    api(f"/repos/{REPO}/releases/assets/{assets[OLD]['id']}", method="DELETE")
    print(f"deleted old asset: {OLD}")

# 3. download new assets locally
os.makedirs(OUT, exist_ok=True)
for n in NEW:
    url = f"https://github.com/{REPO}/releases/download/v1.0.0/{n}"
    urllib.request.urlretrieve(url, f"{OUT}/{n}")
    print(f"downloaded {n}: {os.path.getsize(f'{OUT}/{n}')} bytes")

# 4. regenerate SHA256SUMS.txt from the live release assets
rel = api(f"/repos/{REPO}/releases/tags/v1.0.0")  # refresh after delete
assets = {a["name"]: a for a in rel["assets"]}
lines = []
for name, a in sorted(assets.items()):
    if name == "SHA256SUMS.txt":
        continue
    lines.append(f"{a['digest'].replace('sha256:', '')}  {name}")
sums = "\n".join(lines) + "\n"
with open(f"{OUT}/SHA256SUMS.txt", "w") as f:
    f.write(sums)
sha_asset = api(f"/repos/{REPO}/releases/tags/v1.0.0")["assets"]
# upload checksums (delete existing then re-upload, since clobber needs same-name asset)
rel = api(f"/repos/{REPO}/releases/tags/v1.0.0")
for a in rel["assets"]:
    if a["name"] == "SHA256SUMS.txt":
        api(f"/repos/{REPO}/releases/assets/{a['id']}", method="DELETE")
req = urllib.request.Request(
    f"https://uploads.github.com/repos/{REPO}/releases/{rel['id']}/assets?name=SHA256SUMS.txt",
    data=sums.encode(), method="POST",
    headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "text/plain"})
print("SHA256SUMS.txt uploaded:", urllib.request.urlopen(req).status == 201)

# 5. rewrite release body
def mb(n): return f"{assets[n]['size']/1e6:.1f} MB"
body = f"""# PopcornTime v1.0.0 — Android · Windows · macOS (Intel + Apple Silicon) · iOS

Native shells around the live web app (**https://popcorntime.antideploy.app**) — site fixes ship without rebuilding these binaries.

## Downloads

| File | For | Size |
| --- | --- | --- |
| `PopcornTime-1.0.4-macos-universal.dmg` | **macOS — Apple Silicon (M1–M5) AND Intel**, 10.15+ | {mb(NEW[0])} |
| `PopcornTime-1.0.4-macos-universal.zip` | same app as a ZIP — use if the DMG won't open | {mb(NEW[1])} |
| `PopcornTime-1.0.3-ios-unsigned.ipa` | **iPhone/iPad (sideload)** | {mb('PopcornTime-1.0.3-ios-unsigned.ipa')} |
| `PopcornTime-1.0.0.apk` | Android 6+ | {mb('PopcornTime-1.0.0.apk')} |
| `PopcornTime-Setup-1.0.0.exe` / `PopcornTime-Portable-1.0.0.exe` | Windows 10/11 x64 | {mb('PopcornTime-Setup-1.0.0.exe')} |
| `PopcornTime-iOS-1.0.0-Xcode-project.zip` | iOS devs building with their own signing | {mb('PopcornTime-iOS-1.0.0-Xcode-project.zip')} |

Verify downloads with `SHA256SUMS.txt`.

## macOS (one universal build — Intel and Apple Silicon)

The app is ad-hoc signed but not App-Store **notarized** (no paid Apple developer account), so macOS shows a one-time **""PopcornTime" Not Opened — Apple could not verify…"** dialog on first launch. That is expected and safe to bypass — pick ONE of these:

**Way 1 — Open Anyway (GUI):**
1. Double-click the app → when the ""Not Opened" dialog appears, click **Done**.
2. Open **System Settings → Privacy & Security**, scroll to the **Security** section.
3. Click **Open Anyway** next to "PopcornTime was blocked…" → authenticate (Touch ID / password) → click **Open**.
4. Done — it opens normally from now on.

> The **Open Anyway** button only appears *after* a blocked launch attempt. If you don't see it, try opening the app once more, then check System Settings again. If the button is greyed out, unlock the pane with the padlock/admin password first.

**Way 2 — Terminal one-liner (fastest):**
```bash
xattr -cr /Applications/PopcornTime.app
```
then open the app normally. (If you get "Operation not permitted", prefix with `sudo `.)

**Way 3 — never see the dialog at all:** files downloaded with `curl` don't get quarantined:
```bash
cd ~/Downloads
curl -L -o PopcornTime.dmg https://github.com/shadow7019/popcorn-2.0/releases/download/v1.0.0/PopcornTime-1.0.4-macos-universal.dmg
hdiutil attach PopcornTime.dmg
cp -R /Volumes/PopcornTime/PopcornTime.app /Applications/
hdiutil detach /Volumes/PopcornTime
open /Applications/PopcornTime.app
```

**ZIP fallback:** if the DMG itself fails to open or mount, download the `.zip` instead — double-click to extract, drag `PopcornTime.app` into `/Applications`, then use any Way above.

Requires macOS 10.15+ (Catalina) or newer. The app loads the hosted web app, so first launch needs internet.

## iOS (no App Store / no developer account needed)

The `.ipa` is **unsigned** — sign it with your own free Apple ID, then install:

- **Sideloadly** (Windows/macOS): plug in the iPhone, drop the ipa, enter your Apple ID → signs & installs (free cert: re-sign every 7 days).
- **AltStore / SideStore**: same idea, can auto-refresh in background.
- **TrollStore** (iOS 14.0–16.6.1 where available): installs the unsigned ipa permanently, no re-signing.
- **Have a paid Apple Developer account?** Use the Xcode-project zip (or open the ipa in Xcode → Devices) to build/install with your certificate — permanent install.

Requires iOS 14+. The app loads the hosted web app, so first launch needs internet.

## Android

Install the `.apk` directly (allow "install unknown apps"). The shell loads the hosted app.

## Windows

`PopcornTime-Setup-1.0.0.exe` = installer; `PopcornTime-Portable-1.0.0.exe` = run without installing.
"""
api(f"/repos/{REPO}/releases/{rel['id']}", {"body": body}, method="PATCH")
print("release body updated")
print("\n=== final assets ===")
for a in api(f"/repos/{REPO}/releases/tags/v1.0.0")["assets"]:
    print(f'  {a["name"]}  {a["size"]}  {a.get("digest","")[:20]}')

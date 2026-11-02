#!/usr/bin/env python3
"""Generate all app icons for the Otama shells.

Input : native/mobile-capacitor/assets/icon.png (512x512 RGBA source)
Output: native/desktop-tauri/src-tauri/icons/{32x32,128x128,128x128@2x}.png,
        icon.icns, icon.ico  (Tauri bundle icons for macOS/Windows/Linux)
        native/mobile-capacitor/assets/splash.png (2732x2732, dark, centred
        logo — consumed by @capacitor/assets for Android/iOS splash screens)
"""
from PIL import Image

ROOT = "/home/z/my-project"
SRC = f"{ROOT}/native/mobile-capacitor/assets/icon.png"
TAURI_ICONS = f"{ROOT}/native/desktop-tauri/src-tauri/icons"
BG = (11, 11, 16, 255)  # #0b0b10 — the app background

src = Image.open(SRC).convert("RGBA")

# ---- Tauri PNGs ----
for name, size in [("32x32.png", 32), ("128x128.png", 128), ("128x128@2x.png", 256)]:
    src.resize((size, size), Image.LANCZOS).save(f"{TAURI_ICONS}/{name}")

# ---- Windows .ico (multi-resolution) ----
src.save(
    f"{TAURI_ICONS}/icon.ico",
    sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
)

# ---- macOS .icns (Apple Silicon + Intel) ----
icns_sizes = [16, 32, 64, 128, 256, 512]
imgs = [src.resize((s, s), Image.LANCZOS) for s in icns_sizes]
imgs[0].save(f"{TAURI_ICONS}/icon.icns", format="ICNS", append_images=imgs[1:])

# ---- Capacitor splash source (2732x2732 dark canvas, centred logo) ----
SPLASH = 2732
splash = Image.new("RGBA", (SPLASH, SPLASH), BG)
logo = src.resize((512, 512), Image.LANCZOS)
splash.alpha_composite(logo, ((SPLASH - 512) // 2, (SPLASH - 512) // 2))
splash.save(f"{ROOT}/native/mobile-capacitor/assets/splash.png")

# also refresh the shell's own www icon (shown while the remote app loads)
src.save(f"{ROOT}/native/mobile-capacitor/www/icon.png")

print("icons written:")
import os
for f in sorted(os.listdir(TAURI_ICONS)):
    print(f"  src-tauri/icons/{f}  ({os.path.getsize(f'{TAURI_ICONS}/{f}')} bytes)")
print(f"  mobile-capacitor/assets/splash.png ({os.path.getsize(f'{ROOT}/native/mobile-capacitor/assets/splash.png')} bytes)")

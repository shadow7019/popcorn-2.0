#!/usr/bin/env python3
"""Rebrand every Otama logo/icon asset to the Popcorn Time mascot.

Input : upload/PopcornTime Mascot App Logo.png (1254x1254, wordmark at bottom)
Output:
  public/   icon-192/512, icon-maskable-192/512, apple-touch-icon,
            favicon-32.png, favicon.svg, logo.svg  (mascot crop, no wordmark,
            except logo.svg which keeps the full wordmark logo)
  mobile    assets/icon.png (1024 mascot crop for @capacitor/assets),
            assets/splash.png (2732, full wordmark logo), www/icon.png
  desktop   src-tauri/icons/ 32x32, 128, 128@2x, icon.icns, icon.ico
"""
from PIL import Image, ImageDraw
import base64
import os

ROOT = "/home/z/my-project"
SRC = f"{ROOT}/upload/PopcornTime Mascot App Logo.png"
PUB = f"{ROOT}/public"
TAURI = f"{ROOT}/native/desktop-tauri/src-tauri/icons"
MOB = f"{ROOT}/native/mobile-capacitor"

im = Image.open(SRC).convert("RGBA")
BG = im.getpixel((6, 6))  # the logo's own near-black background

# Mascot-only square crop (excludes the "PopcornTime" wordmark band at the
# bottom; keeps play triangle and all floating kernels). The exact wordmark
# top edge is found by scanning for the all-background gap rows between the
# popcorn box and the lettering.
CROP = (210, 95, 1046, 931)
mascot = im.crop(CROP)

def _is_bg(px) -> bool:
    r, g, b = px[0], px[1], px[2]
    return abs(r - BG[0]) < 14 and abs(g - BG[1]) < 14 and abs(b - BG[2]) < 14

w, h = mascot.size
px = mascot.load()
# non-background fraction per row, bottom 40% of the crop
row_frac = []
for y in range(int(h * 0.6), h):
    n = sum(0 if _is_bg(px[x, y]) else 1 for x in range(0, w, 4))
    row_frac.append((y, n / (w / 4)))
# wordmark band = contiguous rows with >2% coverage at the very bottom;
# walk up over the band, then skip the gap rows above it
y_word_top = h - 1
while y_word_top > 0 and row_frac[y_word_top - int(h * 0.6)][1] > 0.02:
    y_word_top -= 1
while y_word_top > 0 and row_frac[y_word_top - int(h * 0.6)][1] <= 0.02:
    y_word_top -= 1
cut = y_word_top + 1  # first wordmark row — paint everything below with BG
d = ImageDraw.Draw(mascot)
d.rectangle((0, cut, w, h), fill=BG)
print(f"wordmark starts at crop row {cut}/{h} — erased below it")

def on_bg(size: int, scale: float, source: Image.Image = mascot) -> Image.Image:
    canvas = Image.new("RGBA", (size, size), BG)
    inner = int(size * scale)
    art = source.resize((inner, inner), Image.LANCZOS)
    canvas.alpha_composite(art, ((size - inner) // 2, (size - inner) // 2))
    return canvas

def rounded(img: Image.Image, radius_px: int) -> Image.Image:
    """Round the canvas corners (for in-app display of the full logo)."""
    s = img.size[0]
    mask = Image.new("L", (s, s), 0)
    from PIL import ImageDraw
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, s, s), radius=radius_px, fill=255)
    out = Image.new("RGBA", img.size, (0, 0, 0, 0))
    out.paste(img, (0, 0), mask)
    return out

full = im.copy()

# ---- web icons (public/) ----
on_bg(512, 0.92).save(f"{PUB}/icon-512.png")
on_bg(192, 0.92).save(f"{PUB}/icon-192.png")
on_bg(512, 0.66).save(f"{PUB}/icon-maskable-512.png")
on_bg(192, 0.66).save(f"{PUB}/icon-maskable-192.png")
on_bg(180, 0.92).save(f"{PUB}/apple-touch-icon.png")
on_bg(32, 0.96).save(f"{PUB}/favicon-32.png")

# favicon.svg / logo.svg: SVG wrappers with an embedded raster (the site is
# dark-themed, so the logo's own near-black square reads as a rounded tile)
def _png(img: Image.Image) -> bytes:
    import io
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue()

b64_32 = base64.b64encode(_png(on_bg(64, 0.96))).decode()
with open(f"{PUB}/favicon.svg", "w") as f:
    f.write('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32">'
            f'<image width="32" height="32" href="data:image/png;base64,{b64_32}"/></svg>')

b64_logo = base64.b64encode(_png(rounded(full.resize((512, 512), Image.LANCZOS), 96))).decode()
with open(f"{PUB}/logo.svg", "w") as f:
    f.write('<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512">'
            f'<image width="512" height="512" href="data:image/png;base64,{b64_logo}"/></svg>')

# ---- mobile (Capacitor) ----
mascot.resize((1024, 1024), Image.LANCZOS).save(f"{MOB}/assets/icon.png")
SPLASH = 2732
splash = Image.new("RGBA", (SPLASH, SPLASH), BG)
logo_big = full.resize((1200, 1200), Image.LANCZOS)  # full logo incl. wordmark
splash.alpha_composite(logo_big, ((SPLASH - 1200) // 2, (SPLASH - 1200) // 2))
splash.save(f"{MOB}/assets/splash.png")
on_bg(192, 0.92).save(f"{MOB}/www/icon.png")

# ---- desktop (Tauri) ----
os.makedirs(TAURI, exist_ok=True)
for name, size in [("32x32.png", 32), ("128x128.png", 128), ("128x128@2x.png", 256)]:
    on_bg(size, 0.92).save(f"{TAURI}/{name}")
mascot.save(
    f"{TAURI}/icon.ico",
    sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
)
icns_sizes = [16, 32, 64, 128, 256, 512]
imgs = [on_bg(s, 0.92) for s in icns_sizes]
imgs[0].save(f"{TAURI}/icon.icns", format="ICNS", append_images=imgs[1:])

print("rebrand logos written: public/ + mobile assets + tauri icons")
for p in ["icon-512.png", "favicon-32.png", "favicon.svg", "logo.svg"]:
    print(f"  public/{p}: {os.path.getsize(f'{PUB}/{p}')} B")
print(f"  icns: {os.path.getsize(f'{TAURI}/icon.icns')} B, ico: {os.path.getsize(f'{TAURI}/icon.ico')} B")

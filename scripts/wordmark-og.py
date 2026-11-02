#!/usr/bin/env python3
"""Extract the 'PopcornTime' wordmark from the mascot logo as a transparent
PNG for the site header, and build a 1200x630 OG share image.

The wordmark sits below the mascot art: 'Popcorn' in white (play-triangle
inside the first 'o'), 'Time' in red. Background is a near-black rounded
square — keyed out by luminance/darkness so the header can layer it on any
dark surface without a visible box.
"""
from PIL import Image, ImageDraw, ImageFilter

SRC = "/home/z/my-project/upload/PopcornTime Mascot App Logo.png"
im = Image.open(SRC).convert("RGBA")
W, H = im.size  # 1254 x 1254
px = im.load()

def is_dark(p) -> bool:
    r, g, b, a = p
    return (r + g + b) / 3 < 70

# locate the wordmark band: scan rows in the lower quarter, find rows with
# enough bright/colored (non-dark) pixels — the wordmark is the bottom-most
# such band (below the popcorn box art)
rows = []
for y in range(int(H * 0.68), H):
    n = sum(1 for x in range(0, W, 3) if not is_dark(px[x, y]))
    rows.append((y, n))
# core text rows: high coverage; then extend down through connected descenders
# ('p' stems are sparse) and up only while rows stay connected — a run of
# near-empty rows means the gap between mascot art and the wordmark
by_y = dict(rows)
core = [y for y, n in rows if n > 40]
bot = max(core)
# the mascot art's bottom edge overlaps the text band's row range, so scan
# from the top of the range: skip the fragment block, then the empty gap,
# and start the wordmark where coverage rises again
y = min(core)
while y < bot and by_y.get(y, 0) > 2:
    y += 1
while y < bot and by_y.get(y, 0) <= 2:
    y += 1
top = y
while bot + 1 < H and by_y.get(bot + 1, 0) > 2:  # keep 'p' descenders
    bot += 1
print(f"band core {min(core)}-{max(core)}, art trimmed, text {top}-{bot}")
# horizontal bounds of that band
cols = [x for x in range(W) if any(not is_dark(px[x, y]) for y in range(top, bot + 1, 2))]
left, right = min(cols), max(cols)
print(f"wordmark band: y {top}-{bot}, x {left}-{right}  (h={bot-top})")

pad = 6
crop = im.crop((max(0, left - pad), max(0, top - pad), min(W, right + pad), min(H, bot + pad)))

# alpha = brightness-based; dark pixels vanish, white/red text stays
out = Image.new("RGBA", crop.size, (0, 0, 0, 0))
cp, op = crop.load(), out.load()
for y in range(crop.size[1]):
    for x in range(crop.size[0]):
        r, g, b, a = cp[x, y]
        lum = (r + g + b) / 3
        if lum < 70:
            continue  # background
        alpha = 255 if lum > 110 else int((lum - 70) / 40 * 255)
        op[x, y] = (r, g, b, alpha)
out.save("/home/z/my-project/public/wordmark.png")
print("wordmark.png:", out.size)

# ---- OG image: 1200x630, dark bg, centered full logo ----
logo = im.resize((560, 560), Image.LANCZOS)
og = Image.new("RGB", (1200, 630), (11, 11, 16))
d = ImageDraw.Draw(og)
# subtle red glow behind the logo
glow = Image.new("L", (1200, 630), 0)
gd = ImageDraw.Draw(glow)
gd.ellipse((600 - 260, 315 - 260, 600 + 260, 315 + 260), fill=70)
glow = glow.filter(ImageFilter.GaussianBlur(90))
red = Image.new("RGB", (1200, 630), (180, 20, 20))
og = Image.composite(red, og, glow)
og.paste(logo, ((1200 - 560) // 2, (630 - 560) // 2), logo)
og.save("/home/z/my-project/public/og.png", optimize=True)
print("og.png:", og.size)

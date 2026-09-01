#!/usr/bin/env python3
"""
Regenerate the app icons, favicons and splash art.

Everything is drawn from `assets/images/icon.svg` — the same heptagon and its
chords the brand uses elsewhere — so every size is redrawn rather than resampled
from a big PNG, and no asset can drift from the others.

Run after changing the palette or the source SVG:

    python3 scripts/generate-brand-assets.py

Needs Pillow (`pip install Pillow`). Deliberately not wired into a build: these
are brand assets that change once in a blue moon, and regenerating them on every
install would churn binaries in the diff for no reason.

`notification-icon.png` is NOT generated. Android renders it as a silhouette and
tints it itself, so a gold one would come out as a gold-shaped blob; it stays a
black-on-transparent mark.
"""
import json
import math
import re
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
IMAGES = ROOT / "assets" / "images"
SVG = IMAGES / "icon.svg"

# Two grounds, on purpose.
#
# ICONS are gold cords on charcoal: an icon is seen at 16-180px against whatever
# the OS puts behind it, and a dark plate with a bright mark holds its shape
# there. Gold-on-gold does not — it turned to texture below about 32px.
#
# SPLASH is the gold plate, which is the brand image and is only ever seen full
# screen, where a light figure on a warm wash has room to breathe.
#
# Both grounds are a shallow wash rather than a flat fill — one step of value,
# lit from above the mark — so the plate reads as lit without looking like a
# gradient. #EAB300 is the brand gold the source SVG already uses.
class Palette:
    def __init__(self, light, deep, figure, shadow, shadow_alpha):
        self.light = light
        self.deep = deep
        self.figure = figure
        self.shadow = shadow
        self.shadow_alpha = shadow_alpha


CHARCOAL = Palette((58, 58, 63), (22, 22, 25), (234, 179, 0), (0, 0, 0), 120)
GOLD = Palette((238, 190, 56), (196, 134, 12), (255, 231, 146), (150, 100, 6), 90)

SS = 4  # supersample factor; every edge here is a diagonal


def parse_svg():
    """(viewbox, lines, nodes) straight from the source artwork."""
    text = SVG.read_text()
    size = float(re.search(r'viewBox="0 0 ([\d.]+)', text).group(1))
    lines = [
        tuple(float(v) for v in m)
        for m in re.findall(
            r'<line x1="([\d.]+)" y1="([\d.]+)" x2="([\d.]+)" y2="([\d.]+)"', text
        )
    ]
    nodes = [
        tuple(float(v) for v in m)
        for m in re.findall(r'<circle cx="([\d.]+)" cy="([\d.]+)" r="([\d.]+)"', text)
    ]
    return size, lines, nodes


def gradient(size, light, deep):
    """A soft radial wash, brightest above centre, falling to `deep` at the corners."""
    w, h = size
    base = Image.new("RGB", (w, h), deep)
    top = Image.new("RGB", (w, h), light)
    # radial_gradient is white at the edge and black at the centre; inverted and
    # stretched to cover, it becomes the falloff we want.
    mask = Image.radial_gradient("L").resize((w * 2, h * 2), Image.LANCZOS)
    # Highlight above the mark, not behind it: centred, the brightest part of
    # the wash sat exactly where the figure does and flattened it out.
    mask = mask.crop((int(w * 0.5), int(h * 0.78), int(w * 1.5), int(h * 1.78)))
    mask = mask.resize((w, h), Image.LANCZOS).point(lambda v: 255 - v)
    base.paste(top, (0, 0), mask)
    return base


def perimeter(nodes, size):
    """Just the outline: consecutive vertices, walked in angular order."""
    c = size / 2
    ordered = sorted(nodes, key=lambda n: math.atan2(n[1] - c, n[0] - c))
    return [
        (a[0], a[1], b[0], b[1])
        for a, b in zip(ordered, ordered[1:] + ordered[:1])
    ]


def draw_figure(img, inset, palette, chords=True, weight=1.0):
    """
    The figure, centred, at `inset` of the shorter side.

    `chords` off leaves the outline and its vertices alone. Twenty-six chords
    across sixteen pixels is not a mark, it is texture — the favicons drop them
    and thicken what remains so the silhouette survives.
    """
    size, lines, nodes = parse_svg()
    if not chords:
        lines = perimeter(nodes, size)
    w, h = img.size
    span = min(w, h) * inset
    k = span / size
    ox, oy = (w - span) / 2, (h - span) / 2
    big = Image.new("RGBA", (w * SS, h * SS), (0, 0, 0, 0))
    d = ImageDraw.Draw(big)

    stroke = max(1, round(size * 0.0045 * k * SS * weight))
    dot = max(stroke, round(8 * k * SS * 0.9))
    drop = max(1, round(k * SS * 2))

    def place(x, y, dx=0, dy=0):
        return ((ox + x * k) * SS + dx, (oy + y * k) * SS + dy)

    # Shadow first, one step down-right, so the mark reads as raised on a ground
    # of almost its own colour.
    for shade, dx, dy in (
        (palette.shadow + (palette.shadow_alpha,), drop, drop),
        (palette.figure + (255,), 0, 0)
    ):
        for x1, y1, x2, y2 in lines:
            d.line([place(x1, y1, dx, dy), place(x2, y2, dx, dy)], fill=shade, width=stroke)
        for cx, cy, _ in nodes:
            px, py = place(cx, cy, dx, dy)
            d.ellipse([px - dot, py - dot, px + dot, py + dot], fill=shade)

    img.paste(big.resize((w, h), Image.LANCZOS), (0, 0), big.resize((w, h), Image.LANCZOS))
    return img


def solid(size, inset=0.62, palette=CHARCOAL, chords=True, weight=1.0):
    img = gradient(size, palette.light, palette.deep).convert("RGBA")
    return draw_figure(img, inset, palette, chords=chords, weight=weight)


def transparent(size, inset=0.86, palette=GOLD):
    """The mark alone, for a splash whose ground is painted by the OS."""
    img = Image.new("RGBA", size, (0, 0, 0, 0))
    return draw_figure(img, inset, palette)


IOS_ASSETS = ROOT / "ios" / "BSVWallet" / "Images.xcassets"
# The flat colour behind the splash logo. Matches app.json's splash
# backgroundColor; the plugin writes this into the colorset on prebuild, and we
# write it here so a checked-in native project does not sit on the old one.
SPLASH_BG = (224, 172, 44)


def write_ios(written):
    """
    Keep the committed native project in step.

    `expo prebuild` regenerates these from app.json and assets/, but ios/ is
    checked in — so without this the app would go on showing the previous icons
    until someone happened to run a prebuild.
    """
    icons = IOS_ASSETS / "AppIcon.appiconset"
    logos = IOS_ASSETS / "SplashScreenLogo.imageset"
    colorset = IOS_ASSETS / "SplashScreenBackground.colorset" / "Contents.json"
    if not icons.is_dir() or not logos.is_dir():
        print("skipped ios: no checked-in native project")
        return

    # iOS app icons must be fully opaque — an alpha channel is rejected at
    # submission — so this one is flattened rather than pasted with a mask.
    Image.open(IMAGES / "icon.png").convert("RGB").save(icons / "App-Icon-1024x1024@1x.png")
    written.append("ios AppIcon 1024")

    logo = Image.open(IMAGES / "splash-logo.png").convert("RGBA")
    for name, px in (("image.png", 200), ("image@2x.png", 400), ("image@3x.png", 600)):
        logo.resize((px, px), Image.LANCZOS).save(logos / name)
        written.append(f"ios splash logo {px}")

    if colorset.is_file():
        r, g, b = SPLASH_BG
        colorset.write_text(
            json.dumps(
                {
                    "colors": [
                        {
                            "color": {
                                "components": {
                                    "alpha": "1.000",
                                    "blue": f"{b / 255:.15f}",
                                    "green": f"{g / 255:.15f}",
                                    "red": f"{r / 255:.15f}",
                                },
                                "color-space": "srgb",
                            },
                            "idiom": "universal",
                        }
                    ],
                    "info": {"version": 1, "author": "expo"},
                },
                indent=2,
            )
            + "\n"
        )
        written.append("ios splash background colour")


def main():
    written = []

    def save(img, name, **kw):
        path = IMAGES / name
        img.save(path, **kw)
        written.append(f"{name} {img.size[0]}x{img.size[1]}")

    save(solid((1024, 1024)).convert("RGB"), "icon.png")
    # Adaptive icons are masked to a circle and can be cropped further, so the
    # figure sits well inside the safe area.
    save(solid((1006, 1007), inset=0.46), "adaptive-icon.png")
    save(solid((512, 512)), "android-chrome-512x512.png")
    save(solid((192, 192)), "android-chrome-192x192.png")
    save(solid((180, 180)), "apple-touch-icon.png")
    save(solid((64, 64), inset=0.66, chords=False, weight=1.6), "favicon.png")
    save(solid((32, 32), inset=0.70, chords=False, weight=2.4), "favicon-32x32.png")
    save(solid((16, 16), inset=0.74, chords=False, weight=4.0), "favicon-16x16.png")
    # Full-bleed phone art: the mark sits at roughly a third of the width, the
    # proportion the brand reference uses, not the near-filling one an icon wants.
    save(solid((512, 1007), inset=0.44, palette=GOLD), "splash-orig.png")
    save(solid((1179, 2556), inset=0.42, palette=GOLD), "splash.png")
    save(transparent((1024, 1024)), "splash-logo.png")

    ico = solid((256, 256), inset=0.70, chords=False, weight=1.4)
    ico.save(IMAGES / "favicon.ico", sizes=[(16, 16), (32, 32), (48, 48), (64, 64)])
    written.append("favicon.ico 16/32/48/64")

    write_ios(written)

    for line in written:
        print("wrote", line)


if __name__ == "__main__":
    main()

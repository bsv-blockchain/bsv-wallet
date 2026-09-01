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

from PIL import Image, ImageChops, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
IMAGES = ROOT / "assets" / "images"
SVG = IMAGES / "icon.svg"

# Two grounds, on purpose.
#
# SPLASH is the gold plate: the brand image, only ever seen full screen, where a
# warm wash and a figure lit from the upper left have room to show their shading.
#
# ICON is that same figure on a very dark ground tinted toward the gold, so the
# mark keeps its own colour at 16-180px instead of competing with whatever the OS
# puts behind it.
#
# The cords are drawn as raised cord rather than flat stroke — a contact shadow
# under them, a body, a highlight along the lit edge, and spherical nodes. Flat
# strokes rendered the same topology but read as a diagram; the shading is what
# makes it an object.
class Palette:
    def __init__(self, light, deep, cord, highlight, shade):
        self.light = light
        self.deep = deep
        self.cord = cord
        self.highlight = highlight
        self.shade = shade


# #EAB300 is the BSV gold the source SVG uses; the plate is that hue lit and
# shaded around it.
GOLD = Palette(
    light=(236, 192, 62),
    deep=(199, 141, 20),
    cord=(244, 199, 58),
    highlight=(255, 230, 150),
    shade=(140, 92, 4),
)
# #171614 sits between these two: very dark, warmed a step toward the gold so the
# plate never reads as neutral grey behind a gold mark.
DARK = Palette(
    light=(30, 28, 24),
    deep=(19, 18, 16),
    cord=(234, 179, 0),
    highlight=(255, 216, 96),
    shade=(0, 0, 0),
)

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


def _stroke(draw, lines, nodes, place, width, dot, fill):
    for x1, y1, x2, y2 in lines:
        draw.line([place(x1, y1), place(x2, y2)], fill=fill, width=width)
    for cx, cy, _ in nodes:
        px, py = place(cx, cy)
        draw.ellipse([px - dot, py - dot, px + dot, py + dot], fill=fill)


def _sphere(radius, palette):
    """A node as a lit bead: highlight up-left, the cord colour turning to shade."""
    d = radius * 2
    img = Image.new("RGBA", (d, d), (0, 0, 0, 0))
    px = img.load()
    for y in range(d):
        for x in range(d):
            nx, ny = (x - radius + 0.5) / radius, (y - radius + 0.5) / radius
            r2 = nx * nx + ny * ny
            if r2 > 1:
                continue
            # Lambert-ish falloff from a light up and to the left.
            lit = max(0.0, min(1.0, 0.5 - (nx + ny) * 0.5))
            edge = min(1.0, (1 - r2) * 6)  # soften the rim rather than clip it
            mix = lambda a, b: int(a + (b - a) * lit)
            px[x, y] = (
                mix(palette.shade[0], palette.highlight[0]),
                mix(palette.shade[1], palette.highlight[1]),
                mix(palette.shade[2], palette.highlight[2]),
                int(255 * edge),
            )
    return img


GRAIN = ROOT / "assets" / "brand" / "plate-grain.png"


def _grain_sheet(size):
    """
    The grain asset, mirror-tiled to cover `size`.

    Mirrored rather than repeated: a straight tile of a photographic texture
    shows its seams as a grid, which is more visible than the grain itself.
    Returns None when the asset is missing, so the script still runs for anyone
    who has not got it — they get clean gradients instead of a hard failure.
    """
    if not GRAIN.is_file():
        return None
    tile = Image.open(GRAIN).convert("L")
    # Scale the tooth to the target rather than cropping the tile into it: at
    # 1:1 the 1024px grain landed on a 180px icon five times too coarse, which
    # read as speckle instead of surface.
    edge = min(tile.size[0], max(size))
    if edge != tile.size[0]:
        tile = tile.resize((edge, edge), Image.LANCZOS)
    tw, th = tile.size
    flip_x = tile.transpose(Image.FLIP_LEFT_RIGHT)
    flip_y = tile.transpose(Image.FLIP_TOP_BOTTOM)
    flip_xy = flip_x.transpose(Image.FLIP_TOP_BOTTOM)
    w, h = size
    sheet = Image.new("L", (w, h), 128)
    for j, y in enumerate(range(0, h, th)):
        for i, x in enumerate(range(0, w, tw)):
            sheet.paste((tile, flip_x, flip_y, flip_xy)[(i % 2) + 2 * (j % 2)], (x, y))
    return sheet


def texture(img, strength=1.6, vignette=0.14):
    """
    Surface and falloff, so the plate reads as a lit object rather than a ramp.

    The grain comes from `assets/brand/plate-grain.png` — the high-passed
    surface of a rendered gold panel, so it is real paint tooth rather than
    synthetic speckle, and it is tone-free, which is why the same asset serves
    both the gold plate and the near-black one.

    Both effects sit close to the threshold of visibility on purpose: a large
    flat area should stop looking computed, not start looking textured.
    """
    w, h = img.size
    sheet = _grain_sheet((w, h))
    if sheet is not None:
        # ADDITIVE, not overlay. Overlay is multiplicative in the shadows, so on
        # the near-black plate — whose entire range is about thirteen of 255
        # levels — it moved nothing and left the gradient's quantisation visible
        # as rings. Adding the grain's deviation from mid grey dithers those
        # steps away and costs the same on both plates.
        dev = sheet.point(lambda v: int(round((v - 128) * strength)) + 128)
        r, g, b, a = img.split()
        # c + dev - 128, in one clipped pass. Reaching for ImageChops.subtract
        # here instead clips at zero first, which flattened the dark plate to
        # mid grey — the channel has to keep its sign through the addition.
        chans = [ImageChops.add(c, dev, 1.0, -128) for c in (r, g, b)]
        img = Image.merge("RGBA", (*chans, a))

    if vignette > 0:
        mask = Image.radial_gradient("L").resize((w, h), Image.LANCZOS)
        dark = Image.new("RGBA", (w, h), (0, 0, 0, 255))
        img = Image.composite(Image.blend(img, dark, vignette), img, mask.point(lambda v: int(v * 0.8)))
    return img


def draw_figure(img, inset, palette, chords=True, weight=1.0, shaded=True):
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
    W, H = w * SS, h * SS

    def place(x, y, dx=0.0, dy=0.0):
        return ((ox + x * k) * SS + dx, (oy + y * k) * SS + dy)

    body = max(2, round(size * 0.0052 * k * SS * weight))
    lit = max(1, round(body * 0.34))
    dot = max(body, round(8.5 * k * SS * weight))
    lift = max(1, round(body * 0.30))
    drop = max(2, round(body * 0.85))

    # 1. Contact shadow: the same geometry, offset and blurred, so the cords sit
    #    ON the plate instead of being painted into it. Skipped on the small
    #    favicons, where a blur wider than a pixel only muddies the silhouette
    #    and the shading it would carry is invisible anyway.
    shadow = None
    if shaded:
        shadow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        sd = ImageDraw.Draw(shadow)
        _stroke(
            sd, lines, nodes,
            lambda x, y: place(x, y, drop, drop),
            body, dot, palette.shade + (150,),
        )
        shadow = shadow.filter(ImageFilter.GaussianBlur(body * 0.9))

    # 2. Body, then 3. the highlight along the lit edge, offset up-left and
    #    thinner, which is what turns a stroke into a round cord.
    figure = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    fd = ImageDraw.Draw(figure)
    _stroke(fd, lines, nodes, place, body, dot, palette.cord + (255,))
    if shaded:
        _stroke(
            fd, lines, [],
            lambda x, y: place(x, y, -lift, -lift),
            lit, dot, palette.highlight + (165,),
        )
        # _sphere takes a radius and returns a 2r sprite, so this is pasted from
        # its top-left corner at (centre - r).
        bead = _sphere(dot, palette)
        for cx, cy, _ in nodes:
            px, py = place(cx, cy)
            figure.alpha_composite(bead, (int(px - dot), int(py - dot)))

    for layer in (shadow, figure):
        if layer is None:
            continue
        img.alpha_composite(layer.resize((w, h), Image.LANCZOS))
    return img


def solid(size, inset=0.62, palette=DARK, chords=True, weight=1.0, shaded=True):
    img = gradient(size, palette.light, palette.deep).convert("RGBA")
    # Only where there is room to see it. Under about 64px the grain is one
    # pixel of dirt on a mark that needs every pixel it has.
    if shaded and min(size) >= 128:
        img = texture(img)
    return draw_figure(img, inset, palette, chords=chords, weight=weight, shaded=shaded)


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

    def save(img, name, alpha=False, **kw):
        # Opaque plates go out as RGB. The grain is high-frequency by nature and
        # already costs PNG most of its compression, so carrying an alpha channel
        # nothing reads was adding a quarter again on top of that.
        out = img if alpha else img.convert("RGB")
        path = IMAGES / name
        out.save(path, optimize=True, **kw)
        written.append(f"{name} {out.size[0]}x{out.size[1]} {out.mode}")

    save(solid((1024, 1024)), "icon.png")
    # Adaptive icons are masked to a circle and can be cropped further, so the
    # figure sits well inside the safe area.
    save(solid((1006, 1007), inset=0.46), "adaptive-icon.png")
    save(solid((512, 512)), "android-chrome-512x512.png")
    save(solid((192, 192)), "android-chrome-192x192.png")
    save(solid((180, 180)), "apple-touch-icon.png")
    save(solid((64, 64), inset=0.66, chords=False, weight=1.6), "favicon.png")
    save(solid((32, 32), inset=0.70, chords=False, weight=2.4, shaded=False), "favicon-32x32.png")
    save(solid((16, 16), inset=0.74, chords=False, weight=4.0, shaded=False), "favicon-16x16.png")
    # Full-bleed phone art: the mark sits at roughly a third of the width, the
    # proportion the brand reference uses, not the near-filling one an icon wants.
    save(solid((512, 1007), inset=0.44, palette=GOLD), "splash-orig.png")
    save(solid((1179, 2556), inset=0.42, palette=GOLD), "splash.png")
    save(transparent((1024, 1024)), "splash-logo.png", alpha=True)

    ico = solid((256, 256), inset=0.70, chords=False, weight=1.4)
    ico.save(IMAGES / "favicon.ico", sizes=[(16, 16), (32, 32), (48, 48), (64, 64)])
    written.append("favicon.ico 16/32/48/64")

    write_ios(written)

    for line in written:
        print("wrote", line)


if __name__ == "__main__":
    main()

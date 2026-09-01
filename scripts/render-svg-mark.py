#!/usr/bin/env python3
"""
Render the flat vector mark onto a flat plate — the Android splash icon.

    render-svg-mark.py OUT.png SIZE BACKGROUND CORD [MARK_SHARE]

Android's splash cannot be the photographic plate: since Android 12 the system
splash is a centred icon over a flat background colour, and expo's pipeline
flattens transparency, so a crop of the plate showed its edges and a feathered
one came back as a dark ring. Flat vector art on the flat colour has neither
problem — there is no gradient to mismatch and no alpha to lose.

Geometry comes from assets/images/icon.svg, so this mark is the same graph as
everything else, centred by construction rather than by measurement.
"""
import re
import sys
from pathlib import Path

from PIL import Image, ImageDraw

SS = 4  # supersample; every edge here is a diagonal

out_path, size, bg_hex, cord_hex = sys.argv[1], int(sys.argv[2]), sys.argv[3], sys.argv[4]
share = float(sys.argv[5]) if len(sys.argv) > 5 else 0.62

svg = (Path(__file__).resolve().parent.parent / "assets" / "images" / "icon.svg").read_text()
box = float(re.search(r'viewBox="0 0 ([\d.]+)', svg).group(1))
lines = [tuple(map(float, m)) for m in re.findall(
    r'<line x1="([\d.]+)" y1="([\d.]+)" x2="([\d.]+)" y2="([\d.]+)"', svg)]
nodes = [tuple(map(float, m)) for m in re.findall(
    r'<circle cx="([\d.]+)" cy="([\d.]+)" r="([\d.]+)"', svg)]

rgb = lambda h: tuple(int(h.lstrip("#")[i:i + 2], 16) for i in (0, 2, 4))
img = Image.new("RGB", (size * SS, size * SS), rgb(bg_hex))
draw = ImageDraw.Draw(img)

span = size * SS * share
k = span / box
ox = oy = (size * SS - span) / 2
place = lambda x, y: (ox + x * k, oy + y * k)

# Proportions measured off the brand plate: cords 0.0068 of the mark's span,
# node beads 0.0248 of it.
width = max(1, round(span * 0.0068))
dot = max(width, round(span * 0.0124))
for x1, y1, x2, y2 in lines:
    draw.line([place(x1, y1), place(x2, y2)], fill=rgb(cord_hex), width=width)
for cx, cy, _ in nodes:
    px, py = place(cx, cy)
    draw.ellipse([px - dot, py - dot, px + dot, py + dot], fill=rgb(cord_hex))

img.resize((size, size), Image.LANCZOS).save(out_path)
print(f"  {Path(out_path).name}  {size}x{size} (flat SVG mark on {bg_hex})")

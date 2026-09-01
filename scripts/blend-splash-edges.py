#!/usr/bin/env python3
"""
Converge a splash tile's edges into the background colour it will sit on.

Called by generate-brand-assets.sh. Kept as its own file rather than inlined:
it was a nested heredoc inside the shell script, and the inner delimiter closed
the outer one.
"""
import sys

from PIL import Image, ImageDraw, ImageFilter

path, bg_hex = sys.argv[1], sys.argv[2].lstrip("#")
bg = tuple(int(bg_hex[i:i + 2], 16) for i in (0, 2, 4))
img = Image.open(path).convert("RGB")
w, h = img.size
mask = Image.new("L", (w, h), 0)
inset = int(w * 0.14)
ImageDraw.Draw(mask).ellipse([inset, inset, w - inset, h - inset], fill=255)
mask = mask.filter(ImageFilter.GaussianBlur(w * 0.06))
Image.composite(img, Image.new("RGB", (w, h), bg), mask).save(path)
print(f"  splash-logo.png  {w}x{h} (android splash icon, edges blended to #{bg_hex})")

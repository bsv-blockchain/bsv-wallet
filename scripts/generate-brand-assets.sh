#!/usr/bin/env bash
#
# Cut every icon, favicon and splash asset out of the brand reference.
#
#   ./scripts/generate-brand-assets.sh
#
# assets/brand/reference.jpg IS the artwork — the plate, the lighting and the
# relief of the cords all come from it. Nothing here redraws the mark: earlier
# versions of this script rebuilt it from icon.svg and spent a long time failing
# to match the reference's material, which the reference simply has.
#
# Two shapes of crop, both taken straight from the source with no invented pixels:
#
#   SPLASH targets are narrower than the reference, so they cover on height and
#   centre-crop the width.
#
#   ICONS are square, so they crop a square window centred on the figure
#   (fx 0.499, fy 0.521 of the frame, spanning 0.44 of its width) and scale that
#   down. ICON_WINDOW sets how much plate surrounds the mark: at 1.0 the figure
#   fills the icon edge to edge, so it sits wider than that.
#
# Needs ffmpeg. `notification-icon.png` is not generated — Android tints it as a
# silhouette, so it stays a black-on-transparent mark.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REF="$ROOT/assets/brand/reference.jpg"
OUT="$ROOT/assets/images"
IOS="$ROOT/ios/BSVWallet/Images.xcassets"

command -v ffmpeg >/dev/null || { echo "ffmpeg not found" >&2; exit 1; }
[[ -f "$REF" ]] || { echo "missing $REF" >&2; exit 1; }

# Figure geometry within the reference, measured from it.
FIG_CX=0.4990
FIG_CY=0.5206
FIG_SPAN=0.4400
# Figure : icon width. 0.62 leaves a comfortable margin of plate around the mark.
ICON_WINDOW=0.62

REF_W=$(ffprobe -v error -select_streams v:0 -show_entries stream=width -of csv=p=0 "$REF")
REF_H=$(ffprobe -v error -select_streams v:0 -show_entries stream=height -of csv=p=0 "$REF")

# The square window in source pixels, and its top-left corner.
WIN=$(python3 -c "print(round($REF_W*$FIG_SPAN/$ICON_WINDOW))")
WIN_X=$(python3 -c "print(max(0, round($REF_W*$FIG_CX - $WIN/2)))")
WIN_Y=$(python3 -c "print(max(0, round($REF_H*$FIG_CY - $WIN/2)))")

# A wider window for Android's centred splash icon: the mark reads smaller there,
# closer to how it sits on the full plate.
SPLASH_WINDOW=0.46
WIN_WIDE=$(python3 -c "print(min($REF_W, round($REF_W*$FIG_SPAN/$SPLASH_WINDOW)))")
WIN_WIDE_X=$(python3 -c "print(max(0, round($REF_W*$FIG_CX - $WIN_WIDE/2)))")
WIN_WIDE_Y=$(python3 -c "print(max(0, round($REF_H*$FIG_CY - $WIN_WIDE/2)))")

cover() { # cover+centre-crop to WxH
  ffmpeg -y -loglevel error -i "$REF" \
    -vf "scale=$2:$3:force_original_aspect_ratio=increase,crop=$2:$3" "$OUT/$1"
  echo "  $1  ${2}x${3}"
}

square() { # the figure window, scaled to NxN
  ffmpeg -y -loglevel error -i "$REF" \
    -vf "crop=$WIN:$WIN:$WIN_X:$WIN_Y,scale=$2:$2:flags=lanczos" "$OUT/$1"
  echo "  $1  ${2}x${2}"
}

echo "splash:"
cover splash.png 1179 2556
cover splash-orig.png 512 1007

echo "icons:"
square icon.png 1024
square adaptive-icon.png 1006
square android-chrome-512x512.png 512
square android-chrome-192x192.png 192
square apple-touch-icon.png 180
square favicon.png 64
square favicon-32x32.png 32
square favicon-16x16.png 16

# Android's splash is not full-bleed and cannot be: since Android 12 the system
# splash is a centred icon over a background colour, so handing it the tall plate
# squeezed the whole picture into a small box. It gets a square crop instead —
# the same window the icons use, a little wider so the mark sits smaller — over a
# background colour matched to that crop's edge, which hides the tile's boundary.
ffmpeg -y -loglevel error -i "$REF" \
  -vf "crop=$WIN_WIDE:$WIN_WIDE:$WIN_WIDE_X:$WIN_WIDE_Y,scale=1024:1024:flags=lanczos" \
  "$OUT/splash-logo.png"
echo "  splash-logo.png  1024x1024 (android centred splash icon)"

echo "favicon.ico:"
python3 - "$OUT" <<'PY'
import sys
from PIL import Image
out = sys.argv[1]
src = Image.open(f"{out}/favicon.png").convert("RGB")
src.save(f"{out}/favicon.ico", sizes=[(16, 16), (32, 32), (48, 48), (64, 64)])
print("  favicon.ico  16/32/48/64")
PY

if [[ -d "$IOS/AppIcon.appiconset" ]]; then
  echo "ios (checked-in native project):"
  # iOS app icons must be fully opaque; ffmpeg writes RGB here already.
  cp "$OUT/icon.png" "$IOS/AppIcon.appiconset/App-Icon-1024x1024@1x.png"
  echo "  AppIcon 1024"
  # One image per scale factor, sized for it. Copying the full-resolution plate
  # into all three slots cost 5.4MB to ship the same picture three times.
  for spec in "image.png:393:852" "image@2x.png:786:1704" "image@3x.png:1179:2556"; do
    name="${spec%%:*}"; rest="${spec#*:}"; iw="${rest%%:*}"; ih="${rest##*:}"
    ffmpeg -y -loglevel error -i "$OUT/splash.png" \
      -vf "scale=$iw:$ih:flags=lanczos" "$IOS/SplashScreenLogo.imageset/$name"
    echo "  splash $name  ${iw}x${ih}"
  done
fi

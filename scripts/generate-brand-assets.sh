#!/usr/bin/env bash
#
# Cut every icon, favicon and splash asset out of the brand master.
#
#   ./scripts/generate-brand-assets.sh
#
# assets/brand/reference.png IS the artwork — plate, lighting and the relief of
# the cords all come from it. Nothing here draws anything: earlier versions
# rebuilt the mark from icon.svg and spent a long time failing to reproduce what
# the master simply has.
#
# The splash is the master, copied verbatim rather than resampled, so what was
# approved is byte-for-byte what ships.
#
# Icons take a square window centred on the graph and scale it down. The centre
# and span are measured from the LIT cords only: including the cast shadow, which
# sits down and to the right, drags the centre off by a tenth of the frame.
#
# Needs ffmpeg. `notification-icon.png` is not generated — Android tints it as a
# silhouette, so it stays a black-on-transparent mark.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REF="$ROOT/assets/brand/reference.png"
OUT="$ROOT/assets/images"
IOS="$ROOT/ios/BSVWallet/Images.xcassets"

command -v ffmpeg >/dev/null || { echo "ffmpeg not found" >&2; exit 1; }
[[ -f "$REF" ]] || { echo "missing $REF" >&2; exit 1; }

# Graph geometry within the master. Measured with a small-radius high pass,
# which isolates the thin cords from the smooth cast shadow: a brightness
# threshold missed the figure's top edge entirely and put the centre 0.016 too
# low, which is what left the mark sitting high in every crop.
FIG_CX=0.4996
FIG_CY=0.5027
FIG_SPAN=0.4980
# The mark's share of an icon's width. Icons are seen small, so the mark carries
# them; leaving it at 0.62 had it swimming in plate.
ICON_WINDOW=0.80
# Android's splash icon reads smaller, closer to how the mark sits on the plate.
SPLASH_WINDOW=0.52
# Must equal the android splash backgroundColor in app.json.
ANDROID_SPLASH_BG="#dba132"

REF_W=$(ffprobe -v error -select_streams v:0 -show_entries stream=width -of csv=p=0 "$REF")
REF_H=$(ffprobe -v error -select_streams v:0 -show_entries stream=height -of csv=p=0 "$REF")

win() { python3 -c "print(min($REF_W, round($REF_W*$FIG_SPAN/$1)))"; }
win_x() { python3 -c "print(max(0, round($REF_W*$FIG_CX - $1/2)))"; }
win_y() { python3 -c "print(max(0, round($REF_H*$FIG_CY - $1/2)))"; }

WIN=$(win "$ICON_WINDOW");        WIN_X=$(win_x "$WIN");        WIN_Y=$(win_y "$WIN")
WIN_S=$(win "$SPLASH_WINDOW");    WIN_S_X=$(win_x "$WIN_S");    WIN_S_Y=$(win_y "$WIN_S")

square() { # the graph window, scaled to NxN
  ffmpeg -y -loglevel error -i "$REF" \
    -vf "crop=$WIN:$WIN:$WIN_X:$WIN_Y,scale=$2:$2:flags=lanczos" "$OUT/$1"
  echo "  $1  ${2}x${2}"
}

echo "splash:"
# Verbatim. Re-encoding the master through ffmpeg would resample the very pixels
# that were signed off on.
cp "$REF" "$OUT/splash.png"
echo "  splash.png  ${REF_W}x${REF_H} (master, copied)"
ffmpeg -y -loglevel error -i "$REF" -vf "scale=512:-1:flags=lanczos" "$OUT/splash-orig.png"
echo "  splash-orig.png  512x$(python3 -c "print(round(512*$REF_H/$REF_W))")"

echo "icons:"
square icon.png 1024
square adaptive-icon.png 1006
square android-chrome-512x512.png 512
square android-chrome-192x192.png 192
square apple-touch-icon.png 180
square favicon.png 64
square favicon-32x32.png 32
square favicon-16x16.png 16

# Android's splash: the flat vector mark on the flat background colour.
python3 "$ROOT/scripts/render-svg-mark.py" "$OUT/splash-logo.png" 1024 "$ANDROID_SPLASH_BG" "#ffd133" 0.62

echo "favicon.ico:"
python3 - "$OUT" <<'INNER'
import sys
from PIL import Image
out = sys.argv[1]
Image.open(f"{out}/favicon.png").convert("RGB").save(
    f"{out}/favicon.ico", sizes=[(16, 16), (32, 32), (48, 48), (64, 64)]
)
print("  favicon.ico  16/32/48/64")
INNER

if [[ -d "$IOS/AppIcon.appiconset" ]]; then
  echo "ios (checked-in native project):"
  # iOS app icons must be fully opaque; an alpha channel is rejected at submission.
  cp "$OUT/icon.png" "$IOS/AppIcon.appiconset/App-Icon-1024x1024@1x.png"
  echo "  AppIcon 1024"
  # One image per scale factor. Copying the full-resolution plate into all three
  # shipped the same picture three times.
  for spec in "image.png:393:852" "image@2x.png:786:1704" "image@3x.png:1179:2556"; do
    name="${spec%%:*}"; rest="${spec#*:}"; iw="${rest%%:*}"; ih="${rest##*:}"
    ffmpeg -y -loglevel error -i "$OUT/splash.png" \
      -vf "scale=$iw:$ih:flags=lanczos" "$IOS/SplashScreenLogo.imageset/$name"
    echo "  splash $name  ${iw}x${ih}"
  done
fi

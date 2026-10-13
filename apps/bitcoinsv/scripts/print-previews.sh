#!/bin/sh
# The design picker's preview images (assets/print/previews), drawn from
# sample data by the print designs themselves. Run again after changing a
# design (src/print/designs.ts or document.ts). Needs Google Chrome.
set -e
cd "$(dirname "$0")/.."
OUT=$(mktemp -d)
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
PRINT_PICKER="$OUT" npx jest --rootDir ../.. apps/bitcoinsv/__tests__/printDesigns -t 'picker previews' >/dev/null
mkdir -p assets/print/previews
for f in "$OUT"/*.html; do
  name=$(basename "$f" .html)
  case "$name" in plain-*) size=794,900 ;; *) size=1260,594 ;; esac
  "$CHROME" --headless=new --disable-gpu --no-first-run --user-data-dir="$OUT/chrome" --hide-scrollbars \
    --force-device-scale-factor=1 --window-size=$size --screenshot="$OUT/$name.png" "file://$f" >/dev/null 2>&1 &
  pid=$!; sleep 6; kill $pid 2>/dev/null || true
  sips -s format jpeg -s formatOptions 82 -Z 1000 "$OUT/$name.png" --out "assets/print/previews/$name.jpg" >/dev/null
done
ls -la assets/print/previews

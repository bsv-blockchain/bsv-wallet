#!/usr/bin/env bash
# Re-vendor @bsv/mandala from the sibling checkout of bsv-blockchain/mandala.
#
# The wallet consumes the Mandala token client as a packed tarball under
# vendor/ rather than `file:../demos/mandala/lib`: EAS local builds extract a
# git archive of THIS repo into a temp dir and run `npm install` there, so a
# relative path outside the repo does not exist at build time. The npm-published
# @bsv/mandala lags the lib (0.1.0 on npm is from July), so vendoring is the
# only way a production build ships the current wire contract.
#
# Usage: scripts/sync-mandala.sh [path-to-mandala-lib]   (default ../demos/mandala/lib)
set -euo pipefail
LIB="${1:-$(dirname "$0")/../../demos/mandala/lib}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LIB="$(cd "$LIB" && pwd)"
echo "building $LIB"
(cd "$LIB" && npm run build --silent)
rm -f "$ROOT"/vendor/bsv-mandala-*.tgz
TGZ="$(cd "$LIB" && npm pack --silent --pack-destination "$ROOT/vendor")"
echo "packed vendor/$TGZ"
(cd "$ROOT" && npm install "./vendor/$TGZ" --save --no-audit --no-fund)
echo "done — commit package.json, package-lock.json and vendor/$TGZ"

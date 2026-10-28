#!/bin/bash
# Dev link: pack the toolbox and this kit with a unique version (not a prerelease: CocoaPods will not resolve one) and install both into a host app,
# so the host sees WT changes without the npm `file:` tarball cache serving a stale copy.
#
#   link-kit.sh <host-dir>
#
# Both tarballs are unpacked straight into <host>/node_modules/@bsv/<name> (replacing whatever is there,
# including a symlink) instead of `npm install --no-save`: a host whose node_modules is a farm of symlinks
# into another checkout would have npm write through those links. Re-run after every change to either package.
set -euo pipefail

HOST="${1:?usage: link-kit.sh <host-dir>}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
TOOLBOX="$(cd "$HERE/../expo-wallet-toolbox" && pwd)"
VERSION="0.0.$(date +%s)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

pack_one() {
  local src="$1" name="$2"
  local tmp="$WORK/$name"
  mkdir -p "$tmp"
  # copy without node_modules, then set the unique version in the copy only
  rsync -a --exclude node_modules --exclude .scratch --exclude .build "$src/" "$tmp/"
  (cd "$tmp" && npm pkg set version="$VERSION" >/dev/null && npm pack --silent --pack-destination "$WORK" >/dev/null)
  local tgz
  tgz="$(ls "$WORK"/*"$name"*.tgz | head -1)"
  local dest="$HOST/node_modules/@bsv/$name"
  rm -rf "$dest"
  mkdir -p "$dest"
  tar -xzf "$tgz" -C "$dest" --strip-components=1
  rm -f "$tgz"
  echo "linked @bsv/$name@$VERSION -> $dest"
}

pack_one "$TOOLBOX" expo-wallet-toolbox
pack_one "$HERE" expo-safari-wallet-bridge

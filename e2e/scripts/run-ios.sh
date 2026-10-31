#!/usr/bin/env bash
# Build the iOS simulator harness and run the Maestro flows.
# macOS only. E2E_SKIP_BUILD=1 reuses an .app already produced under build/ios
# and installed on the booted simulator.
set -euo pipefail
source "$(dirname "$0")/common.sh"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "iOS simulator builds run on macOS. Use the e2e-ios GitHub Actions workflow, or a Mac." >&2
  exit 1
fi

export LANG="${LANG:-en_US.UTF-8}"
export LC_ALL="${LC_ALL:-en_US.UTF-8}"

if [[ "${E2E_SKIP_BUILD:-}" != "1" ]]; then
  if [[ "${E2E_CLEAN:-}" == "1" || ! -d "$ROOT/ios" ]]; then
    npx expo prebuild --platform ios --no-install --clean
  else
    npx expo prebuild --platform ios --no-install
  fi
  # `expo run:ios` has no --non-interactive flag. `--device generic` builds
  # the simulator binary without prompting for a destination, and CI=true
  # (set by GitHub Actions) keeps Expo from asking questions.
  mkdir -p "$ROOT/build/ios"
  # prebuild rewrites ios/Podfile from the Expo template. Re-apply the YubiKit
  # git pin if that rewrite dropped it. The config plugin does the same; this
  # is the backstop for a Podfile that was already on disk.
  python3 - "$ROOT/ios/Podfile" <<'PY'
import sys
path = sys.argv[1]
text = open(path).read()
anchor = "use_expo_modules!\n"
pin = "  pod 'YubiKit', :git => 'https://github.com/Yubico/yubikit-ios.git', :tag => '4.4.1'\n"
if "pod 'YubiKit'" not in text:
    if anchor not in text:
        sys.exit("Podfile has no use_expo_modules! anchor")
    text = text.replace(anchor, anchor + "\n" + pin, 1)
    open(path, "w").write(text)
    print("Restored the YubiKit 4.4.1 git pin in the Podfile")
PY
  npx expo run:ios --configuration Release --no-bundler --device generic --output "$ROOT/build/ios"
fi

APP="$(find "$ROOT/build/ios" -name '*.app' -type d -print -quit || true)"
if [[ -z "$APP" ]]; then
  echo "No simulator .app under $ROOT/build/ios. Build first, or pass E2E_SKIP_BUILD only after a successful build." >&2
  exit 1
fi

if ! xcrun simctl list devices booted | grep -q Booted; then
  UDID="$(xcrun simctl list devices available | grep -E 'iPhone' | grep -oE '[0-9A-Fa-f-]{36}' | head -1 || true)"
  if [[ -z "$UDID" ]]; then
    echo "No available iPhone simulator." >&2
    xcrun simctl list devices available || true
    exit 1
  fi
  echo "Booting simulator $UDID"
  xcrun simctl boot "$UDID" || true
  xcrun simctl bootstatus "$UDID" -b
fi

xcrun simctl install booted "$APP"

trap stop_mock EXIT
start_mock
run_maestro "$@"

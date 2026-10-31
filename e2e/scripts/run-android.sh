#!/usr/bin/env bash
# Build the Android harness (release APK) and run the Maestro flows.
# Requires the Android SDK, an emulator or device, and Maestro.
# E2E_SKIP_BUILD=1 reuses an existing APK. E2E_CLEAN=1 forces expo prebuild --clean.
#
# A debug APK does not embed the JS bundle (debuggableVariants skips it) and
# waits for Metro. The harness has to run with Metro stopped, so this is a
# release APK. Expo's template signs that variant with the debug keystore.
set -euo pipefail
source "$(dirname "$0")/common.sh"

if [[ "${E2E_SKIP_BUILD:-}" != "1" ]]; then
  if [[ "${E2E_CLEAN:-}" == "1" || ! -d "$ROOT/android" ]]; then
    npx expo prebuild --platform android --no-install --clean
  else
    npx expo prebuild --platform android --no-install
  fi
  (cd "$ROOT/android" && ./gradlew assembleRelease --no-daemon)
fi

APK="$ROOT/android/app/build/outputs/apk/release/app-release.apk"
if [[ ! -f "$APK" ]]; then
  echo "Release APK not found at $APK" >&2
  exit 1
fi

adb install -r "$APK"

trap stop_mock EXIT
start_mock
run_maestro "$@"

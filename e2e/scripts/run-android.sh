#!/usr/bin/env bash
# Build the Android harness (debug APK) and run the Maestro flows.
# Requires the Android SDK, an emulator or device, and Maestro.
# E2E_SKIP_BUILD=1 reuses an existing APK. E2E_CLEAN=1 forces expo prebuild --clean.
set -euo pipefail
source "$(dirname "$0")/common.sh"

if [[ "${E2E_SKIP_BUILD:-}" != "1" ]]; then
  if [[ "${E2E_CLEAN:-}" == "1" || ! -d "$ROOT/android" ]]; then
    npx expo prebuild --platform android --no-install --clean
  else
    npx expo prebuild --platform android --no-install
  fi
  (cd "$ROOT/android" && ./gradlew assembleDebug --no-daemon)
fi

APK="$ROOT/android/app/build/outputs/apk/debug/app-debug.apk"
if [[ ! -f "$APK" ]]; then
  echo "Debug APK not found at $APK" >&2
  exit 1
fi

adb install -r "$APK"

trap stop_mock EXIT
start_mock
run_maestro "$@"

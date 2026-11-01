#!/usr/bin/env bash
# One script for android-emulator-runner. That action runs each line of its
# `script:` input in a separate shell, so a multi-line `if` is a syntax error.
set -u

APK="android/app/build/outputs/apk/release/app-release.apk"
if [[ ! -f "$APK" ]]; then
  echo "Release APK not found at $APK" >&2
  exit 1
fi

# boot_completed can flip before the package service is listening. A single
# adb install then fails with "Broken pipe" / "Can't find service: package".
install_status=1
for _ in 1 2 3 4 5 6 7 8 9 10 11 12; do
  if adb install -r "$APK"; then
    install_status=0
    break
  fi
  echo "adb install failed; waiting for the package service"
  sleep 10
done
mkdir -p e2e/artifacts
capture_device() {
  # The emulator runner kills the device when this script exits, and a later
  # step cannot read logcat from a dead emulator. Capture while it is up.
  timeout 20 adb logcat -d > e2e/artifacts/logcat.txt || true
  adb exec-out screencap -p > e2e/artifacts/screen.png || true
  adb shell uiautomator dump /sdcard/e2e-window.xml >/dev/null 2>&1 || true
  adb pull /sdcard/e2e-window.xml e2e/artifacts/window.xml >/dev/null 2>&1 || true
}
if [[ "$install_status" -ne 0 ]]; then
  capture_device
  exit "$install_status"
fi

bash e2e/scripts/run.sh
status=$?
if [[ "$status" -ne 0 ]]; then
  capture_device
fi
exit "$status"

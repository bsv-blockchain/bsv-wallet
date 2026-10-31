#!/usr/bin/env bash
# One script for android-emulator-runner. That action runs each line of its
# `script:` input in a separate shell, so a multi-line `if` is a syntax error.
set -u

adb install -r android/app/build/outputs/apk/debug/app-debug.apk
install_status=$?
mkdir -p e2e/artifacts
if [[ "$install_status" -ne 0 ]]; then
  timeout 20 adb logcat -d > e2e/artifacts/logcat.txt || true
  exit "$install_status"
fi

bash e2e/scripts/run.sh
status=$?
if [[ "$status" -ne 0 ]]; then
  timeout 20 adb logcat -d > e2e/artifacts/logcat.txt || true
fi
exit "$status"

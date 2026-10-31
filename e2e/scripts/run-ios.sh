#!/usr/bin/env bash
# Build the iOS simulator harness and run the Maestro flows.
# macOS only. E2E_SKIP_BUILD=1 reuses the app already installed on the booted simulator.
set -euo pipefail
source "$(dirname "$0")/common.sh"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "iOS simulator builds run on macOS. Use the e2e-ios GitHub Actions workflow, or a Mac." >&2
  exit 1
fi

if [[ "${E2E_SKIP_BUILD:-}" != "1" ]]; then
  npx expo prebuild --platform ios --no-install ${E2E_CLEAN:+--clean}
  npx expo run:ios --configuration Release --non-interactive
fi

trap stop_mock EXIT
start_mock
run_maestro "$@"

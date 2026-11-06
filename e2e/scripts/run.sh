#!/usr/bin/env bash
# Run the Maestro flows against an already-installed harness build.
# Start a simulator or emulator first. See TESTING.md.
set -euo pipefail
source "$(dirname "$0")/common.sh"
trap stop_mock EXIT
start_mock
run_maestro "$@"

#!/usr/bin/env bash
# Shared bits for the local E2E scripts. Sourced, not executed.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

export EXPO_PUBLIC_E2E=true
export EXPO_NO_TELEMETRY=1
export RCT_USE_PREBUILT_RNCORE="${RCT_USE_PREBUILT_RNCORE:-0}"

# Gradle and the Xcode bundle step inline EXPO_PUBLIC_* from .env as well as
# the environment. A daemon that does not inherit this shell still has to
# produce a harness binary.
if ! grep -q '^EXPO_PUBLIC_E2E=' "$ROOT/.env" 2>/dev/null; then
  echo 'EXPO_PUBLIC_E2E=true' >> "$ROOT/.env"
fi

# The fixture is the twelve published BIP-39 words, one line.
E2E_MNEMONIC="$(tr -d '\r\n' < "$ROOT/e2e/fixtures/bip39-test-vector.txt")"
export E2E_MNEMONIC
# A public testnet P2PKH address (version byte 0x6f). Not a key.
export E2E_TESTNET_ADDRESS="${E2E_TESTNET_ADDRESS:-mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn}"

if [[ "$E2E_MNEMONIC" != "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about" ]]; then
  echo "e2e/fixtures/bip39-test-vector.txt is not the published BIP-39 test vector." >&2
  exit 1
fi

MOCK_PID=""
start_mock() {
  local port="${E2E_BROADCASTER_PORT:-8787}"
  export E2E_BROADCASTER_PORT="$port"
  if curl -sf "http://127.0.0.1:${port}/health" >/dev/null 2>&1; then
    echo "Mock broadcaster already listening on ${port}"
    return
  fi
  node "$ROOT/e2e/mock/server.mjs" &
  MOCK_PID=$!
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    if curl -sf "http://127.0.0.1:${port}/health" >/dev/null 2>&1; then
      echo "Mock broadcaster listening on ${port} (pid ${MOCK_PID})"
      return
    fi
    sleep 0.3
  done
  echo "Mock broadcaster did not become healthy on ${port}" >&2
  exit 1
}

stop_mock() {
  if [[ -n "${MOCK_PID}" ]]; then
    kill "$MOCK_PID" >/dev/null 2>&1 || true
  fi
}

run_maestro() {
  local maestro="${MAESTRO:-maestro}"
  if ! command -v "$maestro" >/dev/null 2>&1; then
    echo "Maestro is not on PATH. Install it with: curl -Ls https://get.maestro.mobile.dev | bash" >&2
    exit 1
  fi
  mkdir -p "$ROOT/e2e/artifacts"
  "$maestro" test \
    --config "$ROOT/e2e/config.yaml" \
    --debug-output "$ROOT/e2e/artifacts" \
    -e "E2E_MNEMONIC=${E2E_MNEMONIC}" \
    -e "E2E_TESTNET_ADDRESS=${E2E_TESTNET_ADDRESS}" \
    "$@" \
    "$ROOT/e2e/flows"
}

#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
build=$(mktemp -d)
trap 'rm -rf "$build"' EXIT
swiftc "$root/ios/BleGattProfile.swift" "$root/tests/ble/main.swift" -o "$build/ble-tests"
"$build/ble-tests"

#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
build=$(mktemp -d)
trap 'rm -rf "$build"' EXIT
swiftc -emit-module -emit-library -module-name NitroModules \
  "$root/tests/awdl/Support/NitroModules.swift" -o "$build/libNitroModules.dylib" -emit-module-path "$build/NitroModules.swiftmodule"
swiftc -I "$build" -L "$build" -lNitroModules -Xlinker -rpath -Xlinker "$build" \
  "$root/tests/awdl/Support/HybridLocalPayTransportSpec.swift" \
  "$root/ios/AwdlSession.swift" "$root/ios/HybridLocalPayTransport.swift" \
  "$root/tests/awdl/main.swift" -o "$build/awdl-tests"
"$build/awdl-tests"

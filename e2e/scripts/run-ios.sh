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
  # The committed ios/ project already pins YubiKit and disables Firebase SPM.
  # `expo prebuild` rewrites that Podfile and Xcode then fails to resolve the
  # generated Swift packages. Only prebuild when the native project is absent
  # or E2E_CLEAN=1.
  if [[ "${E2E_CLEAN:-}" == "1" || ! -f "$ROOT/ios/Podfile" ]]; then
    if [[ "${E2E_CLEAN:-}" == "1" ]]; then
      npx expo prebuild --platform ios --no-install --clean
    else
      npx expo prebuild --platform ios --no-install
    fi
  fi
  # `expo run:ios` has no --non-interactive flag. CI=true (set by GitHub
  # Actions) keeps Expo from asking questions. `--device generic` selects
  # destination `generic/platform=iOS Simulator`, and Xcode 16 then exits 65
  # with "Could not resolve package dependencies" and no package name.
  # A concrete booted simulator does not.
  mkdir -p "$ROOT/build/ios"
  mkdir -p "$ROOT/e2e/artifacts"
  # If a prebuild did run, put back the pins it drops. No-op for the committed Podfile.
  python3 - "$ROOT/ios/Podfile" <<'PY'
import sys
path = sys.argv[1]
text = open(path).read()
changed = False
firebase = (
    "# react-native-firebase: opt out of SPM; SPM + use_frameworks static collides.\n"
    "$RNFirebaseDisableSPM = true\n"
)
if "$RNFirebaseDisableSPM" not in text:
    anchor = "prepare_react_native_project!\n"
    if anchor not in text:
        sys.exit("Podfile has no prepare_react_native_project! anchor")
    text = text.replace(anchor, firebase + "\n" + anchor, 1)
    changed = True
pin = "  pod 'YubiKit', :git => 'https://github.com/Yubico/yubikit-ios.git', :tag => '4.4.1'\n"
if "pod 'YubiKit'" not in text:
    anchor = "use_expo_modules!\n"
    if anchor not in text:
        sys.exit("Podfile has no use_expo_modules! anchor")
    text = text.replace(anchor, anchor + "\n" + pin, 1)
    changed = True
if changed:
    open(path, "w").write(text)
    print("Restored Podfile pins dropped by prebuild (YubiKit git tag, RNFirebaseDisableSPM)")
PY
  # SDK 57's EventEmitter.swift fails on Xcode 26.2 and 26.3 with
  # "sending 'emitter' risks causing data races". Expo ships the fix in the
  # Xcode 26.4 compiler. On an older 26.x, compile that one pod as Swift 5.10
  # so the check is not an error. This does not change the committed Podfile.
  xver="$(xcodebuild -version | awk '/^Xcode /{print $2}')"
  xminor="$(printf '%s' "$xver" | awk -F. '{print $2}')"
  if [[ "${xver%%.*}" -eq 26 && "${xminor:-0}" -lt 4 ]]; then
    python3 - "$ROOT/ios/Podfile" <<'PY'
import sys
path = sys.argv[1]
text = open(path).read()
marker = "E2E_EXPO_SWIFT_5"
if marker in text:
    sys.exit(0)
snippet = """
    # E2E_EXPO_SWIFT_5: Xcode 26.2/26.3 rejects ExpoModulesCore EventEmitter.swift.
    installer.pods_project.targets.each do |target|
      next unless target.name == 'ExpoModulesCore'
      target.build_configurations.each do |bc|
        bc.build_settings['SWIFT_VERSION'] = '5.10'
        bc.build_settings['SWIFT_STRICT_CONCURRENCY'] = 'minimal'
        bc.build_settings['SWIFT_COMPILATION_MODE'] = 'singlefile'
      end
    end
"""
anchor = "    floor = (podfile_properties['ios.deploymentTarget'] || '16.4')\n"
if anchor not in text:
    sys.exit("Podfile has no deployment-target floor anchor")
text = text.replace(anchor, snippet + "\n" + anchor, 1)
open(path, "w").write(text)
print("Compiling ExpoModulesCore as Swift 5.10 for this Xcode")
PY
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
  else
    UDID="$(xcrun simctl list devices booted | grep -oE '[0-9A-Fa-f-]{36}' | head -1)"
  fi
  # Passing a real simulator makes Expo also enumerate physical devices.
  # `devicectl` is installed on the runner, and Expo records that by writing
  # ~/.expo/devicectl-exists. The directory does not exist until something
  # else creates it, so the write throws ENOENT before xcodebuild starts.
  mkdir -p "${HOME}/.expo"
  set +e
  npx expo run:ios --configuration Release --no-bundler --device "$UDID" --output "$ROOT/build/ios"
  build_status=$?
  set -e
  if [[ -f "$ROOT/.expo/xcodebuild-error.log" ]]; then
    cp "$ROOT/.expo/xcodebuild-error.log" "$ROOT/e2e/artifacts/xcodebuild-error.log" || true
  fi
  if [[ -f "$ROOT/.expo/xcodebuild.log" ]]; then
    tail -n 400 "$ROOT/.expo/xcodebuild.log" > "$ROOT/e2e/artifacts/xcodebuild.tail.log" || true
  fi
  if [[ "$build_status" -ne 0 ]]; then
    if ! find "$ROOT/build/ios" -name '*.app' -type d -print -quit | grep -q .; then
      echo "iOS build failed (exit $build_status). See e2e/artifacts/xcodebuild-error.log." >&2
      exit "$build_status"
    fi
    echo "expo run:ios exited $build_status after writing a simulator .app; continuing."
  fi
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
set +e
run_maestro "$@"
maestro_status=$?
set -e
if [[ "$maestro_status" -ne 0 ]]; then
  xcrun simctl io booted screenshot "$ROOT/e2e/artifacts/screen.png" || true
fi
exit "$maestro_status"

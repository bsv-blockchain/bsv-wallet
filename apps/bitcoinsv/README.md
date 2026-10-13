# Bitcoin SV Wallet (Now mode)

A second app shell next to the existing BSV Wallet (repository root). It brings the designer's prototype ([vincemedia/bitcoinsv-wallet-proto](https://github.com/vincemedia/bitcoinsv-wallet-proto)) to iOS and Android, starting with the prototype's Now features. Scope, boundaries and the feature matrix:

- [docs/superpowers/2026-10-09-now-app-handover.md](../../docs/superpowers/2026-10-09-now-app-handover.md)
- [docs/superpowers/2026-10-09-now-app-matrix.md](../../docs/superpowers/2026-10-09-now-app-matrix.md)

## How it fits in the repository

- **One wallet implementation.** All wallet behaviour comes from `packages/expo-wallet-toolbox`, which the existing app also uses. This app adds screens and an app-local theme. It does not add wallet services.
- **npm workspace of the root.** `apps/*` is a workspace. A single `npm ci` at the repository root installs one copy of every dependency and applies the root `patches/` for both apps. Every dependency shared with the existing app must use the same version (`__tests__/isolation.test.js` enforces this). A different version would install a second copy of a native module.
- **Native projects are generated.** `ios/` and `android/` are produced by `expo prebuild` from `app.config.js` and are not committed. Native build settings for the shared modules (the `expo-build-properties` and `expo-audio` entries) are read from the existing app's `app.json`, so a fix there applies to both builds.

## Identity: takes over the existing app

This app ships under the existing BSV Wallet's installed identity, as an update to the same store listings. `app.config.js` reads each value from the root `app.json`, so the two cannot drift:

| | Value |
|---|---|
| Bundle ID / package | `org.bsvblockchain.wallet` |
| URL schemes | `bsv-wallet`, `bsv-browser`, `peerpay` |
| EAS project, Firebase registrations, App Store app | the existing app's |

Installed over the existing app, it inherits that installation's keychain items, SQLite databases, AsyncStorage and secure store (the shared core uses the same internal key and service names), so it opens on the same wallet. The two apps cannot be installed side by side. Neither declares keychain access groups, app groups or an Android shared user ID. `__tests__/isolation.test.js` fails if any of this changes.

## Release gates

| Profile (`eas.json`) | Vault | Push |
|---|---|---|
| `development`, `dev-physical`, `preview`, `preview-apk` | on | on |
| `production` | on (from build 61) | on (via MessageBox) |

Push uses the existing app's Firebase registrations at the repository root (`GoogleService-Info.plist`, `google-services.json`). Without them the app builds and runs with push unavailable.

Production handles live under `bitcoinsv.com`. Set `EXPO_PUBLIC_HANDLE_REGISTRY_URL` (and the `TEST_` one) in the production profile once BSVA provides that registry host; until then Profile shows handles as not available. The development and preview profiles use the existing development registry (`deggen.com`).

## Design

Colours, corner radii and type come from the prototype, so the app should look identical:

- `src/theme/tokens.ts` is **generated** from the prototype's `app/globals.css`. Regenerate it after the designer changes tokens, and commit it together with the prototype revision named in its header:
  ```bash
  node scripts/sync-design-tokens.mjs ../../../bitcoinsv-wallet-proto
  ```
- Fonts: Nunito (400–900) for everything and Caveat (600/700) for the Home tour's handwriting. Both are embedded at build time. Use `font(weight)` / `handwriting()` from `src/theme`.
- `src/theme` is app-local. The shared toolbox theme and the existing app's look are unchanged.

## Running

### Toolchain (macOS, Apple silicon)

- Xcode selected with `sudo xcode-select -s /Applications/Xcode.app`, plus an iOS simulator runtime.
- From the arm64 Homebrew (`/opt/homebrew`): `brew install cocoapods openjdk@17 watchman`.
- Rust (rustup) with `aarch64-apple-ios`, `aarch64-apple-ios-sim` and `x86_64-apple-ios`.
- Android SDK with command-line tools, `platforms;android-36`, `ndk;27.1.12297006` and `cmake;3.22.1`.
- `JAVA_HOME=/opt/homebrew/opt/openjdk@17` and `ANDROID_HOME=~/Library/Android/sdk`.

### iOS native frameworks (once, and after any Rust change)

The tx engine and secp256k1 modules are Rust xcframeworks that are not committed. Build and sync them from the repository root:

```bash
(cd native-secp-poc && scripts/build-secp-xcframework.sh)
(cd native-engine-ffi && scripts/build-engine-xcframework.sh)
bash packages/react-native-secp-native/scripts/sync-xcframework.sh
bash packages/react-native-engine-native/scripts/sync-xcframework.sh
git checkout native-engine-ffi/BSV-RS-PIN.md   # the build only refreshes its timestamp
```

Run the two sync scripts by hand. The podspecs try to run them automatically during `pod install`, but that fails when the repository path contains a space. Android does not use these modules.

### Build and run

From the repository root, `npm ci` once. Then, from this folder:

```bash
npm run prebuild          # generate ios/ and android/
npm run ios               # or: npm run android
npm start                 # Metro for an installed development build (never with CI=1: it disables file watching)
npm test                  # this app's guard tests
eas build --profile development --platform ios   # the existing app's EAS project
```

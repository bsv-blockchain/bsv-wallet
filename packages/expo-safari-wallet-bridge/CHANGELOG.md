# Changelog

## 0.1.0 (unreleased, `private: true` until release)

- Safari Web Extension (MV3, non-persistent background, page-world provider at `document_start`) that
  speaks BRC-185 to the page and stages every call through the app's inbox.
- `BsvBridgeQueue` Swift package: the sealed App Group queue (AES-256-GCM, state is where the file is),
  the continuity key and the native-message router, linked into the app and the appex.
- Expo native module `BsvBridge` and the JS inbox-store adapter (`createNativeInboxStore`).
- `SafariBridgeHost` (app runtime: scheme doorbell, drain, mirror writer, receipts, done screen and
  toast) and `SafariSetupGuide`.
- Config plugin `withSafariBridge`: extension target, entitlements, URL type, `BSVBridge*` Info.plist
  keys, bundled extension JS, Podfile wiring. Everything is derived from `ios.bundleIdentifier`.
- Stand-in BRC-185 page client (`src/testing/pageClient`) and the Simulator demo page (`demo/`).

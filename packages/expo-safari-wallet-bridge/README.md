# @bsv/expo-safari-wallet-bridge

Lets a page in iOS Safari use an Expo app as its BRC-100 wallet (BRC-185 window provider). One
Safari Web Extension, one sealed App Group queue, one Expo native module, the app runtime, and a
config plugin. The BRC-185 engine itself (consent, dispatcher, inbox processor, Connect sheet) is
`@bsv/expo-wallet-toolbox`'s `core/bridge`; this package is the iOS Safari transport.

Design: `docs/superpowers/specs/2026-10-28-browser-bridge-ios-kit-design.md`. BRC-185 profile choices:
`CONFORMANCE.md`. Spike results, build facts and owner device gates: `SPIKES.md`.

## What the host does

1. **Plugin entry** in `app.config.js` (nothing else in that file changes):

   ```js
   ;[
     '@bsv/expo-safari-wallet-bridge',
     {
       appleTeamId: 'SV8SWTHA2H', // or ios.appleTeamId
       extensionName: 'Bitcoin SV Wallet', // shown in Safari's extension list
       profile: 'release' // 'development' also allows http://localhost origins
     }
   ]
   ```

   `ios.bundleIdentifier` (`B`) must be set. Everything else is derived from it: URL scheme `B`,
   extension bundle id `B.safari`, App Group `group.B`, bridge keychain group
   `$(AppIdentifierPrefix)B.bridge` (the host's own `$(AppIdentifierPrefix)B` is listed first, so
   existing keychain items stay readable). `overrides` can replace derived values and is checked
   against the same constraints. The prebuild fails with a named error for a missing team id, bundle
   id or Podfile anchor.

2. **Register** `B.safari` and the App Group capability for both identifiers with your signing
   (EAS picks the extension up through apple-targets' `extra.eas.build.experimental.ios.appExtensions`).
3. **Route the doorbell**: `redirectSystemPath` in `+native-intent` returns `/` for `B://bridge…`.
4. **Mount** `BrowserBridgeProvider` (toolbox), then inside the wallet context
   `<SafariBridgeHost native={getBsvBridgeNative()} getIdentityKey={…} />` (iOS only) next to the
   permission sheet. Logout and Delete Wallet need no extra call: the host's teardown hook resets the
   bridge, synchronously.
5. **Place `SafariSetupGuide`** in Settings and on the onboarding surface. The app cannot detect
   whether the extension is switched on or has website access, so the guide is the only way the user
   learns that (Settings > Apps > Safari > Extensions, then Always Allow).
6. **Development builds** that should accept the demo page's `http://localhost` origin also set
   `configureToolbox({ browserBridge: { allowLocalhostHttp: __DEV__ } })`; the toolbox ignores the
   flag outside `__DEV__`. Without it the app answers `PROTOCOL_ERROR` / "Origin refused" for an origin
   the extension attested.
7. **Tests**: pin the resolved entitlements (exact App Group and keychain groups for the app and the
   extension) and the App Group's contents; both read the config after plugins run.

`SafariBridgeHost` props: `native: BsvBridgeNative` (`getBsvBridgeNative()`), `getIdentityKey: () =>
Promise<string | null>` (the wallet's identity key, `null` until ready).

## What the app cannot detect

Whether the extension is enabled, whether it has access to a given site, whether the user cancelled
Safari's "Open in app?" prompt, and which Safari profile a page is in. The page sees an announcement
only when all of that is in place; a page that gets none cannot tell why.

## Layout

`extension/` (JS, bundled by the plugin into the target's `Resources/`), `swift/BsvBridgeQueue`
(pod + SwiftPM, XCTest), `ios/` (Expo module), `plugin/`, `shared/`, `src/` (JS adapter, host,
UI), `demo/` (Simulator demo page, never shipped).

## Developing

`scripts/link-kit.sh <host-dir>` packs this package and the toolbox with a throwaway version and
unpacks them into the host's `node_modules` (it never runs `npm install` there). Tests: `npx jest`
from the repo root; `swift test --package-path swift/BsvBridgeQueue`. Demo page:
`node demo/serve.mjs` on port 3000 (`?csp=strict` adds a strict Content-Security-Policy).

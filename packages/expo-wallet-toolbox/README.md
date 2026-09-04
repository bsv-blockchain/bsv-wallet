# @bsv/expo-wallet-toolbox

Wallet screens and P2P local-payment backend for Expo/React Native apps —
storage, local WiFi/Bluetooth payment transport, offline queueing, backup,
hardware-key vault, and the 11 wallet screens, extracted from BSV Wallet so
a second app (e.g. BSV Browser) can install the same wallet instead of
re-implementing or forking it.

Two subpath exports, one npm package:

- `@bsv/expo-wallet-toolbox` (root/`core`) — headless: context providers,
  storage, services, localpay/peerpay/offline/backup/vault logic. No
  screen components.
- `@bsv/expo-wallet-toolbox/ui` — the 11 screen components and their UI
  dependencies (`components/wallet`, `components/pay`, `components/vault`,
  `components/ui`, `components/security`, `QRScanner`). Imports `core`.

This package ships raw TypeScript (not precompiled JS) — Metro and your
app's own TypeScript config transpile it like any other workspace source.

## Install

```bash
npm install @bsv/expo-wallet-toolbox @bsv/react-native-localpay-transport react-native-engine-native react-native-secp-native react-native-nitro-modules
```

`react-native-yubikey` is optional — the vault subsystem
(`services/vault/driver.ts`) detects its absence at runtime and disables
vault/hardware-key features gracefully; install it only if you want
YubiKey PIV custody support.

**The command above is not the whole story.** `core`/`ui` import roughly
four dozen packages beyond the four listed — Expo native modules
(camera, clipboard, secure-store, haptics, ...), state/i18n libraries
(mobx, i18next), and BSV SDK packages. The **[Peer dependencies](#peer-dependencies)**
table below is the full, audited list — `package.json`'s `peerDependencies`
now declares all 49 entries (46 directly imported + 3 required only for
native linking — see the Nitro row below), so a plain `npm install
@bsv/expo-wallet-toolbox` surfaces the rest as peer-dependency warnings
instead of silently missing them.

## Peer dependencies

Versions shown are what this repo currently builds against (root
`package.json`) — known-good, not hard requirements; align to your own
Expo SDK line.

### React / Expo core (required)

| Package | Version |
| --- | --- |
| `react` | 19.2.0 |
| `react-native` | 0.83.6 |
| `expo-router` | ~55.0.16 |

### BSV SDK & protocol libraries (required)

| Package | Version |
| --- | --- |
| `@bsv/sdk` | ^2.4.1 |
| `@bsv/wallet-toolbox-mobile` | ^2.4.3 |
| `@bsv/btms-permission-module` | ^1.1.0 |
| `@bsv/air-gap` | ^0.1.1 |
| `@bsv/backup-cache-client` | ^0.1.0 |
| `@bsv/message-box-client` | ^2.2.1 |
| `@bsv/templates` | ^1.10.0 |
| `@noble/curves` | ^2.3.0 |
| `qrcode` | ^1.5.4 |

### Expo native modules (required — each needs its own autolinking/config)

| Package | Version |
| --- | --- |
| `expo-sqlite` | ~55.0.16 |
| `expo-secure-store` | ~55.0.14 |
| `expo-camera` | ~55.0.19 |
| `expo-audio` | ~55.0.16 |
| `expo-clipboard` | ~55.0.13 |
| `expo-crypto` | ~55.0.15 |
| `expo-device` | ~55.0.17 |
| `expo-document-picker` | ~55.0.13 |
| `expo-file-system` | ~55.0.20 |
| `expo-haptics` | ~55.0.14 |
| `expo-local-authentication` | ~55.0.14 |
| `expo-localization` | ~55.0.15 |
| `expo-print` | ~55.0.15 |
| `expo-sharing` | ~55.0.19 |
| `expo-status-bar` | ~55.0.6 |
| `expo-blur` | ~55.0.14 |
| `@expo/vector-icons` | ^15.0.3 |

### React Native native modules (required)

| Package | Version |
| --- | --- |
| `@react-native-async-storage/async-storage` | 2.2.0 |
| `@react-native-clipboard/clipboard` | ^1.16.2 |
| `@react-native-community/netinfo` | 11.5.2 |
| `react-native-gesture-handler` | ~2.30.0 |
| `react-native-localize` | ^3.4.1 |
| `react-native-qrcode-svg` | ^6.3.15 |
| `react-native-reanimated` | 4.2.1 |
| `react-native-safe-area-context` | ~5.6.0 |
| `react-native-svg` | 15.15.3 |
| `react-native-sse` | ^1.2.1 |

### State & i18n (required)

| Package | Version |
| --- | --- |
| `mobx` | ^6.13.7 |
| `mobx-react-lite` | ^4.1.0 |
| `i18next` | ^25.2.1 |
| `react-i18next` | ^15.5.3 |
| `date-fns` | ^4.1.0 |

### Nitro native modules — this repo's own packages (required)

| Package | Notes |
| --- | --- |
| `react-native-nitro-modules` | ^0.35.2. Nitro codegen runtime the three below build on. |
| `@bsv/react-native-localpay-transport` | Local WiFi/Bluetooth/BLE P2P payment transport. Published independently — see `packages/react-native-localpay-transport`. |
| `react-native-engine-native` | Native wallet-toolbox engine bindings. |
| `react-native-secp-native` | Native secp256k1 signing. |

`react-native-engine-native` and `react-native-secp-native` ship as sibling
`packages/` in this repo and are not yet published to npm independently —
when they are, pin to their published version. Each of the three declares
`react-native` and `react-native-nitro-modules` as its own peer
dependencies.

### Optional

| Package | Notes |
| --- | --- |
| `react-native-yubikey` | Vault/hardware-key support. Absence is detected at runtime and vault features degrade gracefully. |

## Usage

```tsx
import {
  WalletContextProvider,
  ThemeProvider,
  LocalStorageProvider,
  LanguageProvider,
  UserContextProvider,
  ExchangeRateContextProvider,
  WalletConnectionProvider,
  VaultProvider
} from '@bsv/expo-wallet-toolbox'
import {
  PermissionSheet,
  VaultCeremonySheet,
  AlertHost,
  ToastHost,
  showToast,
  ErrorBoundary
} from '@bsv/expo-wallet-toolbox/ui'
```

### Provider setup

Compose the providers in this order (outer→inner) around your
`expo-router` `<Stack>` — this is the exact nesting `bsv-wallet` itself
uses in `app/_layout.tsx`:

```tsx
<LanguageProvider>
  <LocalStorageProvider>
    <UserContextProvider nativeHandlers={nativeHandlers} appVersion={appVersion} appName="Your App">
      <ExchangeRateContextProvider>
        <WalletContextProvider onToast={showToast}>
          <ThemeProvider>
            <WalletConnectionProvider walletName="Your App">
              <VaultProvider onToast={showToast}>
                {/* mount once, anywhere inside VaultProvider: */}
                <PermissionSheet />
                <VaultCeremonySheet />
                <AlertHost />

                <Stack />

                <ToastHost />
              </VaultProvider>
            </WalletConnectionProvider>
          </ThemeProvider>
        </WalletContextProvider>
      </ExchangeRateContextProvider>
    </UserContextProvider>
  </LocalStorageProvider>
</LanguageProvider>
```

Notes on the non-obvious props (all technically optional with defaults,
but you almost always want to set them):

- `UserContextProvider` — `appVersion`/`appName` default to `'unknown'`/`'App'`;
  pass your own `package.json` version and app name. `nativeHandlers` is an
  optional `NativeHandlers` object (`isFocused`, `onFocusRequested`,
  `onFocusRelinquished`, `onDownloadFile`) — omit it to use no-op defaults.
- `WalletContextProvider` and `VaultProvider` — `onToast` is an optional
  callback of shape `(message: string, opts?: { type?: 'success' | 'error' | 'info' | ... }) => void`.
  Wire it to `showToast` from `@bsv/expo-wallet-toolbox/ui` (or your own
  toast) so background events (offline-payment internalization, vault
  ceremony results) surface to the user. Neither context imports a UI
  component directly — that's a deliberate `core`/`ui` boundary.
- `WalletConnectionProvider` — `walletName` defaults to `'App'`; set it to
  your app's display name (shown to QR-paired desktop sessions).

## Screens

`@bsv/expo-wallet-toolbox/ui` exports 11 screen components. Create thin
`app/*.tsx` files in your `expo-router` app that just re-export them —
this is the pattern `bsv-wallet`'s own route files use:

```tsx
// app/index.tsx
export { WalletHomeScreen as default } from '@bsv/expo-wallet-toolbox/ui'
```

| Screen | Source route in this repo |
| --- | --- |
| `WalletHomeScreen` | `app/index.tsx` |
| `PayScreen` | `app/pay.tsx` |
| `SettingsScreen` | `app/settings.tsx` |
| `WalletConfigScreen` | `app/wallet-config.tsx` |
| `VaultScreen` | `app/vault.tsx` |
| `VaultRecoverScreen` | `app/vault-recover.tsx` |
| `VaultTransferScreen` | `app/vault-transfer.tsx` |
| `ConnectionsScreen` | `app/connections.tsx` |
| `PairScreen` | `app/pair.tsx` |
| `TrustScreen` | `app/trust.tsx` |
| `LogsScreen` | `app/logs.tsx` |

> **Note:** `ConnectionsScreen`'s OS-level deep-link pairing (a desktop
> session opening the app directly) currently assumes the `bsv-wallet://`
> URL scheme is hardcoded into its parsing and link-building. A consuming
> app that registers a different scheme would need that deep-link path
> updated to match. In-app QR-code scanning of a pairing code is unaffected
> and works regardless of the consumer's own scheme.

Each route file is the one-line `export { XScreen as default } from '@bsv/expo-wallet-toolbox/ui'`
pattern shown above — no other wiring needed per screen; navigation
between them uses `expo-router`'s file-based routes, so your route file
names determine the paths (`/pay`, `/settings`, etc.), not the exported
screen names.

## Required app.json configuration

Expo config (Info.plist keys, Android permissions, config plugins,
`expo-build-properties`) can't be installed by an npm package — it stays
declared in your own app's `app.json`. This is the exact config
`bsv-wallet`'s `app.json` and `plugins/` currently carry:

### iOS `infoPlist`

```json
{
  "NSCameraUsageDescription": "This app needs camera access to scan QR codes.",
  "NSPhotoLibraryAddUsageDescription": "This app needs permission to save images to your photo library.",
  "NSMicrophoneUsageDescription": "This app needs microphone access for video recording features.",
  "NSFaceIDUsageDescription": "This app uses Face ID/Touch ID to securely authenticate you and protect your wallet.",
  "NSLocationWhenInUseUsageDescription": "...enable features like discovering nearby devices/services...",
  "NSBonjourServices": ["_bsvpay._tcp"],
  "NSLocalNetworkUsageDescription": "...local network to send and receive payments directly between nearby devices.",
  "NFCReaderUsageDescription": "...NFC to unlock your vault with your YubiKey...",
  "com.apple.developer.nfc.readersession.iso7816.select-identifiers": [
    "A000000308",
    "A000000308000010000100",
    "A0000006472F0001",
    "A0000005272101",
    "A000000527471117",
    "A0000005272001"
  ]
}
```

`NFCReaderUsageDescription` and the AID list are only needed if you ship
vault/hardware-key support (i.e. installed `react-native-yubikey`); omit
both if you didn't.

Also add `CFBundleURLTypes` for **your own** deep-link scheme(s) — do not
reuse `bsv-wallet://` or `peerpay://`, those are this repo's own app
identity, not the package's:

```json
"CFBundleURLTypes": [
  { "CFBundleURLName": "com.yourcompany.yourapp", "CFBundleURLSchemes": ["yourapp"] }
]
```

### iOS entitlement

`com.apple.developer.nfc.readersession.formats: ["TAG"]` — needed only
alongside the NFC/vault config above. Add it via a config plugin
equivalent to this repo's `plugins/withNfcReaderEntitlement.js`, which
wraps `@expo/config-plugins`' `withEntitlementsPlist`:

```js
const { withEntitlementsPlist } = require('@expo/config-plugins')

module.exports = (config) =>
  withEntitlementsPlist(config, (mod) => {
    mod.modResults['com.apple.developer.nfc.readersession.formats'] = ['TAG']
    return mod
  })
```

This is a real, provisionable iOS capability ("NFC Tag Reading") — your
App ID needs it enabled and the provisioning profile regenerated, or
codesign/App Store submission will reject it.

### Android `permissions`

```json
[
  "android.permission.INTERNET",
  "android.permission.SYSTEM_ALERT_WINDOW",
  "android.permission.ACCESS_COARSE_LOCATION",
  "android.permission.ACCESS_FINE_LOCATION",
  "android.permission.CAMERA",
  "android.permission.RECORD_AUDIO",
  "android.permission.MODIFY_AUDIO_SETTINGS",
  "android.permission.BLUETOOTH_ADVERTISE",
  "android.permission.BLUETOOTH_CONNECT",
  "android.permission.BLUETOOTH_SCAN",
  "android.permission.NEARBY_WIFI_DEVICES",
  "android.permission.ACCESS_WIFI_STATE",
  "android.permission.CHANGE_WIFI_STATE"
]
```

### Android intent filter

Register **your own** deep-link scheme (VIEW/BROWSABLE/DEFAULT) — the
local-payment QR/nearby flows deep-link back into your app, not this
repo's:

```json
{
  "action": "VIEW",
  "data": [{ "scheme": "yourapp" }],
  "category": ["BROWSABLE", "DEFAULT"]
}
```

### `expo-build-properties`

```json
{
  "ios": {
    "useFrameworks": "static",
    "useModularHeaders": true
  }
}
```

Required for the Nitro/xcframework native modules
(`@bsv/react-native-localpay-transport`, `react-native-engine-native`,
`react-native-secp-native`, `react-native-yubikey`) to build on iOS.

### `metro.config.js`

The package's crypto code expects `node:crypto` to resolve to
`react-native-quick-crypto`, and `node:buffer`/`node:process` to resolve
to an empty stub (not the real Node polyfills) — mirror this repo's
`metro.config.js`:

```js
const { getDefaultConfig } = require('expo/metro-config')
const path = require('path')

const config = getDefaultConfig(__dirname)

config.resolver.extraNodeModules = {
  crypto: require.resolve('react-native-quick-crypto'),
  stream: require.resolve('stream-browserify'),
  buffer: require.resolve('buffer'),
  ...config.resolver.extraNodeModules
}

const emptyShim = path.resolve(__dirname, 'metro-shims/empty.js') // module.exports = {}
const quickCryptoMain = require.resolve('react-native-quick-crypto')

const upstream = config.resolver.resolveRequest
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === 'node:crypto') {
    return { type: 'sourceFile', filePath: quickCryptoMain }
  }
  if (moduleName === 'node:buffer' || moduleName === 'node:process') {
    return { type: 'sourceFile', filePath: emptyShim }
  }
  if (typeof upstream === 'function') return upstream(context, moduleName, platform)
  return context.resolveRequest(context, moduleName, platform)
}

module.exports = config
```

`react-native-quick-crypto`, `stream-browserify`, and `buffer` must be
installed in your app for the `extraNodeModules` lines above to resolve;
add them alongside the peer dependencies list.

## Jest configuration

If your app runs Jest against code that imports this package, two things
are required — both hard-won during this package's extraction:

1. **`transformIgnorePatterns`** must include `@bsv/expo-wallet-toolbox`,
   because this package ships raw TypeScript, not precompiled JS — Jest's
   default `node_modules` exclusion will otherwise fail to transform it.
   This repo's own (proven-working) pattern, verbatim from `package.json`:

   ```
   transformIgnorePatterns: [
     "node_modules/(?!((jest-)?react-native|@react-native(-community)?|expo(nent)?|@expo(nent)?/.*|@expo-google-fonts/.*|react-navigation|@react-navigation/.*|@sentry/react-native|native-base|react-native-svg|react-native-reanimated|react-native-gesture-handler|react-native-worklets|expo-modules-core|@noble/secp256k1|@noble/curves|@noble/hashes|@bsv/backup-cache-client|@bsv/auth|@bsv/expo-wallet-toolbox)/)",
     "/node_modules/react-native-reanimated/plugin/"
   ]
   ```

   The second array entry excludes `react-native-reanimated`'s own babel
   plugin directory from transformation — unrelated to this package
   specifically, but part of the same reference config and needed
   because `react-native-reanimated` is a required peer dependency.
   You don't need every name in that big alternation — most come from
   the `jest-expo` preset's own defaults or other-app concerns — but
   `@bsv/expo-wallet-toolbox` itself and `@bsv/backup-cache-client` (see
   below) must be in whatever pattern you end up with.

2. **Native-module and ESM-only-package mocks** — anything the package
   touches that has no pure-JS Jest-safe implementation, or that ships
   as ESM-only with no `require` export condition, needs a
   `moduleNameMapper` entry. This repo's full set, verbatim:

   ```js
   moduleNameMapper: {
     '^@bsv/backup-cache-client$':
       '<rootDir>/node_modules/@bsv/backup-cache-client/dist/index.js',
     '^react-native-reanimated$': '<rootDir>/__tests__/__mocks__/reanimated.js',
     '^react-native-worklets$':
       '<rootDir>/node_modules/react-native-worklets/lib/module/mock.js',
     '^expo-audio$': '<rootDir>/__tests__/__mocks__/expo-audio.js',
     '^expo-sqlite$': '<rootDir>/__tests__/__mocks__/expo-sqlite.js',
     '^@react-native-async-storage/async-storage$':
       '<rootDir>/node_modules/@react-native-async-storage/async-storage/jest/async-storage-mock.js'
   }
   ```

   `@bsv/backup-cache-client` is the one entry every consumer needs even
   before writing a single test that touches wallet behavior:
   `core/backup/client.ts` statically imports it, and it's re-exported
   through the core barrel (`core/index.ts`), so any test that imports
   *anything* from `@bsv/expo-wallet-toolbox` pulls it in. The package
   is `"type": "module"` (ESM-only, no CJS `require` export condition),
   which Jest's default CJS-based resolver can't load — hence the
   explicit redirect straight to its `dist/index.js` build. This bites
   on the very first `jest` run in a consumer app, unlike the other
   entries below, which only bite once a test actually exercises that
   native API.

   `expo-sqlite`/`expo-audio` need hand-written mocks (see this repo's
   `__tests__/__mocks__/` for working examples) since they wrap native
   modules with no official Jest mock; `async-storage` and
   `react-native-worklets` ship their own mock you can point to directly;
   `react-native-reanimated`'s official `jest.setup.js` mock doesn't cover
   every API this package uses, hence the local override.

   This repo uses the `jest-expo` preset as its base
   (`"preset": "jest-expo"` in `package.json`), which already covers most
   other Expo native modules — start from that preset before adding the
   overrides above.

## Publishing notes

This package deliberately ships **no `exports` map** in `package.json`.
Resolution relies on plain `main`/`types` (root → `core/index.ts`) plus
Node/Metro's default directory-index resolution for the `/ui` subpath
(`@bsv/expo-wallet-toolbox/ui` → `ui/index.ts`).

This is a conscious choice, not an oversight: roughly 50 files under `ui/`
import shared primitives (`useTheme`, `useWallet`, `spacing`, `haptics`,
etc.) from the bare `@bsv/expo-wallet-toolbox` specifier — i.e. the
package imports itself by name, relying on the workspace's self-referencing
`node_modules/@bsv/expo-wallet-toolbox` symlink (or, once published, plain
`node_modules` directory-walk resolution — the installed copy sits inside a
consumer's `node_modules` and is found there like any other dependency, not
through Node's dedicated package-self-reference feature). That feature only
kicks in when an `exports` map is present *and* includes a `"."` entry — adding an
`exports` map without one would silently break every one of those ~50
imports at publish time, and adding one with only `"."` (no `"./ui"` entry)
would break every consumer's `/ui` subpath import instead.

If a future change adds an `exports` map, it must include at minimum:

```json
"exports": {
  ".": "./core/index.ts",
  "./ui": "./ui/index.ts"
}
```

and must be re-verified against the full Jest suite, the
`packageResolution.test.ts` canary (`CANARY_UI`/`CANARY_CORE` barrel-import
check), and a real `npx expo export` Metro bundle — the self-reference
resolution path is exactly what both currently exercise successfully
without an `exports` map, and Metro's own `exports` support has its own
quirks worth re-testing explicitly rather than assuming Node's behavior
carries over.

`files` is `["core", "ui", "assets"]`; npm always includes `package.json`
and `README.md` regardless of `files`. `__tests__/` and `tsconfig.json`
live at the package root, outside every `files` entry, so they are
excluded from the published tarball — confirmed with `npm pack --dry-run`.

# Extract wallet functionality into `@bsv/expo-wallet-toolbox`

## Context

`bsv-wallet` was forked from the BSV Browser app (fork point
`9cdb1b4cd906f27e75bf33c9cb5a4575a1712375`) by stripping browser chrome
(webview, address bar, tabs, bookmarks, permission UI) and keeping the
wallet. The two apps share ancestry and largely the same stack
(Expo/React Native). Browser needs the wallet's P2P payment
functionality (local WiFi/Bluetooth transport, send/receive, settings,
vault, backup) back, and future apps may want the same. Rather than
re-diverge or hand-copy code, extract the wallet into a standalone,
publishable package other Expo/RN apps can install.

Three native modules already exist as separate `packages/` in this
repo (`react-native-localpay-transport`, `react-native-engine-native`,
`react-native-secp-native`) and their `package.json` descriptions
already say "for BSV Browser" — they were built anticipating this
extraction.

## Goal

Publish `@bsv/expo-wallet-toolbox` to npm: an installable package
giving any Expo/RN app the wallet screens (home, pay, settings,
wallet-config, vault, connections, pair, trust, logs), the P2P
local-payment backend (WiFi/Bluetooth transport, offline queueing,
backup, header sync), and the storage layer — with `bsv-wallet` itself
becoming the first consumer (dogfooding).

## Package boundary

One package, two subpath exports, npm workspace under `packages/`:

```
packages/expo-wallet-toolbox/
  package.json          # name: @bsv/expo-wallet-toolbox
  src/
    core/                # headless: context, storage, services, utils
    ui/                  # screens + components (imports core)
```

- `@bsv/expo-wallet-toolbox/core` — no RN-UI-specific screen code.
  Context providers (`WalletContext`, `LocalStorageProvider`,
  `ExchangeRateContext`, `UserContext`, `VaultContext`,
  `WalletConnectionContext`, `ThemeContext`, i18n), `storage/*`,
  `services/*`, and `utils/*` subsystems (localpay, peerpay, pay
  rails, headers, offline, backup, monitor, net, mnemonicWallet,
  walletDbRegistry, walletMonitor).
- `@bsv/expo-wallet-toolbox/ui` — screen components (not expo-router
  files themselves) plus their component dependencies
  (`components/wallet`, `components/pay`, `components/vault`,
  `components/ui`, `components/localpay`). Consumer apps create thin
  `app/*.tsx` expo-router files that just re-export these.

Rejected: splitting into two separate packages (`-core` / `-ui`) — no
known consumer needs core without UI today; can split later if one
appears. Rejected: pulling Browser repo into this one as a monorepo —
explicitly ruled out in favor of public npm distribution.

Native modules stay as separate packages, declared as peer
dependencies of `@bsv/expo-wallet-toolbox`:
`react-native-localpay-transport`, `react-native-engine-native`,
`react-native-secp-native` (required), `react-native-yubikey`
(optional — vault subsystem already degrades gracefully without it via
`services/vault/driver.ts`'s runtime capability check).

## What moves where

**Core:**
- `storage/` (`StorageExpoSQLite`, `LocalStorageAdapter`, `methods/*`,
  `schema/*`) — fix the two screens (`app/index.tsx`, `app/pay.tsx`)
  that currently import `storage/methods/offlineActions` and
  `walletBalanceSql` directly, bypassing the barrel; route through the
  package's public API instead.
- `services/` (`walletServiceConfig`, `arcadeBroadcastProvider`,
  `exchangeRate`, `capWalletArgs`, `secrets/*`, `vault/*`).
- `utils/localpay/*`, `utils/peerpay/*`, `utils/pay/*`,
  `utils/headers/*`, `utils/offline/*`, `utils/backup/*`,
  `utils/net/online.ts`, `utils/monitor/*`, `utils/mnemonicWallet.ts`,
  `utils/walletDbRegistry.ts`, `utils/walletMonitor.ts`.
- `context/WalletContext.tsx`, `context/LocalStorageProvider.tsx`,
  `context/ExchangeRateContext.tsx`, `context/UserContext.tsx`,
  `context/VaultContext.tsx`, `context/WalletConnectionContext.tsx`,
  `context/theme/*`, `context/i18n/*`.
- Wallet-relevant subset of `shared/constants.ts`
  (`DEFAULT_AUTO_APPROVE_THRESHOLD`, `AUTO_APPROVE_COOLDOWN_MS`,
  `AUTO_APPROVE_STORAGE_KEY`, `DEFAULT_ARC_URLS`, `KNOWN_ARC_URLS`) and
  `context/config.tsx` (org/network endpoint defaults, already
  env-overridable).

**UI:**
- Screen logic extracted as plain components from `app/index.tsx`
  (→ `WalletHomeScreen`), `app/pay.tsx` (→ `PayScreen`),
  `app/settings.tsx` (→ `SettingsScreen`), `app/wallet-config.tsx`
  (→ `WalletConfigScreen`), `app/vault.tsx` /
  `app/vault-recover.tsx` / `app/vault-transfer.tsx` (→
  `VaultScreen`/`VaultRecoverScreen`/`VaultTransferScreen`),
  `app/connections.tsx` (→ `ConnectionsScreen`), `app/pair.tsx`
  (→ `PairScreen`), `app/trust.tsx` (→ `TrustScreen`), `app/logs.tsx`
  (→ `LogsScreen`).
- `components/wallet/*`, `components/pay/*`, `components/vault/*`,
  `components/ui/*`, `components/localpay/*`, `components/security/*`.
- Redirect-only routes (`app/payments.tsx`, `app/legacy-payments.tsx`,
  `app/local-payments.tsx`, `app/transactions.tsx`) stay as thin
  app-level files, not package code — they're routing shims, not
  wallet functionality.

**Stays in `bsv-wallet` (not extracted):**
- `app/_layout.tsx` (provider composition — becomes thin, imports from
  package), `app/*.tsx` route files (thin wrappers around package
  screens), `app.json`, `plugins/`, `ios/`, `android/`, `eas.json` —
  all inherently per-app config.
- Dead browser-only exports in `shared/constants.ts`
  (`kNEW_TAB_URL`, `DEFAULT_HOMEPAGE_URL`, `SEARCH_ENGINES`,
  `DEFAULT_SEARCH_ENGINE_ID`, `ADDRESS_BAR_HEIGHT`,
  `safeBottomInset`/`ANDROID_MIN_BOTTOM_INSET`) — deleted, unused in
  this repo since the browser-chrome strip at fork time.

## Migration phases

1. **Workspace scaffold** — add `workspaces` to root `package.json`,
   create `packages/expo-wallet-toolbox/{core,ui}` with their own
   `package.json`/`tsconfig.json`. No code moves yet.
2. **Core extraction** — move core modules listed above; root app
   imports from the workspace package via `@bsv/expo-wallet-toolbox/core`.
   Fix the two direct storage-method import call sites.
3. **UI extraction** — move screen components + their component deps;
   root app's `app/*.tsx` become thin wrappers exporting package
   screens.
4. **Constants cleanup** — split `shared/constants.ts` per above;
   delete the dead browser-only exports.
5. **Dogfood + verify** — full test suite (`__tests__/*`) green against
   the workspace-linked package; manual smoke test of localpay
   send/receive, backup, vault flows in the running app.
6. **Publish** — version and publish `@bsv/expo-wallet-toolbox` plus
   any not-yet-public native Nitro packages to npm.

## Native config documentation

Expo config (Info.plist keys, Android permissions, config plugins,
`expo-build-properties` settings) cannot be installed by an npm
package — it stays declared per consuming app. The package ships a
README section listing exactly what a consumer's `app.json` needs,
derived from this repo's current config:

- iOS `infoPlist`: `NSCameraUsageDescription`,
  `NSPhotoLibraryAddUsageDescription`, `NSMicrophoneUsageDescription`,
  `NSFaceIDUsageDescription`, `NSLocationWhenInUseUsageDescription`,
  `NSBonjourServices: ["_bsvpay._tcp"]`, `NSLocalNetworkUsageDescription`,
  `NFCReaderUsageDescription` +
  `com.apple.developer.nfc.readersession.iso7816.select-identifiers`.
- iOS entitlement: `com.apple.developer.nfc.readersession.formats: ["TAG"]`
  (via a config plugin equivalent to `plugins/withNfcReaderEntitlement.js`).
- iOS `CFBundleURLTypes` for the consumer's own deep-link scheme (this
  repo's `bsv-wallet://` and `peerpay://` are app-specific — a
  consumer app registers its own).
- Android `permissions`: `INTERNET`, `SYSTEM_ALERT_WINDOW`,
  `ACCESS_COARSE_LOCATION`, `ACCESS_FINE_LOCATION`, `CAMERA`,
  `RECORD_AUDIO`, `MODIFY_AUDIO_SETTINGS`, `BLUETOOTH_ADVERTISE`,
  `BLUETOOTH_CONNECT`, `BLUETOOTH_SCAN`, `NEARBY_WIFI_DEVICES`,
  `ACCESS_WIFI_STATE`, `CHANGE_WIFI_STATE`.
- Android intent filter for the consumer's own payment deep-link
  scheme.
- `expo-build-properties`: `ios.useFrameworks: static`,
  `useModularHeaders: true` (required for the Nitro/xcframework native
  modules).
- `metro.config.js`: `node:crypto` → `react-native-quick-crypto`,
  `node:buffer`/`node:process` shims.

## Deferred (not in this extraction)

- Splitting `core`/`ui` into separate packages — revisit if a headless
  consumer appears.
- Un-bundling the 5761-line i18n resource file into per-package
  translation bundles that a consumer app can merge/extend at
  runtime — ship as-is for v1, note as follow-up.
- Deep-link scheme parameterization (`bsv-wallet://`, `peerpay://` are
  hardcoded in a handful of places per the exploration map) — v1
  extraction keeps these as `bsv-wallet`'s own app-level config; a
  second consumer app registering its own scheme is a `core`
  config-option addition to make later, not blocking today.

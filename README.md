# BSV Wallet

A self-custodial BSV payments wallet for iOS and Android. Built with React Native + Expo, it holds keys on-device (BIP-39 mnemonic) and moves money over MessageBox, a nearby peer-to-peer link, or plain P2PKH addresses -- no server ever sees your funds.

**Key capabilities:**

- Self-custodial BSV wallet (BIP-39 mnemonic, derived at `m/0'/0'`) with local SQLite storage
- Peer-to-peer payments via MessageBox (PeerPay) with identity resolution
- Local Payments -- nearby peer-to-peer transfers over AWDL (iOS) / Nearby Connections (Android), no internet required
- Paying to, and getting paid at, traditional P2PKH addresses
- Trust and identity management (BRC-68 certifiers)
- Shamir's Secret Sharing backup -- split your key into printable/scannable QR shares
- Database import/export for full wallet backup and migration
- Multi-network support (mainnet, testnet, teratest)
- Background transaction monitoring via ARC SSE (Server-Sent Events)
- Hardware-backed Vault -- a YubiKey-secured spending key (NFC on iOS, USB on Android)
- Pairing with external wallets/clients over `bsv-wallet://pair` deep links, and payment handles via `peerpay:` links
- 12 languages supported

## Table of Contents

- [Prerequisites](#prerequisites)
- [Getting Started](#getting-started)
- [Available Scripts](#available-scripts)
- [Project Structure](#project-structure)
- [Architecture](#architecture)
- [Environment Variables](#environment-variables)
- [Code Style](#code-style)
- [Contributing](#contributing)
- [Building for Devices](#building-for-devices)
- [Native Rebuild Requirements](#native-rebuild-requirements)
- [Publishing Your Own Version](#publishing-your-own-version)
- [Supported Languages](#supported-languages)
- [License](#license)

## Prerequisites

| Tool               | Notes                                                     |
| ------------------ | --------------------------------------------------------- |
| **Node.js**        | LTS recommended (the project has no `engines` constraint) |
| **npm**            | Ships with Node                                           |
| **Expo CLI**       | Installed automatically via `npx expo`                    |
| **EAS CLI**        | `npm i -g eas-cli` -- needed for device builds            |
| **Xcode**          | Required for iOS simulator / device builds (macOS only)   |
| **Android Studio** | Required for Android emulator / device builds             |
| **Watchman**       | Recommended on macOS (`brew install watchman`)            |

## Getting Started

```bash
# 1. Clone the repo
git clone https://github.com/bsv-blockchain/bsv-wallet.git
cd bsv-wallet

# 2. Install dependencies
npm install

# 3. (Optional) Create a .env.local for API keys -- see "Environment Variables" below
#    The app works without one; defaults are defined in context/config.tsx

# 4. Start the dev server
npm start                    # opens Expo dev-client menu
```

On first launch the app walks you through provisioning a wallet:

1. Tap **Create New Wallet** or **Import Existing Wallet**
2. If creating: the app generates a 12-word BIP-39 mnemonic -- back it up securely
3. If importing: paste an existing mnemonic phrase, a 64-character hex private key, or scan Shamir backup shares via QR code

There is no separate browsing mode -- the app opens straight into the wallet (balance, Pay / Get paid / Vault, and Activity).

> **Note:** The app uses a **development build** (Expo dev-client), not Expo Go.
> You must create a dev build first -- see [Building for Devices](#building-for-devices).

## Available Scripts

| Script                  | Description                                                        |
| ------------------------ | ------------------------------------------------------------------ |
| `npm start`              | Start the Expo dev server (`expo start --dev-client`)              |
| `npm run android`        | Start on a connected Android device / emulator                     |
| `npm run ios`            | Start on a connected iOS device / simulator                        |
| `npm run ios-run`        | Build (RN from source) + launch the iOS dev-client on the simulator |
| `npm run ios-dev-device` | Start the dev server via tunnel, for a physical device off USB     |
| `npm run web`            | Start the web version                                              |
| `npm run lint`           | Run ESLint                                                         |
| `npm run lint:fix`       | Run ESLint with auto-fix                                           |
| `npm run format`         | Format all files with Prettier                                     |
| `npm run format:check`   | Check formatting without writing                                   |
| `npm run fix`            | Run `format` then `lint:fix`                                       |
| `npm test`               | Run the Jest test suite                                            |
| `npm run clean`          | Delete generated caches and build artifacts                        |
| `npm run version`        | Bump version in package.json + app.json, commit and tag            |

### Device / Store Builds

| Script                                 | Description                                    |
| --------------------------------------- | ----------------------------------------------- |
| `npm run android-dev-build`             | Local EAS dev-client build (Android emulator)   |
| `npm run android-dev-physical`          | Local EAS dev-client build (physical Android)   |
| `npm run android-apk`                   | Local EAS preview APK build                     |
| `npm run android-build-for-play-store`  | Local EAS production AAB build                  |
| `npm run ios-dev-build`                 | Local EAS dev-client build (iOS simulator)      |
| `npm run ios-dev-physical`              | Local EAS dev-client build (physical iOS)       |
| `npm run ios-build-for-app-store`       | Local EAS production build (iOS)                |

## Project Structure

```
bsv-wallet/
├── app/                       # Expo Router screens (file-based routing)
│   ├── _layout.tsx            #   Root layout -- context providers + Stack navigator
│   ├── index.tsx               #   The Wallet screen -- balance, Pay/Get paid/Vault, Activity
│   ├── auth/                    #   Mnemonic create/import & Shamir-share recovery flows
│   ├── pay.tsx                   #   Pay / Get paid -- one screen over three rails
│   ├── vault.tsx                  #   Hardware-backed vault (YubiKey NFC/USB)
│   ├── vault-recover.tsx           #   Vault recovery flow
│   ├── vault-transfer.tsx           #   Vault deposit / withdraw
│   ├── trust.tsx                     #   Trust / certifier management
│   ├── connections.tsx                #   Paired external wallet connections
│   ├── pair.tsx                        #   Pairing handshake screen (bsv-wallet://pair)
│   ├── settings.tsx                     #   Settings screen
│   ├── wallet-config.tsx                 #   Network / ARC config picker
│   ├── logs.tsx                           #   In-app debug log viewer
│   └── payments.tsx, local-payments.tsx, legacy-payments.tsx, transactions.tsx
│                                            #   Retired routes -- redirect into /pay (old links still resolve)
├── components/
│   ├── pay/                   #   Pay/Get paid screen pieces (handle, nearby, address rails)
│   ├── vault/                  #   Enrollment wizard, ceremony sheet, passphrase field
│   ├── localpay/                #   Nearby-peer presence row
│   ├── security/                 #   Wallet lock notice
│   └── ui/                        #   Shared UI primitives (Sheet, GroupedList, ErrorBoundary, Toast, etc.)
├── context/                   # React context providers
│   ├── config.tsx              #   Default configuration constants
│   ├── i18n/                    #   Translations (12 languages)
│   ├── theme/                    #   Theme tokens and context
│   ├── WalletContext.tsx          #   Wallet build/auth, permissions, ARC SSE monitor
│   ├── WalletConnectionContext.tsx #   Paired-connection RPC channel (BRC-100-subset)
│   ├── VaultContext.tsx            #   Vault enrollment / ceremony state
│   ├── UserContext.tsx              #   User / auth state
│   ├── ExchangeRateContext.tsx       #   BSV/fiat exchange rates
│   └── LocalStorageProvider.tsx       #   Local key/value storage
├── hooks/                     # Custom React hooks (deep linking, vault balance, permission queue, etc.)
├── stores/                    # MobX store for paired connections (ConnectionStore)
├── storage/                   # SQLite-backed wallet storage adapter
│   ├── schema/                  #   Table creation SQL
│   └── methods/                   #   Query builders for actions, outputs & offline actions
├── services/                  # Vault, secrets and network-service configuration
│   ├── vault/                   #   YubiKey driver, ceremony state machine, key derivation
│   └── secrets/                   #   Encrypted local secret storage
├── shared/                    # Shared constants
├── utils/                     # Helpers -- crypto, payments, backup, offline queueing
│   ├── pay/rails/                #   handle.ts (MessageBox), nearby.ts, address.ts (P2PKH)
│   ├── localpay/                  #   Local Payments -- AWDL/Nearby Connections transport, session, codec
│   ├── backup/                     #   Encrypted remote wallet-backup client
│   ├── headers/                     #   Offline-first Chaintracks header store
│   ├── backupShares.ts                #   Shamir Secret Sharing for printable key recovery
│   ├── mnemonicWallet.ts                #   BIP-39/32 mnemonic key derivation
│   ├── importDatabases.ts                 #   Import wallet database from file
│   └── exportDatabases.ts                   #   Export wallet database for backup
├── types/                     # Global TypeScript declarations
├── scripts/                   # Shell / Node helper scripts (configure, version)
├── packages/                  # Local native modules (Nitro) -- localpay transport, YubiKey, native crypto engines
├── plugins/                   # Expo config plugins (NFC entitlement, Xcode config)
├── docs/                      # GitHub Pages marketing site + design docs
├── funding-app/               # Standalone Vite app for funding (builds into docs/)
├── __tests__/                 # Jest test suite
└── assets/                    # App icons, splash screens, favicons
```

## Architecture

The app boots through `index.js`, which installs `react-native-quick-crypto` as a global `crypto` polyfill before any BSV SDK code runs. Expo Router then takes over.

The root layout (`app/_layout.tsx`) nests context providers in this order:

```
GestureHandlerRootView
  └─ ErrorBoundary
       └─ LanguageProvider (i18n)
            └─ LocalStorageProvider
                 └─ UserContextProvider
                      └─ ExchangeRateContextProvider
                           └─ WalletContextProvider
                                └─ ThemeProvider
                                     └─ WalletConnectionProvider
                                          └─ VaultProvider
```

**State management** uses React Context for wallet, user, theme and UI state, plus a single MobX store (`stores/ConnectionStore.ts`) for the list of paired external connections.

**Wallet** is fully self-custodial. Keys are derived from a BIP-39 mnemonic at path `m/0'/0'` (hardened). The mnemonic is stored in `expo-secure-store`. The wallet is built using `@bsv/wallet-toolbox-mobile`'s `SimpleWalletManager`.

**Wallet storage** is backed by `expo-sqlite` with a schema defined in `storage/schema/createTables.ts`. See `storage/README.md` for detailed documentation.

**Payments** run over three rails behind a single `/pay` screen (`utils/pay/rails/`): a MessageBox/PeerPay handle (`handle.ts`), a nearby peer-to-peer transfer (`nearby.ts`), or a plain P2PKH address (`address.ts`).

**Local Payments** move a transaction to a phone nearby with no internet connection, using a native Nitro module (`packages/react-native-localpay-transport`) over AWDL (Apple Wireless Direct Link, via `Network.framework`) on iOS and Nearby Connections on Android. Payments built while offline are queued (`utils/offline/`) and delivered or internalized once a transport is available again.

**Vault** is an optional hardware-backed spending key secured by a YubiKey, via the `react-native-yubikey` Nitro module -- NFC (PIV over ISO7816) on iOS, USB/CCID on Android. `services/vault/` holds the driver abstraction, the enrollment/ceremony state machine, and key derivation; `context/VaultContext.tsx` and `components/vault/` drive the UI.

**Pairing with external wallets/clients** happens over `bsv-wallet://pair` deep links (`app/pair.tsx`, `app/connections.tsx`). `context/WalletConnectionContext.tsx` opens an encrypted, relay-based RPC channel to the pairing origin and implements a subset of the BRC-100 wallet interface (`createAction`, `signAction`, `listActions`, `getPublicKey`, certificates, `encrypt`/`decrypt`, signatures, etc.) for that paired connection. Every call still goes through the same wallet permission system as an in-app spend -- there is no standing grant.

**Background monitoring** -- a `Monitor` instance (from `@bsv/wallet-toolbox-mobile`) subscribes to ARC SSE (Server-Sent Events) for real-time transaction status updates. Missed events are fetched when the app returns from the background.

**Trust and identity** -- `app/trust.tsx` manages a ranked list of trusted BRC-68 certifiers used to resolve counterparties' identities across MessageBox payments and pairing.

**Metro** is configured with crypto polyfills (`react-native-quick-crypto`, `stream-browserify`, `buffer`) and special COOP/COEP headers for SharedArrayBuffer support (required by `expo-sqlite` on web).

## Environment Variables

Create a `.env.local` file in the project root. The app reads `EXPO_PUBLIC_*` variables at build time.

| Variable                     | Purpose                                             | Default (mainnet)                              |
| ----------------------------- | ---------------------------------------------------- | ------------------------------------------------ |
| `EXPO_PUBLIC_ARC_URL`         | ARC transaction processor URL                        | `https://arcade-v2-us-1.bsvblockchain.tech`       |
| `EXPO_PUBLIC_ARC_API_KEY`     | ARC API key                                          | (none)                                            |
| `EXPO_PUBLIC_CHAINTRACKS_URL` | Chaintracks block-header service URL                 | `https://arcade-v2-us-1.bsvblockchain.tech/chaintracks/v1` |
| `EXPO_PUBLIC_WOC_API_KEY`     | WhatsOnChain API key (also used as the TAAL key)      | (none)                                            |
| `EXPO_PUBLIC_BACKUP_URL`      | Encrypted wallet-backup service origin                | (empty -- backup disabled)                        |

Testnet variants use a `_TEST_` infix (e.g. `EXPO_PUBLIC_TEST_ARC_URL`), and Teratest a `_TERATEST_` infix -- see `services/walletServiceConfig.ts` for the full per-network resolution.

Production values are set in `eas.json` under the `production` build profile and override `.env.local`.

## Code Style

The project uses **ESLint** (v9, flat config) with `eslint-config-expo` and **Prettier** for formatting.

Key Prettier rules (`.prettierrc`):

- No semicolons
- Single quotes
- No trailing commas
- 120-character line width
- 2-space indentation
- LF line endings

Run `npm run fix` before committing to auto-format and auto-fix lint issues.

## Contributing

Contributions are welcome. Here's how to get started:

1. **Fork** the repository and create a feature branch from `master`.
2. **Install** dependencies with `npm install`.
3. **Make your changes.** Follow the existing code style -- run `npm run fix` before committing.
4. **Test on-device.** Create a dev build (`npm run ios-dev-build` or `npm run android-dev-build`) and verify your changes work on a real device or emulator.
5. **Open a pull request** against `master` with a clear description of what you changed and why.

### Commit style

Keep commit messages short and imperative, lowercase, and focused on the change:

```
add new permission modal for camera access
fix balance display rounding on transactions screen
refactor connection store to use async initialization
```

### Where to look

| Area                     | Key files                                                                                           |
| ------------------------ | ---------------------------------------------------------------------------------------------------- |
| Adding a new screen      | `app/` -- add a new `.tsx` file; Expo Router picks it up automatically                               |
| Wallet logic             | `context/WalletContext.tsx`, `utils/simpleWalletBuilder.ts`, `storage/`                              |
| Auth / mnemonic          | `app/auth/mnemonic.tsx`, `utils/mnemonicWallet.ts`                                                   |
| Payments                 | `app/pay.tsx` over `utils/pay/rails/` -- `handle.ts` (MessageBox), `nearby.ts` (Local Payments), `address.ts` (P2PKH) |
| Local Payments transport | `packages/react-native-localpay-transport`, `utils/localpay/`                                        |
| Vault                    | `services/vault/`, `context/VaultContext.tsx`, `components/vault/`, `packages/react-native-yubikey`  |
| Pairing / external RPC   | `context/WalletConnectionContext.tsx`, `app/pair.tsx`, `app/connections.tsx`, `stores/ConnectionStore.ts` |
| Permissions               | `context/WalletContext.tsx` (spend/protocol/basket/certificate approval), `components/ui/PermissionSheet.tsx` |
| Backup / recovery        | `utils/backupShares.ts`, `app/auth/scan-shares.tsx`, `utils/backup/`                                 |
| DB import/export         | `utils/importDatabases.ts`, `utils/exportDatabases.ts`                                               |
| Translations             | `context/i18n/translations.tsx` -- add your language code to the table                               |
| Theming                  | `context/theme/tokens.ts`, `context/theme/ThemeContext.tsx`                                          |

## Building for Devices

The app uses **EAS Build** to create native binaries locally. You need the EAS CLI installed (`npm i -g eas-cli`).

### iOS (macOS only)

```bash
# Create a development build (EAS local — simulator dev-client)
npm run ios-dev-build

# The build produces a .tar.gz archive. Double-click it to extract the .app,
# then drag the .app onto the iOS Simulator window to install it.

# Start the dev server and connect
npm run ios
```

For a faster local iterate-on-native loop (compiles, installs, and launches on
a booted simulator in one step, without the EAS packaging), use:

```bash
npm run ios-run
```

> **Why `RCT_USE_PREBUILT_RNCORE=0`?** This repo defaults to Expo's **prebuilt
> React-Core** (`ios/Podfile`) for faster release builds. The prebuilt
> framework omits the RN dev-support symbols that **`expo-dev-client`** /
> `expo-dev-menu` link against (packager connection, Hermes inspector), so a
> dev-client build against the prebuilt core **fails to link**. Dev-client
> builds must therefore build React Native **from source**:
> - `npm run ios-run` sets `RCT_USE_PREBUILT_RNCORE=0` for you.
> - `npm run ios-dev-build` / `ios-dev-physical` inherit it from the matching
>   EAS profile in `eas.json` (`env.RCT_USE_PREBUILT_RNCORE = "0"`).
> - Production builds keep the prebuilt core (they don't ship the dev menu), so
>   release build times are unaffected.
>
> If you run `npx expo run:ios` or `pod install` directly, export
> `RCT_USE_PREBUILT_RNCORE=0` first, or the dev-client link will fail with
> `Undefined symbols … RCTPackagerConnection / inspector_modern`.

### Android

```bash
# Create a development build
npm run android-dev-build

# The APK will be output locally -- install it via adb
adb install build-*.apk

# Start the dev server and connect
npm run android
```

### Production builds

```bash
npm run ios-build-for-app-store
npm run android-build-for-play-store
```

## Native Rebuild Requirements

Some features use native libraries that require a full native rebuild (not just a Metro restart). After adding or updating these dependencies, run:

```bash
# iOS
npx expo prebuild --platform ios --clean
npx expo run:ios --device

# Android
npx expo prebuild --platform android --clean
npx expo run:android --device
```

The `--clean` flag regenerates the native projects from scratch, ensuring all native modules, `patch-package` patches, and `app.json` plugin configs are picked up.

**Features requiring native rebuilds:**

| Feature                    | Native Dependencies                                                                          |
| --------------------------- | ---------------------------------------------------------------------------------------------- |
| Local Payments              | `react-native-localpay-transport` (AWDL/Nearby Connections), `react-native-nitro-modules`, `@react-native-community/netinfo` |
| Vault (hardware key)        | `react-native-yubikey`, `react-native-nitro-modules`                                          |
| Wallet storage              | `expo-sqlite`                                                                                  |
| Secure key storage          | `expo-secure-store`                                                                            |
| Crypto polyfill             | `react-native-quick-crypto`                                                                    |

**When is a rebuild needed?**

- After `npm install` adds a package with native code
- After modifying files in `patches/` (applied via `patch-package` postinstall)
- After changing `app.json` plugin configurations (e.g. NFC entitlement, Expo plugins)

**When is a rebuild NOT needed?**

- Changes to JS/TS source files only -- Metro hot-reload is sufficient
- Changes to translations, styles, or React component logic

## Publishing Your Own Version

If you want to fork this project and release your own version on the Apple App Store and Google Play Store, you need to create your own Expo project, generate signing credentials, and replace the identifiers in the config files.

### 1. Create an Expo account and project

1. Sign up at [expo.dev](https://expo.dev).
2. Create a new project in the Expo dashboard. This gives you an **EAS project ID** and an **owner** slug.

### 2. Replace identifiers in `app.json`

Open `app.json` and change the following fields to match your own project:

| Field                       | Current value                            | What to change it to                                        |
| ---------------------------- | ----------------------------------------- | -------------------------------------------------------------- |
| `expo.name`                 | `"BSV Wallet"`                            | Your app's display name                                      |
| `expo.slug`                 | `"bsv-wallet"`                            | Your Expo project slug (must match the dashboard)            |
| `expo.scheme`               | `"bsv-wallet"`                            | Your app's URI scheme for deep links                         |
| `expo.owner`                 | `"bsvb"`                                  | Your Expo account username or organization slug              |
| `expo.extra.eas.projectId`  | `"435e9e20-dd2a-4be5-8684-af5809f913bb"`  | Your EAS project ID from the Expo dashboard                  |
| `expo.android.package`       | `"org.bsvassociation.wallet"`             | Your Android application ID (e.g. `com.yourcompany.wallet`)  |
| `expo.ios.bundleIdentifier`  | `"org.bsvassociation.wallet"`             | Your iOS bundle identifier (e.g. `com.yourcompany.wallet`)   |

The Android package and iOS bundle identifier must be unique across the Play Store and App Store respectively. Once published, they cannot be changed.

### 3. Set up iOS credentials

EAS can manage iOS credentials for you. Run:

```bash
eas credentials -p ios
```

This will walk you through:

- **Apple Developer account** -- you need a paid [Apple Developer Program](https://developer.apple.com/programs/) membership ($99/year).
- **Distribution certificate** -- EAS will create one or let you upload an existing `.p12`.
- **Provisioning profile** -- EAS generates this automatically, tied to your bundle identifier.

For App Store submissions, EAS handles code signing automatically during `eas build --profile production`. You do not need to manually manage certificates unless you prefer to.

### 4. Set up Android credentials

For Android you need a **keystore** to sign your APK/AAB. The `production` profile in `eas.json` sets `credentialsSource: "remote"`, meaning EAS stores and manages the keystore for its own project -- there is no keystore file checked into this repository for you to reuse. Run:

```bash
eas credentials -p android
```

This will either:

- **Generate a new keystore** -- EAS creates and securely stores it remotely for your own project, or
- **Let you upload an existing keystore** -- if you already have a `.jks` or `.keystore` file.

Keep whatever keystore you generate safe -- if you lose your upload keystore, you cannot update your app on the Play Store.

To upload to the Play Store you also need a [Google Play Developer account](https://play.google.com/console/) ($25 one-time fee) and must create your app listing in the Play Console before your first submission.

### 5. Update production environment variables

Edit the `production` env block in `eas.json` to point to your own infrastructure:

```jsonc
// eas.json → build → production → env
{
  "EXPO_PUBLIC_ARC_URL": "https://your-arc.example.com",
  "EXPO_PUBLIC_CHAINTRACKS_URL": "https://your-chaintracks.example.com",
  "EXPO_PUBLIC_BACKUP_URL": "https://your-backup.example.com"
}
```

### 6. Build and submit

```bash
# iOS -- builds an IPA and submits to App Store Connect
eas build --profile production --platform ios
eas submit -p ios

# Android -- builds an AAB and submits to Google Play
eas build --profile production --platform android
eas submit -p android
```

The `eas submit` commands will prompt you for your App Store Connect / Google Play credentials on first use. You can also run builds locally with the `--local` flag (which is what the npm scripts in this repo do).

### Summary of files you need to touch

| File        | Fields to change                                                                                     |
| ----------- | -------------------------------------------------------------------------------------------------------- |
| `app.json`  | `name`, `slug`, `scheme`, `owner`, `extra.eas.projectId`, `android.package`, `ios.bundleIdentifier`      |
| `eas.json`  | `production.env.*` values (ARC/Chaintracks/backup URLs, etc.)                                            |
| Credentials | Run `eas credentials` for both platforms -- Android credentials are stored remotely on EAS by default    |

## Supported Languages

The app is localised into the following languages using `react-i18next`:

| Code | Language             |
| ---- | --------------------- |
| `en` | English               |
| `zh` | Chinese (Simplified)  |
| `hi` | Hindi                 |
| `es` | Spanish               |
| `fr` | French                |
| `ar` | Arabic                |
| `pt` | Portuguese            |
| `bn` | Bengali               |
| `ru` | Russian               |
| `id` | Indonesian            |
| `ja` | Japanese              |
| `pl` | Polish                |

Translations live in `context/i18n/translations.tsx`. The device locale is detected automatically via `expo-localization` and falls back to English.

To add a new language, add a new key to the translations object and include it in the language table above.

## License

The code in this repository is licensed under the [Open BSV License v4](LICENSE.txt). Software and derivatives may only be used on the BSV blockchain and its test networks.

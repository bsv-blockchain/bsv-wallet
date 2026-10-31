# End-to-end tests

Maestro drives the installed iOS and Android apps. The flows are YAML, the same shape used for the sibling wallets. They run against a **harness build** that cannot select mainnet and never talks to a real broadcaster.

Jest (`npm test`) stays the unit and component suite. This document is only the device suite.

## Why Maestro

The app is Expo SDK 57 with a development client, the New Architecture, and Nitro modules (secp, the transaction engine, YubiKey, local payments) plus React Native Firebase. Detox has to be linked into the native projects that `expo prebuild` regenerates, and that link fights this setup. Maestro talks to the installed binary from outside, on an iOS simulator and an Android emulator, locally and in CI. `testID`s are already how the bridge sheets are addressed.

A harness build is a normal release-or-debug binary with `EXPO_PUBLIC_E2E=true`. It is not Expo Go, and it does not need Metro once the JavaScript is bundled.

## What the harness changes

Nothing changes unless `EXPO_PUBLIC_E2E` is the string `true`. Development and production profiles do not set it.

When it is set, `app/_layout.tsx` passes `e2e: { broadcasterUrl }` into `configureToolbox` and turns backup, the vault, and push off. The toolbox then:

- Opens **testnet**. A request for mainnet, including a stored profile, is forced to test. The network picker does not offer Mainnet. `configureToolbox` throws if an E2E config also names mainnet services, a backup URL, the vault, or push.
- Stores a new key **without a biometric prompt** (`dev-plain`), so a simulator with Face ID enrolled and one with nothing enrolled take the same path. Relaunch is the unlock journey.
- On Pay → review → Send for a BSV address, posts `{ chain: "test", to, satoshis }` to the mock and stays on the review step. The real address rail is not called. The mock **never forwards** a transaction.

The mock listens on port 8787.

| Where the app runs | Broadcaster URL                   |
| ------------------ | --------------------------------- |
| Android emulator   | `http://10.0.2.2:8787`            |
| iOS simulator      | `http://127.0.0.1:8787`           |
| Anywhere else      | `EXPO_PUBLIC_E2E_BROADCASTER_URL` |

`plugins/withE2eCleartext.js` allows that HTTP only when the prebuild sees `EXPO_PUBLIC_E2E=true`. A production prebuild does not.

The EAS profile is `e2e` in `eas.json` (internal APK, iOS simulator). Local scripts use `expo prebuild` plus a debug Android APK or an iOS Release simulator build, which do not need Apple or Play signing.

The application id stays `org.bsvblockchain.wallet`. An E2E install shares the keychain with a normal install of this app. Use a dedicated simulator or emulator. Do not install the harness over a wallet that holds funds.

## The recovery phrase

`e2e/fixtures/bip39-test-vector.txt` is the **published BIP-39 test vector** (`abandon` × 11, then `about`). It is not a secret, and it is not a wallet anyone should fund. The restore flow types it. The harness cannot put that wallet on mainnet. Do not replace the file with any other phrase. The scripts refuse to start if the file changes.

The send flow pays `mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn`, a public testnet address (version byte `0x6f`), not a key.

## Flows

| Flow                           | What it covers                                                                                                                                                          |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `01-first-launch`              | Fresh install: balance, Pay, Get paid, empty history, import prompt, no Vault button, Settings locked to Testnet                                                        |
| `02-create-wallet`             | Create New Wallet, the recovery words, the app's own 15s delay, Confirm, home without the import prompt                                                                 |
| `03-restore-and-unlock`        | Import the BIP-39 test vector, empty history, relaunch with no biometric unlock                                                                                         |
| `04-send`                      | Pay form, review, confirm, mock broadcaster receipt                                                                                                                     |
| `05-receive-and-history`       | Get paid → BSV address, QR, copy chip, empty activity                                                                                                                   |
| `06-settings-and-screens`      | Profile switcher (shows Testnet), Profile, Identifier, Contacts, New Contact, Trust, Connections, Debugging, Troubleshooting, Vault unavailable, Settings, log out      |
| `07-pair-permission-deeplinks` | `bsv-wallet://pair` Approve/Reject, the BRC-100 connection sheet (`bridge-deny` / `bridge-approve`), retired `/payments` link, blocked external import link, `peerpay:` |
| `08-scan-shares`               | Scan Backup Shares, including the camera permission buttons when the OS shows them                                                                                      |

`02-create-wallet` waits up to 40s for Confirm because the screen hides it for 15s on purpose (`HANDWRITTEN_BACKUP_DELAY_MS`). That wait is not a retry. Flows do not retry a failed assertion.

## Run it locally

Install Maestro once:

```bash
curl -Ls "https://get.maestro.mobile.dev" | bash
```

Boot a simulator or emulator, then:

```bash
npm run e2e:android    # prebuild, debug APK, install, mock, Maestro
npm run e2e:ios        # macOS only: prebuild, Release simulator build, mock, Maestro
npm run e2e            # app already installed; starts the mock and runs Maestro
npm run e2e:mock       # only the mock, on port 8787
```

`E2E_SKIP_BUILD=1` skips the native build. `E2E_CLEAN=1` passes `--clean` to prebuild. The first Android build, and every iOS build, compiles the Nitro modules and (on iOS) React Native from source. Expect that to take a long time.

The mock's unit tests do not need a device:

```bash
node --test e2e/mock/server.test.mjs
```

The harness rules (no mainnet, no biometric probe) are also covered by Jest:

```bash
npx jest packages/expo-wallet-toolbox/__tests__/e2e/harness.test.ts
```

### Add a flow

1. Add `testID`s on the controls the flow taps. Prefer an id over copy. Do not change behaviour to make a screen easier to reach.
2. Put the YAML in `e2e/flows/`. Give it an `appId: org.bsvblockchain.wallet` header. Shared steps go in `e2e/subflows/` and are pulled in with `runFlow`.
3. Start from a fresh install (`e2e/subflows/launch-fresh.yaml`) unless the flow is specifically about a relaunch.
4. Point any new network call at the mock, and teach `e2e/mock/server.mjs` to answer it without forwarding.
5. Run `npm run e2e` (or one file: `maestro test --config e2e/config.yaml -e E2E_MNEMONIC=... e2e/flows/04-send.yaml` from a shell that has sourced `e2e/scripts/common.sh`).

`e2e/subflows/go-home.yaml` opens `bsv-wallet://`, which lands on the wallet. Use it instead of counting back buttons.

### Debug a failure

Maestro writes screenshots and a hierarchy into `e2e/artifacts/` (`--debug-output`). The mock appends one JSON line per request to `e2e/mock/requests.log`. Both paths are gitignored.

Useful checks:

- The screen never shows `e2e-harness`. The installed binary was not built with `EXPO_PUBLIC_E2E=true`, or it was installed before a prebuild that included `withE2eCleartext`. Rebuild. `E2E_CLEAN=1` if the native project already existed.
- Send fails with a connection error. The mock is not running, or the device cannot reach the host. An emulator uses `10.0.2.2`. A physical device needs `EXPO_PUBLIC_E2E_BROADCASTER_URL=http://<lan-ip>:8787` at **bundle** time, then a rebuild.
- Create sits on "Secure Your Wallet". Continue is `biometric-continue`. The harness must not raise a system biometric sheet. If it does, the binary is not a harness build.
- Restore does not finish. Confirm `E2E_MNEMONIC` is the fixture line. The scripts set it. A hand-run `maestro test` must pass `-e E2E_MNEMONIC=...`.
- Android cleartext is blocked. Prebuild ran without `EXPO_PUBLIC_E2E=true`, so `android:usesCleartextTraffic` was not set.

On a booted emulator, `adb logcat` is the app log. On a booted simulator, `xcrun simctl spawn booted log show --last 5m` is the same idea. `maestro hierarchy` prints the accessibility tree of the current screen.

## CI

| Workflow                            | When                                                                              | Runner                           |
| ----------------------------------- | --------------------------------------------------------------------------------- | -------------------------------- |
| `.github/workflows/e2e-android.yml` | Pull requests that touch the app, the toolbox, or `e2e/`, and `workflow_dispatch` | `ubuntu-latest`, API 34 emulator |
| `.github/workflows/e2e-ios.yml`     | Nightly (`06:00` UTC), `workflow_dispatch`, or a pull request labeled `e2e-ios`   | `macos-15` simulator             |

Both jobs upload `e2e/artifacts` and `e2e/mock/requests.log` when the suite fails, and the Android job also saves `logcat`.

iOS is not on every pull request. A macOS minute costs about ten Linux minutes, and the job compiles the gitignored Rust xcframeworks before the simulator build, so a green iOS run is a long job. The release harness uses the prebuilt React core. Android runs the same flows on pull requests. Label a pull request `e2e-ios` when a change is specific to iOS (deep links, the share scanner, the secure-store path).

There is no retry wrapper around Maestro. A red run is a failed assertion, a missing id, or a crash.

## Gaps

These are real limits of this suite, not skipped assertions.

- **Send does not spend a coin.** The confirm button posts a description to the mock. Coin selection, signing, and ARC submission stay on the unit-tested wallet path. Funding a regtest or testnet wallet inside CI would mean holding a key that can spend, which this repo will not do. A later harness can teach the mock a chaintracks tip and a UTXO if deggen wants a signed broadcast that still never leaves the runner.
- **History is the empty state.** There is no seeded activity row. The demo ledger is dev-only and is compiled out of release binaries, including this harness. Empty history plus the filter control is what the flow asserts.
- **No in-app browser.** This repo does not ship a WebView. The Android and Safari bridge packages are libraries (Jest covers their conformance). The wallet side of that bridge is the pair screen and the PermissionSheet. `07-pair-permission-deeplinks` opens both. `bsv-wallet://e2e-consent` exists only to raise the sheet; in a non-harness build the route redirects home and registers nothing.
- **YubiKey, nearby radio, and push** are off. Vault is asserted as "Not available yet". NFC and a second device are not in CI.
- **Camera.** `08-scan-shares` opens the scanner and accepts the OS permission dialog. It does not decode a share QR.
- **Same application id as production.** See the warning above.
- **This environment did not boot an emulator or a simulator.** The mock's tests and the Jest harness tests are what can run here. The GitHub workflows are the device runs.

## Decisions for deggen

1. iOS stays nightly, manual, and label-gated. Say if it should run on every pull request instead.
2. The send hook stops at the mock. Say if a signed regtest broadcast is worth a follow-up.
3. The harness uses the production application id. A separate id would isolate the keychain, but `google-services.json` is pinned to `org.bsvblockchain.wallet`, so the Firebase plugin would have to be dropped from the harness or given a second client. Say if that split is wanted.

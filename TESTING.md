# Testing

BSV Wallet is a React Native + Expo app. The wallet logic and screens live in `packages/expo-wallet-toolbox`. Tests stay off mainnet: chain clients are mocked, sends used in these suites pass `noSend`, and the only keys are fixtures or keys generated in the test process.

## Why these tools

Jest with `jest-expo` and React Native Testing Library is already how this repo tests. The suite is thousands of cases written against that preset (SQLite via `node:sqlite`, the BRC-185 router, screen renders). Vitest would mean a second transform of the same React Native modules, so the new layers stay on Jest.

End-to-end uses Playwright (Chromium). The browser wallet bridge is an HTTP loopback on `127.0.0.1`, which is what Android Chrome and the `bsv-browser` client speak. A real browser can drive that without a phone. Detox and Maestro need a compiled dev-client. iOS needs macOS, and an Android emulator job needs an APK this repository does not build in the required checks. Those device flows live in `e2e/maestro` and `.github/workflows/e2e-device.yml` (manual). They are not a substitute for the Playwright gate.

## Layers

| Layer            | What it covers                                                                                                                                | Command                 |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| Unit             | Keys, shares, storage SQL, pay rails, permissions, bridge protocol                                                                            | `pnpm test:unit`        |
| Component        | Screens and sheets under `packages/expo-wallet-toolbox/__tests__/ui` and the app-root tests in `__tests__/`                                   | `pnpm test:ui`          |
| Integration      | Module journeys (restore → SQLite → testnet address → P2PKH send → approved BRC-100 `createAction`) plus the existing bridge integration test | `pnpm test:integration` |
| All of the above | Default local / CI suite                                                                                                                      | `pnpm test`             |
| End-to-end       | Chromium: create, restore, receive, settings, connect, approve, pay 1 sat with `noSend`                                                       | `pnpm test:e2e`         |
| Coverage         | Same as `pnpm test`, writing `coverage/`                                                                                                      | `pnpm test:coverage`    |

`pnpm test` does not launch a browser. `pnpm test:e2e` does. The first e2e run needs Chromium:

```bash
pnpm exec playwright install chromium
pnpm test:e2e
```

On Linux CI the browser install is `pnpm exec playwright install --with-deps chromium`.

## What the end-to-end test drives

`e2e/bridge-wallet.e2e.test.ts` starts the real loopback router and the real bridge dispatcher, bundles `e2e/browser/page.ts` (the Android loopback page client) and opens it in Chromium at `http://localhost`. The page:

1. Creates a wallet and restores the same phrase (real BIP-39 / BIP-32).
2. Shows a testnet receive address derived from that key.
3. Reads settings as testnet with broadcasts off.
4. Connects as a site, using the launch-intent and describe/connect proofs.
5. Asks for the identity key. The call parks until **Approve** is clicked (real consent store).
6. Pays 1 satoshi. The wallet records `noSend: true` and returns a fixture txid. No transaction is broadcast.

## Device flows (not in required CI)

```bash
maestro test e2e/maestro
```

Needs Maestro, a running Android emulator or iOS simulator, and an installed dev-client (`npm run android-dev-build` or `npm run ios-dev-build`). iOS cannot run on the Ubuntu runners used for pull requests. `.github/workflows/e2e-device.yml` is `workflow_dispatch` only: it installs a `wallet-apk` artifact onto an API 34 emulator and runs the Maestro flows. Required CI does not build that APK.

## CI

`.github/workflows/ci.yml` runs on every pull request and on `master`:

- **Unit, component, and integration** — `pnpm test:ci` (coverage on), Node 24.22.1, pnpm cache. The summary is uploaded as the `coverage` artifact.
- **End-to-end (browser)** — Playwright Chromium, `pnpm test:e2e`.

`publish.yaml`'s **Verify** job is still the npm publish gate for `@bsv/expo-wallet-toolbox`. It runs when that package (or the workflow file) changes. A leading-zero private key used to fail its Shamir round-trip about once in 256 runs; the share test now uses fixed keys, including one whose first byte is zero.

## Coverage

Collected from `packages/expo-wallet-toolbox/core`, `ui`, `app`, `utils` and `hooks`, with Jest's V8 provider. The workspace pins `minimatch` 10, whose export shape breaks `babel-plugin-istanbul`, so the Istanbul provider cannot instrument this repo. The i18n dictionary (`core/i18n/translations.tsx`) is excluded: it is string data, and counting it would hide regressions in the logic. Reports:

- `coverage/coverage-summary.json`
- `coverage/lcov.info`

```bash
pnpm test:coverage
```

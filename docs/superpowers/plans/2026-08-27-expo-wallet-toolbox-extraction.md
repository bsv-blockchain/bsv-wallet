# Extract wallet into @bsv/expo-wallet-toolbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the wallet's screens, context, storage, services, and P2P local-payment backend out of `bsv-wallet` into a standalone package, `@bsv/expo-wallet-toolbox`, that any Expo/RN app can install — with `bsv-wallet` itself becoming the package's first consumer.

**Architecture:** One local package at `packages/expo-wallet-toolbox`, linked into the root app via a plain `file:` dependency (the same pattern already used for `react-native-localpay-transport`, `react-native-engine-native`, `react-native-secp-native`, `react-native-yubikey` — no npm workspaces protocol needed). Two hand-rolled entry points, `core/index.ts` (headless: context, storage, services, utils) and `ui/index.ts` (screens + components, imports `core`), resolved via plain directory-index resolution (`@bsv/expo-wallet-toolbox` → `core/index.ts`, `@bsv/expo-wallet-toolbox/ui` → `ui/index.ts`) — deliberately not using package.json `"exports"`, to avoid depending on Metro's package-exports support.

**Tech Stack:** Expo ^55, React Native 0.83, TypeScript ~5.9 (strict), Jest via `jest-expo`, `@bsv/sdk` / `@bsv/wallet-toolbox-mobile`.

**Spec:** [docs/superpowers/specs/2026-08-27-expo-wallet-toolbox-extraction-design.md](../specs/2026-08-27-expo-wallet-toolbox-extraction-design.md)

## Global Constraints

- Package name: `@bsv/expo-wallet-toolbox`. Location: `packages/expo-wallet-toolbox/{core,ui}`. Linked into root `package.json` via `"@bsv/expo-wallet-toolbox": "file:./packages/expo-wallet-toolbox"` (added in Task 1).
- **This plan performs code relocation, not new-feature TDD.** Each task's step pattern is: (1) confirm baseline — run the subsystem's existing tests and confirm they pass before touching anything; (2) `git mv` the files (preserves history — never plain `mv` + `git add`); (3) fix imports; (4) run the same tests again from their new location; (5) commit. A task that also edits a not-yet-moved consumer file (e.g. `WalletContext.tsx` before it itself moves) does that as its own step.
- **Import-fix rule:** after moving a file, any import of the form `from '@/...'` or `from './...'`/`from '../...'` that pointed at another module *also being moved in this plan* becomes a relative path to that module's new location inside the package. Imports of node_modules packages (`react`, `react-native`, `expo-*`, `@bsv/*`, etc.) are untouched. Verify with `grep -rn "from '@/" <moved-file-or-dir>` — every remaining hit must point only at app code not yet moved (expected mid-plan) or is a bug to fix now. Because moves use `git mv`, a leftover unfixed `@/` import that pointed at something already moved will fail to resolve (the old path no longer exists) — both `tsc` and Jest will error loudly, so there is no silent-breakage risk.
- **Test command convention:** `npx jest <path-or-pattern>`.
- **Commit convention:** Conventional Commits, `refactor(wallet-toolbox): <what moved>`.
- Whenever a task's file list says "Test: move `__tests__/X.test.ts` → `packages/expo-wallet-toolbox/__tests__/...`", mirror the existing `__tests__/` subfolder convention (flat, except `storage/`, `vault/`, `secrets/` keep their own subfolders).
- Package `package.json` stays `"private": true` until Task 28 (publish prep).

---

### Task 1: Scaffold the package + prove cross-package resolution works

**Files:**
- Create: `packages/expo-wallet-toolbox/package.json`
- Create: `packages/expo-wallet-toolbox/tsconfig.json`
- Create: `packages/expo-wallet-toolbox/core/index.ts`
- Create: `packages/expo-wallet-toolbox/ui/index.ts`
- Modify: `package.json` (root — add dependency, fix `jest.transformIgnorePatterns`)
- Test: `packages/expo-wallet-toolbox/__tests__/packageResolution.test.ts`

**Interfaces:**
- Produces: `CANARY: string` from `@bsv/expo-wallet-toolbox`, `CANARY_UI: string` from `@bsv/expo-wallet-toolbox/ui` — proof that both entry points resolve through Jest/Metro before any real code moves. Every later task appends real exports to these same two `index.ts` files.

- [ ] **Step 1: Create the package manifest**

```json
{
  "name": "@bsv/expo-wallet-toolbox",
  "version": "0.1.0",
  "private": true,
  "description": "Wallet screens and P2P local-payment backend for Expo/React Native apps, extracted from BSV Wallet.",
  "main": "core/index.ts",
  "types": "core/index.ts",
  "files": ["core", "ui"],
  "peerDependencies": {
    "react": "*",
    "react-native": "*",
    "expo-router": "*",
    "expo-sqlite": "*",
    "@bsv/sdk": "*",
    "@bsv/wallet-toolbox-mobile": "*",
    "@bsv/btms-permission-module": "*",
    "react-native-nitro-modules": "*",
    "react-native-localpay-transport": "*",
    "react-native-engine-native": "*",
    "react-native-secp-native": "*",
    "react-native-yubikey": "*"
  },
  "peerDependenciesMeta": {
    "react-native-yubikey": { "optional": true }
  }
}
```
Save as `packages/expo-wallet-toolbox/package.json`.

- [ ] **Step 2: Create the package tsconfig**

```json
{
  "extends": "expo/tsconfig.base",
  "compilerOptions": {
    "strict": true,
    "jsx": "react-native",
    "resolveJsonModule": true
  },
  "include": ["core/**/*", "ui/**/*"]
}
```
Save as `packages/expo-wallet-toolbox/tsconfig.json`. Deliberately no `baseUrl`/`paths` — package-internal imports must be relative so the package resolves the same way inside any consuming app, not just this one.

- [ ] **Step 3: Create the two entry-point barrels**

`packages/expo-wallet-toolbox/core/index.ts`:
```ts
export const CANARY = 'core'
```

`packages/expo-wallet-toolbox/ui/index.ts`:
```ts
export const CANARY_UI = 'ui'
```

- [ ] **Step 4: Link the package into the root app**

In root `package.json`, add (alphabetical position in `dependencies`):
```json
"@bsv/expo-wallet-toolbox": "file:./packages/expo-wallet-toolbox",
```

- [ ] **Step 5: Whitelist the package for Jest transformation**

Jest's default `transformIgnorePatterns` skips `node_modules` except an explicit whitelist regex — our package ships raw TypeScript, so without this it fails with a syntax error the first time a test imports it. In root `package.json`, find the `jest.transformIgnorePatterns` entry ending in `...@bsv/backup-cache-client|@bsv/auth)/)"` and extend the alternation:

```
"node_modules/(?!((jest-)?react-native|@react-native(-community)?|expo(nent)?|@expo(nent)?/.*|@expo-google-fonts/.*|react-navigation|@react-navigation/.*|@sentry/react-native|native-base|react-native-svg|react-native-reanimated|react-native-gesture-handler|react-native-worklets|expo-modules-core|@noble/secp256k1|@noble/curves|@noble/hashes|@bsv/backup-cache-client|@bsv/auth|@bsv/expo-wallet-toolbox)/)"
```

- [ ] **Step 6: Install to symlink the package into node_modules**

Run: `npm install`
Expected: completes cleanly; `node_modules/@bsv/expo-wallet-toolbox` is a symlink to `packages/expo-wallet-toolbox`.

- [ ] **Step 7: Write the resolution canary test**

```ts
import { CANARY } from '@bsv/expo-wallet-toolbox'
import { CANARY_UI } from '@bsv/expo-wallet-toolbox/ui'

describe('package resolution', () => {
  it('resolves the core entry point', () => {
    expect(CANARY).toBe('core')
  })

  it('resolves the ui entry point', () => {
    expect(CANARY_UI).toBe('ui')
  })
})
```
Save as `packages/expo-wallet-toolbox/__tests__/packageResolution.test.ts`.

- [ ] **Step 8: Run it**

Run: `npx jest packageResolution.test.ts`
Expected: 2 passed. If it fails on module resolution, stop and fix the manifest/jest config before any other task — every later task depends on this working.

- [ ] **Step 9: Commit**

```bash
git add package.json packages/expo-wallet-toolbox
git commit -m "refactor(wallet-toolbox): scaffold @bsv/expo-wallet-toolbox package"
```

---

### Task 2: Move foundational leaf modules (no internal deps)

**Files:**
- Move: `utils/mnemonicWallet.ts` → `packages/expo-wallet-toolbox/core/mnemonicWallet.ts`
- Move: `utils/walletDbRegistry.ts` → `packages/expo-wallet-toolbox/core/walletDbRegistry.ts`
- Move: `utils/walletMonitor.ts` → `packages/expo-wallet-toolbox/core/walletMonitor.ts`
- Move: `utils/net/online.ts` → `packages/expo-wallet-toolbox/core/net/online.ts`
- Move: `utils/logging.ts` → `packages/expo-wallet-toolbox/core/logging.ts`
- Move: `utils/logging.config.ts` → `packages/expo-wallet-toolbox/core/logging.config.ts`
- Move: `utils/diskSpace.ts` → `packages/expo-wallet-toolbox/core/diskSpace.ts`
- Move: `context/config.tsx` → `packages/expo-wallet-toolbox/core/config.tsx`
- Test: `__tests__/netOnline.test.ts` → `packages/expo-wallet-toolbox/__tests__/net/online.test.ts`
- Test: `__tests__/walletMonitor.test.ts` → `packages/expo-wallet-toolbox/__tests__/walletMonitor.test.ts`
- Test: `__tests__/diskSpace.test.ts` → `packages/expo-wallet-toolbox/__tests__/diskSpace.test.ts`
- Modify: `packages/expo-wallet-toolbox/core/index.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks (these are the dependency-graph leaves).
- Produces: `recoverMnemonicWallet` (mnemonicWallet), `getRegisteredDbs`/`registerDb`/`selectLatestDb`/`parseDbFilename` (walletDbRegistry), `configureNewHeaderPolling` (walletMonitor), `getOnline`/`subscribeOnline` (net/online), `logWithTimestamp` + friends (logging), `AppChain`/`WalletChain`/`toWalletChain`/`DEFAULT_WAB_URL`/`DEFAULT_STORAGE_URL`/`DEFAULT_MESSAGEBOX_URL`/`DEFAULT_BACKUP_URL`/`DEFAULT_CHAIN`/`ADMIN_ORIGINATOR` (config) — all re-exported from `packages/expo-wallet-toolbox/core/index.ts`. Every later core task both consumes some of these and appends its own exports to the same file.

- [ ] **Step 1: Baseline**

Run: `npx jest netOnline.test.ts walletMonitor.test.ts diskSpace.test.ts`
Expected: all pass (confirms starting point before moving).

- [ ] **Step 2: Move the source files**

```bash
mkdir -p packages/expo-wallet-toolbox/core/net
git mv utils/mnemonicWallet.ts packages/expo-wallet-toolbox/core/mnemonicWallet.ts
git mv utils/walletDbRegistry.ts packages/expo-wallet-toolbox/core/walletDbRegistry.ts
git mv utils/walletMonitor.ts packages/expo-wallet-toolbox/core/walletMonitor.ts
git mv utils/net/online.ts packages/expo-wallet-toolbox/core/net/online.ts
git mv utils/logging.ts packages/expo-wallet-toolbox/core/logging.ts
git mv utils/logging.config.ts packages/expo-wallet-toolbox/core/logging.config.ts
git mv utils/diskSpace.ts packages/expo-wallet-toolbox/core/diskSpace.ts
git mv context/config.tsx packages/expo-wallet-toolbox/core/config.tsx
```

- [ ] **Step 3: Move the test files and fix their imports**

```bash
mkdir -p packages/expo-wallet-toolbox/__tests__/net
git mv __tests__/netOnline.test.ts packages/expo-wallet-toolbox/__tests__/net/online.test.ts
git mv __tests__/walletMonitor.test.ts packages/expo-wallet-toolbox/__tests__/walletMonitor.test.ts
git mv __tests__/diskSpace.test.ts packages/expo-wallet-toolbox/__tests__/diskSpace.test.ts
```
Each moved test imports its subject via `@/utils/...` or `@/context/config` — update those to relative paths against the new test location, e.g. in `__tests__/net/online.test.ts`: `from '@/utils/net/online'` → `from '../../core/net/online'`.

- [ ] **Step 4: Fix internal imports within the moved source files**

None of these eight files import each other or anything else moved in this plan (verified leaf modules) — run the verification grep to confirm no fix is needed:

Run: `grep -rn "from '@/" packages/expo-wallet-toolbox/core/mnemonicWallet.ts packages/expo-wallet-toolbox/core/walletDbRegistry.ts packages/expo-wallet-toolbox/core/walletMonitor.ts packages/expo-wallet-toolbox/core/net/online.ts packages/expo-wallet-toolbox/core/logging.ts packages/expo-wallet-toolbox/core/logging.config.ts packages/expo-wallet-toolbox/core/diskSpace.ts packages/expo-wallet-toolbox/core/config.tsx`

Expected: no output. If anything appears, fix it to a relative path per the Import-fix rule.

- [ ] **Step 5: Append exports to the core barrel**

Add to `packages/expo-wallet-toolbox/core/index.ts`:
```ts
export { recoverMnemonicWallet } from './mnemonicWallet'
export { getRegisteredDbs, registerDb, selectLatestDb, parseDbFilename } from './walletDbRegistry'
export { configureNewHeaderPolling } from './walletMonitor'
export { getOnline, subscribeOnline } from './net/online'
export { logWithTimestamp } from './logging'
export * from './diskSpace'
export type { AppChain, WalletChain } from './config'
export {
  toWalletChain,
  DEFAULT_WAB_URL,
  DEFAULT_STORAGE_URL,
  DEFAULT_MESSAGEBOX_URL,
  DEFAULT_BACKUP_URL,
  DEFAULT_CHAIN,
  ADMIN_ORIGINATOR
} from './config'
```
(Check `utils/logging.ts`'s actual named exports before finalizing this line — export every name it defines, not just `logWithTimestamp`.)

- [ ] **Step 6: Run tests from the new location**

Run: `npx jest packages/expo-wallet-toolbox/__tests__/net/online.test.ts packages/expo-wallet-toolbox/__tests__/walletMonitor.test.ts packages/expo-wallet-toolbox/__tests__/diskSpace.test.ts`
Expected: same pass count as Step 1.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor(wallet-toolbox): move foundational leaf modules into core"
```

---

### Task 3: Move theme + i18n

**Files:**
- Move: `context/theme/ThemeContext.tsx` → `packages/expo-wallet-toolbox/core/theme/ThemeContext.tsx`
- Move: `context/theme/tokens.ts` → `packages/expo-wallet-toolbox/core/theme/tokens.ts`
- Move: `context/theme/assertThemeContrast.ts` → `packages/expo-wallet-toolbox/core/theme/assertThemeContrast.ts`
- Move: `context/i18n/translations.tsx` → `packages/expo-wallet-toolbox/core/i18n/translations.tsx`
- Modify: `packages/expo-wallet-toolbox/core/index.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks (both self-contained per the exploration map — no test files exist for either, so there is no baseline/re-run test step here beyond the type-check).
- Produces: `ThemeProvider`, `useTheme`, `spacing`/`radii`/`typography` tokens, `LanguageProvider`, the i18n singleton default export — re-exported from `core/index.ts`.

- [ ] **Step 1: Move the files**

```bash
mkdir -p packages/expo-wallet-toolbox/core/theme packages/expo-wallet-toolbox/core/i18n
git mv context/theme/ThemeContext.tsx packages/expo-wallet-toolbox/core/theme/ThemeContext.tsx
git mv context/theme/tokens.ts packages/expo-wallet-toolbox/core/theme/tokens.ts
git mv context/theme/assertThemeContrast.ts packages/expo-wallet-toolbox/core/theme/assertThemeContrast.ts
git mv context/i18n/translations.tsx packages/expo-wallet-toolbox/core/i18n/translations.tsx
```
(If `context/theme/` or `context/i18n/` contain any other files not listed above, move those too — check with `ls context/theme context/i18n` before running the commands and add any extras.)

- [ ] **Step 2: Fix internal imports**

Run: `grep -rn "from '@/" packages/expo-wallet-toolbox/core/theme packages/expo-wallet-toolbox/core/i18n`
`ThemeContext.tsx` importing `./tokens` and `./assertThemeContrast` needs no change (already relative, same directory). Fix any `@/`-prefixed hit to a relative path.

- [ ] **Step 3: Append exports to the core barrel**

```ts
export { ThemeProvider, useTheme } from './theme/ThemeContext'
export { spacing, radii, typography, colors } from './theme/tokens'
export { LanguageProvider } from './i18n/translations'
export { default as i18n } from './i18n/translations'
```
(Verify the exact named exports of `tokens.ts` and adjust the list — export every token group it defines.)

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit -p packages/expo-wallet-toolbox/tsconfig.json`
Expected: no errors referencing `theme` or `i18n`.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(wallet-toolbox): move theme and i18n into core"
```

---

### Task 4: Move localpay transport protocol

**Files:**
- Move: `utils/localpay/codec.ts`, `session.ts`, `build.ts`, `pending.ts`, `verify.ts`, `qr.ts`, `nearbyPermissions.ts`, `types.ts` → `packages/expo-wallet-toolbox/core/localpay/`
- Move: `utils/localpay/transport/socket.ts`, `awdl.ts`, `nearby.ts`, `select.ts` → `packages/expo-wallet-toolbox/core/localpay/transport/`
- Move: `utils/peerpay/outbox.ts` → `packages/expo-wallet-toolbox/core/peerpay/outbox.ts`
- Test: `__tests__/localpayCodec.test.ts`, `localpaySession.test.ts`, `localpayBuild.test.ts`, `localpayPending.test.ts`, `localpayVerify.test.ts`, `localpayAirGap.test.ts`, `localpayTransportAwdl.test.ts`, `localpayTransportSelect.test.ts` → `packages/expo-wallet-toolbox/__tests__/localpay/`
- Modify: `packages/expo-wallet-toolbox/core/index.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks (localpay only needs `@bsv/sdk` and, for transport/select.ts, the `react-native-localpay-transport` peer dep).
- Produces: codec encode/decode functions, `SessionKeys`/session helpers, payment-frame builders, `PEERPAY_LABEL`/`PEERPAY_PROTOCOL_ID` and pending-queue helpers, `getLocalPayTransport`, `Ack` type, peerpay outbox helpers — re-exported from `core/index.ts`.

- [ ] **Step 1: Baseline**

Run: `npx jest localpayCodec localpaySession localpayBuild localpayPending localpayVerify localpayAirGap localpayTransportAwdl localpayTransportSelect`
Expected: all pass.

- [ ] **Step 2: Move source**

```bash
mkdir -p packages/expo-wallet-toolbox/core/localpay/transport packages/expo-wallet-toolbox/core/peerpay
git mv utils/localpay/codec.ts packages/expo-wallet-toolbox/core/localpay/codec.ts
git mv utils/localpay/session.ts packages/expo-wallet-toolbox/core/localpay/session.ts
git mv utils/localpay/build.ts packages/expo-wallet-toolbox/core/localpay/build.ts
git mv utils/localpay/pending.ts packages/expo-wallet-toolbox/core/localpay/pending.ts
git mv utils/localpay/verify.ts packages/expo-wallet-toolbox/core/localpay/verify.ts
git mv utils/localpay/qr.ts packages/expo-wallet-toolbox/core/localpay/qr.ts
git mv utils/localpay/nearbyPermissions.ts packages/expo-wallet-toolbox/core/localpay/nearbyPermissions.ts
git mv utils/localpay/types.ts packages/expo-wallet-toolbox/core/localpay/types.ts
git mv utils/localpay/transport/socket.ts packages/expo-wallet-toolbox/core/localpay/transport/socket.ts
git mv utils/localpay/transport/awdl.ts packages/expo-wallet-toolbox/core/localpay/transport/awdl.ts
git mv utils/localpay/transport/nearby.ts packages/expo-wallet-toolbox/core/localpay/transport/nearby.ts
git mv utils/localpay/transport/select.ts packages/expo-wallet-toolbox/core/localpay/transport/select.ts
git mv utils/peerpay/outbox.ts packages/expo-wallet-toolbox/core/peerpay/outbox.ts
```
(If `utils/localpay/` has any additional files beyond this list, `ls utils/localpay utils/localpay/transport` first and include them.)

- [ ] **Step 3: Move tests and fix imports**

```bash
mkdir -p packages/expo-wallet-toolbox/__tests__/localpay
git mv __tests__/localpayCodec.test.ts packages/expo-wallet-toolbox/__tests__/localpay/codec.test.ts
git mv __tests__/localpaySession.test.ts packages/expo-wallet-toolbox/__tests__/localpay/session.test.ts
git mv __tests__/localpayBuild.test.ts packages/expo-wallet-toolbox/__tests__/localpay/build.test.ts
git mv __tests__/localpayPending.test.ts packages/expo-wallet-toolbox/__tests__/localpay/pending.test.ts
git mv __tests__/localpayVerify.test.ts packages/expo-wallet-toolbox/__tests__/localpay/verify.test.ts
git mv __tests__/localpayAirGap.test.ts packages/expo-wallet-toolbox/__tests__/localpay/airGap.test.ts
git mv __tests__/localpayTransportAwdl.test.ts packages/expo-wallet-toolbox/__tests__/localpay/transportAwdl.test.ts
git mv __tests__/localpayTransportSelect.test.ts packages/expo-wallet-toolbox/__tests__/localpay/transportSelect.test.ts
```
Update each test's imports from `@/utils/localpay/...` to relative paths against `__tests__/localpay/`, e.g. `from '@/utils/localpay/codec'` → `from '../../core/localpay/codec'`.

- [ ] **Step 4: Fix internal imports**

`build.ts` imports `codec`, `session`, `pending`, `net/online` — after the move these are `./codec`, `./session`, `./pending`, `../net/online` respectively (same relative depth, only the `net/online` one changes since it now lives one directory up in `core/net/`, not `core/localpay/net/`).

Run: `grep -rn "from '@/" packages/expo-wallet-toolbox/core/localpay packages/expo-wallet-toolbox/core/peerpay`
Fix every hit per the Import-fix rule.

- [ ] **Step 5: Append exports to the core barrel**

```ts
export * from './localpay/codec'
export * from './localpay/session'
export * from './localpay/build'
export * from './localpay/pending'
export * from './localpay/verify'
export * from './localpay/qr'
export * from './localpay/nearbyPermissions'
export type { Ack } from './localpay/types'
export { getLocalPayTransport } from './localpay/transport/select'
export * from './peerpay/outbox'
```

- [ ] **Step 6: Run tests from new location**

Run: `npx jest packages/expo-wallet-toolbox/__tests__/localpay`
Expected: same pass count as Step 1.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor(wallet-toolbox): move localpay transport protocol into core"
```

---

### Task 5: Move offline-payment queueing

**Files:**
- Move: every file under `utils/offline/` → `packages/expo-wallet-toolbox/core/offline/`
- Test: `__tests__/offlineHold.test.ts`, `offlineOrder.test.ts`, `offlinePlan.test.ts`, `offlineChaintracks.test.ts` → `packages/expo-wallet-toolbox/__tests__/offline/`
- Modify: `packages/expo-wallet-toolbox/core/index.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: offline-hold/order/plan helpers, `OfflineFirstChaintracks` (if that's where it lives — cross-check against Task 11's headers move; `OfflineFirstChaintracks` belongs with `utils/headers/`, not `utils/offline/`, per the exploration map — confirm with `ls utils/offline` and only move what's actually there).

- [ ] **Step 1: Inventory the directory**

Run: `ls utils/offline`
List every file found; the plan's file list above is the exploration map's best-known set (`hold.ts`, `order.ts`, `plan.ts`) — adjust the move commands in Step 2 to match exactly what `ls` shows.

- [ ] **Step 2: Baseline**

Run: `npx jest offlineHold offlineOrder offlinePlan offlineChaintracks`
Expected: all pass.

- [ ] **Step 3: Move source**

```bash
mkdir -p packages/expo-wallet-toolbox/core/offline
git mv utils/offline/*.ts packages/expo-wallet-toolbox/core/offline/
```

- [ ] **Step 4: Move tests and fix imports**

```bash
mkdir -p packages/expo-wallet-toolbox/__tests__/offline
git mv __tests__/offlineHold.test.ts packages/expo-wallet-toolbox/__tests__/offline/hold.test.ts
git mv __tests__/offlineOrder.test.ts packages/expo-wallet-toolbox/__tests__/offline/order.test.ts
git mv __tests__/offlinePlan.test.ts packages/expo-wallet-toolbox/__tests__/offline/plan.test.ts
```
`offlineChaintracks.test.ts` — check its import target first (`grep -n "^import" __tests__/offlineChaintracks.test.ts`); if it tests `utils/headers/OfflineFirstChaintracks.ts` rather than anything under `utils/offline/`, leave it for Task 11 (headers) instead of moving it here.

Fix each moved test's imports from `@/utils/offline/...` to relative paths against `__tests__/offline/`.

- [ ] **Step 5: Fix internal imports**

Run: `grep -rn "from '@/" packages/expo-wallet-toolbox/core/offline`
Fix every hit per the Import-fix rule.

- [ ] **Step 6: Append exports to the core barrel**

Add one `export * from './offline/<file>'` line per file actually found in Step 1.

- [ ] **Step 7: Run tests from new location**

Run: `npx jest packages/expo-wallet-toolbox/__tests__/offline`
Expected: same pass count as Step 2 (minus `offlineChaintracks` if deferred to Task 11).

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "refactor(wallet-toolbox): move offline-payment queueing into core"
```

---

### Task 6: Move the send-offline background task

**Files:**
- Move: `utils/monitor/TaskSendOffline.ts` → `packages/expo-wallet-toolbox/core/monitor/TaskSendOffline.ts`
- Test: `__tests__/taskSendOffline.test.ts` → `packages/expo-wallet-toolbox/__tests__/monitor/taskSendOffline.test.ts`
- Modify: `packages/expo-wallet-toolbox/core/index.ts`

**Interfaces:**
- Consumes: offline-queue helpers from Task 5 (`core/offline`), `getOnline` from Task 2 (`core/net/online`).
- Produces: `TaskSendOffline` — needed by Task 7 (storage, which imports it directly) and Task 17 (`WalletContext.tsx`).

- [ ] **Step 1: Baseline**

Run: `npx jest taskSendOffline.test.ts`
Expected: passes.

- [ ] **Step 2: Move**

```bash
mkdir -p packages/expo-wallet-toolbox/core/monitor packages/expo-wallet-toolbox/__tests__/monitor
git mv utils/monitor/TaskSendOffline.ts packages/expo-wallet-toolbox/core/monitor/TaskSendOffline.ts
git mv __tests__/taskSendOffline.test.ts packages/expo-wallet-toolbox/__tests__/monitor/taskSendOffline.test.ts
```

- [ ] **Step 3: Fix imports**

Run: `grep -n "from '@/" packages/expo-wallet-toolbox/core/monitor/TaskSendOffline.ts packages/expo-wallet-toolbox/__tests__/monitor/taskSendOffline.test.ts`
Fix each hit (its offline-queue and net/online imports become `../offline/...` and `../net/online`; the test's import becomes `../../core/monitor/TaskSendOffline`).

- [ ] **Step 4: Append export**

```ts
export { TaskSendOffline } from './monitor/TaskSendOffline'
```

- [ ] **Step 5: Run test**

Run: `npx jest packages/expo-wallet-toolbox/__tests__/monitor/taskSendOffline.test.ts`
Expected: passes.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor(wallet-toolbox): move TaskSendOffline into core"
```

---

### Task 7: Move the storage layer

**Files:**
- Move: `storage/StorageExpoSQLite.ts`, `storage/LocalStorageAdapter.ts`, `storage/errors.ts`, `storage/index.ts`, `storage/schema/*`, `storage/methods/*` → `packages/expo-wallet-toolbox/core/storage/` (mirroring the same subfolder structure)
- Test: everything under `__tests__/storage/` → `packages/expo-wallet-toolbox/__tests__/storage/`
- Test: `__tests__/walletBalanceSql.test.ts` → `packages/expo-wallet-toolbox/__tests__/storage/walletBalanceSql.test.ts`
- Modify: `packages/expo-wallet-toolbox/core/index.ts`
- Modify: `app/index.tsx:53-54` — will still import `@/storage/methods/...` directly until Task 18 rewires the app; leave as-is for now (this task only moves the package's own code, not its callers — the direct-import bypass gets fixed for good in Task 18).

**Interfaces:**
- Consumes: `getOnline` (Task 2), `logWithTimestamp`/`diskSpace` (Task 2), offline-hold helpers (Task 5), `TaskSendOffline` (Task 6), `AppChain`/`toWalletChain` (Task 2).
- Produces: `StorageExpoSQLite`, `StorageExpoSQLiteOptions`, `createTables`, and — per the spec's explicit fix requirement — `findOfflineActions`, `OfflineActionRow`, `readWalletBalance` now also re-exported at the top level (previously only reachable via `storage/methods/*` direct imports).

- [ ] **Step 1: Baseline**

Run: `npx jest packages/expo-wallet-toolbox/__tests__ -t storage 2>/dev/null; npx jest __tests__/storage __tests__/walletBalanceSql.test.ts`
Expected: all pass.

- [ ] **Step 2: Move source**

```bash
mkdir -p packages/expo-wallet-toolbox/core/storage/schema packages/expo-wallet-toolbox/core/storage/methods
git mv storage/StorageExpoSQLite.ts packages/expo-wallet-toolbox/core/storage/StorageExpoSQLite.ts
git mv storage/LocalStorageAdapter.ts packages/expo-wallet-toolbox/core/storage/LocalStorageAdapter.ts
git mv storage/errors.ts packages/expo-wallet-toolbox/core/storage/errors.ts
git mv storage/index.ts packages/expo-wallet-toolbox/core/storage/index.ts
git mv storage/schema/*.ts packages/expo-wallet-toolbox/core/storage/schema/
git mv storage/methods/*.ts packages/expo-wallet-toolbox/core/storage/methods/
rmdir storage/schema storage/methods storage 2>/dev/null || true
```

- [ ] **Step 3: Move tests and fix imports**

```bash
mkdir -p packages/expo-wallet-toolbox/__tests__/storage
git mv __tests__/storage/*.ts packages/expo-wallet-toolbox/__tests__/storage/
git mv __tests__/walletBalanceSql.test.ts packages/expo-wallet-toolbox/__tests__/storage/walletBalanceSql.test.ts
rmdir __tests__/storage 2>/dev/null || true
```
Fix each test's `@/storage/...` import to a relative path against `__tests__/storage/`.

- [ ] **Step 4: Fix internal imports**

`StorageExpoSQLite.ts` per the exploration map imports `./schema/createTables`, `./methods/historyNotes`, `./errors`, `../utils/diskSpace`, `../utils/logging`, `./methods/listActionsSql`, `./methods/listOutputsSql`, `./methods/offlineActions`, `../utils/offline/hold`, `../utils/net/online`, `../utils/monitor/TaskSendOffline`. After the move: the `./schema/...`, `./methods/...`, `./errors` imports are unchanged (same relative structure); `../utils/diskSpace` → `../diskSpace`; `../utils/logging` → `../logging`; `../utils/offline/hold` → `../offline/hold`; `../utils/net/online` → `../net/online`; `../utils/monitor/TaskSendOffline` → `../monitor/TaskSendOffline`.

`LocalStorageAdapter.ts` imports `@/context/config` → `../config`.

Run: `grep -rn "from '@/\|from '\.\./utils\|from '\.\./context" packages/expo-wallet-toolbox/core/storage`
Fix every remaining hit.

- [ ] **Step 5: Append exports to the core barrel**

```ts
export { StorageExpoSQLite } from './storage/StorageExpoSQLite'
export type { StorageExpoSQLiteOptions } from './storage/StorageExpoSQLite'
export { createTables } from './storage/schema/createTables'
export { LocalStorageAdapter } from './storage/LocalStorageAdapter'
export { findOfflineActions } from './storage/methods/offlineActions'
export type { OfflineActionRow } from './storage/methods/offlineActions'
export { readWalletBalance } from './storage/methods/walletBalanceSql'
```
(Verify `LocalStorageAdapter.ts`'s actual export name/shape before finalizing.)

- [ ] **Step 6: Run tests from new location**

Run: `npx jest packages/expo-wallet-toolbox/__tests__/storage`
Expected: same pass count as Step 1.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor(wallet-toolbox): move storage layer into core, expose offlineActions/walletBalanceSql publicly"
```

---

### Task 8: Move local secrets storage + LocalStorageProvider

**Files:**
- Move: every file under `services/secrets/` → `packages/expo-wallet-toolbox/core/services/secrets/`
- Move: `context/LocalStorageProvider.tsx` → `packages/expo-wallet-toolbox/core/context/LocalStorageProvider.tsx`
- Test: everything under `__tests__/secrets/` → `packages/expo-wallet-toolbox/__tests__/secrets/`
- Modify: `packages/expo-wallet-toolbox/core/index.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks (secrets subsystem is self-contained per the exploration map).
- Produces: `LocalStorageProvider`, `useLocalStorage` — needed by Tasks 17 (WalletContext) and many UI tasks.

- [ ] **Step 1: Baseline**

Run: `npx jest __tests__/secrets`
Expected: all pass.

- [ ] **Step 2: Move source**

```bash
mkdir -p packages/expo-wallet-toolbox/core/services/secrets packages/expo-wallet-toolbox/core/context
git mv services/secrets/*.ts packages/expo-wallet-toolbox/core/services/secrets/
git mv context/LocalStorageProvider.tsx packages/expo-wallet-toolbox/core/context/LocalStorageProvider.tsx
```

- [ ] **Step 3: Move tests and fix imports**

```bash
mkdir -p packages/expo-wallet-toolbox/__tests__/secrets
git mv __tests__/secrets/*.ts packages/expo-wallet-toolbox/__tests__/secrets/
rmdir __tests__/secrets 2>/dev/null || true
```
Fix each test's imports to relative paths against `__tests__/secrets/`.

- [ ] **Step 4: Fix internal imports**

`LocalStorageProvider.tsx` wraps `services/secrets` — after the move that import becomes `../services/secrets/...` (adjust to the actual exported module name).

Run: `grep -rn "from '@/" packages/expo-wallet-toolbox/core/services/secrets packages/expo-wallet-toolbox/core/context/LocalStorageProvider.tsx`
Fix every hit.

- [ ] **Step 5: Append exports**

```ts
export { default as LocalStorageProvider, useLocalStorage } from './context/LocalStorageProvider'
```
(Adjust to the file's actual export shape — default vs named.)

- [ ] **Step 6: Run tests**

Run: `npx jest packages/expo-wallet-toolbox/__tests__/secrets`
Expected: same pass count as Step 1.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor(wallet-toolbox): move secrets storage and LocalStorageProvider into core"
```

---

### Task 9: Move UserContext + ExchangeRateContext

**Files:**
- Move: `context/UserContext.tsx` → `packages/expo-wallet-toolbox/core/context/UserContext.tsx`
- Move: `context/ExchangeRateContext.tsx` → `packages/expo-wallet-toolbox/core/context/ExchangeRateContext.tsx`
- Move: `services/exchangeRate.ts` → `packages/expo-wallet-toolbox/core/services/exchangeRate.ts`
- Modify: `packages/expo-wallet-toolbox/core/index.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks (both self-contained; no dedicated test files for either per the exploration map).
- Produces: `UserContextProvider`, `NativeHandlers` type, `UserContext`, `ExchangeRateContextProvider`, `ExchangeRateContext`, `getExchangeRate`.

- [ ] **Step 1: Move**

```bash
git mv context/UserContext.tsx packages/expo-wallet-toolbox/core/context/UserContext.tsx
git mv context/ExchangeRateContext.tsx packages/expo-wallet-toolbox/core/context/ExchangeRateContext.tsx
git mv services/exchangeRate.ts packages/expo-wallet-toolbox/core/services/exchangeRate.ts
```

- [ ] **Step 2: Fix internal imports**

`ExchangeRateContext.tsx` likely calls into `services/exchangeRate.ts` — after the move that's `../services/exchangeRate`.

Run: `grep -rn "from '@/" packages/expo-wallet-toolbox/core/context/UserContext.tsx packages/expo-wallet-toolbox/core/context/ExchangeRateContext.tsx packages/expo-wallet-toolbox/core/services/exchangeRate.ts`
Fix every hit.

- [ ] **Step 3: Append exports**

```ts
export { UserContextProvider, UserContext } from './context/UserContext'
export type { NativeHandlers } from './context/UserContext'
export { ExchangeRateContextProvider, ExchangeRateContext } from './context/ExchangeRateContext'
export { getExchangeRate } from './services/exchangeRate'
```

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit -p packages/expo-wallet-toolbox/tsconfig.json`
Expected: no new errors.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(wallet-toolbox): move UserContext and ExchangeRateContext into core"
```

---

### Task 10: Move pay rails

**Files:**
- Move: `utils/pay/rails/index.ts`, `address.ts`, `handle.ts`, `nearby.ts`, `sweeper.ts`, `proofNudge.ts`, `watchlist.ts` → `packages/expo-wallet-toolbox/core/pay/`
- Move: `utils/parsePeerPayURI.ts` → `packages/expo-wallet-toolbox/core/parsePeerPayURI.ts`
- Test: `__tests__/payRails.test.ts`, `payAddressRail.test.ts`, `payAddressDerivation.test.ts`, `payHandleRail.test.ts`, `payHandleInbox.test.ts`, `payNearbyRail.test.ts`, `paySweeper.test.ts`, `payWatchlist.test.ts`, `payerHold.test.ts`, `sendMaxSignerVerify.test.ts`, `verifyShadowRouting.test.ts` → `packages/expo-wallet-toolbox/__tests__/pay/`
- Modify: `packages/expo-wallet-toolbox/core/index.ts`

**Interfaces:**
- Consumes: `decodeSession` from localpay (Task 4), `StorageExpoSQLite`/offline-action helpers (Task 7), `TaskSendOffline` (Task 6).
- Produces: `PayCell` type, `isPayCell`, rail routing helpers, `wocConfigFor`, `SWEEP_INTERVAL_MS`/`runSweep`/`shouldSweepNow`/`sweptTotal`, `takeProofNudge`, watchlist helpers, `validatePeerPayURI` — needed directly by Task 17 (`WalletContext.tsx`) and by the `PayScreen` UI task (Task 21).

- [ ] **Step 1: Inventory**

Run: `ls utils/pay utils/pay/rails`
Confirm the file list against what's above; adjust if it differs.

- [ ] **Step 2: Baseline**

Run: `npx jest payRails payAddressRail payAddressDerivation payHandleRail payHandleInbox payNearbyRail paySweeper payWatchlist payerHold sendMaxSignerVerify verifyShadowRouting`
Expected: all pass.

- [ ] **Step 3: Move source**

```bash
mkdir -p packages/expo-wallet-toolbox/core/pay/rails
git mv utils/pay/rails/index.ts packages/expo-wallet-toolbox/core/pay/rails/index.ts
git mv utils/pay/rails/address.ts packages/expo-wallet-toolbox/core/pay/rails/address.ts
git mv utils/pay/rails/handle.ts packages/expo-wallet-toolbox/core/pay/rails/handle.ts
git mv utils/pay/rails/nearby.ts packages/expo-wallet-toolbox/core/pay/rails/nearby.ts
git mv utils/pay/sweeper.ts packages/expo-wallet-toolbox/core/pay/sweeper.ts
git mv utils/pay/proofNudge.ts packages/expo-wallet-toolbox/core/pay/proofNudge.ts
git mv utils/pay/watchlist.ts packages/expo-wallet-toolbox/core/pay/watchlist.ts
git mv utils/parsePeerPayURI.ts packages/expo-wallet-toolbox/core/parsePeerPayURI.ts
```

- [ ] **Step 4: Move tests and fix imports**

```bash
mkdir -p packages/expo-wallet-toolbox/__tests__/pay
git mv __tests__/payRails.test.ts packages/expo-wallet-toolbox/__tests__/pay/rails.test.ts
git mv __tests__/payAddressRail.test.ts packages/expo-wallet-toolbox/__tests__/pay/addressRail.test.ts
git mv __tests__/payAddressDerivation.test.ts packages/expo-wallet-toolbox/__tests__/pay/addressDerivation.test.ts
git mv __tests__/payHandleRail.test.ts packages/expo-wallet-toolbox/__tests__/pay/handleRail.test.ts
git mv __tests__/payHandleInbox.test.ts packages/expo-wallet-toolbox/__tests__/pay/handleInbox.test.ts
git mv __tests__/payNearbyRail.test.ts packages/expo-wallet-toolbox/__tests__/pay/nearbyRail.test.ts
git mv __tests__/paySweeper.test.ts packages/expo-wallet-toolbox/__tests__/pay/sweeper.test.ts
git mv __tests__/payWatchlist.test.ts packages/expo-wallet-toolbox/__tests__/pay/watchlist.test.ts
git mv __tests__/payerHold.test.ts packages/expo-wallet-toolbox/__tests__/pay/payerHold.test.ts
git mv __tests__/sendMaxSignerVerify.test.ts packages/expo-wallet-toolbox/__tests__/pay/sendMaxSignerVerify.test.ts
git mv __tests__/verifyShadowRouting.test.ts packages/expo-wallet-toolbox/__tests__/pay/verifyShadowRouting.test.ts
```
Fix each test's imports to relative paths against `__tests__/pay/`.

- [ ] **Step 5: Fix internal imports**

`rails/index.ts` imports `@bsv/sdk`, `../../localpay/session` (→ `../../localpay/session`, unchanged depth since both moved into sibling `core/` subfolders — verify with the grep below rather than assume), and `@/utils/parsePeerPayURI` (→ `../parsePeerPayURI`).

Run: `grep -rn "from '@/" packages/expo-wallet-toolbox/core/pay`
Fix every hit.

- [ ] **Step 6: Append exports**

```ts
export * from './pay/rails'
export * from './pay/rails/address'
export * from './pay/rails/handle'
export * from './pay/rails/nearby'
export * from './pay/sweeper'
export * from './pay/proofNudge'
export * from './pay/watchlist'
export { validatePeerPayURI } from './parsePeerPayURI'
```

- [ ] **Step 7: Run tests from new location**

Run: `npx jest packages/expo-wallet-toolbox/__tests__/pay`
Expected: same pass count as Step 2.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "refactor(wallet-toolbox): move pay rails into core"
```

---

### Task 11: Move header sync

**Files:**
- Move: every file under `utils/headers/` → `packages/expo-wallet-toolbox/core/headers/`
- Test: `__tests__/headerPrewarm.test.ts`, `headerStore.test.ts`, `syncHeaders.test.ts`, `offlineChaintracks.test.ts` (if not already moved in Task 5) → `packages/expo-wallet-toolbox/__tests__/headers/`
- Modify: `packages/expo-wallet-toolbox/core/index.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks (headers subsystem is self-contained per the exploration map).
- Produces: `HEADER_CHECKPOINTS`, `expoHeaderFs`, `HeaderStore`, `OfflineFirstChaintracks`, `prewarmOwnRoots`, `syncHeaders`, `HeaderSource` type — needed by Task 17 (`WalletContext.tsx`).

- [ ] **Step 1: Inventory + baseline**

Run: `ls utils/headers`
Run: `npx jest headerPrewarm headerStore syncHeaders offlineChaintracks`
Expected: all pass.

- [ ] **Step 2: Move source**

```bash
mkdir -p packages/expo-wallet-toolbox/core/headers
git mv utils/headers/*.ts packages/expo-wallet-toolbox/core/headers/
```

- [ ] **Step 3: Move tests and fix imports**

```bash
mkdir -p packages/expo-wallet-toolbox/__tests__/headers
git mv __tests__/headerPrewarm.test.ts packages/expo-wallet-toolbox/__tests__/headers/prewarm.test.ts
git mv __tests__/headerStore.test.ts packages/expo-wallet-toolbox/__tests__/headers/headerStore.test.ts
git mv __tests__/syncHeaders.test.ts packages/expo-wallet-toolbox/__tests__/headers/syncHeaders.test.ts
```
If `offlineChaintracks.test.ts` is still in root `__tests__/` (not moved by Task 5), move it here: `git mv __tests__/offlineChaintracks.test.ts packages/expo-wallet-toolbox/__tests__/headers/offlineChaintracks.test.ts`.

Fix each test's imports to relative paths against `__tests__/headers/`.

- [ ] **Step 4: Fix internal imports**

Run: `grep -rn "from '@/" packages/expo-wallet-toolbox/core/headers`
Fix every hit.

- [ ] **Step 5: Append exports**

Add one `export * from './headers/<file>'` line per file found in Step 1's `ls`, plus explicit named re-exports for anything Task 17 needs by exact name (`HEADER_CHECKPOINTS`, `expoHeaderFs`, `HeaderStore`, `OfflineFirstChaintracks`, `prewarmOwnRoots`, `syncHeaders`, `HeaderSource` type).

- [ ] **Step 6: Run tests**

Run: `npx jest packages/expo-wallet-toolbox/__tests__/headers`
Expected: same pass count as Step 1.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor(wallet-toolbox): move header sync into core"
```

---

### Task 12: Split shared/constants.ts

**Files:**
- Create: `packages/expo-wallet-toolbox/core/constants.ts`
- Modify: `shared/constants.ts` (delete the wallet-relevant exports that moved, delete the dead browser-only exports)
- Modify: `packages/expo-wallet-toolbox/core/index.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `DEFAULT_AUTO_APPROVE_THRESHOLD`, `AUTO_APPROVE_COOLDOWN_MS`, `AUTO_APPROVE_STORAGE_KEY`, `arcUrlStorageKey`, `arcApiTokenStorageKey`, `DEFAULT_ARC_URLS`, `KNOWN_ARC_URLS` — needed by Task 14 (`arcadeBroadcastProvider`) and Task 17 (`WalletContext.tsx`).

- [ ] **Step 1: Create the wallet-relevant constants file**

```ts
/** Auto-approve transactions below this satoshi amount without showing the spend modal */
export const DEFAULT_AUTO_APPROVE_THRESHOLD = 100_000
/** Minimum milliseconds between auto-approved transactions (global, origin-agnostic) */
export const AUTO_APPROVE_COOLDOWN_MS = 10_000
/** AsyncStorage key for persisted auto-approve threshold */
export const AUTO_APPROVE_STORAGE_KEY = 'autoApproveThreshold'

/** AsyncStorage key for custom ARC URL override (per network) */
export const arcUrlStorageKey = (network: string) => `arc_custom_url_${network}`
/** AsyncStorage key for custom ARC API token override (per network) */
export const arcApiTokenStorageKey = (network: string) => `arc_custom_api_token_${network}`

/** Default ARC URLs per network */
export const DEFAULT_ARC_URLS: Record<string, string> = {
  main: 'https://arcade-v2-us-1.bsvblockchain.tech',
  test: 'https://arcade-v2-testnet-us-1.bsvblockchain.tech',
  teratest: 'https://arcade-v2-ttn-us-1.bsvblockchain.tech'
}

/** Known ARC endpoint presets (mainnet-focused, user edits for other regions) */
export const KNOWN_ARC_URLS = [
  { label: 'Arcade v2 (default)', url: 'https://arcade-v2-us-1.bsvblockchain.tech', requiresToken: false },
  { label: 'Arcade', url: 'https://arcade-us-1.bsvb.tech', requiresToken: false },
  { label: 'TAAL', url: 'https://arc.taal.com', requiresToken: true },
  { label: 'GorillaPool', url: 'https://arc.gorillapool.io', requiresToken: false }
]
```
Save as `packages/expo-wallet-toolbox/core/constants.ts`.

- [ ] **Step 2: Strip `shared/constants.ts` down to nothing**

Every export currently in `shared/constants.ts` is either wallet-relevant (moved above) or a dead browser-only export unused since this repo's fork-time browser-chrome strip (`kNEW_TAB_URL`, `DEFAULT_HOMEPAGE_URL`, `ANDROID_MIN_BOTTOM_INSET`, `ADDRESS_BAR_HEIGHT`, `safeBottomInset`, `SearchEngine`, `SEARCH_ENGINES`, `DEFAULT_SEARCH_ENGINE_ID`). Before deleting, confirm the browser-only ones are truly unreferenced:

Run: `grep -rln "kNEW_TAB_URL\|DEFAULT_HOMEPAGE_URL\|ANDROID_MIN_BOTTOM_INSET\|ADDRESS_BAR_HEIGHT\|safeBottomInset\|SEARCH_ENGINES\|DEFAULT_SEARCH_ENGINE_ID" --include='*.ts' --include='*.tsx' . | grep -v shared/constants.ts | grep -v node_modules`
Expected: no output (confirms dead). If anything shows up, keep that export instead of deleting it and note why in the commit message.

Delete `shared/constants.ts` entirely (everything in it either moved to `core/constants.ts` or is confirmed dead):
```bash
git rm shared/constants.ts
rmdir shared 2>/dev/null || true
```

- [ ] **Step 3: Fix the one remaining consumer**

`context/WalletContext.tsx:64` currently reads `import { DEFAULT_AUTO_APPROVE_THRESHOLD, AUTO_APPROVE_COOLDOWN_MS, AUTO_APPROVE_STORAGE_KEY } from '@/shared/constants'`. It hasn't moved yet (that's Task 17) — update this one line now so the file keeps compiling: `from '@/shared/constants'` → `from '@bsv/expo-wallet-toolbox'` (the package has no `/core/constants` subpath — only `core/index.ts` and `ui/index.ts` are real entry points — so this goes through the top-level barrel, which Step 4 below re-exports these three names from).

Run: `grep -rln "shared/constants" --include='*.ts' --include='*.tsx' . | grep -v node_modules`
Fix every remaining hit the same way (there should be exactly one, in `WalletContext.tsx`, until Task 17 moves that file too — at which point its import becomes a same-package relative import instead).

- [ ] **Step 4: Append exports to the core barrel**

```ts
export * from './constants'
```

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors about missing `shared/constants` or `@/shared/constants`.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor(wallet-toolbox): split wallet constants into core, delete dead browser-only constants"
```

---

### Task 13: Move backup + the backup-push background task

**Files:**
- Move: every file under `utils/backup/` → `packages/expo-wallet-toolbox/core/backup/`
- Move: `utils/monitor/TaskBackupPush.ts` → `packages/expo-wallet-toolbox/core/monitor/TaskBackupPush.ts`
- Test: `__tests__/backupClient.test.ts`, `backupCodec.test.ts`, `backupDerive.test.ts`, `backupErase.test.ts`, `backupEstimate.test.ts`, `backupPreference.test.ts`, `backupPush.test.ts`, `backupRestore.test.ts`, `backupRestoreOnImport.test.ts`, `backupTask.test.ts` → `packages/expo-wallet-toolbox/__tests__/backup/`
- Modify: `packages/expo-wallet-toolbox/core/index.ts`

**Interfaces:**
- Consumes: `DEFAULT_BACKUP_URL` (Task 2, `core/config`).
- Produces: backup client/push/restore/erase/device-id/preference helpers, `BACKUP_CHAINS`, `TaskBackupPush` — needed by Task 17 (`WalletContext.tsx`) and the `WalletConfigScreen` UI task (Task 22).

- [ ] **Step 1: Inventory + baseline**

Run: `ls utils/backup`
Run: `npx jest backupClient backupCodec backupDerive backupErase backupEstimate backupPreference backupPush backupRestore backupRestoreOnImport backupTask`
Expected: all pass.

- [ ] **Step 2: Move source**

```bash
mkdir -p packages/expo-wallet-toolbox/core/backup
git mv utils/backup/*.ts packages/expo-wallet-toolbox/core/backup/
git mv utils/monitor/TaskBackupPush.ts packages/expo-wallet-toolbox/core/monitor/TaskBackupPush.ts
```

- [ ] **Step 3: Move tests and fix imports**

```bash
mkdir -p packages/expo-wallet-toolbox/__tests__/backup
git mv __tests__/backupClient.test.ts packages/expo-wallet-toolbox/__tests__/backup/client.test.ts
git mv __tests__/backupCodec.test.ts packages/expo-wallet-toolbox/__tests__/backup/codec.test.ts
git mv __tests__/backupDerive.test.ts packages/expo-wallet-toolbox/__tests__/backup/derive.test.ts
git mv __tests__/backupErase.test.ts packages/expo-wallet-toolbox/__tests__/backup/erase.test.ts
git mv __tests__/backupEstimate.test.ts packages/expo-wallet-toolbox/__tests__/backup/estimate.test.ts
git mv __tests__/backupPreference.test.ts packages/expo-wallet-toolbox/__tests__/backup/preference.test.ts
git mv __tests__/backupPush.test.ts packages/expo-wallet-toolbox/__tests__/backup/push.test.ts
git mv __tests__/backupRestore.test.ts packages/expo-wallet-toolbox/__tests__/backup/restore.test.ts
git mv __tests__/backupRestoreOnImport.test.ts packages/expo-wallet-toolbox/__tests__/backup/restoreOnImport.test.ts
git mv __tests__/backupTask.test.ts packages/expo-wallet-toolbox/__tests__/backup/task.test.ts
```
Fix each test's imports to relative paths against `__tests__/backup/`.

- [ ] **Step 4: Fix internal imports**

`TaskBackupPush.ts` imports `../backup/push` — unchanged relative structure once both live under `core/`. Its config import (`DEFAULT_BACKUP_URL`, if any) becomes `../config`.

Run: `grep -rn "from '@/" packages/expo-wallet-toolbox/core/backup packages/expo-wallet-toolbox/core/monitor/TaskBackupPush.ts`
Fix every hit.

- [ ] **Step 5: Append exports**

Add one `export * from './backup/<file>'` per file found in Step 1, plus:
```ts
export { TaskBackupPush } from './monitor/TaskBackupPush'
```

- [ ] **Step 6: Run tests**

Run: `npx jest packages/expo-wallet-toolbox/__tests__/backup`
Expected: same pass count as Step 1.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor(wallet-toolbox): move backup subsystem and TaskBackupPush into core"
```

---

### Task 14: Move services (wallet config, ARC broadcast, cap wallet args)

**Files:**
- Move: `services/walletServiceConfig.ts` → `packages/expo-wallet-toolbox/core/services/walletServiceConfig.ts`
- Move: `services/arcadeBroadcastProvider.ts` → `packages/expo-wallet-toolbox/core/services/arcadeBroadcastProvider.ts`
- Move: `services/capWalletArgs.ts` → `packages/expo-wallet-toolbox/core/services/capWalletArgs.ts`
- Test: `__tests__/walletServiceConfig.test.ts`, `arcadeBroadcastProvider.test.ts`, `capWalletArgs.test.ts` → `packages/expo-wallet-toolbox/__tests__/services/`
- Modify: `packages/expo-wallet-toolbox/core/index.ts`

**Interfaces:**
- Consumes: `DEFAULT_ARC_URLS`/`KNOWN_ARC_URLS` (Task 12, `core/constants`).
- Produces: `createServices`, `chaintracksUrlFor`, ARC broadcast provider factory, `capWalletArgs` — needed by Task 17 (`WalletContext.tsx`).

- [ ] **Step 1: Baseline**

Run: `npx jest walletServiceConfig arcadeBroadcastProvider capWalletArgs`
Expected: all pass.

- [ ] **Step 2: Move source**

```bash
git mv services/walletServiceConfig.ts packages/expo-wallet-toolbox/core/services/walletServiceConfig.ts
git mv services/arcadeBroadcastProvider.ts packages/expo-wallet-toolbox/core/services/arcadeBroadcastProvider.ts
git mv services/capWalletArgs.ts packages/expo-wallet-toolbox/core/services/capWalletArgs.ts
```

- [ ] **Step 3: Move tests and fix imports**

```bash
mkdir -p packages/expo-wallet-toolbox/__tests__/services
git mv __tests__/walletServiceConfig.test.ts packages/expo-wallet-toolbox/__tests__/services/walletServiceConfig.test.ts
git mv __tests__/arcadeBroadcastProvider.test.ts packages/expo-wallet-toolbox/__tests__/services/arcadeBroadcastProvider.test.ts
git mv __tests__/capWalletArgs.test.ts packages/expo-wallet-toolbox/__tests__/services/capWalletArgs.test.ts
```
Fix each test's imports to relative paths against `__tests__/services/`.

- [ ] **Step 4: Fix internal imports**

`arcadeBroadcastProvider.ts` imports `@/shared/constants` (`DEFAULT_ARC_URLS`/`KNOWN_ARC_URLS`) — now `../constants`.

Run: `grep -rn "from '@/" packages/expo-wallet-toolbox/core/services/walletServiceConfig.ts packages/expo-wallet-toolbox/core/services/arcadeBroadcastProvider.ts packages/expo-wallet-toolbox/core/services/capWalletArgs.ts`
Fix every hit.

- [ ] **Step 5: Append exports**

```ts
export { createServices, chaintracksUrlFor } from './services/walletServiceConfig'
export * from './services/arcadeBroadcastProvider'
export { capWalletArgs } from './services/capWalletArgs'
```
(Verify exact names against each file before finalizing.)

- [ ] **Step 6: Run tests**

Run: `npx jest packages/expo-wallet-toolbox/__tests__/services`
Expected: same pass count as Step 1.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor(wallet-toolbox): move wallet/ARC/capWalletArgs services into core"
```

---

### Task 15: Move the vault subsystem

**Files:**
- Move: every file under `services/vault/` → `packages/expo-wallet-toolbox/core/vault/`
- Test: everything under `__tests__/vault/` → `packages/expo-wallet-toolbox/__tests__/vault/`
- Modify: `packages/expo-wallet-toolbox/core/index.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks (vault is internally self-contained per the exploration map; its native `react-native-yubikey` dependency is structural/interface-only, already a peer dep from Task 1).
- Produces: `VaultDriver` interface, `getVaultDriver`, `ceremony`/`ceremonyHost` (incl. `VAULT_RETENTION_MS`), `VaultKeyService`, `k1` helpers, `sealing` helpers, `session` helpers, `transfers` (deposit/withdraw/sweep/reclaim), `vaultStore`, `vaultDerivation`, `vaultPassphrase`, `guardVaultAccess`, `recordBackupAttestation`, `VaultError` type — needed by Task 16 (`VaultContext`), Task 17 (`WalletContext.tsx`), and the vault/connections/pair UI tasks (23, 24).

- [ ] **Step 1: Inventory + baseline**

Run: `ls services/vault`
Run: `npx jest packages/expo-wallet-toolbox 2>/dev/null; npx jest __tests__/vault`
Expected: all pass.

- [ ] **Step 2: Move source**

```bash
mkdir -p packages/expo-wallet-toolbox/core/vault
git mv services/vault/*.ts packages/expo-wallet-toolbox/core/vault/
```

- [ ] **Step 3: Move tests and fix imports**

```bash
mkdir -p packages/expo-wallet-toolbox/__tests__/vault
git mv __tests__/vault/*.ts packages/expo-wallet-toolbox/__tests__/vault/
rmdir __tests__/vault 2>/dev/null || true
```
Fix each test's imports to relative paths against `__tests__/vault/`.

- [ ] **Step 4: Fix internal imports**

Run: `grep -rn "from '@/" packages/expo-wallet-toolbox/core/vault`
Fix every hit (expect mostly `@bsv/sdk` imports, which are untouched, plus a handful of intra-vault `@/services/vault/...` cross-imports that become plain relative `./...`).

- [ ] **Step 5: Append exports**

Add one `export * from './vault/<file>'` per file found in Step 1, plus explicit named re-exports for the interface surface listed in "Produces" above.

- [ ] **Step 6: Run tests**

Run: `npx jest packages/expo-wallet-toolbox/__tests__/vault`
Expected: same pass count as Step 1.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor(wallet-toolbox): move vault subsystem into core"
```

---

### Task 16: Move connection/pairing state + VaultContext + shared UI-feedback hooks

**Files:**
- Move: `stores/ConnectionStore.ts` → `packages/expo-wallet-toolbox/core/stores/ConnectionStore.ts`
- Move: `context/WalletConnectionContext.tsx` → `packages/expo-wallet-toolbox/core/context/WalletConnectionContext.tsx`
- Move: `context/VaultContext.tsx` → `packages/expo-wallet-toolbox/core/context/VaultContext.tsx`
- Move: `hooks/useHaptics.ts` → `packages/expo-wallet-toolbox/core/hooks/useHaptics.ts`
- Move: `hooks/useConfirmationSound.ts` → `packages/expo-wallet-toolbox/core/hooks/useConfirmationSound.ts`
- Test: `__tests__/useHaptics.test.ts`, `useConfirmationSound.test.ts` → `packages/expo-wallet-toolbox/__tests__/hooks/`
- Modify: `packages/expo-wallet-toolbox/core/index.ts`

**Interfaces:**
- Consumes: `ceremonyHost`/`ceremony` (Task 15, `core/vault`), `i18n` (Task 3).
- Produces: `connectionStore` (mobx store instance), `Connection` type, `WalletConnectionProvider`, `VaultProvider`, `haptics`, `useConfirmationSound` — needed by Task 17 (`WalletContext.tsx` does not use these directly, but `app/_layout.tsx` and several UI screens do).

`VaultContext.tsx` depends on `useConfirmationSound`/`useHaptics` — these are device-feedback hooks, not screen components, and a *core* context needs them, so they cannot live in the `ui` layer (core must never import from ui). That's why they move here instead of with a screen task.

- [ ] **Step 1: Baseline**

Run: `npx jest useHaptics.test.ts useConfirmationSound.test.ts`
Expected: pass.

- [ ] **Step 2: Move source**

```bash
mkdir -p packages/expo-wallet-toolbox/core/stores packages/expo-wallet-toolbox/core/hooks
git mv stores/ConnectionStore.ts packages/expo-wallet-toolbox/core/stores/ConnectionStore.ts
git mv context/WalletConnectionContext.tsx packages/expo-wallet-toolbox/core/context/WalletConnectionContext.tsx
git mv context/VaultContext.tsx packages/expo-wallet-toolbox/core/context/VaultContext.tsx
git mv hooks/useHaptics.ts packages/expo-wallet-toolbox/core/hooks/useHaptics.ts
git mv hooks/useConfirmationSound.ts packages/expo-wallet-toolbox/core/hooks/useConfirmationSound.ts
rmdir stores 2>/dev/null || true
```

- [ ] **Step 3: Move tests and fix imports**

```bash
mkdir -p packages/expo-wallet-toolbox/__tests__/hooks
git mv __tests__/useHaptics.test.ts packages/expo-wallet-toolbox/__tests__/hooks/useHaptics.test.ts
git mv __tests__/useConfirmationSound.test.ts packages/expo-wallet-toolbox/__tests__/hooks/useConfirmationSound.test.ts
```
Fix each test's imports to relative paths against `__tests__/hooks/`.

- [ ] **Step 4: Fix internal imports**

`VaultContext.tsx` imports `services/vault/ceremonyHost`, `services/vault/ceremony` (→ `../vault/ceremonyHost`, `../vault/ceremony`), `hooks/useConfirmationSound`, `hooks/useHaptics` (→ `../hooks/useConfirmationSound`, `../hooks/useHaptics`), `context/i18n/translations` (→ `../i18n/translations`).

`WalletConnectionContext.tsx` imports `stores/ConnectionStore` (→ `../stores/ConnectionStore`), `@bsv/sdk` (untouched).

Run: `grep -rn "from '@/" packages/expo-wallet-toolbox/core/context/WalletConnectionContext.tsx packages/expo-wallet-toolbox/core/context/VaultContext.tsx packages/expo-wallet-toolbox/core/stores/ConnectionStore.ts`
Fix every hit.

- [ ] **Step 5: Append exports**

```ts
export { default as connectionStore } from './stores/ConnectionStore'
export type { Connection } from './stores/ConnectionStore'
export { WalletConnectionProvider, useWalletConnection } from './context/WalletConnectionContext'
export { VaultProvider, useVault } from './context/VaultContext'
export { haptics } from './hooks/useHaptics'
export { useConfirmationSound } from './hooks/useConfirmationSound'
```
(Verify exact export names/shapes — default vs named, actual hook-consumer names like `useWalletConnection`/`useVault` — against each file before finalizing.)

- [ ] **Step 6: Run tests**

Run: `npx jest packages/expo-wallet-toolbox/__tests__/hooks`
Expected: same pass count as Step 1.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor(wallet-toolbox): move connection store, VaultContext, and device-feedback hooks into core"
```

---

### Task 17: Move WalletContext.tsx — the core hub

**Files:**
- Move: `context/WalletContext.tsx` → `packages/expo-wallet-toolbox/core/context/WalletContext.tsx`
- Move: `hooks/usePermissionQueue.ts` → `packages/expo-wallet-toolbox/core/hooks/usePermissionQueue.ts`
- Test: `__tests__/walletServiceConfig.test.ts` (already moved), any `walletBalanceSql`-adjacent context test — check `grep -rl "WalletContext" __tests__` for stragglers not yet covered by earlier tasks and move them here.
- Modify: `packages/expo-wallet-toolbox/core/index.ts`

**Interfaces:**
- Consumes: everything moved in Tasks 2–16 — `ceremonyHost`/`getVaultDriver`/`backupAttestation` (vault), `config` constants, `useLocalStorage`, `usePermissionQueue`, `createServices`/`chaintracksUrlFor`, `configureNewHeaderPolling`, `getExchangeRate`, `logWithTimestamp`, `recoverMnemonicWallet`, `StorageExpoSQLite`, `getRegisteredDbs`/`registerDb`/`selectLatestDb`, `getOnline`/`subscribeOnline`, `processPending` (localpay/pending), `TaskSendOffline`, `TaskBackupPush`, `pushOnce`/`restoreOnImport` (backup), `findOfflineActions`/`processOfflineActions` (storage), `wocConfigFor` (pay/rails/address), `SWEEP_INTERVAL_MS`/`runSweep`/`shouldSweepNow`/`sweptTotal` (pay/sweeper), `HEADER_CHECKPOINTS`/`expoHeaderFs`/`HeaderStore`/`OfflineFirstChaintracks`/`prewarmOwnRoots`/`syncHeaders`/`HeaderSource` (headers), `DEFAULT_AUTO_APPROVE_THRESHOLD`/`AUTO_APPROVE_COOLDOWN_MS`/`AUTO_APPROVE_STORAGE_KEY` (constants), `UserContext` (Task 9).
- Produces: `WalletContextProvider`, `useWallet` — this is the single most depended-on export in the whole package; every screen and `app/_layout.tsx` needs it.

This is the largest single file in the codebase (2452 lines, ~35 import lines). Take it slowly — this task is entirely import-path surgery, no logic changes.

- [ ] **Step 1: Baseline**

Run: `npx tsc --noEmit` (full repo — confirms the app compiles before this move)
Expected: no errors.

- [ ] **Step 2: Move**

```bash
git mv context/WalletContext.tsx packages/expo-wallet-toolbox/core/context/WalletContext.tsx
git mv hooks/usePermissionQueue.ts packages/expo-wallet-toolbox/core/hooks/usePermissionQueue.ts
```

- [ ] **Step 3: Fix internal imports**

Run: `grep -n "from '@/\|from '\./" packages/expo-wallet-toolbox/core/context/WalletContext.tsx`

Every `@/services/vault/...`, `@/utils/...`, `@/storage/...`, `@/shared/constants`, `@/hooks/usePermissionQueue`, `@/context/LocalStorageProvider` import becomes a relative path into its new sibling location under `core/` (e.g. `@/services/vault/driver` → `../vault/driver`; `@/utils/walletMonitor` → `../walletMonitor`; `@/storage` → `../storage`; `@/shared/constants` → `../constants`; `@/hooks/usePermissionQueue` → `../hooks/usePermissionQueue`; `@/context/LocalStorageProvider` → `./LocalStorageProvider`, since both now live in `core/context/`). The two already-relative imports, `import type { AppChain } from './config'` and `from './config'`, become `../config` (one level up — `config.tsx` lives at `core/`, not `core/context/`). `import { UserContext } from './UserContext'` becomes `./UserContext` unchanged (both are siblings in `core/context/`).

Fix every import line the grep surfaces. Re-run the grep until it returns only `@bsv/*`, `expo-*`, `react*`, and other node_modules imports (all untouched).

- [ ] **Step 4: Fix `hooks/usePermissionQueue.ts`'s own imports**

Run: `grep -n "from '@/" packages/expo-wallet-toolbox/core/hooks/usePermissionQueue.ts`
Fix any hit.

- [ ] **Step 5: Append exports**

```ts
export { WalletContextProvider, useWallet } from './context/WalletContext'
export { usePermissionQueue } from './hooks/usePermissionQueue'
```

- [ ] **Step 6: Type-check the package in isolation**

Run: `npx tsc --noEmit -p packages/expo-wallet-toolbox/tsconfig.json`
Expected: no errors. This is the first point where the whole `core/` tree type-checks as a self-contained unit — treat any error here as a real bug in an earlier task's import fix, not something to patch around.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor(wallet-toolbox): move WalletContext into core"
```

---

### Task 18: Finish the core barrel, wire the root app to it, dogfood checkpoint

**Files:**
- Modify: `app/_layout.tsx`
- Modify: `app/index.tsx:53-54` (the direct `storage/methods` bypass the spec calls out)
- Modify: `app/pay.tsx:36` (same bypass)
- Modify: `packages/expo-wallet-toolbox/core/index.ts` (final pass — ensure every name any remaining `app/`/`components/`/`hooks/` file needs is actually exported)

**Interfaces:**
- Consumes: the complete `core/index.ts` barrel built up across Tasks 1–17.
- Produces: nothing new — this task proves the barrel is complete and correct by making the whole app compile and run against it.

- [ ] **Step 1: Rewire `app/_layout.tsx`**

Replace every `@/context/...` and `../context/...` import that now points at a moved file with a single import from the package:

```ts
import {
  UserContextProvider,
  type NativeHandlers,
  WalletContextProvider,
  useWallet,
  ExchangeRateContextProvider,
  ThemeProvider,
  LocalStorageProvider,
  VaultProvider,
  LanguageProvider,
  WalletConnectionProvider
} from '@bsv/expo-wallet-toolbox'
```
Remove the now-dead individual `@/context/...` import lines this replaces. Leave everything else in the file untouched (it doesn't otherwise reference moved code — `components/ui/*`, `components/vault/VaultCeremonySheet`, `hooks/useDeepLinking` all stay app-level per the spec).

- [ ] **Step 2: Fix `app/index.tsx`'s storage bypass**

Change:
```ts
import { findOfflineActions, type OfflineActionRow } from '@/storage/methods/offlineActions'
import { readWalletBalance } from '@/storage/methods/walletBalanceSql'
```
to:
```ts
import { findOfflineActions, type OfflineActionRow, readWalletBalance } from '@bsv/expo-wallet-toolbox'
```
Also update every other `@/context/...`, `@/utils/...`, `@/services/...`, `@/storage`, `@/shared/constants` import in this file to the package import — check with `grep -n "from '@/" app/index.tsx` and resolve each against the barrel built in Tasks 1–17.

- [ ] **Step 3: Fix `app/pay.tsx`'s storage bypass**

Change:
```ts
import { findOfflineActions, type OfflineActionRow } from '@/storage/methods/offlineActions'
```
to:
```ts
import { findOfflineActions, type OfflineActionRow } from '@bsv/expo-wallet-toolbox'
```
Also resolve every other now-broken `@/` import in this file the same way.

- [ ] **Step 4: Sweep the rest of the app for stale imports**

Run: `grep -rln "from '@/context/\|from '@/services/\|from '@/storage\|from '@/shared/constants\|from '@/utils/mnemonicWallet\|from '@/utils/walletDbRegistry\|from '@/utils/walletMonitor\|from '@/utils/net/\|from '@/utils/logging\|from '@/utils/diskSpace\|from '@/utils/localpay\|from '@/utils/peerpay\|from '@/utils/pay\|from '@/utils/headers\|from '@/utils/offline\|from '@/utils/backup\|from '@/utils/monitor\|from '@/utils/parsePeerPayURI\|from '@/hooks/useHaptics\|from '@/hooks/useConfirmationSound\|from '@/hooks/usePermissionQueue\|from '@/stores/ConnectionStore" app components hooks --include='*.ts' --include='*.tsx'`

Every file this lists still needs fixing (it's UI-layer code the later UI tasks haven't moved yet, but it references something that already moved to core) — update each hit to import from `@bsv/expo-wallet-toolbox` instead. This is expected to be a non-trivial list (most of `components/wallet`, `components/pay`, `components/vault`, the remaining `app/*.tsx` screens) — work through it file by file.

- [ ] **Step 5: Full test suite**

Run: `npx jest`
Expected: all tests pass — this is the CORE PHASE DOGFOOD CHECKPOINT. Any failure here means an earlier task's import fix or barrel export was wrong; fix it in place (don't proceed to UI-phase tasks with a broken core).

- [ ] **Step 6: Type-check the whole repo**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Manual smoke test**

Start the app (`npm run ios` or the simulator workflow already in use for this project) and confirm: wallet home screen loads and shows balance, the wallet-config screen opens, a local-payment QR/nearby flow initiates without crashing. This proves the provider tree still wires up correctly at runtime, not just at compile/test time.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "refactor(wallet-toolbox): wire root app to @bsv/expo-wallet-toolbox core, fix storage bypass imports"
```

---

### Task 19: Move shared UI primitives (components/ui, components/security)

**Files:**
- Move: every file under `components/ui/` → `packages/expo-wallet-toolbox/ui/components/ui/`
- Move: every file under `components/security/` → `packages/expo-wallet-toolbox/ui/components/security/`
- Test: `__tests__/AlertCard.test.tsx`, `Celebration.test.tsx`, `PresenceRow.test.tsx`, `PressableScale.test.tsx`, `Toast.test.tsx` → `packages/expo-wallet-toolbox/__tests__/ui/`
- Modify: `packages/expo-wallet-toolbox/ui/index.ts`

**Interfaces:**
- Consumes: `useTheme`/`spacing`/`radii`/`typography` (Task 3, core), `haptics` (Task 16, core).
- Produces: every primitive component (`PressableScale`, `ScreenGradient`, `GroupedList`/`GroupedSection`/`ListRow`, `AlertCard`/`showAlert`/`AlertHost`, `Toast`/`showToast`/`ToastHost`, `PermissionSheet`, `ErrorBoundary`, `Celebration`, `PresenceRow`, `WalletLockNotice`) — needed by nearly every screen task that follows.

- [ ] **Step 1: Inventory + baseline**

Run: `ls components/ui components/security`
Run: `npx jest AlertCard.test.tsx Celebration.test.tsx PresenceRow.test.tsx PressableScale.test.tsx Toast.test.tsx`
Expected: all pass.

- [ ] **Step 2: Move source**

```bash
mkdir -p packages/expo-wallet-toolbox/ui/components/ui packages/expo-wallet-toolbox/ui/components/security
git mv components/ui/*.tsx packages/expo-wallet-toolbox/ui/components/ui/
git mv components/security/*.tsx packages/expo-wallet-toolbox/ui/components/security/
```
(If any `.ts` — not `.tsx` — files also live in those directories, include them in the `git mv` glob too.)

- [ ] **Step 3: Move tests and fix imports**

```bash
mkdir -p packages/expo-wallet-toolbox/__tests__/ui
git mv __tests__/AlertCard.test.tsx packages/expo-wallet-toolbox/__tests__/ui/AlertCard.test.tsx
git mv __tests__/Celebration.test.tsx packages/expo-wallet-toolbox/__tests__/ui/Celebration.test.tsx
git mv __tests__/PresenceRow.test.tsx packages/expo-wallet-toolbox/__tests__/ui/PresenceRow.test.tsx
git mv __tests__/PressableScale.test.tsx packages/expo-wallet-toolbox/__tests__/ui/PressableScale.test.tsx
git mv __tests__/Toast.test.tsx packages/expo-wallet-toolbox/__tests__/ui/Toast.test.tsx
```
Fix each test's imports to relative paths against `__tests__/ui/`.

- [ ] **Step 4: Fix internal imports**

Run: `grep -rn "from '@/" packages/expo-wallet-toolbox/ui/components/ui packages/expo-wallet-toolbox/ui/components/security`
Fix every hit — `@/context/theme/...` becomes `@bsv/expo-wallet-toolbox` (cross-package import into `core`, since `ui` is allowed to depend on `core`), `@/hooks/useHaptics` likewise becomes `@bsv/expo-wallet-toolbox`, intra-`components/ui` cross-imports become relative.

- [ ] **Step 5: Append exports to the ui barrel**

Add an `export * from './components/ui/<File>'` / `export * from './components/security/<File>'` line per file, matching each component's actual named/default export shape.

- [ ] **Step 6: Run tests**

Run: `npx jest packages/expo-wallet-toolbox/__tests__/ui`
Expected: same pass count as Step 1.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor(wallet-toolbox): move shared UI primitives into ui"
```

---

### Task 20: Move wallet home screen

**Files:**
- Move: every file under `components/wallet/` → `packages/expo-wallet-toolbox/ui/components/wallet/`
- Move: `utils/amountFormatHelpers.ts` → `packages/expo-wallet-toolbox/ui/amountFormatHelpers.ts`
- Move: `utils/exportTransactions.ts` → `packages/expo-wallet-toolbox/ui/exportTransactions.ts`
- Create: `packages/expo-wallet-toolbox/ui/screens/WalletHomeScreen.tsx` (extracted from `app/index.tsx`)
- Modify: `app/index.tsx` (becomes a thin wrapper)
- Test: `__tests__/generalHelpers.test.ts` (if it tests amountFormatHelpers — check first) → `packages/expo-wallet-toolbox/__tests__/ui/`
- Modify: `packages/expo-wallet-toolbox/ui/index.ts`

**Interfaces:**
- Consumes: `useWallet`, `useTheme`, `useTranslation`/i18n, `ExchangeRateContext`, `useLocalStorage`, `findOfflineActions`, `readWalletBalance` (all from `@bsv/expo-wallet-toolbox`), plus `PressableScale`/`ScreenGradient`/`showToast`/`WalletLockNotice` (Task 19, `@bsv/expo-wallet-toolbox/ui`).
- Produces: `WalletHomeScreen` component.

- [ ] **Step 1: Inventory + baseline**

Run: `ls components/wallet`
Run: `grep -rl "amountFormatHelpers" __tests__/*.test.ts`
Run: `npx jest <whichever test file(s) the grep above found>`
Expected: pass (if none found, skip — `amountFormatHelpers.ts` may have no dedicated test).

- [ ] **Step 2: Move source**

```bash
mkdir -p packages/expo-wallet-toolbox/ui/components/wallet packages/expo-wallet-toolbox/ui/screens
git mv components/wallet/*.tsx packages/expo-wallet-toolbox/ui/components/wallet/
git mv utils/amountFormatHelpers.ts packages/expo-wallet-toolbox/ui/amountFormatHelpers.ts
git mv utils/exportTransactions.ts packages/expo-wallet-toolbox/ui/exportTransactions.ts
```

- [ ] **Step 3: Extract the screen component**

`app/index.tsx` (861 lines) is currently an expo-router route file whose default export is the screen. Read it in full, then create `packages/expo-wallet-toolbox/ui/screens/WalletHomeScreen.tsx` containing everything from the file except the route-specific bits — rename the default-exported function from whatever it's currently called to `WalletHomeScreen`, export it as a named export (not default — `ui/index.ts` re-exports it by name), and fix every import per Step 4 below. This step is a straight copy of the component body — no logic changes.

- [ ] **Step 4: Fix imports in the extracted screen + moved components**

Run: `grep -rn "from '@/" packages/expo-wallet-toolbox/ui/screens/WalletHomeScreen.tsx packages/expo-wallet-toolbox/ui/components/wallet packages/expo-wallet-toolbox/ui/amountFormatHelpers.ts packages/expo-wallet-toolbox/ui/exportTransactions.ts`

Fix each hit: anything from `context/`, `storage`, `shared/constants`, `utils/mnemonicWallet` etc. (core-layer) becomes `from '@bsv/expo-wallet-toolbox'`; anything from `components/ui`, `components/wallet`, `components/security` (ui-layer) becomes `from '@bsv/expo-wallet-toolbox/ui'` or a relative path if it's a same-directory sibling; `router` from `expo-router` stays untouched (a peer dep, not something we own).

- [ ] **Step 5: Rewrite `app/index.tsx` as a thin wrapper**

```ts
export { WalletHomeScreen as default } from '@bsv/expo-wallet-toolbox/ui'
```

- [ ] **Step 6: Move/fix the amountFormatHelpers test (if one exists)**

If Step 1 found a test file covering `amountFormatHelpers`, `git mv` it into `packages/expo-wallet-toolbox/__tests__/ui/` and fix its import.

- [ ] **Step 7: Append exports to the ui barrel**

```ts
export { WalletHomeScreen } from './screens/WalletHomeScreen'
```
Plus one `export * from './components/wallet/<File>'` per file moved in Step 2, plus `export * from './amountFormatHelpers'` and `export { exportTransactionsAsCsv } from './exportTransactions'`.

- [ ] **Step 8: Run tests + type-check**

Run: `npx jest packages/expo-wallet-toolbox/__tests__/ui && npx tsc --noEmit -p packages/expo-wallet-toolbox/tsconfig.json`
Expected: pass, no errors.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "refactor(wallet-toolbox): extract WalletHomeScreen into ui"
```

---

### Task 21: Move pay screen + local-payment UI

**Files:**
- Move: every file under `components/pay/` → `packages/expo-wallet-toolbox/ui/components/pay/`
- Move: every file under `components/localpay/` → `packages/expo-wallet-toolbox/ui/components/localpay/`
- Move: `hooks/useOnline.ts` → `packages/expo-wallet-toolbox/ui/hooks/useOnline.ts`
- Create: `packages/expo-wallet-toolbox/ui/screens/PayScreen.tsx` (extracted from `app/pay.tsx`)
- Modify: `app/pay.tsx`, `app/legacy-payments.tsx`, `app/payments.tsx`, `app/local-payments.tsx` (redirect targets stay app-level per the spec — only `pay.tsx` becomes a wrapper)
- Test: `__tests__/payFormComponents.test.tsx`, `payReceivedOverlay.test.tsx`, `payScreen.test.tsx`, `useOnline.test.ts` → `packages/expo-wallet-toolbox/__tests__/ui/`
- Modify: `packages/expo-wallet-toolbox/ui/index.ts`

**Interfaces:**
- Consumes: `isPayCell`/`PayCell`/`wocConfigFor`/rail helpers (Task 10, core), `validatePeerPayURI` (Task 10, core), `takeProofNudge` (Task 10, core), `TaskSendOffline` (Task 6, core), `findOfflineActions` (Task 7, core), `useWallet` (Task 17, core), plus `PressableScale`/`showToast` etc. (Task 19, ui).
- Produces: `PayScreen` component, `useOnline` hook.

- [ ] **Step 1: Inventory + baseline**

Run: `ls components/pay components/localpay`
Run: `npx jest payFormComponents payReceivedOverlay payScreen useOnline.test.ts`
Expected: all pass.

- [ ] **Step 2: Move source**

```bash
mkdir -p packages/expo-wallet-toolbox/ui/components/pay packages/expo-wallet-toolbox/ui/components/localpay packages/expo-wallet-toolbox/ui/hooks
git mv components/pay/*.tsx packages/expo-wallet-toolbox/ui/components/pay/
git mv components/localpay/*.tsx packages/expo-wallet-toolbox/ui/components/localpay/
git mv hooks/useOnline.ts packages/expo-wallet-toolbox/ui/hooks/useOnline.ts
```
(Include any `.ts` non-component helper files in those directories in the `git mv` glob too — check with the Step 1 `ls`.)

- [ ] **Step 3: Extract the screen component**

Read `app/pay.tsx` (361 lines) in full. Create `packages/expo-wallet-toolbox/ui/screens/PayScreen.tsx` with the same content, renamed to a named export `PayScreen`, imports fixed per Step 4.

- [ ] **Step 4: Fix imports**

Run: `grep -rn "from '@/" packages/expo-wallet-toolbox/ui/screens/PayScreen.tsx packages/expo-wallet-toolbox/ui/components/pay packages/expo-wallet-toolbox/ui/components/localpay packages/expo-wallet-toolbox/ui/hooks/useOnline.ts`
Fix each hit the same way as Task 20 Step 4 (core-layer things → `@bsv/expo-wallet-toolbox`, ui-layer things → `@bsv/expo-wallet-toolbox/ui` or relative).

- [ ] **Step 5: Rewrite `app/pay.tsx`**

```ts
export { PayScreen as default } from '@bsv/expo-wallet-toolbox/ui'
```

- [ ] **Step 6: Move tests and fix imports**

```bash
mkdir -p packages/expo-wallet-toolbox/__tests__/ui
git mv __tests__/payFormComponents.test.tsx packages/expo-wallet-toolbox/__tests__/ui/payFormComponents.test.tsx
git mv __tests__/payReceivedOverlay.test.tsx packages/expo-wallet-toolbox/__tests__/ui/payReceivedOverlay.test.tsx
git mv __tests__/payScreen.test.tsx packages/expo-wallet-toolbox/__tests__/ui/payScreen.test.tsx
git mv __tests__/useOnline.test.ts packages/expo-wallet-toolbox/__tests__/ui/useOnline.test.ts
```
Fix each test's imports.

- [ ] **Step 7: Append exports to the ui barrel**

```ts
export { PayScreen } from './screens/PayScreen'
export { useOnline } from './hooks/useOnline'
```
Plus one `export * from './components/pay/<File>'` and `export * from './components/localpay/<File>'` per file moved in Step 2.

- [ ] **Step 8: Run tests + type-check**

Run: `npx jest packages/expo-wallet-toolbox/__tests__/ui && npx tsc --noEmit -p packages/expo-wallet-toolbox/tsconfig.json`
Expected: pass, no errors.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "refactor(wallet-toolbox): extract PayScreen and local-payment UI into ui"
```

---

### Task 22: Move settings + wallet-config screens

**Files:**
- Move: `utils/exportDatabases.ts`, `utils/importDatabases.ts`, `utils/printRecoveryShares.ts` → `packages/expo-wallet-toolbox/ui/`
- Create: `packages/expo-wallet-toolbox/ui/screens/SettingsScreen.tsx` (extracted from `app/settings.tsx`)
- Create: `packages/expo-wallet-toolbox/ui/screens/WalletConfigScreen.tsx` (extracted from `app/wallet-config.tsx`)
- Modify: `app/settings.tsx`, `app/wallet-config.tsx` (become thin wrappers)
- Test: `__tests__/backupShares.test.ts` (if it covers `printRecoveryShares` — check first) → `packages/expo-wallet-toolbox/__tests__/ui/`
- Modify: `packages/expo-wallet-toolbox/ui/index.ts`

**Interfaces:**
- Consumes: `useWallet`, `useTheme`, `config` exports, `constants` exports (Task 12), `recoverMnemonicWallet` (Task 2), `TaskBackupPush`/backup preference/constants/erase helpers (Task 13), `LocalStorageProvider` (Task 8) — all from `@bsv/expo-wallet-toolbox`; `GroupedSection`/`ListRow`/`showAlert`/`showToast`/`AmountDisplay` from `@bsv/expo-wallet-toolbox/ui`.
- Produces: `SettingsScreen`, `WalletConfigScreen` components.

- [ ] **Step 1: Baseline**

Run: `grep -rl "printRecoveryShares" __tests__/*.test.ts`
Run: `npx jest <whichever file(s) found>` (if any)

- [ ] **Step 2: Move source**

```bash
git mv utils/exportDatabases.ts packages/expo-wallet-toolbox/ui/exportDatabases.ts
git mv utils/importDatabases.ts packages/expo-wallet-toolbox/ui/importDatabases.ts
git mv utils/printRecoveryShares.ts packages/expo-wallet-toolbox/ui/printRecoveryShares.ts
```

- [ ] **Step 3: Extract both screens**

Read `app/settings.tsx` (164 lines) and `app/wallet-config.tsx` (872 lines) in full. Create `packages/expo-wallet-toolbox/ui/screens/SettingsScreen.tsx` and `packages/expo-wallet-toolbox/ui/screens/WalletConfigScreen.tsx` with the same content, renamed to named exports, imports fixed per Step 4.

- [ ] **Step 4: Fix imports**

Run: `grep -rn "from '@/" packages/expo-wallet-toolbox/ui/screens/SettingsScreen.tsx packages/expo-wallet-toolbox/ui/screens/WalletConfigScreen.tsx packages/expo-wallet-toolbox/ui/exportDatabases.ts packages/expo-wallet-toolbox/ui/importDatabases.ts packages/expo-wallet-toolbox/ui/printRecoveryShares.ts`

Fix each hit. Note `importDatabases.ts` imports `i18n` directly (not via the `useTranslation` hook) and `components/ui/AlertCard`/`Toast` — both become `@bsv/expo-wallet-toolbox` and `@bsv/expo-wallet-toolbox/ui` respectively.

- [ ] **Step 5: Rewrite the two app route files**

`app/settings.tsx`:
```ts
export { SettingsScreen as default } from '@bsv/expo-wallet-toolbox/ui'
```

`app/wallet-config.tsx`:
```ts
export { WalletConfigScreen as default } from '@bsv/expo-wallet-toolbox/ui'
```

- [ ] **Step 6: Move/fix the recovery-shares test (if one exists)**

If Step 1 found a covering test, `git mv` it into `packages/expo-wallet-toolbox/__tests__/ui/` and fix its import.

- [ ] **Step 7: Append exports to the ui barrel**

```ts
export { SettingsScreen } from './screens/SettingsScreen'
export { WalletConfigScreen } from './screens/WalletConfigScreen'
export { exportAllWalletDatabases } from './exportDatabases'
export { importWalletDatabase } from './importDatabases'
export { printRecoveryShares } from './printRecoveryShares'
```

- [ ] **Step 8: Run tests + type-check**

Run: `npx jest packages/expo-wallet-toolbox/__tests__/ui && npx tsc --noEmit -p packages/expo-wallet-toolbox/tsconfig.json`
Expected: pass, no errors.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "refactor(wallet-toolbox): extract SettingsScreen and WalletConfigScreen into ui"
```

---

### Task 23: Move vault screens

**Files:**
- Move: every file under `components/vault/` → `packages/expo-wallet-toolbox/ui/components/vault/`
- Move: `hooks/useVaultBalance.ts` → `packages/expo-wallet-toolbox/ui/hooks/useVaultBalance.ts`
- Create: `packages/expo-wallet-toolbox/ui/screens/VaultScreen.tsx`, `VaultRecoverScreen.tsx`, `VaultTransferScreen.tsx` (extracted from `app/vault.tsx`, `app/vault-recover.tsx`, `app/vault-transfer.tsx`)
- Modify: `app/vault.tsx`, `app/vault-recover.tsx`, `app/vault-transfer.tsx` (become thin wrappers)
- Test: `__tests__/useVaultBalance.test.ts` → `packages/expo-wallet-toolbox/__tests__/ui/`
- Modify: `packages/expo-wallet-toolbox/ui/index.ts`

**Interfaces:**
- Consumes: vault subsystem exports (Task 15, core), `useWallet` (Task 17, core), `i18n` singleton (Task 3, core), `GroupedSection`/`ListRow`/`AmountDisplay`/`AmountInput`/`showAlert`/`showToast`/`haptics` (Task 19/20/16).
- Produces: `VaultScreen`, `VaultRecoverScreen`, `VaultTransferScreen`, `useVaultBalance`.

- [ ] **Step 1: Inventory + baseline**

Run: `ls components/vault`
Run: `npx jest useVaultBalance.test.ts`
Expected: passes.

- [ ] **Step 2: Move source**

```bash
mkdir -p packages/expo-wallet-toolbox/ui/components/vault
git mv components/vault/*.tsx packages/expo-wallet-toolbox/ui/components/vault/
git mv hooks/useVaultBalance.ts packages/expo-wallet-toolbox/ui/hooks/useVaultBalance.ts
```
Note: `VaultCeremonySheet.tsx` — check whether it's under `components/vault/`. Per `app/_layout.tsx`'s import (`@/components/vault/VaultCeremonySheet`), it is used at the app-shell level alongside `PermissionSheet`/`ToastHost`. It still belongs in the package (it's vault UI, reusable the same as the screens), but `app/_layout.tsx` keeps rendering it — just via the package import: `import { VaultCeremonySheet } from '@bsv/expo-wallet-toolbox/ui'` (fold this one-line `_layout.tsx` fix into this task's Step 6).

- [ ] **Step 3: Extract the three screens**

Read `app/vault.tsx` (333 lines), `app/vault-recover.tsx` (184 lines), `app/vault-transfer.tsx` (247 lines) in full. Create the three screen files under `packages/expo-wallet-toolbox/ui/screens/`, renamed to named exports, imports fixed per Step 4.

- [ ] **Step 4: Fix imports**

Run: `grep -rn "from '@/" packages/expo-wallet-toolbox/ui/screens/VaultScreen.tsx packages/expo-wallet-toolbox/ui/screens/VaultRecoverScreen.tsx packages/expo-wallet-toolbox/ui/screens/VaultTransferScreen.tsx packages/expo-wallet-toolbox/ui/components/vault packages/expo-wallet-toolbox/ui/hooks/useVaultBalance.ts`

Fix each hit — note `app/vault.tsx`/`vault-recover.tsx`/`vault-transfer.tsx` import `i18n` directly (`import i18n from '@/context/i18n/translations'`) rather than via the `useTranslation` hook; this becomes `import { i18n } from '@bsv/expo-wallet-toolbox'`.

- [ ] **Step 5: Rewrite the three app route files**

```ts
export { VaultScreen as default } from '@bsv/expo-wallet-toolbox/ui'
```
```ts
export { VaultRecoverScreen as default } from '@bsv/expo-wallet-toolbox/ui'
```
```ts
export { VaultTransferScreen as default } from '@bsv/expo-wallet-toolbox/ui'
```
(One line each, in `app/vault.tsx`, `app/vault-recover.tsx`, `app/vault-transfer.tsx` respectively.)

- [ ] **Step 6: Fix `app/_layout.tsx`'s VaultCeremonySheet import**

Change `import { VaultCeremonySheet } from '@/components/vault/VaultCeremonySheet'` to `import { VaultCeremonySheet } from '@bsv/expo-wallet-toolbox/ui'`.

- [ ] **Step 7: Move test and fix import**

```bash
git mv __tests__/useVaultBalance.test.ts packages/expo-wallet-toolbox/__tests__/ui/useVaultBalance.test.ts
```
Fix its import.

- [ ] **Step 8: Append exports to the ui barrel**

```ts
export { VaultScreen } from './screens/VaultScreen'
export { VaultRecoverScreen } from './screens/VaultRecoverScreen'
export { VaultTransferScreen } from './screens/VaultTransferScreen'
export { useVaultBalance } from './hooks/useVaultBalance'
```
Plus one `export * from './components/vault/<File>'` per file moved in Step 2, including `VaultCeremonySheet`.

- [ ] **Step 9: Run tests + type-check**

Run: `npx jest packages/expo-wallet-toolbox/__tests__/ui && npx tsc --noEmit -p packages/expo-wallet-toolbox/tsconfig.json`
Expected: pass, no errors.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "refactor(wallet-toolbox): extract vault screens into ui"
```

---

### Task 24: Move connections + pair screens

**Files:**
- Move: `components/QRScanner.tsx` → `packages/expo-wallet-toolbox/ui/components/QRScanner.tsx`
- Create: `packages/expo-wallet-toolbox/ui/screens/ConnectionsScreen.tsx`, `PairScreen.tsx` (extracted from `app/connections.tsx`, `app/pair.tsx`)
- Modify: `app/connections.tsx`, `app/pair.tsx` (become thin wrappers)
- Modify: `packages/expo-wallet-toolbox/ui/index.ts`

**Interfaces:**
- Consumes: `guardVaultAccess` (Task 15, core), `capWalletArgs` (Task 14, core), `ADMIN_ORIGINATOR` (Task 2, core), `connectionStore`/`Connection` (Task 16, core), `useWalletConnection` (Task 16, core), `useWallet` (Task 17, core), `GroupedSection`/`ListRow`/`showToast` (Task 19, ui).
- Produces: `ConnectionsScreen`, `PairScreen`, `QRScanner`.

- [ ] **Step 1: Baseline**

`app/pair.tsx` has no dedicated test per the exploration map's screen grep (only `pair.test.tsx` exists but check what it actually covers — it may test a `pair` component, not the screen file itself).

Run: `grep -n "^import" __tests__/pair.test.tsx`
If it imports `app/pair` or a moved component, note it for Step 6; otherwise it's unrelated and stays where it is.

- [ ] **Step 2: Move source**

```bash
git mv components/QRScanner.tsx packages/expo-wallet-toolbox/ui/components/QRScanner.tsx
```

- [ ] **Step 3: Extract the two screens**

Read `app/connections.tsx` (380 lines) and `app/pair.tsx` (266 lines) in full. Create the two screen files under `packages/expo-wallet-toolbox/ui/screens/`, renamed to named exports, imports fixed per Step 4.

- [ ] **Step 4: Fix imports**

Run: `grep -rn "from '@/" packages/expo-wallet-toolbox/ui/screens/ConnectionsScreen.tsx packages/expo-wallet-toolbox/ui/screens/PairScreen.tsx packages/expo-wallet-toolbox/ui/components/QRScanner.tsx`
Fix each hit — `@/stores/ConnectionStore` becomes `@bsv/expo-wallet-toolbox` (it's `connectionStore` from Task 16), `expo-secure-store` stays untouched (npm dep).

- [ ] **Step 5: Rewrite the two app route files**

```ts
export { ConnectionsScreen as default } from '@bsv/expo-wallet-toolbox/ui'
```
```ts
export { PairScreen as default } from '@bsv/expo-wallet-toolbox/ui'
```

- [ ] **Step 6: Handle `__tests__/pair.test.tsx` if Step 1 found it relevant**

If it covers the screen or `QRScanner`, `git mv` it to `packages/expo-wallet-toolbox/__tests__/ui/pair.test.tsx` and fix its imports; otherwise leave it in place.

- [ ] **Step 7: Append exports to the ui barrel**

```ts
export { ConnectionsScreen } from './screens/ConnectionsScreen'
export { PairScreen } from './screens/PairScreen'
export { default as QRScanner } from './components/QRScanner'
```
(Verify `QRScanner`'s actual export shape.)

- [ ] **Step 8: Test + type-check**

Run: `npx jest packages/expo-wallet-toolbox/__tests__ && npx tsc --noEmit -p packages/expo-wallet-toolbox/tsconfig.json`
Expected: pass, no errors.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "refactor(wallet-toolbox): extract ConnectionsScreen and PairScreen into ui"
```

---

### Task 25: Move trust + logs screens

**Files:**
- Move: `utils/validateTrust.ts`, `utils/isImageUrl.ts` → `packages/expo-wallet-toolbox/ui/`
- Create: `packages/expo-wallet-toolbox/ui/screens/TrustScreen.tsx`, `LogsScreen.tsx` (extracted from `app/trust.tsx`, `app/logs.tsx`)
- Modify: `app/trust.tsx`, `app/logs.tsx` (become thin wrappers)
- Modify: `packages/expo-wallet-toolbox/ui/index.ts`

**Interfaces:**
- Consumes: `useWallet` (Task 17, core), `haptics` (Task 16, core), `GroupedSection`/`showAlert`/`showToast` (Task 19, ui).
- Produces: `TrustScreen`, `LogsScreen`.

- [ ] **Step 1: Move source**

```bash
git mv utils/validateTrust.ts packages/expo-wallet-toolbox/ui/validateTrust.ts
git mv utils/isImageUrl.ts packages/expo-wallet-toolbox/ui/isImageUrl.ts
```

- [ ] **Step 2: Fix `validateTrust.ts`'s internal import**

It imports `./isImageUrl` — unchanged, both now sibling files in `ui/`.

- [ ] **Step 3: Extract the two screens**

Read `app/trust.tsx` (798 lines) and `app/logs.tsx` (383 lines) in full. Create the two screen files under `packages/expo-wallet-toolbox/ui/screens/`, renamed to named exports, imports fixed per Step 4.

- [ ] **Step 4: Fix imports**

Run: `grep -rn "from '@/" packages/expo-wallet-toolbox/ui/screens/TrustScreen.tsx packages/expo-wallet-toolbox/ui/screens/LogsScreen.tsx`
Fix each hit — `@/utils/validateTrust` becomes `@bsv/expo-wallet-toolbox/ui` (it's now a ui-layer export, not core).

- [ ] **Step 5: Rewrite the two app route files**

```ts
export { TrustScreen as default } from '@bsv/expo-wallet-toolbox/ui'
```
```ts
export { LogsScreen as default } from '@bsv/expo-wallet-toolbox/ui'
```

- [ ] **Step 6: Append exports to the ui barrel**

```ts
export { TrustScreen } from './screens/TrustScreen'
export { LogsScreen } from './screens/LogsScreen'
export { default as validateTrust } from './validateTrust'
```

- [ ] **Step 7: Test + type-check**

Run: `npx jest && npx tsc --noEmit -p packages/expo-wallet-toolbox/tsconfig.json`
Expected: pass, no errors.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "refactor(wallet-toolbox): extract TrustScreen and LogsScreen into ui"
```

---

### Task 26: UI phase dogfood checkpoint

**Files:**
- Modify: any remaining `app/`, `components/`, `hooks/` file with a stale import (swept below)
- Modify: `app/_layout.tsx` (final pass)

**Interfaces:**
- Consumes: the complete `ui/index.ts` barrel built up across Tasks 19–25.
- Produces: nothing new — proves the full extraction (core + ui) works end to end.

- [ ] **Step 1: Sweep for stale imports across the whole app**

Run: `grep -rln "from '@/components/wallet\|from '@/components/pay\|from '@/components/localpay\|from '@/components/vault\|from '@/components/security\|from '@/components/ui\|from '@/components/QRScanner\|from '@/hooks/useOnline\|from '@/hooks/useVaultBalance\|from '@/utils/amountFormatHelpers\|from '@/utils/exportTransactions\|from '@/utils/exportDatabases\|from '@/utils/importDatabases\|from '@/utils/printRecoveryShares\|from '@/utils/validateTrust\|from '@/utils/isImageUrl" app components hooks --include='*.ts' --include='*.tsx'`

Fix every hit to import from `@bsv/expo-wallet-toolbox/ui` instead.

- [ ] **Step 2: Confirm every `app/*.tsx` screen route is now a thin wrapper**

Run: `wc -l app/index.tsx app/pay.tsx app/settings.tsx app/wallet-config.tsx app/vault.tsx app/vault-recover.tsx app/vault-transfer.tsx app/connections.tsx app/pair.tsx app/trust.tsx app/logs.tsx`
Expected: each file is 1 line (the `export { X as default } from '@bsv/expo-wallet-toolbox/ui'` re-export). Any file that isn't means an earlier task's Step 5 was missed — fix it now.

- [ ] **Step 3: Full test suite**

Run: `npx jest`
Expected: all tests pass.

- [ ] **Step 4: Full type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Lint**

Run: `npm run lint`
Expected: no new errors (pre-existing warnings unrelated to this migration are fine).

- [ ] **Step 6: Manual smoke test**

Start the app and walk the full golden path: wallet home → send via nearby (WiFi/Bluetooth local-pay) to a second device or simulator → receive confirmation → check transaction appears in history → open settings → open wallet-config → open vault screen → open connections/pair → open trust → open logs. Confirm no screen crashes and the provider tree behaves identically to before the extraction.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor(wallet-toolbox): finish ui extraction, sweep stale imports"
```

---

### Task 27: Write the package README (native config documentation)

**Files:**
- Create: `packages/expo-wallet-toolbox/README.md`

**Interfaces:**
- Consumes: nothing (documentation only).
- Produces: the install/setup guide a second consuming app (BSV Browser) follows.

- [ ] **Step 1: Write the README**

```markdown
# @bsv/expo-wallet-toolbox

Wallet screens and P2P local-payment backend for Expo/React Native apps.

## Install

\`\`\`bash
npm install @bsv/expo-wallet-toolbox react-native-localpay-transport react-native-engine-native react-native-secp-native react-native-nitro-modules
\`\`\`

`react-native-yubikey` is optional — the vault subsystem detects its absence at runtime and disables vault/hardware-key features gracefully.

## Usage

\`\`\`tsx
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
import { WalletHomeScreen, PayScreen } from '@bsv/expo-wallet-toolbox/ui'
\`\`\`

Compose the providers in this order (outer→inner) around your app's router, then point route files at the screen components:

\`\`\`tsx
// app/index.tsx
export { WalletHomeScreen as default } from '@bsv/expo-wallet-toolbox/ui'
\`\`\`

## Required app.json configuration

A consuming app's own `app.json`/config plugins must declare:

### iOS `infoPlist`
- `NSCameraUsageDescription`, `NSPhotoLibraryAddUsageDescription`, `NSMicrophoneUsageDescription`, `NSFaceIDUsageDescription`, `NSLocationWhenInUseUsageDescription`
- `NSBonjourServices: ["_bsvpay._tcp"]`
- `NSLocalNetworkUsageDescription`
- `NFCReaderUsageDescription` + entitlement `com.apple.developer.nfc.readersession.iso7816.select-identifiers` (YubiKey PIV AIDs — only needed if shipping vault/hardware-key support)
- `CFBundleURLTypes` for your app's own deep-link scheme (do not reuse `bsv-wallet://` or `peerpay://` — those are this repo's own scheme, not the package's)

### iOS entitlement
- `com.apple.developer.nfc.readersession.formats: ["TAG"]` — add via a config plugin equivalent to this repo's `plugins/withNfcReaderEntitlement.js`

### Android `permissions`
`INTERNET`, `SYSTEM_ALERT_WINDOW`, `ACCESS_COARSE_LOCATION`, `ACCESS_FINE_LOCATION`, `CAMERA`, `RECORD_AUDIO`, `MODIFY_AUDIO_SETTINGS`, `BLUETOOTH_ADVERTISE`, `BLUETOOTH_CONNECT`, `BLUETOOTH_SCAN`, `NEARBY_WIFI_DEVICES`, `ACCESS_WIFI_STATE`, `CHANGE_WIFI_STATE`

### Android intent filter
Register your app's own deep-link scheme (VIEW/BROWSABLE/DEFAULT) — the local-payment QR/nearby flows deep-link back into your app, not this repo's.

### `expo-build-properties`
\`\`\`json
{ "ios": { "useFrameworks": "static", "useModularHeaders": true } }
\`\`\`
Required for the Nitro/xcframework native modules to build.

### `metro.config.js`
Route `node:crypto` to `react-native-quick-crypto` and shim `node:buffer`/`node:process` — see this repo's `metro.config.js` for the exact `resolver.resolveRequest` override.

## Jest configuration

If the consuming app runs Jest, extend its `transformIgnorePatterns` to include `@bsv/expo-wallet-toolbox` (this package ships raw TypeScript, not precompiled JS):

\`\`\`
node_modules/(?!(...|@bsv/expo-wallet-toolbox)/)
\`\`\`
```
Save as `packages/expo-wallet-toolbox/README.md`.

- [ ] **Step 2: Commit**

```bash
git add packages/expo-wallet-toolbox/README.md
git commit -m "docs(wallet-toolbox): add package README with native config requirements"
```

---

### Task 28: Publish prep

**Files:**
- Modify: `packages/expo-wallet-toolbox/package.json` (`"private": false`)

**Interfaces:**
- Consumes: nothing.
- Produces: a package ready for `npm publish`, not yet published.

- [ ] **Step 1: Flip the private flag**

In `packages/expo-wallet-toolbox/package.json`, change `"private": true` to `"private": false`.

- [ ] **Step 2: Dry-run the publish**

Run: `cd packages/expo-wallet-toolbox && npm pack --dry-run`
Expected: lists exactly `core/**`, `ui/**`, `package.json`, `README.md` — no test files, no `node_modules`. If test files are included, add a `"files"` entry exclusion or move `__tests__` under a path already outside `files` (it already is — `__tests__` lives at the package root, not under `core/` or `ui/`, so it's excluded by the existing `"files": ["core", "ui"]` list; this step just confirms that).

- [ ] **Step 3: Commit**

```bash
git add packages/expo-wallet-toolbox/package.json
git commit -m "chore(wallet-toolbox): flip package to public, ready for npm publish"
```

- [ ] **Step 4: Stop — do not run `npm publish`**

Publishing to the public npm registry is irreversible (a version number can never be reused) and requires `@bsv` npm-org credentials this plan does not have. Hand off to the user: confirm the version number (`0.1.0`), confirm npm org access, and run `npm publish --access public` from `packages/expo-wallet-toolbox` themselves.

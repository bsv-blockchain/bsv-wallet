# Closure re-run at toolbox 0.24.3

Re-run of the Vault proof suites at unchanged 0.24.3 code. The earlier `external-review-closure.md` ran under Node v22.20.0; this record is a fresh run on a newer toolchain.

- Base commit: `b9c8b1dd57e5886a1d31a8f7f39ed696500b1534`
- Node: v24.15.0
- pnpm: 11.9.0
- Date: 2026-11-14

## Commands

```bash
node scripts/run-proof-bar.cjs
pnpm exec jest --watchman=false --runInBand packages/expo-wallet-toolbox/__tests__/vault
```

## Proof bar summary

```
  [PASS] script matrix (proof bar §4.1) (17.8s)
  [PASS] CRT forgery harness (proof bar §4.1) (4.5s)
  [PASS] clean-device I1 proof (proof bar §4.2) (39.6s)
  [PASS] exclusion matrix I2 (proof bar §4.3) (8.1s)
  [PASS] rail-isolation proof I3 (proof bar §4.4) (6.1s)
  [PASS] no-production-mock proof (proof bar §4.5) (5.9s)
  6 passed, 0 failed, 6 total
```

## Per-proof test counts

| Proof | Result |
|---|---|
| Script matrix | 61 passed |
| CRT forgery harness | 188 skipped, 1 passed |
| Clean-device (I1) | 18 passed |
| Exclusion matrix (I2) | 14 passed |
| Rail-isolation (I3) | 16 passed |
| No-production-mock | 13 passed |

## Vault directory totals

Test Suites: 28 passed, 28 total. Tests: 1099 passed, 1099 total.

## Whole toolbox

Command:

```bash
pnpm exec jest --ci --watchman=false --maxWorkers=4 --testPathPattern=packages/expo-wallet-toolbox --testPathIgnorePatterns=walletConnectionMemoryBudget.test
```

Re-run on 2026-11-14 at base b9c8b1dd (Node v24.15.0, pnpm 11.9.0), exit 0, 89 s: Test Suites: 1 skipped, 437 passed, 437 of 438 total. Tests: 9 skipped, 7577 passed, 7586 total. These match the plan's baseline table.

## What this proves and what it does not

These suites show that the 0.24.3 Vault code behaves as specified against a software MockYubiKey and an in-memory chain. They do not exercise a real indexer, a real node or a physical YubiKey. The `hardware-test` item stays accepted and unverified.

## After the hardening branch

Run on 2026-11-14 on branch `fix/vault-hardening` at toolbox 0.25.0 (not published), Node v24.15.0, pnpm 11.9.0. Same commands as above.

| Check | Result |
|---|---|
| Types (`tsc -p packages/expo-wallet-toolbox/tsconfig.json --noEmit`) | exit 0 |
| Lint, `core/services/vault` | 0 errors, 3 warnings (same three as at base) |
| Lint, `core`, `ui/components/vault`, `ui/backupShares.ts` | no new errors or warnings in changed files; the remaining errors are in files this branch does not change (`BrowserBridgeProvider.tsx`, `core/bridge/index.ts`, `core/index.ts` `ADMIN_ORIGINATOR`, `pay/rails/sweep.ts`, `EnrollWizard.tsx`, `VaultCeremonySheet.tsx`) and were there at base |
| Proof bar | 6 passed, 0 failed |
| Whole toolbox (memory-budget test excluded) | Test Suites: 1 skipped, 448 passed, 448 of 449 total. Tests: 9 skipped, 7739 passed, 7748 total (base: 437 suites, 7577 tests; +11 suites, +162 tests) |
| Rest of repo | Test Suites: 1 skipped, 81 passed, 81 of 82 total. Tests: 1 skipped, 838 passed, 839 total (same as base) |
| `walletConnectionMemoryBudget.test` (run in band) | 1 suite passed, 1 test passed |

The branch audit items fixed in the library are listed in `packages/expo-wallet-toolbox/CHANGELOG.md` under 0.25.0. What cannot be shown without a phone, a YubiKey or the live indexer stays listed under "Not verified" in the plan: the WhatsOnChain paging shapes, real-card behaviour, and the app's patch applying to 0.25.0.

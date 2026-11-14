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

Totals (taken from the plan's baseline table, not re-run for this record): 437 suites (1 skipped), 7577 tests, 9 skipped.

## What this proves and what it does not

These suites show that the 0.24.3 Vault code behaves as specified against a software MockYubiKey and an in-memory chain. They do not exercise a real indexer, a real node or a physical YubiKey. The `hardware-test` item stays accepted and unverified.

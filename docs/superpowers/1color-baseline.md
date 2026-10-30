# 1Color baseline (plan 07, Task 1)

Recorded 2026-10-22 before any 1Color change. Every later "no regression" claim in
`2026-10-22-1color-07-bsv-wallet.md` compares against this file.

- Worktree: `/Users/personal/git/bsv-wallet-wt/1color`, branch `feat/1color`
- HEAD: `ae9dec61538d5f6e215cb292729974ca03248664`
  (`fix(toolbox): show the live route on review, not a host warning; release 0.20.0 (#48)`)
- Node v24.15.0, npm 12.0.1

## Install

`npm ci` exit 0. patch-package applied:

```
@bsv/mandala@0.4.1 ✔
@bsv/sdk@2.8.11 ✔
@bsv/wallet-toolbox-mobile@2.14.9 ✔
decode-uri-component@0.2.2 ✔
expo-splash-screen@57.0.9 ✔
react-native-quick-crypto@0.7.17 ✔
```

## jest (whole suite, from the repo root: `npx jest`)

```
Test Suites: 2 failed, 2 skipped, 370 passed, 372 of 374 total
Tests:       2 failed, 10 skipped, 6403 passed, 6415 total
Snapshots:   0 total
Time:        144.724 s
```

Failing test files (both are 5000 ms timeouts under full-suite parallel load):

- `packages/expo-wallet-toolbox/__tests__/ui/vaultScreen.test.tsx`
  — `wallet profiles › off the default profile: only the notice — no enroll, restore or deposit door`
- `packages/expo-wallet-toolbox/__tests__/ui/enrollWizard.test.tsx`
  — `Begin is inert until both the recovery and whole-PIV acknowledgements are ticked`

Both files pass when run alone
(`npx jest packages/expo-wallet-toolbox/__tests__/ui/enrollWizard.test.tsx packages/expo-wallet-toolbox/__tests__/ui/vaultScreen.test.tsx`
→ `Test Suites: 2 passed, 2 total`, `Tests: 134 passed, 134 total`). Treat them as
load-sensitive timeouts, not product failures: a later full run that fails only these
two by timeout is not a regression.

Files that contain skipped tests (source of the 2 skipped suites / 10 skipped tests):
`packages/expo-wallet-toolbox/__tests__/identity/handleRegistry.live.test.ts`,
`packages/expo-wallet-toolbox/__tests__/pay/sweeper.test.ts`,
`packages/expo-wallet-toolbox/__tests__/walletRepair/runWalletCheck.test.ts`,
`packages/expo-wallet-toolbox/__tests__/profiles/discovery.test.ts`,
`__tests__/manual/restoreRepro.test.ts`.

## tsc (`npx tsc --noEmit -p .`)

Exit 0. **0** `error TS` lines; no file carries errors. Task 19 requires 0.

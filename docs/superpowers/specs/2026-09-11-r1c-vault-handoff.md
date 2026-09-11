# R1C vault — implementation handoff (feat/r1c-vault)

Written by the SDD controller at the end of Plans 1–3. The `.superpowers/sdd/*/progress.md` ledgers hold the per-task record; this file is the durable summary for the maintainer.

## What landed

- **Plan 1 — template module** (`core/services/vault/r1comb.ts`, 166+ tests): P-256 comb verifier lock (27,855 B for N=1, +25 B per extra key), commit-to-table `hash160(salt ‖ table)`, unlock assembly (71 pushes, `R1C_UNLOCK_LEN = 2560`), `customInstructions` v4 `{v:4,type:'R1C',salt,keys}`. K1 template, sealing, vaultDerivation, vaultPassphrase deleted.
- **Plan 2 — services** (13 tasks): error codes + `details`; `vaultEnabled` flag / `isVaultEnabled()`; meta v5 key list; driver/session/mock per serial; `VaultSigner` ceremony with batches of `VAULT_INPUTS_PER_TAP = 16`; `enrollKey` / `finalizeEnrollment` / `addVaultKey` / `disableVault`; hardware-free `depositToVault`; `withdrawFromVault(w, o, amount | 'all', reason, chosenSerial, opts)`; `relockVault`, `estimateRelockFee`, `getVaultKeyCoverage`, `orphanedIfRemoved`; `scripts/r1c-spend-proof.ts`; native NFC alert text via nitrogen; CHANGELOG 0.5.0; restore-salt regression test.
- **Plan 3 — UI** (12 tasks): 80 new i18n keys × 12 locales; `vaultErrorCopy` (exhaustive over the 33-code union); `useExportWalletData`, `useVaultCoverage`; `KeyChooser` / `vaultKeyLabel`; `EnrollWizard` (intro → key × k → more → done, add-key mode); `VaultCeremonySheet` batch progress; `VaultScreen` (four states, badges, add/rename/remove/re-lock, export row, disable); `VaultTransferScreen` (floor/fee line, first-deposit + remainder confirms, key chooser, post-transfer alerts); phrase-era files + 54 dead keys deleted; home button + Settings row gated on the flag; host wiring — `EXPO_PUBLIC_VAULT_ENABLED` on the `development` and `dev-physical` EAS profiles only.

Verification at d790087 (after the final fix wave — commits ae923b3, 05bc8ac, d790087): jest 823/823 (vault + ui + i18n + toolboxConfig), package `tsc` 0 errors, eslint 0 errors/0 warnings on touched files. Branch: 45 commits over merge-base 35187b4.

## Rulings the controller made (not decided by the user)

1. Plan 3 tasks were pipelined behind in-flight reviews when their files were disjoint; two implementers never committed concurrently.
2. Plan 2 Task 13's brief used fake P-256 pubkeys; the encoder's fail-closed point check rejects them, so real fixed-scalar points were used instead.
3. **EnrollWizard passes meta serials in `pendingSerials` in BOTH modes** (implementer had dropped them in enroll mode). Reason: `finalizeEnrollment` overwrites meta unconditionally, so the wizard was the only thing between an enrolled card and `generateVaultKey` (spec §3.3 step 2). The final fix wave moves that refusal into `enrollKey` itself and adds a `finalizeEnrollment` guard (reusing the `key-already-enrolled` code — a new code would have needed 12 locale strings).
4. Hardware back on the wizard's `done` step calls `onDone`; back is swallowed while a tap is in flight.
5. VaultScreen: wizard `onCancel` reloads meta; Remove fails closed without a built wallet; the 32-pass re-lock bound never toasts "done" after "capped"; "Re-lock now" without a wallet shows an in-sheet error (option A).
6. VaultTransferScreen: `run()` is ref-guarded for its whole lifetime (deposit could double-fire during the backup-preference read); the CTA stays inert until the first balance read.
7. **Remainder confirm computed against the chosen key's selectable total** via a new reservation-free `previewVaultWithdrawal` (final fix wave) — spec §4.2 step 4 was being evaluated against the whole vault balance.
8. Deferred, not fixed blind: **iOS `didDisconnectNFC` during an in-flight batch relocks the ceremony instead of offering Retry/resume** (final review Important 3). Changing relock/detach semantics without a device run was judged riskier than leaving it; it is on the §0 device checklist.
9. `VaultSpendResult` has no `withdrawn` figure; the transfer screen's "moved" amount can be off for 'all' + capped + unreachable. Deferred (cosmetic alert figure).
10. `VAULT_INPUTS_PER_TAP = 16` is provisional until the 32-input NFC run.
11. Legacy `reclaimStagingOutputs` kept exactly as it was (pending the user's decision on the staging reclaim).

## Follow-ups (not blocking merge; open as issues)

- `VaultSpendResult.withdrawn`; the transfer screen's NFC reason and "moved" figure still use the whole balance (now cheap to fix from `previewVaultWithdrawal().selectedTotal`); `VaultKeyCoverage.missingKeyOutputs` (badge over-counts when removed + missing coexist); the withdraw preview runs before the busy spinner (no spinner during the ~900 KB `listOutputs`, re-entry is blocked).
- `ceremony.ts` "another ceremony already running" throws `serial-mismatch` without details → misleading copy; needs its own code.
- EnrollWizard add-key `done` CTA always reads "Re-lock now" even when the host skips re-lock on an empty vault (`willRelock` prop).
- `toLocaleString('en-US')` in two alerts; deposit lazy-wallet-creation path untested; `core/logging.ts` pre-existing `process.env.COLORTERM` read; `router.push('/vault' as any)` pattern.
- Spec text drift: §4.2 step 8 `unreachable.keys` shape; §3.3 step 2 should name `enrollKey` as the enforcer; §4.2 step 6 detach-mid-batch behaviour; §5.2 `VaultWallet` legacy methods.

## Release gate (spec §0) — remains manual

1. Run `scripts/r1c-spend-proof.ts` on testnet, then mainnet with token amounts; record all txids in the spec changelog; on S5 success remove the D4b `pushTxDerCheck` screen and its retry loop together.
2. Dev build with two real YubiKeys: enrol (incl. factory-PIN change), deposit, single-input withdrawal by each key, add a third key + re-lock, remove a key (orphan refusal, then re-lock), 32-input withdrawal on iOS NFC to pin `VAULT_INPUTS_PER_TAP`; confirm `cached` touch policy covers a 16-signature batch.
3. Device check of both NFC detach paths (field drop mid-command; late `didDisconnectNFC` after `stopDiscovery()` at a batch boundary).
4. Native compile / `npx nitrogen` regen in the main checkout (generated files were hand-edited on this branch).
5. End-to-end restore on hardware (encrypted backup and exported `.db`), then spend with an enrolled YubiKey.
6. Sweep any dev device holding K1 (`v: 3`) vault funds before installing this build (spec §8).

`vaultEnabled` stays off in `production` and `preview-apk` until 1–5 are recorded.

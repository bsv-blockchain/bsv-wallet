# Vault Enrollment Step Flow — Handoff

**Date:** 2026-09-12
**Spec:** `2026-09-12-vault-enrollment-step-flow-design.md`
**Plan:** `../plans/2026-09-12-vault-enrollment-step-flow.md`
**Range:** `49dbd2c..f458b61` — 25 commits on `master`

## State

Delivered: one decision per page in the enrollment wizard, a four-step progress bar, the factory PIN
and PUK supplied below the UI instead of typed, a generated recovery code, an in-app PIV reset for a
previously-used YubiKey, and a mainnet-only vault.

Verified locally: **2741 tests passing**, the only failures being the two suites that were already red
on `master` before this work (`__tests__/context/walletBuildRestore.test.tsx`, which fails to run on a
jest ESM parse error, and `__tests__/services/capWalletArgs.test.ts`). The branch started from 23
failing tests across 3 suites — the third was `translationParity`, fixed here. `npx tsc --noEmit`
reports 16 errors, identical to baseline. `eslint` reports 0 errors on `EnrollWizard.tsx`.

**Nothing here has run on a physical YubiKey.** Native code has no jest coverage, and the software mock
turned out to be more capable than the real iOS driver in one place — which is how a dead safety guard
survived five task reviews (see C1 below). Treat the hardware checklist as a release gate, not a
formality.

## Must happen on hardware before this ships

1. **Build both platforms.** The nitro spec gained `isVaultSlotOccupied` and was regenerated; no Swift
   or Kotlin compiler has run against the new bindings. This is the item that fails loudly and cheaply.
2. **iOS, factory card** (empty 0x82, F9 intact): reset it. Expect **no** second consent. Confirms
   `attestKey` returns `0x6A88` for an empty retired slot, that `NSError.code` carries the raw status
   word, and that ATTEST needs neither a verified PIN nor an authenticated management key where guard 3
   runs.
3. **iOS, used card** with an unknown vault key in 0x82: expect the `slot-occupied` refusal, the
   "nothing was erased" line, the second consent, then a successful erase. Guard 3's whole purpose, and
   it has never executed on iOS.
4. **The fail-open probe.** A card with 0x82 occupied but its F9 attestation key erased or overwritten,
   and separately a card with an _imported_ key in 0x82. Confirm `isVaultSlotOccupied` still answers
   occupied. If either reports empty, the guard has a hole and the comment at
   `HybridYubiKeyPiv.swift:399-402` is wrong — correct it with the evidence.
5. **Android:** a firmware ≥5.3 token with an occupied 0x82, and a firmware <5.3 token. The older token
   should produce a rejection and **no** erase (yubikit raises `UnsupportedOperationException` from the
   metadata feature gate, not an APDU error — safe either way, but confirm).
6. **The quarantine path end to end:** force a `pin-change-uncertain` quarantine, re-tap, confirm the
   reset offer renders bound to that serial and that completing it clears the quarantine so the card
   enrolls afterwards.
7. **The back-to-back NFC session.** On success the wizard calls `runTap()` immediately after the reset
   session closes, reopening a CoreNFC session within milliseconds. This is the happy path of the whole
   feature. Watch also for a late invalidation callback from the old session reaching the new one's
   listener as a spurious `user-cancelled`.
8. **The preflight hoist's precondition.** Spec §4 says drop the hoist if `preflightDedicatedPiv` needs
   a verified PIN session on either platform. The code reads as though it does not, but that was never
   run on a card.
9. **VoiceOver / TalkBack** on the recovery-code page. The spaced-digit `accessibilityLabel` was
   reasoned, not heard.
10. The spec's own checklist: a factory key end to end, a personalised key through reset then
    enrollment, and a reset refusal on an already-enrolled key.

## Open items

### Needs a decision

- **Multi-identity reset residual.** Two wallet identities on one device, both mainnet: identity B's
  enrolled serials are invisible to identity A's refusal set, because SecureStore cannot be enumerated.
  Guard 3 (the card's own answer about slot 0x82) narrows it. Closing it properly needs a device-wide
  serial index — a design change deliberately left out of this plan.
- **iOS F9 residual (C1's remainder).** On iOS, `0x6A88` from `attestKey` is read as "0x82 is empty",
  but ATTEST depends on the F9 key, so the code cannot distinguish an empty slot from a damaged F9.
  Narrow (needs a damaged F9 _and_ an occupied 0x82 holding another identity's key), and strictly better
  than the pre-fix state where guard 3 was inert for every iOS card. Hardware item 4 settles it.
- **Wedged testnet vaults.** A tester who started a key removal on a testnet vault _before_ the
  mainnet-only change is permanently stuck — no withdraw, deposit, disable or relock. Every exit was
  independently verified closed. Fixing it means either a support path or letting an in-flight
  `revokePubkey` relock bypass the mainnet check, which would permit creating a vault output off
  mainnet. Product call. Small known population (TestFlight build 23), testnet coins only.
- **Destructive-consent copy in ar, hi, bn and pl.** Six strings gate an irreversible key erase:
  `vault_reset_ack`, `vault_reset_unknown_ack`, `vault_reset_own_draft_ack`,
  `vault_reset_nothing_erased`, `vault_reset_uncertain`, `vault_err_reset_enrolled`. A soft
  mistranslation of `vault_reset_unknown_ack` is a user consenting to erase a live signer. Get a native
  speaker per locale, or gate the reset page to reviewed locales.

### Deferred, safe to leave

Core enrollment (`adoptVaultKey`, the `VaultKeyService` enrol path, `resetPivApplication`) has no
availability gate of its own and relies on `VaultScreen`'s two wizard doors; both were verified to close
every route today, but a second entry point would be ungated by default, and `resetPivApplication` is
now public package API. Beyond that: the reset page is dense for a destructive screen and wants a
designer's eye; it identifies the card by four digits with no nickname available; `onPhase` is unused so
there is no progress UI during the reset tap (Android has no system NFC sheet); a stale `pinError` can
survive `pin → puk → pin`; replace-consent is lost on an NFC cancel; `generateRecoveryCode` can throw
out of an `onPress` with no boundary; no test would catch a regression from rejection sampling to
`byte % 10`; `reloadDraftLists` swallows `scope-changed` (advisory copy only); a cosmetic blank-serial
flicker on the reset page; two unreachable render branches (`enrollment-partial` in the wizard,
`puk-invalid` in `RESETTABLE`); `transfers.ts`'s `opts.vaultEnabled` seam is half-dead; `vault_reclaim_done`
is an orphaned key predating this plan.

## Notes for whoever reads the history

Commit `1323e4b` carries a large prettier reformat of `translations.tsx` alongside its intended 22-string
change. The repo has never been prettier-clean, and the plan's own instruction to run `npm run fix`
rewrote 364 files; the unrelated ones were discarded, this one was kept because `translations.tsx` is
edited by six later tasks and a clean baseline made every later diff smaller. `git blame` on roughly 170
lines of that file misattributes authorship to that commit.

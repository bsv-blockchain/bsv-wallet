# Vault Enrollment: One Step Per Page, Generated PUK, In-App PIV Reset — Design

**Date:** 2026-09-12
**Status:** approved by the product owner in conversation, 2026-09-12
**Amends:** `2026-09-09-r1-comb-vault-design.md` §3.3 (enrollment wizard credential collection)

## Summary

Setting up a vault YubiKey currently opens one page carrying up to four PIN-pad
fields at once: the current PIN, a new PIN (shown only when the current one is
the factory default), the current PUK, and a new PUK. Users must know and type
`123456` and `12345678` — values the flow already requires to be factory
defaults, because the intro forces an acknowledgement that the PIV application
is factory-reset and dedicated, and `preflightDedicatedPiv` authenticates the
factory management key before any mutation. Typing them is pure ceremony, and
the wall of fields reads as an open-ended chore with no visible end.

This design splits the credential collection into one decision per page, supplies
both factory codes below the UI, generates the new PUK instead of asking for one,
and shows a four-step progress bar so the length of the task is visible from the
first page.

It also turns the flow's hardest dead end into an action. A YubiKey that has been
used before is currently refused with "use a factory-reset key", which the app
cannot help with. Both YubiKit SDKs expose a PIV reset, so the error pages now
offer to reset the key in place, behind an explicit consent gate and a hard
refusal for any key already enrolled in the vault.

## Non-goals

- The transfer-time PIN prompt (`VaultCeremonySheet`). Unchanged.
- The wizard's outer shape: `intro → key × k → more → done` stays as it is, as do
  the tap and naming sub-steps, the leave-confirm, the draft/quarantine
  restoration, and the 2-of-N minimum and 5-key cap.
- Any change to `enrollKey`'s signature, to the enrollment state machine's
  quarantine transitions, or to what is persisted.
- Recovery of an existing quarantined enrollment. Reset destroys such a token's
  partial state rather than recovering it; the `resumeEnrollmentDraft` path is
  untouched.
- PIN or PUK entry anywhere outside enrollment.

## Verified facts (2026-09-12, read from the tree at `8b39aeb`)

- `EnrollWizard.tsx` is 912 lines with one mount point,
  `VaultScreen.tsx:717`. Its `key` step's `pin` sub-state renders all four PIN-pad
  fields (`EnrollWizard.tsx:556-638`).
- `enrollKey` takes `getPin`, `requestPinChange` and `requestPukChange` callbacks
  and detects the factory PIN as "the PIN the user entered equals the default"
  (`VaultKeyService.ts:253-273`). A wizard that supplies the defaults itself needs
  no service-signature change.
- `preflightDedicatedPiv` verifies the immutable factory F9 certificate against
  the pinned Yubico production chain, then authenticates the **default**
  management key, then proves the user slots empty
  (`HybridYubiKeyPiv.swift:236-253`, `:493-509`, `:511-548`). A personalised PIV
  application cannot pass it, so the factory PIN and PUK are safe to assume.
- Native separates the failure causes into distinct codes: `attestation-invalid`
  for an F9 chain failure, `mgmt-key-custom` for a rotated management key,
  `slot-occupied` for an occupied or unprovable slot. All three already exist in
  `VaultErrorCode` (`types.ts:13-48`).
- `preflightDedicatedPiv` runs **after** `driver.verifyPin`
  (`VaultKeyService.ts:305-316`), so a personalised token costs one of three PIN
  retries before the flow learns it cannot be enrolled.
- `YKFPIVSession.resetWithCompletion:` blocks the PIN, blocks the PUK, then sends
  the RESET APDU (`YKFPIVSession.m:555-572`). `PivSession.reset()` in
  yubikit-android 3.1.0 is the equivalent. The nitro spec
  (`YubiKeyPiv.nitro.ts`) exposes neither.
- `vaultStore` already has `discardEnrollmentDraft(serial)` and
  `discardEnrollmentQuarantine(serial)` (`vaultStore.ts:637`, `:643`).
- `mockYubiKey.ts` models `pin`, `pinRetries`, `puk`, `pukRetries`,
  `managementProtected`, `priv`/`pub` and `otherPivSlotOccupied` as plain state,
  so a mock reset is a restore of the default record.
- 12 languages in `core/i18n/translations.tsx`, held to exact key parity and
  matching interpolation placeholders by `__tests__/i18n/translationParity.test.ts`.

## Design

### 1 · Per-key page flow

`KeySub` becomes `'pin' | 'puk' | 'tap' | 'name' | 'reset' | 'error'`.

| Step | Page | Gate to continue |
|---|---|---|
| 1/4 | **Choose PIN** — two fields: choose, confirm | 6–8 digits, not `123456`, both equal |
| 2/4 | **Recovery code** — 8 generated digits, shown large | `I've written this down` ticked |
| 3/4 | **Tap** — unchanged | — |
| 4/4 | **Name** — unchanged | — |

A local `StepProgress` component renders a bar filled `n/4` plus a `Step n of 4`
line, under the existing `Key {k} of up to 5` title. It appears on those four
sub-steps only — never on `intro`, `more`, `done`, `reset` or `error`. Progress is
per key, not per wizard: the key count is chosen during the run (2 to 5), so a
whole-wizard bar would move at a rate the user cannot predict.

Add-key mode's whole-PIV acknowledgement tick stays on page 1, where the PIN page
is the first page of the key flow.

The PIN field keeps the existing `secureTextEntry`-always treatment and the
150 ms deferred focus; both exist to stop the native field remounting and
swallowing the first keystroke (`8b39aeb`, and the matching comment in
`VaultCeremonySheet`). The confirm field gets the same treatment.

### 2 · Generated recovery code

The new PUK is 8 digits from the vault's CSPRNG (`core/services/vault/random.ts`),
regenerated if it collides with the chosen PIN, since `validatePukChange` refuses
`newPuk === pin` (`VaultKeyService.ts:109-117`). Each digit is drawn by rejection
sampling — bytes of 250 or more are discarded rather than reduced — because
`byte % 10` would make the digits 0 through 5 measurably likelier than 6 through 9.
It is shown once, on its own
page, and is not recoverable afterwards — nothing in the app stores it, by the
same rule that keeps PINs out of storage. The page says so plainly.

Continue is gated on an explicit "written down" tick rather than a timer or a
plain button, because losing the recovery code silently is the failure this page
exists to prevent.

### 3 · Factory codes supplied below the UI

The wizard passes:

```ts
getPin:           async () => '123456'
requestPinChange: async () => ({ oldPin: '123456', newPin: chosenPin })
requestPukChange: async () => ({ oldPuk: '12345678', newPuk: generatedPuk })
```

`enrollKey` is unchanged. Its factory-PIN branch fires exactly as before; the only
difference is that the constant comes from the wizard rather than the user's
fingers.

### 4 · Preflight before PIN verification

`preflightDedicatedPiv` moves above `driver.verifyPin` in `enrollKey`'s card
session. It is read-only, needs no verified PIN session, and rejects every
personalised PIV application. Moving it earlier means a used YubiKey is
identified without spending a PIN retry, which matters now that the PIN being
tried is one the user never chose.

Order becomes: `getKeyInfo` → blocked-PIN check → `preflightDedicatedPiv` →
`verifyPin` → `requireEmptyVaultSlot` → mutations. If the native preflight turns
out to require a verified PIN session on either platform, the hoist is dropped
and the one-retry cost is accepted; the rest of this design is unaffected.

### 5 · Native reset

One method on the nitro spec:

```ts
/** Reset the whole PIV application to factory state. Destroys every key,
 *  certificate and credential in it, Vault slot 0x82 included. The SDK blocks
 *  the PIN and the PUK first — PIV requires both blocked before RESET. */
resetPivApplication(expectedSerial: string): Promise<string> // JSON {ok:true}
```

Swift: `withSession` → `withExpectedSerial` → `session.reset(completion:)`.
Kotlin: `withPiv` → `requireExpectedSerial` → `piv.reset()`. Errors map through
the existing `mapError` on both sides. `VaultDriver` gains the matching
`resetPivApplication(expectedSerial: string): Promise<{ ok: true }>`, and
`mockYubiKey` implements it by restoring the default record and clearing the
generated keypair.

**This requires nitrogen codegen and a native rebuild on both platforms. It
cannot ship over the air; testing it on device needs a new EAS build and
TestFlight upload.**

### 6 · `core/services/vault/pivReset.ts`

A sibling module rather than more surface on `VaultKeyService.ts`, which is
already 864 lines and owns the enrollment state machine. Reset is a different
job with different failure modes and one caller.

```ts
export async function resetPivApplication(args: {
  /** The reset tap must present this exact key. */
  serial: string
  /** Stored ∪ pending serials the wizard holds; refused in addition to meta. */
  refuseSerials: readonly string[]
  acknowledgeDestroysAllCredentials: true
  scopeToken?: VaultScopeToken
  nfcMessage?: string
  onPhase?: (p: 'waiting' | 'resetting') => void
}): Promise<void>
```

Guards, in order:

1. Driver present, else `driver-unavailable`.
2. `acknowledgeDestroysAllCredentials !== true` → `template-invalid`.
3. `isVaultSerial(serial)` → `template-invalid`.
4. `serial` in `meta.keys` or in `refuseSerials` → `key-already-enrolled`, before
   any card contact.
5. Open the session; `getKeyInfo()`; a serial other than `serial` →
   `serial-mismatch`.
6. Re-read meta inside the session and re-apply guard 4 against the tapped serial.
7. `driver.resetPivApplication(serial)`.
8. On success, scope-asserted: `discardEnrollmentDraft(serial)` and
   `discardEnrollmentQuarantine(serial)`. The reset has destroyed whatever partial
   state they described, so leaving them would refuse the key forever.

**Guards 4 and 6 are the safety-critical ones.** Resetting a YubiKey that is
already an enrolled vault key destroys one of the k-of-n signers, and enough such
resets make vault funds permanently unspendable. The refusal is checked before the
card is touched and again inside the session, and no UI flag can override it —
unlike `replaceOccupiedVaultSlot`, which is a consent flag for a slot that is by
definition not yet part of the vault.

### 7 · Which errors offer reset

| Code | Offer | Reason |
|---|---|---|
| `mgmt-key-custom` | yes | Genuine Yubico key whose management key was rotated |
| `slot-occupied` | yes, as a heavier second option beside the existing slot-0x82-only replacement | |
| `pin-invalid`, `puk-invalid` | yes | The flow sent the factory codes; rejection means personalised |
| `pin-locked`, `puk-locked` | yes | Reset is the only remedy |
| `enrollment-partial`, quarantine | yes | `vault_enrollment_reset_required` already tells the user to reset and gives them no way to; this makes that dead end actionable |
| `attestation-invalid` | **no** | The F9 factory chain failed: counterfeit or tampered. A reset cannot fix it, and offering one is misleading |
| `key-already-enrolled` | **no** | It is a live vault key |

The `reset` page states what is destroyed — every PIV credential on the key, not
only Vault's slot — names the key by its serial tail, and gates a destructive
**Reset this key** button behind a consent tick. `Use a different key` sits
alongside it. On success the flow returns to step 3 and the user taps again;
reset never shares a card session with enrollment, so a dropped session cannot
land the enrollment quarantine machinery in a state it was not designed for.

Binding the reset to the right key requires the failed attempt's serial.
`enrollKey` attaches `details.serial` to `key-already-enrolled` only; it must also
attach it to `pin-invalid`, `puk-invalid`, `mgmt-key-custom` and
`attestation-invalid`. Without a serial the wizard cannot offer reset, and falls
back to today's `Use a different key`.

## Files

| File | Change |
|---|---|
| `packages/react-native-yubikey/src/specs/YubiKeyPiv.nitro.ts` | `resetPivApplication` |
| `packages/react-native-yubikey/nitrogen/generated/**` | regenerated |
| `packages/react-native-yubikey/ios/HybridYubiKeyPiv.swift` | reset impl |
| `packages/react-native-yubikey/android/.../HybridYubiKeyPiv.kt` | reset impl |
| `core/services/vault/driver.ts` | `VaultDriver.resetPivApplication` + native adapter |
| `core/services/vault/pivReset.ts` | new |
| `core/services/vault/mockYubiKey.ts` | mock reset |
| `core/services/vault/VaultKeyService.ts` | preflight hoist; `details.serial` on four codes |
| `core/index.ts` | export `resetPivApplication` |
| `ui/components/vault/EnrollWizard.tsx` | page split, progress bar, generated PUK, reset page |
| `core/i18n/translations.tsx` | ~14 new keys × 12 languages; retire the unused ones |

Retiring `vault_enter_pin`, `vault_enter_pin_sub`, `vault_enter_puk`,
`vault_enter_puk_sub`, `vault_set_new_pin` and `vault_default_puk_warning`
requires first confirming `VaultCeremonySheet` and `VaultTransferScreen` do not
use them.

## Testing

Test-first, per the repo's TDD workflow.

- `__tests__/vault/pivReset.test.ts` — new. Each guard in isolation: missing
  acknowledgement, bad serial, a serial in meta, a serial in `refuseSerials`, a
  mismatched tapped serial, scope change mid-session, and the draft/quarantine
  discard on success.
- `__tests__/ui/enrollWizard.test.tsx` — the `enterCredentials` helper is rewritten
  for the two pages. New cases: Continue inert until the PIN pages validate, PIN
  mismatch blocks, the generated PUK reaches `requestPukChange`, the PUK page
  gates on the tick, the progress bar reports the right step, the reset offer
  appears for each eligible code and is absent for `attestation-invalid` and
  `key-already-enrolled`, and a successful reset returns to the tap step.
- `__tests__/vault/vaultKeyService.test.ts` — preflight precedes `verifyPin`, and
  the four error codes carry `details.serial`.
- `__tests__/i18n/translationParity.test.ts` — unchanged, must stay green.

Device verification after the EAS build: a factory key through the full flow, a
personalised key through reset then enrollment, and a reset refusal on an already
enrolled key.

## Deferred

- Showing the recovery code again later. Nothing stores it, so there is nothing
  to show.
- A standalone "reset a YubiKey" maintenance action on `VaultScreen`. Reset is
  reachable only from the error pages that prove it is needed.
- Recovering, rather than destroying, a quarantined enrollment.

/**
 * VaultKeyService — enrolling YubiKeys into the vault's key list, and tearing
 * the list down.
 *
 * Each YubiKey IS a vault key (spec D2/D3): PIV slot 0x82 holds a P-256 key
 * generated ON the card, whose compressed public key is all the phone ever
 * records. There is no seed, no seal, no passphrase and no recovery phrase
 * anywhere in this design. Recovery combines any enrolled YubiKey with the
 * self-describing metadata authenticated against a spendable R1C output.
 * Nothing here derives, wraps or zeroizes anything.
 *
 * enrollKey runs ONE card session for ONE key and returns a public record
 * without persisting it; the wizard collects 2..5 such records and commits
 * them atomically with finalizeEnrollment (spec §3.3: no local Vault authority
 * is stored until Finish). addVaultKey appends one record to an enrolled vault (§3.4).
 *
 * Enrollment never overwrites an occupied slot. A signing probe detects a bare
 * key even on iOS, where YubiKit 4.4 cannot read retired-slot metadata. Recovery
 * uses adoptVaultKey: it proves possession with a fresh challenge and compares
 * the resulting signature to metadata authenticated against a real R1C lock.
 *
 * SECURITY: never log the PIN. Public keys and serials are public data.
 */
import { getVaultDriver } from './driver'
import { enrolledSerialRegistry, forgetSerialsNoLongerEnrolledForIdentity } from './enrolledSerialRegistry'
import {
  computeVaultDraftAuthorityTag,
  computeVaultMetaAuthorityTag,
  verifyVaultDraftAuthorityTag,
  verifyVaultMetaAuthorityTag,
  type HmacCapableWallet
} from './metaAuthority'
import { compressPubkey, type VaultInstructions } from './r1comb'
import { randomBytes } from './random'
import { withKeySession, VaultSessionGuard } from './session'
import { VaultError } from './types'
import {
  isVaultKeyRecord,
  isVaultMeta,
  isVaultSerial,
  vaultStore,
  VaultEnrollmentDraftEntry,
  VaultKeyRecord,
  VaultMeta,
  VaultScopeToken
} from './vaultStore'
import { Utils } from '@bsv/sdk'
import { p256 } from '@noble/curves/nist.js'

/**
 * XR-001 / XR-002: the admin-scoped wallet capability every meta/draft-tag
 * write and verification in this module needs. Callers pass the SAME
 * admin-scoped wallet + `adminOriginator` transfers.ts already uses (see
 * guardVaultAccess) — never a site-scoped WalletClient, which forwards
 * createHmac/verifyHmac for any non-reserved namespace to the underlying
 * wallet (see guard.ts's VAULT_PROTOCOL_NAMES / metaAuthority.ts's header).
 */
export interface VaultWalletAuthority {
  wallet: HmacCapableWallet
  adminOriginator: string
}

/** Re-verify `existing`'s own wallet-root tag before trusting it as the
 * basis for a freshly, validly tagged `next` (addKey only APPENDS to
 * `meta.keys`, so a forged `existing` would otherwise "launder" straight
 * through the moment the legitimate user adds one more, genuinely their
 * own, key — see vaultStore.addKey's laundering caveat).
 *
 * Unlike transfers.ts's requireAuthenticatedMeta, this has no on-chain
 * fallback: VaultKeyService has no chain-scanning capability, and inventing
 * one here only to duplicate transfers.ts's would need this module to import
 * from it, which already imports FROM this module (metaFromVerifiedOutputs).
 * A genuinely untagged-but-legitimate meta (every enrollment created before
 * this fix shipped) is recovered instead through the existing VaultScreen
 * reload() → recoverVaultMetaFromOutputs → restoreVerifiedMeta path, which
 * DOES have chain access and tags the result going forward — the "safer
 * route" this refusal directs the user to rather than ever trusting
 * `existing` on sight. */
async function requireTaggedMeta(
  authority: VaultWalletAuthority,
  meta: VaultMeta,
  scopeToken: VaultScopeToken
): Promise<void> {
  vaultStore.assertScopeToken(scopeToken)
  const scope = vaultStore.getScope()
  if (!scope) throw new VaultError('not-enrolled', 'Wallet vault scope is not configured')
  const tag = await vaultStore.getMetaTag(scopeToken)
  const ok = await verifyVaultMetaAuthorityTag(authority.wallet, authority.adminOriginator, meta, scope, tag)
  if (!ok) {
    throw new VaultError(
      'template-invalid',
      'Vault enrollment metadata could not be authenticated; open the vault screen to re-verify it before adding a key'
    )
  }
}

export const VAULT_SLOT = 0x82

/** Spec D3: at least two keys, so one lost YubiKey does not lose the money;
 * at most five (R1C_MAX_KEYS — the lock carries one commitment per key). */
export const VAULT_MIN_KEYS = 2
export const VAULT_MAX_KEYS = 5
/** The key list may hold ONE key beyond the lock's ceiling, never committed:
 * a replacement is added before the key it replaces is removed, so a full
 * vault passes through six on its way back to five, and a single re-lock
 * covers both changes. Nothing locks to more than VAULT_MAX_KEYS (see
 * newVaultOutput and relockVault). Mirrored in vaultStore.ts, which cannot
 * import this module. */
export const VAULT_MAX_ACTIVE_KEYS = VAULT_MAX_KEYS + 1

const DEFAULT_PIV_PIN = '123456'
const DEFAULT_PIV_PUK = '12345678'
const PIV_CODE = /^[0-9]{6,8}$/

export type EnrollPhase =
  | 'connecting'
  | 'pin-check'
  | 'checking-slot'
  | 'personalizing'
  | 'generating'
  | 'challenging'
  | 'done'
export type AdoptPhase = 'connecting' | 'pin-check' | 'challenging' | 'done'

/** Enrollment requires both native, offline manufacturer attestation and a
 * fresh possession challenge after the management key is protected. */
export const VAULT_ENROLLMENT_ASSURANCE = 'manufacturer-attested-possession-challenge' as const

export type EnrollmentPartialStage =
  | 'pin-change-uncertain'
  | 'pin-changed'
  | 'puk-change-uncertain'
  | 'puk-changed'
  | 'generation-uncertain'
  | 'key-generated'
  | 'key-protected'

/**
 * Personalization mutated (or may have mutated) the token before a later step
 * failed. Confirmed stages let the wizard retain the user's chosen replacement
 * credentials for an explicit retry. An `*-uncertain` stage must never cause
 * the UI to assume which credential is current or spend retries testing that
 * assumption. Secrets are never attached to the error. A generated record is
 * never enrolled implicitly.
 */
export class VaultEnrollmentPartialError extends VaultError {
  readonly stage: EnrollmentPartialStage
  readonly record?: VaultKeyRecord
  readonly recoverySaved: boolean

  constructor(stage: EnrollmentPartialStage, cause: unknown, record?: VaultKeyRecord, recoverySaved = false) {
    super('enrollment-partial', 'YubiKey personalization did not complete', undefined, {
      stage,
      recoverySaved: recoverySaved ? 1 : 0,
      ...(record ? { serial: record.serial, pubkey: record.pubkey } : {})
    })
    this.name = 'VaultEnrollmentPartialError'
    this.stage = stage
    this.record = record
    this.recoverySaved = recoverySaved
    ;(this as Error & { cause?: unknown }).cause = cause
  }
}

/**
 * Does this firmware answer GET METADATA (PIV INS 0xF7)?
 *
 * That command is the only non-inferential way to ask whether a PIV slot holds
 * a key, and it landed in firmware 5.3. Below it every remaining answer is
 * inferred from a status word, and 5.7.4 proved those move: an empty retired
 * slot that once answered ATTEST with 0x6A88 now answers 0x6A80. Enrollment
 * generates a key it must afterwards be able to prove was the only one, so it
 * refuses to guess rather than silently overwriting something.
 *
 * `firmwareVersion` is "major.minor.micro", straight from getKeyInfo.
 */
function supportsSlotMetadata(firmwareVersion: string): boolean {
  const [major, minor] = firmwareVersion.split('.').map(part => Number.parseInt(part, 10))
  if (!Number.isFinite(major) || !Number.isFinite(minor)) return false
  return major > 5 || (major === 5 && minor >= 3)
}

function requirePivCode(value: string, label: 'PIN' | 'PUK'): void {
  if (!PIV_CODE.test(value)) {
    throw new VaultError('template-invalid', `PIV ${label} must be 6 to 8 ASCII digits`)
  }
}

/**
 * XR-004: the same checkpoint enrollKey's session already runs before every
 * mutation (assertScopeToken — wallet/chain unchanged), plus session.assertCurrent
 * — no NEWER Vault hardware session has been acquired since this one started.
 * A timed-out/detached session's continuation can still be running (the native
 * calls it wraps cannot be cancelled) after the lease has already been freed
 * for a retry; this refuses that continuation's next write instead of letting
 * it race the retry's.
 */
function assertSessionCurrent(session: VaultSessionGuard, scopeToken: VaultScopeToken): void {
  session.assertCurrent()
  vaultStore.assertScopeToken(scopeToken)
}

/**
 * Attach the tapped serial to an error leaving the card session.
 *
 * The UI's reset offer must bind to the exact key that failed, and a separate
 * reset tap has no other way to learn which one that was. Native-origin errors
 * cannot carry it themselves: vaultErrorFromNative parses only the code, the
 * message and `retries=`, never `details`.
 *
 * Only a plain VaultError is rebuilt. Anything else passes through untouched:
 * a foreign throwable keeps its identity, and a VaultError SUBCLASS keeps the
 * fields a plain VaultError cannot hold — VaultEnrollmentPartialError's
 * `stage`, `record` and `recoverySaved` are what the quarantine and draft
 * recovery machinery reads, so rebuilding one would silently disarm it. An
 * existing `details.serial` is never overwritten.
 */
function withSerial(error: unknown, serial: string): unknown {
  if (!(error instanceof VaultError)) return error
  if (error.constructor !== VaultError) return error
  if (error.details?.serial !== undefined) return error
  return new VaultError(error.code, error.message, error.retriesLeft, { ...error.details, serial })
}

/**
 * Name the tapped card on a partial-enrollment failure that carries no record.
 *
 * The counterpart to `withSerial` for the one class it deliberately refuses to
 * touch. A partial only gets `details.serial` from its `record`, and every
 * stage BEFORE key generation has no record — which is exactly the set that
 * persists a quarantine. Unnamed, the wizard's `resetSerial` stays undefined
 * and no reset is offered; but a quarantined serial short-circuits every later
 * enrollment tap, and a reset is the only thing that clears one. So without
 * this the card is both unenrollable and unresettable in-app, under copy
 * telling the user to reset it.
 *
 * `pin-change-uncertain` is named too, deliberately, even though it is the one
 * stage where the card may still be factory. The quarantine is written BEFORE
 * the changePin APDU, so nothing may have happened — but it is written all the
 * same, and nothing else erases it. Withholding the offer there would brick
 * exactly the card that was never modified. Resetting a still-factory PIV
 * application costs nothing the user has not already agreed to: preflight
 * refused every occupied user slot before this point, so there is nothing else
 * on it. The wizard keeps the hedged `vault_enrollment_state_uncertain` copy
 * for this stage rather than the reset-required one, so the offer is made
 * without claiming the card was changed.
 *
 * Mutated in place rather than rebuilt: `details` is a plain field, and
 * constructing a fresh VaultEnrollmentPartialError would have to re-thread
 * `stage`, `record`, `recoverySaved` and `cause` — the failure mode withSerial
 * exists to avoid. Applied once around the whole card session so a throw site
 * added later cannot forget it. An existing `details.serial` is never
 * overwritten.
 */
function withPartialSerial(error: unknown, serial: string | undefined): unknown {
  if (serial === undefined) return error
  if (!(error instanceof VaultEnrollmentPartialError)) return error
  if (error.details?.serial !== undefined) return error
  error.details = { ...error.details, serial }
  return error
}

function validatePukChange(change: { oldPuk: string; newPuk: string }, pin: string): void {
  requirePivCode(change.oldPuk, 'PUK')
  requirePivCode(change.newPuk, 'PUK')
  if (change.newPuk === DEFAULT_PIV_PUK || change.newPuk === pin || change.newPuk === change.oldPuk) {
    throw new VaultError('template-invalid', 'Choose a new non-default PUK distinct from the PIN and old PUK')
  }
}

function enrollmentNickname(value: unknown, ordinal: number): string {
  if (value !== undefined && typeof value !== 'string') {
    throw new VaultError('template-invalid', 'Invalid vault key nickname')
  }
  const clean = typeof value === 'string' ? value.trim() : ''
  const nickname = clean || `Key ${ordinal}`
  if (nickname.length > 64 || /[\u0000-\u001f\u007f]/.test(nickname)) {
    throw new VaultError('template-invalid', 'Invalid vault key nickname')
  }
  return nickname
}

function signatureProvesKey(pubkey: string, digest: Uint8Array, signature: string): boolean {
  try {
    const der = p256.Signature.fromBytes(Uint8Array.from(Utils.toArray(signature, 'hex')), 'der')
    return p256.verify(der.toBytes(), digest, Uint8Array.from(Utils.toArray(pubkey, 'hex')), {
      prehash: false,
      lowS: false
    })
  } catch {
    return false
  }
}

function isDefiniteCredentialRejection(error: unknown): boolean {
  return (
    error instanceof VaultError &&
    (error.code === 'pin-invalid' ||
      error.code === 'pin-locked' ||
      error.code === 'puk-invalid' ||
      error.code === 'puk-locked' ||
      error.code === 'template-invalid')
  )
}

function requireVerifiedPin(result: { ok: boolean; retriesLeft: number }, detail = 'PIN not accepted'): void {
  if (result.ok) return
  if (result.retriesLeft <= 0) throw new VaultError('pin-locked', 'PIN is blocked', 0)
  throw new VaultError('pin-invalid', detail, result.retriesLeft)
}

/**
 * Refuse to generate over an occupied Vault slot.
 *
 * Asks the card through `isVaultSlotOccupied`, which both natives answer with
 * GET METADATA. This replaced a random-digest `signEcdsa` probe that treated a
 * `no-key` rejection as proof of emptiness — and `no-key` is derived from status
 * word 0x6A88, which firmware 5.7.4+ no longer returns for an empty retired
 * slot (it answers 0x6A80). The probe was also fail-OPEN in one direction:
 * native reports `no-key` when the card has simply LEFT THE FIELD, which the
 * old code read as "the slot is empty, generate away".
 *
 * The PIN is no longer needed here — occupancy needs no VERIFY, and enrollKey
 * has already verified the PIN by this point.
 */
async function requireEmptyVaultSlot(serial: string, allowReplacement: boolean): Promise<void> {
  // Explicit consent to destroy whatever occupies slot 0x82. Asking anyway only
  // created a way for an ambiguous answer to block a replacement the user had
  // already agreed to.
  if (allowReplacement) return
  const driver = getVaultDriver()
  if (!driver) throw new VaultError('driver-unavailable')
  // A readable certificate is occupancy even when nothing signs: the public key
  // it exposes is what recovery binds to. GET METADATA answers about the KEY, so
  // it would call such a slot empty — this check is not redundant with the one
  // below, and only ever adds occupancy.
  if (await driver.readVaultPublicKey(serial)) {
    throw withSerial(new VaultError('slot-occupied', 'Vault slot already contains a key'), serial)
  }
  const { occupied } = await driver.isVaultSlotOccupied(serial)
  if (occupied) {
    throw withSerial(new VaultError('slot-occupied', 'Vault slot is not provably empty'), serial)
  }
}

/**
 * Enrol ONE YubiKey: one card session (one NFC tap), one fresh key, one
 * public record back. Persists only scoped, non-authoritative recovery state
 * until the caller commits the resulting record to Vault metadata.
 *
 * `pendingSerials` are the serials enrolled earlier in this wizard run (the
 * wizard also passes meta.keys' serials, and may keep doing so). The
 * serials already in meta.keys are read HERE, from the store, so the refusal
 * does not depend on the caller's copy of the key list being loaded yet: the
 * service is the thing that stands between an enrolled card and
 * generateVaultKey. The check runs FIRST inside the session, before the PIN
 * is spent and, above all, before generateVaultKey replaces whatever the
 * slot holds: re-tapping an enrolled card must cost nothing (spec §3.3
 * step 2).
 *
 * All user input (PIN, replacement PIN) is gathered BEFORE the tap: on NFC the
 * scan sheet is a system modal that covers the app.
 */
export async function enrollKey(args: {
  /** Serials already enrolled OR pending in this wizard run. */
  pendingSerials: string[]
  nickname?: string
  onPhase: (p: EnrollPhase) => void
  getPin: () => Promise<string>
  /** Called when the key still has the factory-default PIV PIN; must return a
   * new PIN the user chose. Enrollment rejects omission. */
  requestPinChange?: (retries: number) => Promise<{ oldPin: string; newPin: string }>
  /** Always rotate the PUK during enrollment. Input is collected before NFC. */
  requestPukChange: () => Promise<{ oldPuk: string; newPuk: string }>
  /** Explicit acknowledgement that this token's whole PIV application is
   * dedicated/factory-reset. Enrollment rotates global PIV credentials, which
   * affect every slot, so this is enforced again below the UI boundary. */
  acknowledgeDedicatedPivApplication: true
  /** Localised iOS NFC alert text for this tap (spec §4.2 step 6, enrollment
   * wording). Additive to the interface contract; Android ignores it and an
   * omitted value selects the native default wording. */
  nfcMessage?: string
  /** Bind a multi-key wizard to the wallet+chain scope it opened under. */
  scopeToken?: VaultScopeToken
  /** Explicit consent to destroy and replace an existing key in Vault's fixed
   * slot 0x82. Other occupied PIV slots remain a hard failure. */
  replaceOccupiedVaultSlot?: boolean
  /** XR-001: the admin-scoped wallet capability used to tag this run's
   * `ready` draft the instant it is written, so a later SecureStore-only
   * attacker cannot forge an equivalent one. */
  wallet: HmacCapableWallet
  adminOriginator: string
}): Promise<VaultKeyRecord> {
  const driver = getVaultDriver()
  if (!driver) throw new VaultError('driver-unavailable')
  const scopeToken = args.scopeToken ?? vaultStore.captureScopeToken()
  if (args.acknowledgeDedicatedPivApplication !== true) {
    throw new VaultError(
      'template-invalid',
      'Confirm this YubiKey PIV application is factory-reset and dedicated to Vault'
    )
  }

  // The enrolled key list, read once from device-only secure storage before any user input or
  // key contact. Refused alongside pendingSerials below — across every chain
  // of this identity, plus a key mid-removal, plus pending — so an enrolled
  // card is refused even when the caller's own copy of meta has not loaded
  // (the wizard's key list arrives asynchronously), and even when it is
  // enrolled under a different chain of the same wallet identity, or sits in
  // meta.pendingRemoval in this chain (XR-008: `enrolledSerialsAcrossChains`
  // already covers both — it folds pendingRemoval into every chain it scans —
  // and is the exact non-overridable refusal set pivReset.ts already uses
  // before its own destructive card mutation).
  const quarantines = await vaultStore.getEnrollmentQuarantines(scopeToken)
  const refused = new Set<string>([
    ...(await vaultStore.enrolledSerialsAcrossChains(scopeToken)),
    ...args.pendingSerials
  ])
  const k = args.pendingSerials.length + 1
  const nickname = enrollmentNickname(args.nickname, k)
  const enrolledAt = Date.now()
  if (!Number.isSafeInteger(enrolledAt) || enrolledAt <= 0) {
    throw new VaultError('template-invalid', 'Invalid enrollment time')
  }

  // ── ALL user input up front, BEFORE any key contact ──
  args.onPhase('pin-check')
  const pin0 = await args.getPin()
  requirePivCode(pin0, 'PIN')
  let pin = pin0
  let pinChange: { oldPin: string; newPin: string } | null = null
  if (pin0 === DEFAULT_PIV_PIN) {
    if (!args.requestPinChange) {
      throw new VaultError('template-invalid', 'The factory PIV PIN must be changed before enrollment')
    }
    // Factory-default detection is exactly "the PIN the user entered is the
    // default" — no side probe against '123456' that would burn a retry.
    pinChange = await args.requestPinChange(3)
    requirePivCode(pinChange.oldPin, 'PIN')
    requirePivCode(pinChange.newPin, 'PIN')
    if (pinChange.oldPin !== pin0 || pinChange.newPin === DEFAULT_PIV_PIN || pinChange.newPin === pinChange.oldPin) {
      throw new VaultError('template-invalid', 'Choose a new non-default PIN and provide the current PIN exactly')
    }
    pin = pinChange.newPin
  }
  const pukChange = await args.requestPukChange()
  validatePukChange(pukChange, pin)
  // Do not even open discovery if the wizard outlived its wallet or chain.
  vaultStore.assertScopeToken(scopeToken)

  // ── Token phase: one session / one NFC tap ──
  /** The serial this session's card reported, for the `withPartialSerial` tag
   * on the way out. Written once, from the card, before anything is presented
   * to it — so a partial raised anywhere below can name the card it belongs to. */
  let tappedSerial: string | undefined
  const record = await withKeySession(
    driver,
    async session => {
      assertSessionCurrent(session, scopeToken)
      const info = await driver.getKeyInfo()
      if (!isVaultSerial(info.serial)) {
        throw new VaultError('template-invalid', 'YubiKey returned an invalid serial number')
      }
      tappedSerial = info.serial
      if (refused.has(info.serial)) {
        // The message IS the serial: the wizard resolves it to a nickname.
        throw new VaultError('key-already-enrolled', info.serial, undefined, { serial: info.serial })
      }
      const quarantine = quarantines.find(item => item.serial === info.serial)
      if (quarantine) {
        throw new VaultEnrollmentPartialError(
          quarantine.stage,
          new VaultError(
            'template-invalid',
            'This token has an unfinished global PIV credential change; reset or recover its dedicated PIV application'
          ),
          undefined,
          true
        )
      }
      // A blocked PIN can't be enrolled — surface it before burning anything.
      if (info.pinRetries === 0) throw withSerial(new VaultError('pin-locked', 'PIN is blocked'), info.serial)
      // Refuse a key too old to prove its slots empty, with its own message
      // rather than the slot-occupied one a failed occupancy read would give.
      if (!supportsSlotMetadata(info.firmwareVersion)) {
        throw withSerial(
          new VaultError('unsupported-platform', 'This YubiKey needs firmware 5.3 or later'),
          info.serial
        )
      }
      // PIN/PUK and management credentials are global to the whole PIV
      // application, not slot 0x82. Native must cryptographically verify the
      // factory F9 chain, authenticate the default management key, and reject
      // every occupied user slot it can reliably inspect before mutation. The
      // explicit dedicated-token acknowledgement still matters because a
      // genuine factory-attested token can contain unrelated user credentials.
      //
      // This runs BEFORE verifyPin deliberately. It is read-only, issues no
      // VERIFY on either platform, and refuses every personalised PIV
      // application — so a used token is identified without spending one of
      // three PIN retries on the factory PIN the UI supplies on the user's
      // behalf.
      let preflight: Awaited<ReturnType<typeof driver.preflightDedicatedPiv>>
      try {
        preflight = await driver.preflightDedicatedPiv(info.serial, args.replaceOccupiedVaultSlot === true)
      } catch (e) {
        throw withSerial(e, info.serial)
      }
      if (
        preflight.ok !== true ||
        preflight.manufacturerAttestation !== 'verified' ||
        (preflight.inspection !== 'metadata' && preflight.inspection !== 'attestation')
      ) {
        throw withSerial(
          new VaultError('attestation-invalid', 'Native manufacturer attestation was not verified'),
          info.serial
        )
      }
      // Verify the entered PIN before doing any card mutation. The signing
      // probe below is the iOS-safe occupancy check for retired slot 0x82.
      try {
        const verified = await driver.verifyPin(info.serial, pin0)
        requireVerifiedPin(verified)
      } catch (e) {
        throw withSerial(e, info.serial)
      }
      args.onPhase('checking-slot')
      await requireEmptyVaultSlot(info.serial, args.replaceOccupiedVaultSlot === true)
      // Everything above is read-only. This is the last guard before the
      // first irreversible token mutation.
      assertSessionCurrent(session, scopeToken)
      args.onPhase('personalizing')
      if (pinChange) {
        // Write intent before the irreversible APDU. If the process dies while
        // changePin is executing, the next launch must quarantine this serial
        // instead of guessing which PIN is current and spending retries.
        await vaultStore.preserveEnrollmentQuarantine(info.serial, 'pin-change-uncertain', scopeToken)
        assertSessionCurrent(session, scopeToken)
        try {
          await driver.changePin(info.serial, pinChange.oldPin, pinChange.newPin)
        } catch (e) {
          if (isDefiniteCredentialRejection(e)) {
            try {
              await vaultStore.transitionEnrollmentQuarantine(info.serial, 'pin-change-uncertain', null, scopeToken)
            } catch (storageError) {
              throw new VaultEnrollmentPartialError('pin-change-uncertain', storageError, undefined, true)
            }
            // Symmetric with the changePuk twin below: a definite credential
            // rejection leaves the card unchanged, so it reaches the UI as a
            // plain pin-invalid/pin-locked and must name the key it came from.
            throw withSerial(e, info.serial)
          }
          throw new VaultEnrollmentPartialError('pin-change-uncertain', e, undefined, true)
        }
        try {
          await vaultStore.transitionEnrollmentQuarantine(
            info.serial,
            'pin-change-uncertain',
            'pin-changed',
            scopeToken
          )
        } catch (e) {
          throw new VaultEnrollmentPartialError('pin-changed', e, undefined, true)
        }
        try {
          const changed = await driver.verifyPin(info.serial, pin)
          requireVerifiedPin(changed, 'New PIN was not accepted')
          assertSessionCurrent(session, scopeToken)
        } catch (e) {
          throw new VaultEnrollmentPartialError('pin-changed', e, undefined, true)
        }
      }
      try {
        if (pinChange) {
          await vaultStore.transitionEnrollmentQuarantine(
            info.serial,
            'pin-changed',
            'puk-change-uncertain',
            scopeToken
          )
        } else {
          await vaultStore.preserveEnrollmentQuarantine(info.serial, 'puk-change-uncertain', scopeToken)
        }
      } catch (e) {
        if (pinChange) throw new VaultEnrollmentPartialError('pin-changed', e, undefined, true)
        throw e
      }
      assertSessionCurrent(session, scopeToken)
      try {
        await driver.changePuk(info.serial, pukChange.oldPuk, pukChange.newPuk)
      } catch (e) {
        // A definite wrong-PUK response means the PUK stayed old, but a PIN
        // change earlier in this same attempt is already confirmed. Preserve
        // that partial state instead of sending the wizard back to the factory
        // PIN. A transport error makes the old/new PUK outcome ambiguous; the
        // UI must quarantine this token rather than guessing and consuming PUK
        // retries.
        if (isDefiniteCredentialRejection(e)) {
          try {
            await vaultStore.transitionEnrollmentQuarantine(
              info.serial,
              'puk-change-uncertain',
              pinChange ? 'pin-changed' : null,
              scopeToken
            )
          } catch (storageError) {
            throw new VaultEnrollmentPartialError(
              pinChange ? 'pin-changed' : 'puk-change-uncertain',
              storageError,
              undefined,
              true
            )
          }
          if (pinChange) throw new VaultEnrollmentPartialError('pin-changed', e, undefined, true)
          throw withSerial(e, info.serial)
        }
        throw new VaultEnrollmentPartialError('puk-change-uncertain', e, undefined, true)
      }
      try {
        await vaultStore.transitionEnrollmentQuarantine(info.serial, 'puk-change-uncertain', 'puk-changed', scopeToken)
      } catch (e) {
        throw new VaultEnrollmentPartialError('puk-changed', e, undefined, true)
      }
      try {
        assertSessionCurrent(session, scopeToken)
      } catch (e) {
        // PIN/PUK personalization is confirmed, but no slot key exists yet.
        throw new VaultEnrollmentPartialError('puk-changed', e, undefined, true)
      }
      args.onPhase('generating')
      // As with PIN/PUK changes, durable intent precedes generation. A killed
      // process cannot otherwise distinguish an empty slot from one whose
      // GENERATE ASYMMETRIC KEYPAIR command landed without returning.
      try {
        await vaultStore.transitionEnrollmentQuarantine(info.serial, 'puk-changed', 'generation-uncertain', scopeToken)
      } catch (e) {
        throw new VaultEnrollmentPartialError('puk-changed', e, undefined, true)
      }
      assertSessionCurrent(session, scopeToken)
      // Generation is authorized by the still-default management key. The key
      // is not returned as enrolled until that credential has been replaced by
      // native CSPRNG material that never crosses the JS bridge.
      let publicKey: string
      try {
        const generatedResult = await driver.generateVaultKey(info.serial)
        if (generatedResult.manufacturerAttestation !== 'verified') {
          throw new VaultError('attestation-invalid', 'Generated key attestation was not verified')
        }
        publicKey = generatedResult.publicKey
      } catch (e) {
        throw new VaultEnrollmentPartialError('generation-uncertain', e, undefined, true)
      }
      let pubkey: string
      try {
        pubkey = compressPubkey(publicKey)
      } catch (e) {
        // The card may already contain a generated key even though its returned
        // public encoding was unusable. Never present this as a clean failure
        // that invites generation over the same slot.
        throw new VaultEnrollmentPartialError('generation-uncertain', e, undefined, true)
      }
      const generated: VaultKeyRecord = {
        serial: info.serial,
        slot: VAULT_SLOT,
        pubkey,
        nickname,
        enrolledAt
      }
      if (!isVaultKeyRecord(generated)) {
        throw new VaultEnrollmentPartialError(
          'generation-uncertain',
          new VaultError('template-invalid', 'YubiKey returned invalid enrollment metadata'),
          undefined,
          true
        )
      }
      try {
        await vaultStore.preserveEnrollmentDraft({ record: generated, assurance: 'management-uncertain' }, scopeToken)
      } catch (e) {
        // The public recovery handle could not be made durable after the key
        // was generated. Surface the record and stop before relying on it.
        throw new VaultEnrollmentPartialError('key-generated', e, generated)
      }
      try {
        assertSessionCurrent(session, scopeToken)
      } catch (e) {
        throw new VaultEnrollmentPartialError('key-generated', e, generated, true)
      }
      try {
        await driver.protectManagementKey(info.serial)
      } catch (e) {
        // The slot now holds this exact public key, but the card's management
        // state is ambiguous. Preserve an explicit recovery handle; never
        // silently add it and never generate over it on retry.
        throw new VaultEnrollmentPartialError('key-generated', e, generated, true)
      }
      try {
        await vaultStore.preserveEnrollmentDraft({ record: generated, assurance: 'challenge-required' }, scopeToken)
      } catch (e) {
        throw new VaultEnrollmentPartialError('key-protected', e, generated, true)
      }
      // Native generation has already verified the pinned Yubico chain, exact
      // slot key, serial, and PIN/touch policy. This independent fresh challenge
      // proves the protected key remains usable before the record leaves the
      // service.
      args.onPhase('challenging')
      const challenge = Uint8Array.from(randomBytes(32))
      try {
        assertSessionCurrent(session, scopeToken)
        const { signature } = await driver.signEcdsa(info.serial, pin, Utils.toHex(challenge))
        if (!signatureProvesKey(pubkey, challenge, signature)) {
          throw new VaultError('wrong-key', 'Generated YubiKey did not prove possession of its private key')
        }
        const scope = vaultStore.getScope()
        if (!scope) throw new VaultError('not-enrolled', 'Wallet vault scope is not configured')
        await vaultStore.preserveEnrollmentDraft({ record: generated, assurance: 'ready' }, scopeToken, record =>
          computeVaultDraftAuthorityTag(args.wallet, args.adminOriginator, record, scope)
        )
        assertSessionCurrent(session, scopeToken)
      } catch (e) {
        throw new VaultEnrollmentPartialError('key-protected', e, generated, true)
      }
      return generated
    },
    () => args.onPhase('connecting'),
    { nfcMessage: args.nfcMessage }
  ).catch(e => {
    // One tag for the whole session, rather than one per throw site: the
    // pre-generation stages have no record to name the card with, and they are
    // precisely the ones that leave a quarantine behind.
    throw withPartialSerial(e, tappedSerial)
  })
  try {
    // A scope switch can land while withKeySession is closing native
    // discovery after the challenge. Preserve the exact public record so the
    // now-occupied protected slot can be adopted instead of stranded.
    vaultStore.assertScopeToken(scopeToken)
  } catch (e) {
    throw new VaultEnrollmentPartialError('key-protected', e, record, true)
  }
  args.onPhase('done')
  return record
}

/** Resume a durable, non-authoritative enrollment recovery handle. A record
 * whose management-key rotation is uncertain is deliberately not recoverable:
 * default-MGM rejection is indistinguishable from a transport failure in the
 * installed SDK wrappers, so treating it as proof could enroll an overwritable
 * key. A protected record may repeat only the non-mutating possession
 * challenge; a ready record can return to the wizard after an app restart. */
export async function resumeEnrollmentDraft(args: {
  entry: VaultEnrollmentDraftEntry
  onPhase: (p: AdoptPhase) => void
  getPin: () => Promise<string>
  nfcMessage?: string
  scopeToken?: VaultScopeToken
  /** XR-001: used both to verify a `ready` draft's existing tag before
   * trusting its fast path, and to tag it again after a fresh challenge. */
  wallet: HmacCapableWallet
  adminOriginator: string
}): Promise<VaultKeyRecord> {
  if (!isVaultKeyRecord(args.entry.record)) {
    throw new VaultError('template-invalid', 'Invalid enrollment recovery handle')
  }
  const driver = getVaultDriver()
  if (!driver) throw new VaultError('driver-unavailable')
  const scopeToken = args.scopeToken ?? vaultStore.captureScopeToken()
  const stored = (await vaultStore.getEnrollmentDrafts(scopeToken)).find(
    entry =>
      entry.record.serial === args.entry.record.serial &&
      entry.record.pubkey === args.entry.record.pubkey &&
      JSON.stringify(entry.record) === JSON.stringify(args.entry.record)
  )
  if (!stored) throw new VaultError('not-enrolled', 'Enrollment recovery handle is no longer present')
  if (stored.assurance === 'management-uncertain') {
    throw new VaultEnrollmentPartialError(
      'key-generated',
      new VaultError(
        'mgmt-key-custom',
        'Management-key rotation is uncertain; reset the dedicated PIV application before reusing this token'
      ),
      stored.record
    )
  }
  if (stored.assurance === 'ready') {
    vaultStore.assertScopeToken(scopeToken)
    const scope = vaultStore.getScope()
    const tag = scope ? await vaultStore.getEnrollmentDraftTag(stored.record.serial, scopeToken) : null
    const authentic =
      scope !== null && (await verifyVaultDraftAuthorityTag(args.wallet, args.adminOriginator, stored.record, scope, tag))
    if (authentic) {
      args.onPhase('done')
      return { ...stored.record }
    }
    // XR-001: an unverifiable 'ready' draft — never tagged (every draft
    // written before this fix shipped) or a forged SecureStore-only write —
    // is never trusted on sight. Fall through to the same live driver
    // challenge the 'challenge-required' case below already requires: a
    // legitimate card can simply re-tap and prove itself again; an attacker
    // without the physical key cannot.
  }

  args.onPhase('pin-check')
  const pin = await args.getPin()
  requirePivCode(pin, 'PIN')
  try {
    vaultStore.assertScopeToken(scopeToken)
    await withKeySession(
      driver,
      async () => {
        vaultStore.assertScopeToken(scopeToken)
        const info = await driver.getKeyInfo()
        if (!isVaultSerial(info.serial)) throw new VaultError('template-invalid', 'YubiKey returned an invalid serial')
        if (info.serial !== stored.record.serial) {
          throw new VaultError(
            'serial-mismatch',
            'The presented YubiKey does not match the recovery handle',
            undefined,
            {
              tapped: info.serial,
              chosen: stored.record.serial
            }
          )
        }
        if (info.pinRetries === 0) throw new VaultError('pin-locked', 'PIN is blocked')
        requireVerifiedPin(await driver.verifyPin(stored.record.serial, pin))
        args.onPhase('challenging')
        const readable = await driver.readVaultPublicKey(stored.record.serial)
        if (readable && compressPubkey(readable.publicKey) !== stored.record.pubkey) {
          throw new VaultError('wrong-key', 'The YubiKey slot does not match the enrollment recovery handle')
        }
        const challenge = Uint8Array.from(randomBytes(32))
        const { signature } = await driver.signEcdsa(stored.record.serial, pin, Utils.toHex(challenge))
        if (!signatureProvesKey(stored.record.pubkey, challenge, signature)) {
          throw new VaultError('wrong-key', 'YubiKey failed the enrollment recovery challenge')
        }
        vaultStore.assertScopeToken(scopeToken)
      },
      () => args.onPhase('connecting'),
      { nfcMessage: args.nfcMessage }
    )
    const scope = vaultStore.getScope()
    if (!scope) throw new VaultError('not-enrolled', 'Wallet vault scope is not configured')
    await vaultStore.preserveEnrollmentDraft({ record: stored.record, assurance: 'ready' }, scopeToken, record =>
      computeVaultDraftAuthorityTag(args.wallet, args.adminOriginator, record, scope)
    )
    vaultStore.assertScopeToken(scopeToken)
  } catch (e) {
    if (e instanceof VaultError && e.code === 'scope-changed') {
      throw new VaultEnrollmentPartialError('key-protected', e, stored.record, true)
    }
    throw e
  }
  args.onPhase('done')
  return { ...stored.record }
}

/**
 * Prove that a restored or partially enrolled record is backed by the private
 * key in the presented token. No token state is changed and the slot is never
 * generated over. The random challenge prevents replay of an old signature.
 */
export async function adoptVaultKey(args: {
  record: VaultKeyRecord
  onPhase: (p: AdoptPhase) => void
  getPin: () => Promise<string>
  nfcMessage?: string
  scopeToken?: VaultScopeToken
}): Promise<VaultKeyRecord> {
  if (!isVaultKeyRecord(args.record)) throw new VaultError('template-invalid', 'Invalid recovered vault key record')
  const driver = getVaultDriver()
  if (!driver) throw new VaultError('driver-unavailable')
  const scopeToken = args.scopeToken ?? vaultStore.captureScopeToken()

  args.onPhase('pin-check')
  const pin = await args.getPin()
  requirePivCode(pin, 'PIN')
  const challenge = randomBytes(32)
  const digest = Utils.toHex(challenge)

  vaultStore.assertScopeToken(scopeToken)
  await withKeySession(
    driver,
    async () => {
      vaultStore.assertScopeToken(scopeToken)
      const info = await driver.getKeyInfo()
      if (info.serial !== args.record.serial) {
        throw new VaultError(
          'serial-mismatch',
          'The presented YubiKey does not match the recovered record',
          undefined,
          {
            tapped: info.serial,
            chosen: args.record.serial
          }
        )
      }
      if (info.pinRetries === 0) throw new VaultError('pin-locked', 'PIN is blocked')
      const verified = await driver.verifyPin(args.record.serial, pin)
      requireVerifiedPin(verified)

      args.onPhase('challenging')
      const readable = await driver.readVaultPublicKey(args.record.serial)
      if (readable && compressPubkey(readable.publicKey) !== args.record.pubkey) {
        throw new VaultError('wrong-key', 'The YubiKey slot public key does not match the recovered vault key')
      }
      const { signature } = await driver.signEcdsa(args.record.serial, pin, digest)
      if (!signatureProvesKey(args.record.pubkey, Uint8Array.from(challenge), signature)) {
        throw new VaultError('wrong-key', 'YubiKey failed the recovered-key possession challenge')
      }
      vaultStore.assertScopeToken(scopeToken)
    },
    () => args.onPhase('connecting'),
    { nfcMessage: args.nfcMessage }
  )

  await vaultStore.markKeyAdopted(args.record, scopeToken)
  args.onPhase('done')
  return { ...args.record }
}

export interface VerifiedVaultRecoveryOutput {
  /** Decoded only after baked-salt and exact-lock verification by transfers.
   * v6 or v7 — this function only reads fields common to both shapes
   * (vaultId, revision, createdAt, keys), never `salt`. */
  instructions: VaultInstructions
  /** Transaction containing this currently spendable output. */
  txid: string
}

/**
 * Reconstruct one current enrollment from authoritative spendable R1C outputs.
 * The transfer layer owns pagination and lock verification; this function owns
 * conflict detection and version selection. It never accepts a mixture of
 * enrollment ids or two different key sets at the same revision. A mixed
 * v6+v7 output set reduces to one VaultMeta the same way a same-version
 * mixture does — version is not part of the conflict/version-selection
 * identity here, only vaultId/createdAt/revision/keys are.
 */
export function metaFromVerifiedOutputs(outputs: readonly VerifiedVaultRecoveryOutput[]): VaultMeta {
  if (outputs.length === 0) throw new VaultError('vault-empty', 'No verified vault outputs to recover')
  if (outputs.some(o => !/^[0-9a-f]{64}$/.test(o.txid))) {
    throw new VaultError('template-invalid', 'Recovered vault output has an invalid transaction id')
  }
  const vaultId = outputs[0].instructions.vaultId
  const createdAt = outputs[0].instructions.createdAt
  if (outputs.some(o => o.instructions.vaultId !== vaultId || o.instructions.createdAt !== createdAt)) {
    throw new VaultError('template-invalid', 'Conflicting vault enrollments are currently spendable')
  }

  const revision = Math.max(...outputs.map(o => o.instructions.revision))
  const current = outputs.filter(o => o.instructions.revision === revision)
  const fingerprint = JSON.stringify(current[0].instructions.keys)
  if (current.some(o => JSON.stringify(o.instructions.keys) !== fingerprint)) {
    throw new VaultError('template-invalid', 'Conflicting vault key sets share the latest revision')
  }
  const keys = current[0].instructions.keys.map(k => ({ ...k }))
  const currentPubkeys = new Set(keys.map(k => k.pubkey))
  const removed = new Map<string, { key: VaultKeyRecord; index: number }>()
  for (const { instructions } of outputs) {
    if (instructions.revision >= revision) continue
    instructions.keys.forEach((key, index) => {
      if (!currentPubkeys.has(key.pubkey)) removed.set(key.pubkey, { key: { ...key }, index })
    })
  }
  if (removed.size > 1) {
    throw new VaultError('template-invalid', 'Multiple incomplete key removals are present')
  }

  const meta: VaultMeta = { v: 6, vaultId, revision, createdAt, keys }
  const tombstone = [...removed.values()][0]
  if (tombstone) {
    meta.pendingRemoval = {
      key: tombstone.key,
      keyIndex: Math.min(tombstone.index, keys.length),
      startedAt: Date.now(),
      revision,
      state: 'broadcast'
    }
  }
  if (!isVaultMeta(meta)) throw new VaultError('template-invalid', 'Recovered vault metadata is invalid')
  return meta
}

/**
 * XR-001: a persisted 'ready' entry is data an attacker who can only write
 * SecureStore could fabricate outright — matching serial/slot/pubkey/
 * enrolledAt is a SHAPE check, never proof anyone tapped a real card. Every
 * record this function accepts must ALSO carry a wallet-root authority tag
 * (metaAuthority.ts) that verifies against the SAME record: a tag computed
 * by legitimate code (enrollKey / resumeEnrollmentDraft, immediately after a
 * live driver.signEcdsa challenge) the moment it wrote 'ready', which a
 * storage-only attacker cannot reproduce without the real wallet's
 * admin-scoped createHmac. Reuses the existing 'key-not-adopted' refusal —
 * from the caller's perspective an unauthenticated 'ready' draft is exactly
 * as insufficient as a missing one.
 */
async function requireReadyEnrollmentDrafts(
  records: readonly VaultKeyRecord[],
  scopeToken: VaultScopeToken,
  authority: VaultWalletAuthority
): Promise<void> {
  vaultStore.assertScopeToken(scopeToken)
  const scope = vaultStore.getScope()
  if (!scope) throw new VaultError('not-enrolled', 'Wallet vault scope is not configured')
  const drafts = await vaultStore.getEnrollmentDrafts(scopeToken)
  for (const record of records) {
    const readyDraft = drafts.find(
      draft =>
        draft.assurance === 'ready' &&
        draft.record.serial === record.serial &&
        draft.record.slot === record.slot &&
        draft.record.pubkey === record.pubkey &&
        draft.record.enrolledAt === record.enrolledAt
    )
    const tag = readyDraft ? await vaultStore.getEnrollmentDraftTag(record.serial, scopeToken) : null
    const authentic =
      readyDraft !== undefined &&
      (await verifyVaultDraftAuthorityTag(authority.wallet, authority.adminOriginator, record, scope, tag))
    if (!authentic) {
      throw new VaultError(
        'key-not-adopted',
        `Key ${record.serial} has not completed its protected live enrollment challenge`
      )
    }
  }
}

/** Commit an enrollment: the wizard's 2..5 records become meta v6, atomically
 * (one scoped secure-storage write). The bounds are defensive — the wizard cannot
 * reach Finish with fewer than two keys and disables Add at five.
 *
 * Refuses while a vault is already enrolled: Finish must never silently
 * replace the key list that guards existing deposits (disableVault, offered
 * only at zero balance, is the way to start over; addVaultKey is the way to
 * grow the list). The refusal reuses `key-already-enrolled` — the closest
 * existing code, whose copy the wizard already renders with the serial it
 * carries — rather than minting a new VaultErrorCode that would need its own
 * copy in every locale. */
export async function finalizeEnrollment(
  records: VaultKeyRecord[],
  scopeToken: VaultScopeToken | undefined,
  authority: VaultWalletAuthority
): Promise<void> {
  if (records.length < VAULT_MIN_KEYS) {
    throw new VaultError('not-enough-keys', `A vault needs at least ${VAULT_MIN_KEYS} keys; ${records.length} given`)
  }
  if (records.length > VAULT_MAX_KEYS) {
    throw new VaultError('too-many-keys', `A vault holds at most ${VAULT_MAX_KEYS} keys; ${records.length} given`)
  }
  const serials = records.map(r => r.serial)
  const dupeSerial = serials.find((s, i) => serials.indexOf(s) !== i)
  if (dupeSerial !== undefined) {
    throw new VaultError('key-already-enrolled', 'Duplicate serial in the enrollment', undefined, {
      serial: dupeSerial
    })
  }
  const token = scopeToken ?? vaultStore.captureScopeToken()
  const existing = await vaultStore.getMeta(token)
  if (existing?.keys.length) {
    throw new VaultError(
      'key-already-enrolled',
      'A vault is already enrolled on this device; disable it before enrolling again',
      undefined,
      { serial: existing.keys[0].serial }
    )
  }
  // XR-001: every record must carry a live-challenge-backed, wallet-tagged
  // 'ready' draft — not merely a structurally matching one.
  await requireReadyEnrollmentDrafts(records, token, authority)
  vaultStore.assertScopeToken(token)
  const scope = vaultStore.getScope()
  if (!scope) throw new VaultError('not-enrolled', 'Wallet vault scope is not configured')
  const meta: VaultMeta = {
    v: 6,
    vaultId: Utils.toHex(randomBytes(32)),
    revision: 1,
    createdAt: Date.now(),
    keys: records
  }
  // XR-002: a fresh enrollment has no prior `current` meta to launder — see
  // vaultStore.createEnrollment's own comment — so tagging `meta` here is
  // always safe.
  await vaultStore.createEnrollment(meta, token, next =>
    computeVaultMetaAuthorityTag(authority.wallet, authority.adminOriginator, next, scope)
  )
  // XQ-014: record every committed serial in the device-wide registry
  // (enrolledSerialRegistry.ts) — best-effort, never fails the enrollment
  // that already committed.
  await Promise.all(serials.map(serial => enrolledSerialRegistry.record(serial)))
  // Drafts are public recovery handles, not authority. A cleanup failure must
  // not report enrollment failure after the authoritative write committed.
  try {
    await vaultStore.consumeEnrollmentDrafts(serials, token)
  } catch (error) {
    if (error instanceof VaultError && error.code === 'scope-changed') throw error
  }
}

/** Append one key to an enrolled vault (spec §3.4 "Add key"). vaultStore
 * enforces the duplicate-serial and VAULT_MAX_ACTIVE_KEYS rules. */
export async function addVaultKey(
  record: VaultKeyRecord,
  scopeToken: VaultScopeToken | undefined,
  authority: VaultWalletAuthority
): Promise<VaultMeta> {
  if (!isVaultKeyRecord(record)) throw new VaultError('template-invalid', 'Invalid vault key record')
  const token = scopeToken ?? vaultStore.captureScopeToken()
  const existing = await vaultStore.getMeta(token)
  if (!existing) throw new VaultError('not-enrolled', 'Vault is not set up')
  if (existing.keys.length >= VAULT_MAX_ACTIVE_KEYS) {
    throw new VaultError('too-many-keys', `The vault already has ${VAULT_MAX_ACTIVE_KEYS} keys`)
  }
  if (existing.keys.some(key => key.serial === record.serial || key.pubkey === record.pubkey)) {
    throw new VaultError('key-already-enrolled', record.serial, undefined, { serial: record.serial })
  }
  // XR-002: verify `existing`'s own tag BEFORE trusting it as the basis for
  // a freshly tagged `next` — see requireTaggedMeta's laundering caveat.
  await requireTaggedMeta(authority, existing, token)
  // XR-001: the record being added must itself carry a live-challenge-backed
  // 'ready' draft.
  await requireReadyEnrollmentDrafts([record], token, authority)
  const scope = vaultStore.getScope()
  if (!scope) throw new VaultError('not-enrolled', 'Wallet vault scope is not configured')
  const meta = await vaultStore.addKey(record, token, next =>
    computeVaultMetaAuthorityTag(authority.wallet, authority.adminOriginator, next, scope)
  )
  // XQ-014: record the newly committed serial device-wide.
  await enrolledSerialRegistry.record(record.serial)
  try {
    await vaultStore.consumeEnrollmentDrafts([record.serial], token)
  } catch (error) {
    if (error instanceof VaultError && error.code === 'scope-changed') throw error
  }
  return meta
}

/** Forget the key list. Only offered when the vault balance is zero (spec
 * §3.4); the keys themselves stay on the YubiKeys. */
export async function disableVault(scopeToken?: VaultScopeToken): Promise<void> {
  const token = scopeToken ?? vaultStore.captureScopeToken()
  const existing = await vaultStore.getMeta(token)
  await vaultStore.clear(token)
  // XQ-014: a disabled vault's keys are no longer committed under THIS
  // chain — forget any of them the device-wide registry no longer needs to
  // remember, i.e. every one not still enrolled under another chain of this
  // SAME identity (vaultStore.enrolledSerialsAcrossChains). See
  // enrolledSerialRegistry's header for the cross-identity residual this
  // does not resolve.
  if (existing?.keys.length) {
    await forgetSerialsNoLongerEnrolledForIdentity(
      existing.keys.map(key => key.serial),
      () => vaultStore.enrolledSerialsAcrossChains(token)
    )
  }
}

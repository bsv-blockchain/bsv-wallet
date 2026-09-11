/**
 * VaultKeyService — enrolling YubiKeys into the vault's key list, and tearing
 * the list down.
 *
 * Each YubiKey IS a vault key (spec D2/D3): PIV slot 0x82 holds a P-256 key
 * generated ON the card, whose compressed public key is all the phone ever
 * records. There is no seed, no seal, no passphrase and no recovery phrase
 * anywhere in this design — recovery is "any enrolled YubiKey + this wallet's
 * database" (spec §3.5). Nothing here derives, wraps or zeroizes anything.
 *
 * enrollKey runs ONE card session for ONE key and returns a public record
 * without persisting it; the wizard collects 2..5 such records and commits
 * them atomically with finalizeEnrollment (spec §3.3: nothing reaches disk
 * until Finish). addVaultKey appends one record to an enrolled vault (§3.4).
 *
 * The slot key is ALWAYS freshly generated (spec D6). There is no adoption:
 * iOS cannot read retired-slot occupancy, so "reuse the key already there"
 * is not something both platforms could offer — the key step's copy warns
 * that the slot's contents are replaced.
 *
 * SECURITY: never log the PIN. Public keys and serials are public data.
 */
import { getVaultDriver } from './driver'
import { compressPubkey } from './r1comb'
import { withKeySession } from './session'
import { VaultError } from './types'
import { vaultStore, VaultKeyRecord, VaultMeta } from './vaultStore'

export const VAULT_SLOT = 0x82

/** Spec D3: at least two keys, so one lost YubiKey does not lose the money;
 * at most five (R1C_MAX_KEYS — the lock carries one commitment per key). */
export const VAULT_MIN_KEYS = 2
export const VAULT_MAX_KEYS = 5

const DEFAULT_PIV_PIN = '123456'

export type EnrollPhase = 'connecting' | 'pin-check' | 'generating' | 'done'

/**
 * Enrol ONE YubiKey: one card session (one NFC tap), one fresh key, one
 * public record back. Persists nothing.
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
   * new PIN the user chose. If omitted, enrollment proceeds on the default PIN
   * (dev/test convenience). */
  requestPinChange?: (retries: number) => Promise<{ oldPin: string; newPin: string }>
  /** Localised iOS NFC alert text for this tap (spec §4.2 step 6, enrollment
   * wording). Additive to the interface contract; Android ignores it and an
   * omitted value selects the native default wording. */
  nfcMessage?: string
}): Promise<VaultKeyRecord> {
  const driver = getVaultDriver()
  if (!driver) throw new VaultError('driver-unavailable')

  // The enrolled key list, read once (AsyncStorage) before any user input or
  // key contact. Refused alongside pendingSerials below — meta ∪ pending —
  // so an enrolled card is refused even when the caller's own copy of meta
  // has not loaded (the wizard's key list arrives asynchronously).
  const meta = await vaultStore.getMeta()
  const refused = new Set<string>([...(meta?.keys.map(k => k.serial) ?? []), ...args.pendingSerials])

  // ── ALL user input up front, BEFORE any key contact ──
  args.onPhase('pin-check')
  const pin0 = await args.getPin()
  let pin = pin0
  let pinChange: { oldPin: string; newPin: string } | null = null
  if (pin0 === DEFAULT_PIV_PIN && args.requestPinChange) {
    // Factory-default detection is exactly "the PIN the user entered is the
    // default" — no side probe against '123456' that would burn a retry.
    pinChange = await args.requestPinChange(3)
    pin = pinChange.newPin
  }

  // ── Token phase: one session / one NFC tap ──
  const { serial, publicKey } = await withKeySession(
    driver,
    async () => {
      const info = await driver.getKeyInfo()
      if (refused.has(info.serial)) {
        // The message IS the serial: the wizard resolves it to a nickname.
        throw new VaultError('key-already-enrolled', info.serial, undefined, { serial: info.serial })
      }
      // A blocked PIN can't be enrolled — surface it before burning anything.
      if (info.pinRetries === 0) throw new VaultError('pin-locked', 'PIN is blocked')
      if (pinChange) await driver.changePin(pinChange.oldPin, pinChange.newPin)
      const verified = await driver.verifyPin(pin)
      if (!verified.ok) throw new VaultError('pin-invalid', 'PIN not accepted', verified.retriesLeft)
      args.onPhase('generating')
      // Always fresh (spec D6): the adapter passes 'cached'/'once' (Task 4).
      const { publicKey } = await driver.generateVaultKey(VAULT_SLOT)
      return { serial: info.serial, publicKey }
    },
    () => args.onPhase('connecting'),
    { nfcMessage: args.nfcMessage }
  )

  // Canonical form (33-byte compressed, lowercase) before anything is compared
  // or stored. A point that is not on P-256 is a card bug; recode it without
  // echoing the bytes.
  let pubkey: string
  try {
    pubkey = compressPubkey(publicKey)
  } catch {
    throw new VaultError('template-invalid', 'YubiKey returned invalid key material')
  }

  const k = args.pendingSerials.length + 1
  const record: VaultKeyRecord = {
    serial,
    slot: VAULT_SLOT,
    pubkey,
    nickname: args.nickname?.trim() || `Key ${k}`,
    enrolledAt: Date.now()
  }
  args.onPhase('done')
  return record
}

/** Commit an enrollment: the wizard's 2..5 records become meta v5, atomically
 * (one AsyncStorage write). The bounds are defensive — the wizard cannot
 * reach Finish with fewer than two keys and disables Add at five.
 *
 * Refuses while a vault is already enrolled: Finish must never silently
 * replace the key list that guards existing deposits (disableVault, offered
 * only at zero balance, is the way to start over; addVaultKey is the way to
 * grow the list). The refusal reuses `key-already-enrolled` — the closest
 * existing code, whose copy the wizard already renders with the serial it
 * carries — rather than minting a new VaultErrorCode that would need its own
 * copy in every locale. */
export async function finalizeEnrollment(records: VaultKeyRecord[]): Promise<void> {
  if (records.length < VAULT_MIN_KEYS) {
    throw new VaultError('not-enough-keys', `A vault needs at least ${VAULT_MIN_KEYS} keys; ${records.length} given`)
  }
  if (records.length > VAULT_MAX_KEYS) {
    throw new VaultError('too-many-keys', `A vault holds at most ${VAULT_MAX_KEYS} keys; ${records.length} given`)
  }
  const serials = records.map(r => r.serial)
  const dupeSerial = serials.find((s, i) => serials.indexOf(s) !== i)
  if (dupeSerial !== undefined) {
    throw new VaultError('key-already-enrolled', 'Duplicate serial in the enrollment', undefined, { serial: dupeSerial })
  }
  const existing = await vaultStore.getMeta()
  if (existing && existing.keys.length > 0) {
    throw new VaultError(
      'key-already-enrolled',
      'A vault is already enrolled on this device; disable it before enrolling again',
      undefined,
      { serial: existing.keys[0].serial }
    )
  }
  await vaultStore.setMeta({ v: 5, createdAt: Date.now(), keys: records })
}

/** Append one key to an enrolled vault (spec §3.4 "Add key"). vaultStore
 * enforces the duplicate-serial and five-key rules. */
export async function addVaultKey(record: VaultKeyRecord): Promise<VaultMeta> {
  return vaultStore.addKey(record)
}

/** Forget the key list. Only offered when the vault balance is zero (spec
 * §3.4); the keys themselves stay on the YubiKeys. */
export async function disableVault(): Promise<void> {
  await vaultStore.clear()
}

/**
 * Vault domain types — shared by the store, the ceremony controller, the
 * transfers and the UI. No React, no I/O.
 *
 * There is no sealed private YubiKey material or seed-derived spending
 * authority: the enrolled YubiKeys are the spending keys. The wallet root
 * derives deterministic HMAC salts from the ordered serial list.
 * Each output carries its salt in the locking script; customInstructions
 * mirror it for indexed discovery and are accepted only after exact script and
 * salt-derivation verification.
 */

export type VaultErrorCode =
  | 'unsupported-platform'
  | 'no-key'
  | 'wrong-key'
  | 'pin-required'
  | 'pin-invalid'
  | 'pin-locked'
  | 'puk-invalid'
  | 'puk-locked'
  | 'touch-timeout'
  | 'key-removed-mid-op'
  /** Another transfer still owns the single process-wide hardware signer. */
  | 'ceremony-active'
  /** Wallet or chain changed while a scoped vault operation was in flight. */
  | 'scope-changed'
  | 'mgmt-key-custom'
  /** Factory F9 or generated-slot manufacturer attestation was missing,
   * malformed, mismatched, or outside the pinned Yubico production chains. */
  | 'attestation-invalid'
  | 'slot-occupied'
  /** A slot key exists, but management-key rotation did not confirm. The
   * attached VaultEnrollmentPartialError record can be challenged/recovered;
   * it must never be silently persisted as enrolled. */
  | 'enrollment-partial'
  /** A vault key digest, DER signature, pubkey or script failed a structural
   * check (r1comb.ts throws it for malformed SEC1 points, DER, or a lock that
   * is not an R1C lock). Distinct from 'wrong-key', which vaultErrorFromNative
   * may reclassify to 'nfc-lost'. */
  | 'template-invalid'
  | 'serial-mismatch'
  | 'user-cancelled'
  | 'not-enrolled'
  | 'driver-unavailable'
  | 'vault-empty'
  | 'amount-exceeds-balance'
  | 'below-dust'
  | 'no-transaction'
  | 'nfc-lost'
  /** More vault inputs would be needed than one transaction may safely carry.
   *  See VAULT_MAX_INPUTS — the remedy is a smaller withdrawal, which also
   *  consolidates the vault. */
  | 'too-many-inputs'
  /** The device is offline. Vault transfers never enter the offline queue — see
   *  VaultTransferOptions.isOnline. */
  | 'requires-online'
  // ── R1C (1-of-N comb vault) ──────────────────────────────────────────────
  /** `vaultEnabled` is off in this build (spec §0 / D15): no enrollment,
   *  deposit, re-vault or re-lock may create a vault output. */
  | 'not-released'
  /** No private backup service is configured, or encrypted backup push is
   * opted out. New Vault outputs retain recovery metadata in that backup. */
  | 'backup-off'
  /** Fewer than VAULT_MIN_KEYS keys — defensive; the wizard cannot persist it. */
  | 'not-enough-keys'
  /** The tapped serial is already in meta.keys or in the wizard's pending list.
   *  The message carries the serial. */
  | 'key-already-enrolled'
  /** Restored metadata exists, but this serial has not yet passed the fresh
   * possession challenge on this device. */
  | 'key-not-adopted'
  /** VAULT_MAX_KEYS keys already enrolled. */
  | 'too-many-keys'
  /** Removing this key would leave fewer than VAULT_MIN_KEYS. */
  | 'last-keys'
  /** Removing this key would orphan an output only it can open — re-lock first. */
  | 'relock-required'
  /** The chosen key is not among the commitments baked into an output's real
   *  lock (or no reachable output exists). The message names the outpoint. */
  | 'key-not-committed'
  /** The chosen key can open less than the requested amount while other keys
   *  could open more. */
  | 'key-cannot-cover'
  /** acc − feeEstimate < VAULT_DEPOSIT_MIN: nothing worth re-locking. */
  | 'too-small-to-relock'
  /** The signable transaction is not consensus-bound version 1 — refused
   *  before any signature. */
  | 'bad-version'

export class VaultError extends Error {
  code: VaultErrorCode
  /** PIN attempts remaining, present on pin-invalid. */
  retriesLeft?: number
  /** Structured context for the specific failure — e.g. serial-mismatch's
   *  { tapped, chosen } or key-cannot-cover's { reachable, total } (see the
   *  Interfaces note above for the full convention). Additive: most codes
   *  leave it undefined, and no existing call site needs to change. */
  details?: Record<string, string | number>

  constructor(code: VaultErrorCode, message?: string, retriesLeft?: number, details?: Record<string, string | number>) {
    super(message ?? code)
    this.name = 'VaultError'
    this.code = code
    this.retriesLeft = retriesLeft
    this.details = details
  }
}

/** Native YubiKit description substrings for a dropped NFC field mid-command
 * (the phone moved a hair off the key, or the key was lifted). This is
 * transient and retryable — never a wrong key, but older/currently-installed
 * builds' Swift `mapError` falls through to its `wrong-key` default for any
 * description it doesn't specifically recognize, which includes this one. */
const NFC_LOST_PATTERN = /tag response error|no response|tag connection lost|session invalidated/i

/** Parse a native-module rejection (`VAULT_ERR:<code>:<detail>`) into a
 * VaultError; anything unrecognized becomes a generic driver failure. */
export function vaultErrorFromNative(e: unknown): VaultError {
  const msg = e instanceof Error ? e.message : String(e)
  const m = /^VAULT_ERR:([a-z-]+):?(.*)$/.exec(msg)
  if (m) {
    let code = m[1] as VaultErrorCode
    const detailMatch = /retries=(\d+)/.exec(m[2])
    // Reclassify a native `wrong-key` whose detail is really an NFC dropout —
    // see NFC_LOST_PATTERN. Safe to keep even after the native side is fixed
    // to classify this correctly at the source: this simply never matches then.
    if (code === 'wrong-key' && NFC_LOST_PATTERN.test(m[2])) {
      code = 'nfc-lost'
    }
    return new VaultError(code, m[2] || undefined, detailMatch ? Number(detailMatch[1]) : undefined)
  }
  return new VaultError('driver-unavailable', msg)
}

/**
 * One table from VaultErrorCode to user copy.
 *
 * Replaces two tables that disagreed with each other: VaultCeremonySheet's
 * ERROR_COPY (a hand-written code → key map with alias keys) and
 * VaultTransferScreen's translateVaultError (a `vault_err_${code}` naming
 * convention with a generic fallback). Every code in the union is listed, so
 * adding a code without copy is a type error rather than a raw key on screen.
 *
 * Copy that names keys or amounts takes them from `params`. When a caller has
 * nothing to name, the code degrades to the closest copy that needs no
 * parameters (see the switch) — never to a string with `{{placeholders}}`
 * left in it.
 *
 * Contract note: `VaultError` carries a code, an optional message and
 * `retriesLeft`, plus an optional structured `details` object services may
 * attach (the DECISION: `serial-mismatch` → `{ tapped, chosen }`,
 * `key-already-enrolled` → `{ serial }`, `key-cannot-cover` → `{ reachable,
 * total }`). Callers derive `tappedName`/`chosenName` from `error.details`
 * (Plan 2's `requestSigner` / `enrollKey`), and `reachable`/`total` likewise
 * from `error.details` (see VaultTransferScreen's readErrorDetails). None of
 * this is required: the fallbacks below are what the user sees when a
 * service omits `details`.
 */
import { i18n, type VaultErrorCode } from '@bsv/expo-wallet-toolbox'

const t = (k: string, o?: Record<string, unknown>) => i18n.t(k, o) as string

export interface VaultErrorParams {
  /** The key the copy is about, as `nickname · …tail4` (KeyChooser's vaultKeyLabel) or a bare nickname. */
  nickname?: string
  /** Every enrolled key, joined with ', '. */
  names?: string
  /** The other enrolled keys (all but `nickname`), joined with ', '. */
  otherNames?: string
  /** serial-mismatch: the tapped card, when it is itself an enrolled key. */
  tappedName?: string
  /** serial-mismatch: the key the user chose in-app. */
  chosenName?: string
  /** key-cannot-cover: formatted amounts (formatAmount output), not raw sats. */
  reachable?: string
  total?: string
  /** pin-invalid: attempts left, appended as a second sentence. */
  count?: number
}

/**
 * Exhaustive over the union: TypeScript rejects a missing or extra entry the
 * moment `VaultErrorCode` changes.
 */
const KEY: Record<VaultErrorCode, string> = {
  'unsupported-platform': 'vault_err_unsupported_platform',
  'no-key': 'vault_err_no_key',
  'wrong-key': 'vault_err_wrong_key',
  'pin-required': 'vault_err_pin_required',
  'pin-invalid': 'vault_err_pin_invalid',
  'pin-locked': 'vault_err_pin_locked',
  'puk-invalid': 'vault_err_puk_invalid',
  'puk-locked': 'vault_err_puk_locked',
  'touch-timeout': 'vault_err_touch_timeout',
  'key-removed-mid-op': 'vault_err_key_removed_mid_op',
  'ceremony-active': 'vault_err_ceremony_active',
  'scope-changed': 'vault_err_scope_changed',
  'mgmt-key-custom': 'vault_err_mgmt_key_custom',
  'attestation-invalid': 'vault_err_attestation_invalid',
  'slot-occupied': 'vault_err_slot_occupied',
  'enrollment-partial': 'vault_err_enrollment_partial',
  'template-invalid': 'vault_err_template_invalid',
  'serial-mismatch': 'vault_err_serial_mismatch',
  'user-cancelled': 'vault_err_user_cancelled',
  'not-enrolled': 'vault_err_not_enrolled',
  'driver-unavailable': 'vault_err_driver_unavailable',
  'vault-empty': 'vault_err_vault_empty',
  'amount-exceeds-balance': 'vault_err_amount_exceeds_balance',
  'below-dust': 'vault_err_below_dust',
  'no-transaction': 'vault_err_no_transaction',
  'nfc-lost': 'vault_err_nfc_lost',
  'too-many-inputs': 'vault_err_too_many_inputs',
  'requires-online': 'vault_err_requires_online',
  'not-released': 'vault_err_not_released',
  'not-enough-keys': 'vault_err_not_enough_keys',
  'key-already-enrolled': 'vault_err_key_already_enrolled',
  'key-not-adopted': 'vault_err_key_not_adopted',
  'too-many-keys': 'vault_err_too_many_keys',
  'last-keys': 'vault_err_last_keys',
  'relock-required': 'vault_err_relock_required',
  'key-not-committed': 'vault_err_key_not_committed',
  'key-cannot-cover': 'vault_err_key_cannot_cover',
  'too-small-to-relock': 'vault_err_too_small_to_relock',
  'bad-version': 'vault_err_bad_version'
}

/**
 * Errors where the fix is simply "do the tap again" — worth a Retry button
 * instead of only Dismiss. Must stay a SUBSET of `CeremonyController`'s own
 * retryable set (core/services/vault/ceremony.ts, `RETRYABLE_TAP_ERRORS`) or
 * the button renders but does nothing. 'key-removed-mid-op' is deliberately
 * excluded even though the signing loop can produce it, because it can ALSO
 * arrive from a moment the loop does not cover (waiting-for-key), where retry
 * would be a dead button.
 */
export const RETRYABLE_VAULT_ERRORS: ReadonlySet<VaultErrorCode> = new Set<VaultErrorCode>([
  'touch-timeout',
  'nfc-lost'
])

export function vaultErrorCopy(code: VaultErrorCode | undefined, params: VaultErrorParams = {}): string {
  // `code in KEY` guards a code the natives might emit that the union does not
  // know (vaultErrorFromNative casts freely); it must land on the generic line,
  // not on the raw `vault_err_<code>` key.
  if (!code || !(code in KEY)) return t('vault_err_generic')
  switch (code) {
    case 'serial-mismatch':
      if (params.tappedName && params.chosenName) {
        return t('vault_err_serial_mismatch_chosen', {
          tappedName: params.tappedName,
          chosenName: params.chosenName
        })
      }
      if (params.names) return t('vault_err_serial_mismatch', { names: params.names })
      return t('vault_err_wrong_key')
    case 'key-already-enrolled':
    case 'key-not-committed':
      return params.nickname ? t(KEY[code], { nickname: params.nickname }) : t('vault_err_generic')
    case 'key-cannot-cover':
      return params.nickname && params.reachable && params.total && params.otherNames
        ? t(KEY[code], {
            nickname: params.nickname,
            reachable: params.reachable,
            total: params.total,
            otherNames: params.otherNames
          })
        : t('vault_err_amount_exceeds_balance')
    case 'pin-invalid':
    case 'puk-invalid':
      return typeof params.count === 'number'
        ? `${t(KEY[code])} ${t('vault_pin_retries', { count: params.count })}`
        : t(KEY[code])
    default:
      return t(KEY[code])
  }
}

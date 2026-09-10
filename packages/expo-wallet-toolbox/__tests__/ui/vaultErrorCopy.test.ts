/**
 * vaultErrorCopy is the ONLY place a VaultErrorCode becomes words. Every code
 * in the union must resolve to a real key (never the raw key, never a string
 * with `{{placeholders}}` left in it), and copy that names keys or amounts
 * must degrade to param-free copy when the caller has nothing to name.
 */
const mockT = (k: string, o?: Record<string, unknown>) =>
  o && Object.keys(o).length ? `${k}:${JSON.stringify(o)}` : k

// `mockT` is referenced lazily (inside an arrow) so the hoisted factory never
// touches it before the `const` above has initialised.
jest.mock('@bsv/expo-wallet-toolbox', () => ({
  i18n: { t: (k: string, o?: Record<string, unknown>) => mockT(k, o) }
}))

import { vaultErrorCopy, RETRYABLE_VAULT_ERRORS } from '../../ui/components/vault/vaultErrorCopy'
import type { VaultErrorCode } from '../../core/services/vault/types'

const ALL_CODES: VaultErrorCode[] = [
  'unsupported-platform', 'no-key', 'wrong-key', 'pin-required', 'pin-invalid', 'pin-locked',
  'touch-timeout', 'key-removed-mid-op', 'mgmt-key-custom', 'slot-occupied', 'template-invalid',
  'serial-mismatch', 'user-cancelled', 'not-enrolled', 'driver-unavailable', 'vault-empty',
  'amount-exceeds-balance', 'below-dust', 'no-transaction', 'nfc-lost', 'too-many-inputs',
  'requires-online', 'not-released', 'backup-off', 'not-enough-keys', 'key-already-enrolled',
  'too-many-keys', 'last-keys', 'relock-required', 'key-not-committed', 'key-cannot-cover',
  'too-small-to-relock', 'bad-version'
]

describe('vaultErrorCopy', () => {
  test('every code resolves to a vault_err_* key, never the generic fallback', () => {
    for (const code of ALL_CODES) {
      const params = {
        nickname: 'Desk · …0001',
        names: 'Desk · …0001, Safe · …0002',
        otherNames: 'Safe · …0002',
        tappedName: 'Safe · …0002',
        chosenName: 'Desk · …0001',
        reachable: '40,000 satoshis',
        total: '100,000 satoshis',
        count: 2
      }
      const copy = vaultErrorCopy(code, params)
      expect(copy.startsWith('vault_err_')).toBe(true)
      expect(copy).not.toBe('vault_err_generic')
      expect(copy).not.toMatch(/{{/)
    }
  })

  test('undefined and unknown codes fall back to the generic line', () => {
    expect(vaultErrorCopy(undefined)).toBe('vault_err_generic')
    expect(vaultErrorCopy('seal-corrupt' as unknown as VaultErrorCode)).toBe('vault_err_generic')
  })

  test('plain codes use the code-derived key (aliases from the old ERROR_COPY are gone)', () => {
    expect(vaultErrorCopy('key-removed-mid-op')).toBe('vault_err_key_removed_mid_op')
    expect(vaultErrorCopy('driver-unavailable')).toBe('vault_err_driver_unavailable')
    expect(vaultErrorCopy('mgmt-key-custom')).toBe('vault_err_mgmt_key_custom')
    expect(vaultErrorCopy('pin-required')).toBe('vault_err_pin_required')
    expect(vaultErrorCopy('not-released')).toBe('vault_err_not_released')
    expect(vaultErrorCopy('bad-version')).toBe('vault_err_bad_version')
  })

  test('serial-mismatch names the tapped and chosen keys when both are known', () => {
    expect(vaultErrorCopy('serial-mismatch', { tappedName: 'Safe · …0002', chosenName: 'Desk · …0001' })).toBe(
      'vault_err_serial_mismatch_chosen:{"tappedName":"Safe · …0002","chosenName":"Desk · …0001"}'
    )
  })

  test('serial-mismatch lists the vault keys when only their names are known', () => {
    expect(vaultErrorCopy('serial-mismatch', { names: 'Desk · …0001, Safe · …0002' })).toBe(
      'vault_err_serial_mismatch:{"names":"Desk · …0001, Safe · …0002"}'
    )
  })

  test('serial-mismatch with no names degrades to the plain wrong-key line', () => {
    expect(vaultErrorCopy('serial-mismatch')).toBe('vault_err_wrong_key')
  })

  test('key-already-enrolled names the duplicate, or says nothing specific without a name', () => {
    expect(vaultErrorCopy('key-already-enrolled', { nickname: 'Desk' })).toBe(
      'vault_err_key_already_enrolled:{"nickname":"Desk"}'
    )
    expect(vaultErrorCopy('key-already-enrolled')).toBe('vault_err_generic')
  })

  test('key-cannot-cover needs all four params, else falls back to amount-exceeds-balance', () => {
    expect(
      vaultErrorCopy('key-cannot-cover', {
        nickname: 'Desk · …0001',
        reachable: '40,000 satoshis',
        total: '100,000 satoshis',
        otherNames: 'Safe · …0002'
      })
    ).toBe(
      'vault_err_key_cannot_cover:{"nickname":"Desk · …0001","reachable":"40,000 satoshis","total":"100,000 satoshis","otherNames":"Safe · …0002"}'
    )
    expect(vaultErrorCopy('key-cannot-cover', { nickname: 'Desk · …0001' })).toBe('vault_err_amount_exceeds_balance')
  })

  test('key-not-committed needs the nickname', () => {
    expect(vaultErrorCopy('key-not-committed', { nickname: 'Desk · …0001' })).toBe(
      'vault_err_key_not_committed:{"nickname":"Desk · …0001"}'
    )
    expect(vaultErrorCopy('key-not-committed')).toBe('vault_err_generic')
  })

  test('pin-invalid appends the attempts-left line when a count is given', () => {
    expect(vaultErrorCopy('pin-invalid', { count: 2 })).toBe('vault_err_pin_invalid vault_pin_retries:{"count":2}')
    expect(vaultErrorCopy('pin-invalid')).toBe('vault_err_pin_invalid')
  })

  test('the retryable set is exactly the two tap-again codes', () => {
    expect([...RETRYABLE_VAULT_ERRORS].sort()).toEqual(['nfc-lost', 'touch-timeout'])
  })
})

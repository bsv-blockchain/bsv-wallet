/**
 * VaultErrorCode list guard. The union is compile-time only, so the value of
 * this file is (a) the tsc pass over the package after types.ts changes and
 * (b) the runtime parse of a native rejection carrying one of the new codes.
 */
import { VaultError, VaultErrorCode, vaultErrorFromNative } from '../../core/services/vault/types'

const R1C_CODES: VaultErrorCode[] = [
  'not-released',
  'not-enough-keys',
  'key-already-enrolled',
  'too-many-keys',
  'last-keys',
  'relock-required',
  'key-not-committed',
  'key-cannot-cover',
  'too-small-to-relock',
  'attestation-invalid',
  'bad-version'
]

describe('VaultErrorCode (R1C)', () => {
  it('constructs a VaultError for every new code and keeps the code on the instance', () => {
    for (const code of R1C_CODES) {
      const e = new VaultError(code, 'detail')
      expect(e.code).toBe(code)
      expect(e.message).toBe('detail')
      expect(e.name).toBe('VaultError')
    }
  })

  it('vaultErrorFromNative parses a new code out of a VAULT_ERR rejection', () => {
    const e = vaultErrorFromNative(new Error('VAULT_ERR:key-not-committed:abcd.0'))
    expect(e.code).toBe('key-not-committed')
    expect(e.message).toBe('abcd.0')
  })

  it('preserves the fail-closed manufacturer-attestation code from native', () => {
    const e = vaultErrorFromNative(new Error('VAULT_ERR:attestation-invalid:unknown manufacturer chain'))
    expect(e.code).toBe('attestation-invalid')
  })

  it('a default message falls back to the code itself', () => {
    expect(new VaultError('bad-version').message).toBe('bad-version')
  })

  it('carries structured details when given, and defaults to undefined', () => {
    expect(new VaultError('bad-version').details).toBeUndefined()
    const e = new VaultError('serial-mismatch', 'Tapped key A, chose key B', undefined, { tapped: 'A', chosen: 'B' })
    expect(e.details).toEqual({ tapped: 'A', chosen: 'B' })
  })
})

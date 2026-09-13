/**
 * VaultErrorCode list guard. The union is compile-time only, so the value of
 * this file is (a) the tsc pass over the package after types.ts changes and
 * (b) the runtime parse of a native rejection carrying one of the new codes.
 */
import { VaultError, VaultErrorCode, vaultErrorFromNative } from '../../core/services/vault/types'

const R1C_CODES: VaultErrorCode[] = [
  'not-released',
  'not-on-mainnet',
  'backup-off',
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

  it('reads the payload out of an iOS NSError description wrapper', () => {
    // What actually reaches JS on iOS: Nitro surfaces NSError.description, not
    // localizedDescription, so the payload is quoted inside a wrapper. An
    // anchored ^VAULT_ERR: never matched this, and every iOS vault error became
    // driver-unavailable ("YubiKey support is unavailable on this device").
    const e = vaultErrorFromNative(
      new Error(
        'Error Domain=YubiKeyPiv Code=1 "VAULT_ERR:attestation-invalid:factory attestation certificate is not trusted" UserInfo={NSLocalizedDescription=VAULT_ERR:attestation-invalid:factory attestation certificate is not trusted}'
      )
    )
    expect(e.code).toBe('attestation-invalid')
    expect(e.message).toBe('factory attestation certificate is not trusted')
  })

  it('keeps retriesLeft when the payload is NSError-wrapped', () => {
    const e = vaultErrorFromNative(
      new Error('Error Domain=YubiKeyPiv Code=1 "VAULT_ERR:pin-invalid:retries=2" UserInfo={x=y}')
    )
    expect(e.code).toBe('pin-invalid')
    expect(e.retriesLeft).toBe(2)
  })

  it('still returns driver-unavailable for a rejection carrying no payload', () => {
    const e = vaultErrorFromNative(new Error('Error Domain=NSCocoaErrorDomain Code=4097 "connection invalid"'))
    expect(e.code).toBe('driver-unavailable')
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

/**
 * The payee's half of a nearby token hand-over (plan 07 Task 16): the §7.1
 * receipt built from a v6 frame, and how a failed receipt internalize is
 * classified (retry it, or journal it refused for good).
 */
import { ATTESTED_PROFILE_ID } from '@bsv/mandala'
import type { PaymentFrame } from '../../core/localpay/codec'
import {
  declarationTxOf,
  isRetriableReceiptFailure,
  receiptFailureCode,
  receiptFromFrame,
  receiptInternalizeOutput
} from '../../core/mandala/receipt'

const ASSET = `${'ab'.repeat(32)}_0`
const LEAF = {
  declarationTx: '0100beef',
  transactions: [],
  attestations: [{ txid: 'cd'.repeat(32), outputs: [0], signer: '02'.padEnd(66, 'a'), signature: '3044' }],
  submissions: [{ txid: 'cd'.repeat(32), offChainValues: '00' }]
}
const FRAME: PaymentFrame = {
  version: 6,
  kind: 'token',
  senderIdentityKey: '03'.padEnd(66, 'b'),
  outputIndex: 0,
  derivationPrefix: 'cHJlZml4cHJlZml4cHJlZg==',
  derivationSuffix: 'c3VmZml4c3VmZml4c3VmZg==',
  token: { assetId: ASSET, certificates: [], profileData: JSON.stringify({ [ATTESTED_PROFILE_ID]: { [ASSET]: LEAF } }) },
  transaction: new Uint8Array([1, 2, 3])
}

/** An error as it may arrive from the module, or after a BRC-100 substrate dropped its class. */
function err(name: string, retryable?: boolean, message = 'boom'): Error {
  const e = new Error(message) as Error & { retryable?: boolean }
  e.name = name
  if (retryable !== undefined) e.retryable = retryable
  return e
}

describe('receiptFromFrame / receiptInternalizeOutput', () => {
  it('builds the §7.1 receipt and the p color basket insertion verbatim', () => {
    const out = receiptInternalizeOutput(FRAME)
    expect(out.outputIndex).toBe(0)
    expect(out.protocol).toBe('basket insertion')
    expect(out.insertionRemittance.basket).toBe(`p color ${ASSET.replace('_', 'v')}`)
    expect(JSON.parse(out.insertionRemittance.customInstructions)).toEqual({
      version: 1,
      assetId: ASSET,
      derivationPrefix: FRAME.derivationPrefix,
      derivationSuffix: FRAME.derivationSuffix,
      senderIdentityKey: FRAME.senderIdentityKey,
      profileData: JSON.parse(FRAME.token!.profileData)
    })
    // No caller tags: the module authors every color_* tag itself.
    expect(out.insertionRemittance).not.toHaveProperty('tags')
  })

  it('serializes the members in §7.1 order', () => {
    const keys = Object.keys(JSON.parse(receiptInternalizeOutput(FRAME).insertionRemittance.customInstructions))
    expect(keys).toEqual(['version', 'assetId', 'derivationPrefix', 'derivationSuffix', 'senderIdentityKey', 'profileData'])
  })

  it('refuses a BSV frame and a profileData that is not a JSON object', () => {
    expect(() => receiptFromFrame({ ...FRAME, kind: 'bsv', token: undefined })).toThrow(/token frame/)
    expect(() => receiptFromFrame({ ...FRAME, token: { ...FRAME.token!, profileData: '[1]' } })).toThrow(/object/)
    expect(() => receiptFromFrame({ ...FRAME, token: { ...FRAME.token!, profileData: '{' } })).toThrow()
  })
})

describe('declarationTxOf', () => {
  it('reads the attested leaf’s deploy tx when it is lowercase hex', () => {
    expect(declarationTxOf(receiptFromFrame(FRAME))).toBe('0100beef')
  })

  it('is undefined for a missing, non-hex or uppercase declarationTx', () => {
    const r = receiptFromFrame(FRAME)
    expect(declarationTxOf({ ...r, profileData: {} })).toBeUndefined()
    expect(declarationTxOf({ ...r, profileData: { [ATTESTED_PROFILE_ID]: { [ASSET]: { declarationTx: 'zz' } } } })).toBeUndefined()
    expect(declarationTxOf({ ...r, profileData: { [ATTESTED_PROFILE_ID]: { [ASSET]: { declarationTx: '0A' } } } })).toBeUndefined()
    expect(declarationTxOf({ ...r, profileData: { [ATTESTED_PROFILE_ID]: { [ASSET]: { declarationTx: 7 } } } })).toBeUndefined()
  })
})

describe('isRetriableReceiptFailure', () => {
  it.each([
    ['ColorProviderError', true, true],
    ['ColorProviderError', false, false],
    ['AttestationEvidenceError', undefined, false],
    ['ProfileDataError', undefined, false],
    ['ProfileParamsError', undefined, false],
    ['UnsupportedProfileError', undefined, false],
    ['ColorConsentDeclinedError', undefined, false],
    ['Error', undefined, true]
  ])('classifies %s retryable=%s as retriable=%s', (name, retryable, expected) =>
    expect(isRetriableReceiptFailure(err(name, retryable as boolean | undefined))).toBe(expected)
  )

  // D22: names do not always survive a BRC-100 substrate; the module prefixes
  // its messages with `[Name] ` and the lib provider tags `(ERR_X[, retryable])`.
  it('reads the class and retryability from the message when the name was lost', () => {
    expect(
      isRetriableReceiptFailure(
        err('Error', undefined, '[ColorProviderError] mandala overlay refused (ERR_CONSERVATION): no')
      )
    ).toBe(false)
    expect(
      isRetriableReceiptFailure(
        err('Error', undefined, '[ColorProviderError] mandala overlay refused (ERR_UNAVAILABLE, retryable): down')
      )
    ).toBe(true)
    expect(isRetriableReceiptFailure(err('Error', undefined, 'WERR: [AttestationEvidenceError] BRC-207: bad'))).toBe(
      false
    )
    // The module's consent decline text (dist: `BRC-207: the user declined the ${type} request`).
    expect(isRetriableReceiptFailure(err('Error', undefined, 'BRC-207: the user declined the color_receive request'))).toBe(
      false
    )
  })

  it('treats a storage fault or a non-error as retriable', () => {
    expect(isRetriableReceiptFailure(new Error('database is locked'))).toBe(true)
    expect(isRetriableReceiptFailure('nope')).toBe(true)
    expect(isRetriableReceiptFailure(undefined)).toBe(true)
  })
})

describe('receiptFailureCode', () => {
  it('prefers the overlay code, then the error class', () => {
    const provider = Object.assign(err('ColorProviderError', false), { code: 'ERR_CONSERVATION' })
    expect(receiptFailureCode(provider)).toBe('ERR_CONSERVATION')
    expect(receiptFailureCode(err('Error', undefined, '[ColorProviderError] refused (ERR_LINKAGE): x'))).toBe(
      'ERR_LINKAGE'
    )
    expect(receiptFailureCode(err('AttestationEvidenceError'))).toBe('AttestationEvidenceError')
    expect(receiptFailureCode(err('Error', undefined, '[ProfileDataError] x'))).toBe('ProfileDataError')
    expect(receiptFailureCode(new Error('x'))).toBe('ERR_RECEIPT')
  })
})

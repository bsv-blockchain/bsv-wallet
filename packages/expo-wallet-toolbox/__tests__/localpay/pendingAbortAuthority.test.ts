/**
 * XR-102 (non-Vault residual): pending-abort entry authenticity tag.
 *
 * Mirrors __tests__/services/connectionAuthority.test.ts's own structure —
 * real (ProtoWallet-backed) crypto tests first, then wiring tests against a
 * mocked wallet.
 */
import { PrivateKey, ProtoWallet } from '@bsv/sdk'
import {
  computePendingAbortAuthorityTag,
  verifyPendingAbortAuthorityTag,
  PENDING_ABORT_AUTHORITY_PROTOCOL_ID
} from '../../core/localpay/pendingAbortAuthority'

const ADMIN_ORIGINATOR = 'internal-admin.bsv-wallet.invalid'

describe('pending-abort authority tag (real crypto)', () => {
  const adminWallet = new ProtoWallet(new PrivateKey(1))

  it('verifies a tag against the exact reference it was computed over', async () => {
    const tag = await computePendingAbortAuthorityTag(adminWallet, ADMIN_ORIGINATOR, 'ref-1')
    await expect(verifyPendingAbortAuthorityTag(adminWallet, ADMIN_ORIGINATOR, 'ref-1', tag)).resolves.toBe(true)
  })

  it('XR-102: fails verification when the reference is substituted after tagging', async () => {
    const tag = await computePendingAbortAuthorityTag(adminWallet, ADMIN_ORIGINATOR, 'ref-1')
    await expect(verifyPendingAbortAuthorityTag(adminWallet, ADMIN_ORIGINATOR, 'ref-2', tag)).resolves.toBe(false)
  })

  it('never authenticates a missing tag (legacy/untagged/forged entry)', async () => {
    await expect(
      verifyPendingAbortAuthorityTag(adminWallet, ADMIN_ORIGINATOR, 'ref-1', undefined)
    ).resolves.toBe(false)
  })

  it('fails closed on a malformed/corrupted tag instead of throwing', async () => {
    await expect(
      verifyPendingAbortAuthorityTag(adminWallet, ADMIN_ORIGINATOR, 'ref-1', 'not-a-real-tag')
    ).resolves.toBe(false)
  })

  it('a tag computed by a DIFFERENT wallet (different key material) does not verify', async () => {
    const otherWallet = new ProtoWallet(new PrivateKey(2))
    const tag = await computePendingAbortAuthorityTag(otherWallet, ADMIN_ORIGINATOR, 'ref-1')
    await expect(verifyPendingAbortAuthorityTag(adminWallet, ADMIN_ORIGINATOR, 'ref-1', tag)).resolves.toBe(false)
  })
})

describe('pending-abort authority tag (wiring)', () => {
  it('computes the tag under the reserved namespace, keyed by reference, as the admin originator', async () => {
    const createHmac = jest.fn(async () => ({ hmac: [1, 2, 3, 4] }))
    const tag = await computePendingAbortAuthorityTag({ createHmac }, ADMIN_ORIGINATOR, 'ref-1')

    expect(tag).toBe(Buffer.from([1, 2, 3, 4]).toString('base64url'))
    expect(createHmac).toHaveBeenCalledWith(
      expect.objectContaining({
        protocolID: PENDING_ABORT_AUTHORITY_PROTOCOL_ID,
        keyID: 'ref-1',
        counterparty: 'self'
      }),
      ADMIN_ORIGINATOR
    )
  })

  it('verifies with the matching protocolID/keyID/hmac shape', async () => {
    const verifyHmac = jest.fn(async () => ({ valid: true }))
    await verifyPendingAbortAuthorityTag(
      { verifyHmac },
      ADMIN_ORIGINATOR,
      'ref-1',
      Buffer.from([1, 2, 3, 4]).toString('base64url')
    )

    expect(verifyHmac).toHaveBeenCalledWith(
      expect.objectContaining({
        protocolID: PENDING_ABORT_AUTHORITY_PROTOCOL_ID,
        keyID: 'ref-1',
        counterparty: 'self',
        hmac: [1, 2, 3, 4]
      }),
      ADMIN_ORIGINATOR
    )
  })

  it('never calls the wallet at all for a missing tag -- no admin dispatch on the fast-fail path', async () => {
    const verifyHmac = jest.fn()
    await verifyPendingAbortAuthorityTag({ verifyHmac }, ADMIN_ORIGINATOR, 'ref-1', undefined)
    expect(verifyHmac).not.toHaveBeenCalled()
  })

  it('treats a REJECTED verifyHmac (an actual mismatch, per @bsv/sdk) as "not authentic", not a thrown error', async () => {
    const verifyHmac = jest.fn(async () => {
      const e: any = new Error('HMAC is not valid')
      e.code = 'ERR_INVALID_HMAC'
      throw e
    })
    await expect(
      verifyPendingAbortAuthorityTag({ verifyHmac }, ADMIN_ORIGINATOR, 'ref-1', 'A'.repeat(43))
    ).resolves.toBe(false)
  })
})

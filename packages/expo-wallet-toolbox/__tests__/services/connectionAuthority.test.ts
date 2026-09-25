/**
 * XR-027: saved pairing authority tag.
 *
 * ConnectionStore's stored (origin, topic, protocolID, backendIdentityKey)
 * tuple had no integrity binding -- any well-formed replacement authenticated
 * exactly like the record the user actually approved. These tests build a
 * tuple, compute its tag with a real (ProtoWallet-backed) admin wallet, then
 * flip exactly one field and assert verification fails for that reason alone
 * -- before any reconnect/network step would ever run.
 */
import { PrivateKey, ProtoWallet } from '@bsv/sdk'
import {
  computeConnectionAuthorityTag,
  verifyConnectionAuthorityTag
} from '../../core/services/connectionAuthority'
import { CONNECTION_AUTHORITY_PROTOCOL_ID } from '../../core/services/walletConnectionValidation'

const ADMIN_ORIGINATOR = 'internal-admin.bsv-wallet.invalid'

const baseTuple = () => ({
  origin: 'https://app.example',
  topic: '123e4567-e89b-12d3-a456-426614174000',
  protocolID: JSON.stringify([0, 'mobile wallet session']),
  backendIdentityKey: '02' + 'aa'.repeat(32)
})

describe('connection authority tag (real crypto)', () => {
  const adminWallet = new ProtoWallet(new PrivateKey(1))

  it('verifies a tag against the exact tuple it was computed over', async () => {
    const tuple = baseTuple()
    const tag = await computeConnectionAuthorityTag(adminWallet, ADMIN_ORIGINATOR, tuple)
    await expect(verifyConnectionAuthorityTag(adminWallet, ADMIN_ORIGINATOR, tuple, tag)).resolves.toBe(true)
  })

  it.each(['origin', 'topic', 'protocolID', 'backendIdentityKey'] as const)(
    'XR-027: fails verification when only %s is substituted after approval',
    async field => {
      const tuple = baseTuple()
      const tag = await computeConnectionAuthorityTag(adminWallet, ADMIN_ORIGINATOR, tuple)
      const tampered = { ...tuple, [field]: tuple[field] + 'x' }
      await expect(verifyConnectionAuthorityTag(adminWallet, ADMIN_ORIGINATOR, tampered, tag)).resolves.toBe(false)
    }
  )

  it('never authenticates a missing tag (legacy/untagged record)', async () => {
    await expect(
      verifyConnectionAuthorityTag(adminWallet, ADMIN_ORIGINATOR, baseTuple(), undefined)
    ).resolves.toBe(false)
  })

  it('fails closed on a malformed/corrupted tag instead of throwing', async () => {
    await expect(
      verifyConnectionAuthorityTag(adminWallet, ADMIN_ORIGINATOR, baseTuple(), 'not-a-real-tag')
    ).resolves.toBe(false)
  })
})

describe('connection authority tag (wiring)', () => {
  it('computes the tag under the reserved connection-authority namespace, keyed by topic, as the admin originator', async () => {
    const tuple = baseTuple()
    const createHmac = jest.fn(async () => ({ hmac: [1, 2, 3, 4] }))
    const verifyHmac = jest.fn(async () => ({ valid: true }))
    const wallet = { createHmac, verifyHmac }

    const tag = await computeConnectionAuthorityTag(wallet, ADMIN_ORIGINATOR, tuple)
    expect(tag).toBe(Buffer.from([1, 2, 3, 4]).toString('base64url'))
    expect(createHmac).toHaveBeenCalledWith(
      expect.objectContaining({
        protocolID: CONNECTION_AUTHORITY_PROTOCOL_ID,
        keyID: tuple.topic,
        counterparty: 'self'
      }),
      ADMIN_ORIGINATOR
    )

    await verifyConnectionAuthorityTag(wallet, ADMIN_ORIGINATOR, tuple, tag)
    expect(verifyHmac).toHaveBeenCalledWith(
      expect.objectContaining({
        protocolID: CONNECTION_AUTHORITY_PROTOCOL_ID,
        keyID: tuple.topic,
        counterparty: 'self',
        hmac: [1, 2, 3, 4]
      }),
      ADMIN_ORIGINATOR
    )
  })

  it('never calls the wallet at all for a missing tag -- no admin dispatch on the fast-fail path', async () => {
    const createHmac = jest.fn()
    const verifyHmac = jest.fn()
    await verifyConnectionAuthorityTag({ createHmac, verifyHmac }, ADMIN_ORIGINATOR, baseTuple(), undefined)
    expect(verifyHmac).not.toHaveBeenCalled()
  })

  it('treats a REJECTED verifyHmac (an actual mismatch, per @bsv/sdk) as "not authentic", not a thrown error', async () => {
    const createHmac = jest.fn()
    const verifyHmac = jest.fn(async () => {
      const e: any = new Error('HMAC is not valid')
      e.code = 'ERR_INVALID_HMAC'
      throw e
    })
    await expect(
      verifyConnectionAuthorityTag({ createHmac, verifyHmac }, ADMIN_ORIGINATOR, baseTuple(), 'A'.repeat(43))
    ).resolves.toBe(false)
  })
})

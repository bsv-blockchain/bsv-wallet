/**
 * How the three rails answer for a token payment.
 *
 * The rails are where a user's typed string becomes a decision about money, so
 * the two facts pinned here are the two a user can act on:
 *
 *  · **The address rail cannot carry a token, ever (D4).** Not a policy: the
 *    token output's owner key is ECDH-derived against the recipient's IDENTITY
 *    key and the issuer's overlay refuses an FT output it cannot name an owner
 *    for from a linkage. A base58 address names a hash. So the refusal is
 *    stated with the lib's own words rather than a second wording that could
 *    drift from it.
 *  · **The handle rail refuses everything it can before touching the network.**
 *    No runtime, wrong network, a recipient that is not an identity key — each
 *    is a fact about the request, and no overlay round-trip can change any of
 *    them.
 */
import { PrivateKey } from '@bsv/sdk'
import { addressRailAvailability } from '../../core/pay/rails/address'
import { drainMandalaInbox, sendTokenViaHandle, type HandleTokenRuntime } from '../../core/pay/rails/handle'
import type { TokenSendResult } from '../../core/mandala/runtime'

const IDENTITY = new PrivateKey(13).toPublicKey().toString()
const ADDRESS = '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2'
const ASSET_ID = 'ab'.repeat(32) + '.0'

/** The lib's own refusal text, as the runtime would supply it. */
const LIB_REFUSAL =
  'Mandala tokens can only be sent to an identity key (66-hex compressed public key), not to an address — the token output is derived against the recipient identity and the overlay refuses anything else'

function fakeRuntime(over: Partial<HandleTokenRuntime> = {}): HandleTokenRuntime {
  return {
    available: true,
    recipientRefusal: (recipient: string) => (recipient === IDENTITY ? null : LIB_REFUSAL),
    sendToHandle: jest.fn(async () => ({ kind: 'sent', txid: 'ab'.repeat(32), settled: true }) as TokenSendResult),
    receiveFromInbox: jest.fn(async () => ({ credited: 2, failed: 1 })),
    ...over
  } as HandleTokenRuntime
}

describe('the address rail (D4)', () => {
  it('carries satoshis to a valid address', () => {
    expect(addressRailAvailability({ address: ADDRESS })).toEqual({ kind: 'available' })
  })

  it('refuses an invalid address on the satoshi path too', () => {
    expect(addressRailAvailability({ address: 'not-an-address' })).toEqual({
      kind: 'unavailable',
      reason: 'Invalid BSV address'
    })
  })

  it('refuses a token payment with the runtime’s own reason, address valid or not', () => {
    const recipientRefusal = jest.fn(() => LIB_REFUSAL)
    expect(addressRailAvailability({ address: ADDRESS, assetId: ASSET_ID, recipientRefusal })).toEqual({
      kind: 'unavailable',
      reason: LIB_REFUSAL
    })
    expect(recipientRefusal).toHaveBeenCalledWith(ADDRESS)
  })

  it('still refuses a token payment with no runtime to ask — just in fewer words', () => {
    const result = addressRailAvailability({ address: ADDRESS, assetId: ASSET_ID })
    expect(result.kind).toBe('unavailable')
    expect(result.kind === 'unavailable' && result.reason).toMatch(/identity key/i)
  })
})

describe('the handle rail’s token path', () => {
  it('sends through the runtime once the recipient is an identity key', async () => {
    const runtime = fakeRuntime()
    const result = await sendTokenViaHandle({ runtime, recipient: IDENTITY, assetId: ASSET_ID, baseUnits: 250 })
    expect(result).toEqual({ kind: 'sent', txid: 'ab'.repeat(32), settled: true })
    expect(runtime.sendToHandle).toHaveBeenCalledWith({
      assetId: ASSET_ID,
      recipientIdentityKey: IDENTITY,
      baseUnits: 250
    })
  })

  it('refuses an address before the runtime is asked to send anything', async () => {
    const runtime = fakeRuntime()
    const result = await sendTokenViaHandle({ runtime, recipient: ADDRESS, assetId: ASSET_ID, baseUnits: 1 })
    expect(result).toMatchObject({ kind: 'refused', code: 'ERR_RECIPIENT', message: LIB_REFUSAL })
    expect(runtime.sendToHandle).not.toHaveBeenCalled()
  })

  it('is unavailable with no runtime at all, and with one that is off on this chain', async () => {
    const off = fakeRuntime({ available: false })
    for (const runtime of [undefined, off]) {
      const result = await sendTokenViaHandle({ runtime, recipient: IDENTITY, assetId: ASSET_ID, baseUnits: 1 })
      expect(result.kind).toBe('unavailable')
    }
    expect(off.sendToHandle).not.toHaveBeenCalled()
  })

  it('passes a runtime verdict straight through — the rail invents none of its own', async () => {
    const runtime = fakeRuntime({
      sendToHandle: jest.fn(async () => ({ kind: 'refused', code: 'ERR_FROZEN', message: 'frozen' }) as TokenSendResult)
    })
    expect(await sendTokenViaHandle({ runtime, recipient: IDENTITY, assetId: ASSET_ID, baseUnits: 1 })).toEqual({
      kind: 'refused',
      code: 'ERR_FROZEN',
      message: 'frozen'
    })
  })
})

describe('the handle rail’s receive drain includes the Mandala inbox', () => {
  it('drains it and reports what was credited', async () => {
    const runtime = fakeRuntime()
    expect(await drainMandalaInbox(runtime)).toEqual({ credited: 2, failed: 1 })
    expect(runtime.receiveFromInbox).toHaveBeenCalledTimes(1)
  })

  it('does nothing when there is no runtime, or none on this chain', async () => {
    expect(await drainMandalaInbox(undefined)).toEqual({ credited: 0, failed: 0 })
    expect(await drainMandalaInbox(fakeRuntime({ available: false }))).toEqual({ credited: 0, failed: 0 })
  })

  it('a MessageBox fault on the token side never propagates — the satoshi inbox must still drain', async () => {
    const runtime = fakeRuntime({
      receiveFromInbox: jest.fn(async () => {
        throw new Error('Network request failed')
      })
    })
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await drainMandalaInbox(runtime)).toEqual({ credited: 0, failed: 0 })
    warn.mockRestore()
  })
})

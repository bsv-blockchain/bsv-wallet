/**
 * Crediting a received token frame (offline-settlement spec §9, "Credit").
 *
 * `processPending` branches on `frame.kind`: a BSV frame is a wallet payment
 * with a payment remittance, a token frame is a BASKET INSERTION into the
 * permission-routed token basket. The toolbox never inspects a token script
 * and credits no satoshis, so everything needed to spend the coin later has to
 * ride in `customInstructions` — there is no second chance to write it.
 *
 * And `onTokenCredited` is the seam the drain hangs off: a credited token frame
 * is the moment this device becomes responsible for submitting the chain
 * (settlement rule 3), which means the settlement row and the evidence the
 * frame carried have to be persisted right there.
 */
import { Beef, LockingScript, Transaction } from '@bsv/sdk'
import { MandalaToken } from '@bsv/templates'
import { processPending, savePending, PEERPAY_LABEL, type KVStorage } from '../../core/localpay/pending'
import { FRAME_VERSION, type PaymentFrame } from '../../core/localpay/codec'
import { MANDALA_ACTION_LABEL, MANDALA_BASKET } from '../../core/mandala/bundle'
import { SESSION_VERSION } from '../../core/localpay/session'

const ASSET = 'ab'.repeat(32) + '.0'
const OVERLAY_KEY = '03'.padEnd(66, 'b')
const PKH = new Array(20).fill(9)

function memoryStorage(): KVStorage {
  const map = new Map<string, string>()
  return {
    getKeyValue: async (k: string) => map.get(k),
    setKeyValue: async (k: string, v: string) => {
      map.set(k, v)
    }
  }
}

function tokenBeef(): { bytes: Uint8Array; txid: string } {
  const tx = new Transaction()
  tx.addOutput({ satoshis: 1, lockingScript: new MandalaToken().lock(ASSET, 250, PKH) })
  const beef = new Beef()
  beef.mergeTransaction(tx)
  return { bytes: new Uint8Array(beef.toBinaryAtomic(tx.id('hex'))), txid: tx.id('hex') }
}

function bsvBeef(): Uint8Array {
  const tx = new Transaction()
  tx.addOutput({ satoshis: 4200, lockingScript: LockingScript.fromHex('76a914' + '00'.repeat(20) + '88ac') })
  const beef = new Beef()
  beef.mergeTransaction(tx)
  return new Uint8Array(beef.toBinaryAtomic(tx.id('hex')))
}

function tokenFrame(): PaymentFrame {
  const { bytes } = tokenBeef()
  return {
    version: FRAME_VERSION,
    kind: 'token',
    senderIdentityKey: '02'.padEnd(66, 'a'),
    outputIndex: 0,
    derivationPrefix: 'cHJlZml4',
    derivationSuffix: 'c3VmZml4',
    token: {
      assetId: ASSET,
      overlayUrl: 'https://overlay.issuer.example',
      overlayIdentityKey: OVERLAY_KEY,
      certificates: [],
      linkage: [],
      admissions: []
    },
    transaction: bytes
  }
}

function bsvFrame(): PaymentFrame {
  return {
    version: FRAME_VERSION,
    kind: 'bsv',
    senderIdentityKey: '02'.padEnd(66, 'a'),
    outputIndex: 0,
    derivationPrefix: 'cHJlZml4',
    derivationSuffix: 'c3VmZml4',
    transaction: bsvBeef()
  }
}

const walletStub = () => ({ internalizeAction: jest.fn(async (_args: unknown) => ({ accepted: true })) })

describe('processPending: token credit', () => {
  it('internalizes a token frame as a basket insertion into the token basket', async () => {
    const storage = memoryStorage()
    const wallet = walletStub()
    await savePending(storage, tokenFrame(), 'nearby')

    const results = await processPending(wallet as never, storage, 'admin.com')

    expect(results).toEqual([{ id: expect.any(String), success: true }])
    const args = wallet.internalizeAction.mock.calls[0][0] as {
      outputs: { outputIndex: number; protocol: string; insertionRemittance?: { basket: string } }[]
      labels: string[]
    }
    expect(args.outputs[0].protocol).toBe('basket insertion')
    expect(args.outputs[0].insertionRemittance?.basket).toBe(MANDALA_BASKET)
    expect(args.labels).toContain(PEERPAY_LABEL)
    // The home screen recognises a token row by this label alone; without it a
    // received stablecoin rendered as a BSV row — the sender's abbreviated key
    // over "+0 sats" (2026-09-16).
    expect(args.labels).toContain(MANDALA_ACTION_LABEL)
  })

  it('uses the sender’s note as the description when the token frame carries one', async () => {
    const storage = memoryStorage()
    const wallet = walletStub()
    await savePending(storage, { ...tokenFrame(), note: 'thanks!' }, 'nearby')

    await processPending(wallet as never, storage, 'admin.com')

    const args = wallet.internalizeAction.mock.calls[0][0] as { description: string }
    expect(args.description).toBe('thanks!')
  })

  // The toolbox forces the derivation fields undefined on the basket-insertion
  // path, so anything the coin needs to be spent later has to be here.
  it('writes the derivation triple into customInstructions, the only slot that survives', async () => {
    const storage = memoryStorage()
    const wallet = walletStub()
    const frame = tokenFrame()
    await savePending(storage, frame, 'nearby')

    await processPending(wallet as never, storage, 'admin.com')

    const args = wallet.internalizeAction.mock.calls[0][0] as {
      outputs: { insertionRemittance?: { customInstructions?: string; tags?: string[] } }[]
    }
    const ci = JSON.parse(args.outputs[0].insertionRemittance?.customInstructions as string) as Record<string, unknown>
    expect(ci.keyID).toBe(`${frame.derivationPrefix} ${frame.derivationSuffix}`)
    expect(ci.counterparty).toBe(frame.senderIdentityKey)
    expect(ci.protocolID).toEqual([2, 'mandala token'])
    expect(args.outputs[0].insertionRemittance?.tags).toContain(ASSET)
  })

  it('never sends a paymentRemittance on the token path', async () => {
    const storage = memoryStorage()
    const wallet = walletStub()
    await savePending(storage, tokenFrame(), 'nearby')
    await processPending(wallet as never, storage, 'admin.com')
    const args = wallet.internalizeAction.mock.calls[0][0] as { outputs: Record<string, unknown>[] }
    expect(args.outputs[0]).not.toHaveProperty('paymentRemittance')
  })

  it('leaves the BSV path exactly as it was: wallet payment, payment remittance', async () => {
    const storage = memoryStorage()
    const wallet = walletStub()
    await savePending(storage, bsvFrame(), 'nearby')
    await processPending(wallet as never, storage, 'admin.com')
    const args = wallet.internalizeAction.mock.calls[0][0] as {
      outputs: { protocol: string; paymentRemittance?: { senderIdentityKey: string } }[]
    }
    expect(args.outputs[0].protocol).toBe('wallet payment')
    expect(args.outputs[0].paymentRemittance?.senderIdentityKey).toBe('02'.padEnd(66, 'a'))
  })
})

describe('processPending: onTokenCredited', () => {
  it('fires with the frame and its txid after a successful token credit', async () => {
    const storage = memoryStorage()
    const wallet = walletStub()
    const frame = tokenFrame()
    const onTokenCredited = jest.fn(async () => undefined)
    await savePending(storage, frame, 'nearby')

    await processPending(wallet as never, storage, 'admin.com', undefined, onTokenCredited)

    expect(onTokenCredited).toHaveBeenCalledTimes(1)
    const [seenFrame, txid] = onTokenCredited.mock.calls[0] as unknown as [PaymentFrame, string]
    expect(seenFrame.token?.assetId).toBe(ASSET)
    expect(txid).toBe(tokenBeef().txid)
  })

  it('does not fire for a BSV frame', async () => {
    const storage = memoryStorage()
    const onTokenCredited = jest.fn(async () => undefined)
    await savePending(storage, bsvFrame(), 'nearby')
    await processPending(walletStub() as never, storage, 'admin.com', undefined, onTokenCredited)
    expect(onTokenCredited).not.toHaveBeenCalled()
  })

  it('does not fire when the credit itself failed', async () => {
    const storage = memoryStorage()
    const wallet = { internalizeAction: jest.fn(async (_args: unknown) => { throw new Error('db locked') }) }
    const onTokenCredited = jest.fn(async () => undefined)
    await savePending(storage, tokenFrame(), 'nearby')
    const results = await processPending(wallet as never, storage, 'admin.com', undefined, onTokenCredited)
    expect(results[0].success).toBe(false)
    expect(onTokenCredited).not.toHaveBeenCalled()
  })

  // The money has already been credited by the time this runs. A failing hook
  // is a settlement-bookkeeping problem the drain can recover from on its next
  // tick; turning it into a 'failed' entry would re-internalize a coin the
  // wallet already holds.
  it('never turns a completed credit into a failure when the hook throws', async () => {
    const storage = memoryStorage()
    const wallet = walletStub()
    const onTokenCredited = jest.fn(async () => { throw new Error('settlement store down') })
    await savePending(storage, tokenFrame(), 'nearby')
    const results = await processPending(wallet as never, storage, 'admin.com', undefined, onTokenCredited)
    expect(results).toEqual([{ id: expect.any(String), success: true }])
  })

  it('is optional: the queue drains without one', async () => {
    const storage = memoryStorage()
    await savePending(storage, tokenFrame(), 'nearby')
    await expect(processPending(walletStub() as never, storage, 'admin.com')).resolves.toEqual([
      { id: expect.any(String), success: true }
    ])
  })
})

describe('Session', () => {
  // §2.2: nothing in v4 changes what `amount` MEANS on a deployed session, so
  // the session version must not move — bumping it would refuse every QR
  // already printed, for a change no payee can observe.
  it('stays at version 1 across the frame v4 change', () => {
    expect(SESSION_VERSION).toBe(1)
  })
})

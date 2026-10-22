/**
 * Crediting a received nearby token frame (plan 07 Task 16).
 *
 * `processPending` branches on `frame.kind`: a BSV frame is a wallet payment
 * with a payment remittance; a token frame is the BRC-207 §7.1 receipt, a
 * basket insertion into `p color <assetTag>` that the color module checks,
 * stores and credits (online admission, or attested offline acceptance tagged
 * `color_offline`).
 *
 * `onTokenReceived` (the runtime's `nearby.onReceived`) runs once the
 * internalize settles either way: credited, refused for good, or worth
 * retrying. It is never allowed to turn a credit into a failure.
 */
import { Beef, LockingScript, Transaction } from '@bsv/sdk'
import { OneColor } from '@bsv/templates'
import { ATTESTED_PROFILE_ID } from '@bsv/mandala'
import {
  MAX_PENDING_ATTEMPTS,
  PEERPAY_LABEL,
  getPending,
  isPendingExhausted,
  processPending,
  savePending,
  type KVStorage,
  type TokenReceiveHook
} from '../../core/localpay/pending'
import { FRAME_VERSION, type PaymentFrame } from '../../core/localpay/codec'
import { MANDALA_ACTION_LABEL } from '../../core/mandala/types'

const ASSET = 'ab'.repeat(32) + '_0'
const PKH = new Array(20).fill(9)
const SENDER = '02'.padEnd(66, 'a')
const DECL = '0100'
const PROFILE_DATA = JSON.stringify({
  [ATTESTED_PROFILE_ID]: { [ASSET]: { declarationTx: DECL, transactions: [], attestations: [], submissions: [] } }
})

function memoryStorage(): KVStorage {
  const map = new Map<string, string>()
  return {
    getKeyValue: async (k: string) => map.get(k),
    setKeyValue: async (k: string, v: string) => {
      map.set(k, v)
    }
  }
}

function tokenBeef(units = 250n): Uint8Array {
  const tx = new Transaction()
  tx.addOutput({ satoshis: 1, lockingScript: new OneColor().lock(ASSET, units, PKH) })
  const beef = new Beef()
  beef.mergeTransaction(tx)
  return new Uint8Array(beef.toBinaryAtomic(tx.id('hex')))
}

function bsvBeef(): Uint8Array {
  const tx = new Transaction()
  tx.addOutput({ satoshis: 4200, lockingScript: LockingScript.fromHex('76a914' + '00'.repeat(20) + '88ac') })
  const beef = new Beef()
  beef.mergeTransaction(tx)
  return new Uint8Array(beef.toBinaryAtomic(tx.id('hex')))
}

function tokenFrame(units = 250n): PaymentFrame {
  return {
    version: FRAME_VERSION,
    kind: 'token',
    senderIdentityKey: SENDER,
    outputIndex: 0,
    derivationPrefix: 'cHJlZml4',
    derivationSuffix: 'c3VmZml4',
    token: { assetId: ASSET, certificates: [], profileData: PROFILE_DATA },
    transaction: tokenBeef(units)
  }
}

function bsvFrame(): PaymentFrame {
  return {
    version: FRAME_VERSION,
    kind: 'bsv',
    senderIdentityKey: SENDER,
    outputIndex: 0,
    derivationPrefix: 'cHJlZml4',
    derivationSuffix: 'c3VmZml4',
    transaction: bsvBeef()
  }
}

const walletStub = () => ({ internalizeAction: jest.fn(async (_args: unknown) => ({ accepted: true })) })
const hook = () => jest.fn<ReturnType<TokenReceiveHook>, Parameters<TokenReceiveHook>>(async () => undefined)

function named(name: string, message = 'refused', extra: Record<string, unknown> = {}): Error {
  const e = new Error(message)
  e.name = name
  return Object.assign(e, extra)
}

describe('processPending: token receipt', () => {
  it('internalizes a token frame as the §7.1 receipt into its p color basket', async () => {
    const storage = memoryStorage()
    const wallet = walletStub()
    const frame = tokenFrame()
    await savePending(storage, frame, 'nearby')

    const results = await processPending(wallet as never, storage, 'admin.com')

    expect(results).toEqual([{ id: expect.any(String), success: true }])
    const args = wallet.internalizeAction.mock.calls[0][0] as {
      outputs: {
        outputIndex: number
        protocol: string
        insertionRemittance: { basket: string; customInstructions: string; tags?: string[] }
      }[]
      labels: string[]
    }
    expect(args.outputs[0].protocol).toBe('basket insertion')
    expect(args.outputs[0].outputIndex).toBe(0)
    expect(args.outputs[0].insertionRemittance.basket).toBe(`p color ${ASSET.replace('_', 'v')}`)
    expect(JSON.parse(args.outputs[0].insertionRemittance.customInstructions)).toEqual({
      version: 1,
      assetId: ASSET,
      derivationPrefix: frame.derivationPrefix,
      derivationSuffix: frame.derivationSuffix,
      senderIdentityKey: SENDER,
      profileData: JSON.parse(PROFILE_DATA)
    })
    expect(args.outputs[0].insertionRemittance).not.toHaveProperty('tags')
    expect(args.outputs[0]).not.toHaveProperty('paymentRemittance')
    // The home screen recognises a token row by MANDALA_ACTION_LABEL; there is
    // no legacy P-module label any more (that module is gone).
    expect(args.labels).toEqual([PEERPAY_LABEL, MANDALA_ACTION_LABEL])
  })

  it('uses the sender’s note as the description when the token frame carries one', async () => {
    const storage = memoryStorage()
    const wallet = walletStub()
    await savePending(storage, { ...tokenFrame(), note: 'thanks!' }, 'nearby')
    await processPending(wallet as never, storage, 'admin.com')
    const args = wallet.internalizeAction.mock.calls[0][0] as { description: string }
    expect(args.description).toBe('thanks!')
  })

  it('leaves the BSV path exactly as it was: wallet payment, payment remittance', async () => {
    const storage = memoryStorage()
    const wallet = walletStub()
    const onTokenReceived = hook()
    await savePending(storage, bsvFrame(), 'nearby')
    await processPending(wallet as never, storage, 'admin.com', undefined, onTokenReceived)
    const args = wallet.internalizeAction.mock.calls[0][0] as {
      outputs: { protocol: string; paymentRemittance?: { senderIdentityKey: string } }[]
      labels: string[]
    }
    expect(args.outputs[0].protocol).toBe('wallet payment')
    expect(args.outputs[0].paymentRemittance?.senderIdentityKey).toBe(SENDER)
    expect(args.labels).toEqual([PEERPAY_LABEL])
    expect(onTokenReceived).not.toHaveBeenCalled()
  })
})

describe('processPending: onTokenReceived', () => {
  it('reports a credit with the exact units read from the script', async () => {
    const storage = memoryStorage()
    const onTokenReceived = hook()
    const frame = tokenFrame(9007199254740993n)
    await savePending(storage, frame, 'nearby')

    await processPending(walletStub() as never, storage, 'admin.com', undefined, onTokenReceived)

    expect(onTokenReceived).toHaveBeenCalledTimes(1)
    expect(onTokenReceived).toHaveBeenCalledWith(
      {
        txid: Beef.fromBinary(Array.from(frame.transaction)).atomicTxid,
        assetId: ASSET,
        units: 9007199254740993n,
        counterpartyKey: SENDER,
        outputIndex: 0,
        declarationTx: DECL
      },
      { ok: true }
    )
  })

  it('journals a credited offline receipt as held and a refused one as refused', async () => {
    // processPending's half: the hook hears ok for a credit and a FINAL
    // failure for a definitive refusal (the runtime then journals held /
    // refused; createRuntime.test pins that half).
    const storage = memoryStorage()
    const onTokenReceived = hook()
    const wallet = {
      internalizeAction: jest.fn(async () => {
        throw named('AttestationEvidenceError', '[AttestationEvidenceError] BRC-207: attested evidence rejected (x)')
      })
    }
    await savePending(storage, tokenFrame(), 'nearby')

    const results = await processPending(wallet as never, storage, 'admin.com', undefined, onTokenReceived)

    expect(results).toEqual([{ id: expect.any(String), success: false, error: expect.any(String) }])
    expect(onTokenReceived).toHaveBeenCalledWith(expect.objectContaining({ assetId: ASSET, units: 250n }), {
      ok: false,
      code: 'AttestationEvidenceError',
      final: true
    })
    // A definitive refusal is never retried: re-internalizing the same receipt
    // can only be refused again.
    const [entry] = await getPending(storage)
    expect(entry.attempts).toBe(MAX_PENDING_ATTEMPTS)
    expect(isPendingExhausted(entry)).toBe(true)
    await processPending(wallet as never, storage, 'admin.com', undefined, onTokenReceived)
    expect(wallet.internalizeAction).toHaveBeenCalledTimes(1)
  })

  it('reports a retryable overlay verdict as not final and never burns an attempt on it', async () => {
    const storage = memoryStorage()
    const onTokenReceived = hook()
    const wallet = {
      internalizeAction: jest.fn(async () => {
        throw named('ColorProviderError', '[ColorProviderError] mandala overlay refused (ERR_BUSY, retryable): later', {
          code: 'ERR_BUSY',
          retryable: true
        })
      })
    }
    await savePending(storage, tokenFrame(), 'nearby')

    for (let i = 0; i < MAX_PENDING_ATTEMPTS + 1; i++) {
      await processPending(wallet as never, storage, 'admin.com', undefined, onTokenReceived)
    }

    expect(wallet.internalizeAction).toHaveBeenCalledTimes(MAX_PENDING_ATTEMPTS + 1)
    expect(onTokenReceived).toHaveBeenLastCalledWith(expect.anything(), { ok: false, code: 'ERR_BUSY', final: false })
    const [entry] = await getPending(storage)
    expect(entry.attempts ?? 0).toBe(0)
  })

  it('a non-final unknown failure still counts toward the ceiling', async () => {
    const storage = memoryStorage()
    const wallet = {
      internalizeAction: jest.fn(async () => {
        throw new Error('WERR_INVALID_PARAMETER: tx is not valid AtomicBEEF')
      })
    }
    await savePending(storage, tokenFrame(), 'nearby')
    await processPending(wallet as never, storage, 'admin.com')
    const [entry] = await getPending(storage)
    expect(entry.attempts).toBe(1)
  })

  it('never turns a completed credit into a failure when the hook throws', async () => {
    const storage = memoryStorage()
    const onTokenReceived = jest.fn(async () => {
      throw new Error('journal locked')
    })
    await savePending(storage, tokenFrame(), 'nearby')

    const results = await processPending(walletStub() as never, storage, 'admin.com', undefined, onTokenReceived)

    expect(results).toEqual([{ id: expect.any(String), success: true }])
    expect(await getPending(storage)).toEqual([])
  })

  it('is optional: the queue drains without one', async () => {
    const storage = memoryStorage()
    await savePending(storage, tokenFrame(), 'nearby')
    const results = await processPending(walletStub() as never, storage, 'admin.com')
    expect(results).toEqual([{ id: expect.any(String), success: true }])
  })

  // The journal row is the broadcast hold's key and a missing row already
  // holds (W1), so a frame whose named output this device cannot decode is
  // still handed to the module, which decides, and simply reported to nobody.
  it('reports nothing for a frame whose named output is not a token', async () => {
    const storage = memoryStorage()
    const onTokenReceived = hook()
    await savePending(storage, { ...tokenFrame(), transaction: bsvBeef() }, 'nearby')
    const results = await processPending(walletStub() as never, storage, 'admin.com', undefined, onTokenReceived)
    expect(results).toEqual([{ id: expect.any(String), success: true }])
    expect(onTokenReceived).not.toHaveBeenCalled()
  })
})

/**
 * Crediting a received nearby token frame (plan 07 Task 16, design §9 B7).
 *
 * `processPending` branches on `frame.kind`: a BSV frame is a wallet payment
 * with a payment remittance; a token frame goes to the runtime's
 * `nearby.accept` (lib `acceptHandover`: verify online or by COVER, record in
 * the host ledger, then internalize the plain receipt). `processPending`
 * never internalizes a token frame itself.
 *
 * `onTokenReceived` (the runtime's `nearby.onReceived`) runs once the receipt
 * settles either way: credited (online or offline), refused for good, or
 * worth retrying. It is never allowed to turn a credit into a failure.
 */
import { Beef, LockingScript, Transaction } from '@bsv/sdk'
import { OneColor } from '@bsv/templates'
import { InvalidTransferError, OverlayRefusedError } from '@bsv/mandala'
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

const ASSET = 'ab'.repeat(32) + '_0'
const PKH = new Array(20).fill(9)
const SENDER = '02'.padEnd(66, 'a')

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
    token: {
      assetId: ASSET,
      amount: units.toString(),
      senderMode: 'blinded',
      admissions: [],
      linkage: [],
      certificates: []
    },
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
const acceptOk = (offline = false) =>
  jest.fn(async (f: PaymentFrame) => ({
    txid: Beef.fromBinary(Array.from(f.transaction)).atomicTxid as string,
    assetId: ASSET,
    units: 250n,
    outputIndex: 0,
    offline
  }))
const acceptThrowing = (e: unknown) =>
  jest.fn(async (_f: PaymentFrame): Promise<never> => {
    throw e
  })

describe('processPending: token receipt', () => {
  it('hands a token frame to the lib accept path and never internalizes it itself', async () => {
    const storage = memoryStorage()
    const wallet = walletStub()
    const accept = acceptOk()
    const frame = tokenFrame()
    await savePending(storage, frame, 'nearby')

    const results = await processPending(wallet as never, storage, 'admin.com', undefined, undefined, accept)

    expect(results).toEqual([{ id: expect.any(String), success: true }])
    expect(accept).toHaveBeenCalledTimes(1)
    expect(accept.mock.calls[0][0].token).toEqual(frame.token)
    expect(wallet.internalizeAction).not.toHaveBeenCalled()
  })

  it('fails a token frame retriably when there is no accept path (never a plain internalize)', async () => {
    const storage = memoryStorage()
    const wallet = walletStub()
    const onTokenReceived = hook()
    await savePending(storage, tokenFrame(), 'nearby')
    const results = await processPending(wallet as never, storage, 'admin.com', undefined, onTokenReceived)
    expect(results).toEqual([{ id: expect.any(String), success: false, error: expect.any(String) }])
    expect(wallet.internalizeAction).not.toHaveBeenCalled()
    expect(onTokenReceived).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ ok: false, final: false })
    )
    const [entry] = await getPending(storage)
    expect(entry.attempts ?? 0).toBe(0)
  })

  it('leaves the BSV path exactly as it was: wallet payment, payment remittance', async () => {
    const storage = memoryStorage()
    const wallet = walletStub()
    const onTokenReceived = hook()
    const accept = acceptOk()
    await savePending(storage, bsvFrame(), 'nearby')
    await processPending(wallet as never, storage, 'admin.com', undefined, onTokenReceived, accept)
    const args = wallet.internalizeAction.mock.calls[0][0] as {
      outputs: { protocol: string; paymentRemittance?: { senderIdentityKey: string } }[]
      labels: string[]
    }
    expect(args.outputs[0].protocol).toBe('wallet payment')
    expect(args.outputs[0].paymentRemittance?.senderIdentityKey).toBe(SENDER)
    expect(args.labels).toEqual([PEERPAY_LABEL])
    expect(onTokenReceived).not.toHaveBeenCalled()
    expect(accept).not.toHaveBeenCalled()
  })
})

describe('processPending: onTokenReceived', () => {
  it('reports a credit with the exact units read from the script, and whether it was offline', async () => {
    for (const offline of [false, true]) {
      const storage = memoryStorage()
      const onTokenReceived = hook()
      const frame = tokenFrame(9007199254740993n)
      await savePending(storage, frame, 'nearby')

      await processPending(walletStub() as never, storage, 'admin.com', undefined, onTokenReceived, acceptOk(offline))

      expect(onTokenReceived).toHaveBeenCalledTimes(1)
      expect(onTokenReceived).toHaveBeenCalledWith(
        {
          txid: Beef.fromBinary(Array.from(frame.transaction)).atomicTxid,
          assetId: ASSET,
          units: 9007199254740993n,
          counterpartyKey: SENDER,
          outputIndex: 0
        },
        { ok: true, offline }
      )
    }
  })

  it('reports a definitive refusal as final and never retries it', async () => {
    const storage = memoryStorage()
    const onTokenReceived = hook()
    const accept = acceptThrowing(
      new InvalidTransferError(
        '@bsv/mandala: invalid hand-over: the hand-over evidence is refused (hop)',
        'ERR_EVIDENCE'
      )
    )
    await savePending(storage, tokenFrame(), 'nearby')

    const results = await processPending(
      walletStub() as never,
      storage,
      'admin.com',
      undefined,
      onTokenReceived,
      accept
    )

    expect(results).toEqual([{ id: expect.any(String), success: false, error: expect.any(String) }])
    expect(onTokenReceived).toHaveBeenCalledWith(expect.objectContaining({ assetId: ASSET, units: 250n }), {
      ok: false,
      code: 'ERR_EVIDENCE',
      final: true
    })
    const [entry] = await getPending(storage)
    expect(entry.attempts).toBe(MAX_PENDING_ATTEMPTS)
    expect(isPendingExhausted(entry)).toBe(true)
    await processPending(walletStub() as never, storage, 'admin.com', undefined, onTokenReceived, accept)
    expect(accept).toHaveBeenCalledTimes(1)
  })

  it('reports a final overlay verdict as final', async () => {
    const storage = memoryStorage()
    const onTokenReceived = hook()
    const accept = acceptThrowing(
      new OverlayRefusedError({ code: 'ERR_CONSERVATION', description: 'no', retryable: false })
    )
    await savePending(storage, tokenFrame(), 'nearby')
    await processPending(walletStub() as never, storage, 'admin.com', undefined, onTokenReceived, accept)
    expect(onTokenReceived).toHaveBeenCalledWith(expect.anything(), {
      ok: false,
      code: 'ERR_CONSERVATION',
      final: true
    })
  })

  it('keeps an offline hand-over COVER cannot reach σ for yet (ERR_NOT_COVERED) retriable', async () => {
    const storage = memoryStorage()
    const onTokenReceived = hook()
    const accept = acceptThrowing(
      new InvalidTransferError('@bsv/mandala: invalid hand-over: offline', 'ERR_NOT_COVERED')
    )
    await savePending(storage, tokenFrame(), 'nearby')
    await processPending(walletStub() as never, storage, 'admin.com', undefined, onTokenReceived, accept)
    expect(onTokenReceived).toHaveBeenCalledWith(expect.anything(), {
      ok: false,
      code: 'ERR_NOT_COVERED',
      final: false
    })
    expect(isPendingExhausted((await getPending(storage))[0])).toBe(false)
  })

  it('never burns an attempt on an unreachable overlay', async () => {
    const storage = memoryStorage()
    const onTokenReceived = hook()
    const accept = acceptThrowing(
      new OverlayRefusedError({ code: 'ERR_UNAVAILABLE', description: 'network', retryable: true, httpStatus: 0 })
    )
    await savePending(storage, tokenFrame(), 'nearby')

    for (let i = 0; i < MAX_PENDING_ATTEMPTS + 1; i++) {
      await processPending(walletStub() as never, storage, 'admin.com', undefined, onTokenReceived, accept)
    }

    expect(accept).toHaveBeenCalledTimes(MAX_PENDING_ATTEMPTS + 1)
    expect(onTokenReceived).toHaveBeenLastCalledWith(expect.anything(), {
      ok: false,
      code: 'ERR_UNAVAILABLE',
      final: false
    })
    const [entry] = await getPending(storage)
    expect(entry.attempts ?? 0).toBe(0)
  })

  it('a non-final unknown failure still counts toward the ceiling', async () => {
    const storage = memoryStorage()
    const accept = acceptThrowing(new Error('WERR_INVALID_PARAMETER: tx is not valid AtomicBEEF'))
    await savePending(storage, tokenFrame(), 'nearby')
    await processPending(walletStub() as never, storage, 'admin.com', undefined, undefined, accept)
    const [entry] = await getPending(storage)
    expect(entry.attempts).toBe(1)
  })

  it('never turns a completed credit into a failure when the hook throws', async () => {
    const storage = memoryStorage()
    const onTokenReceived = jest.fn(async () => {
      throw new Error('journal locked')
    })
    await savePending(storage, tokenFrame(), 'nearby')

    const results = await processPending(
      walletStub() as never,
      storage,
      'admin.com',
      undefined,
      onTokenReceived,
      acceptOk()
    )

    expect(results).toEqual([{ id: expect.any(String), success: true }])
    expect(await getPending(storage)).toEqual([])
  })

  it('reports nothing for a frame whose named output is not a token', async () => {
    const storage = memoryStorage()
    const onTokenReceived = hook()
    await savePending(storage, { ...tokenFrame(), transaction: bsvBeef() }, 'nearby')
    const results = await processPending(
      walletStub() as never,
      storage,
      'admin.com',
      undefined,
      onTokenReceived,
      acceptOk()
    )
    expect(results).toEqual([{ id: expect.any(String), success: true }])
    expect(onTokenReceived).not.toHaveBeenCalled()
  })
})

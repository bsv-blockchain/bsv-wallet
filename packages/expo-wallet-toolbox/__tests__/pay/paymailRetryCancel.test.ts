import { P2PKH, PrivateKey, Transaction, LockingScript } from '@bsv/sdk'
import {
  PaymailSendError,
  cancelPaymailPayment,
  resolveOrphanPaymailAction,
  retryPaymailDelivery,
  sendViaPaymail
} from '../../core/pay/rails/paymail'
import {
  getOutboxEntries,
  savePaymailOutboxEntry,
  updateOutboxEntry,
  removeOutboxEntry,
  type PaymailOutboxEntry
} from '../../core/peerpay/outbox'
import { TaskDrainOutbox } from '../../core/monitor/TaskDrainOutbox'

function fakeStorage() {
  const map = new Map<string, string>()
  return {
    map,
    getKeyValue: async (k: string) => map.get(k),
    setKeyValue: async (k: string, v: string) => void map.set(k, v)
  }
}

const ENDPOINT = 'https://hc.example/api/receive-beef/deggen'

function mintTx(seed = 7, sats = 1000) {
  const tx = new Transaction()
  tx.addOutput({ lockingScript: new P2PKH().lock(new PrivateKey(seed).toAddress()), satoshis: sats })
  return tx
}

function fakeWallet(txid?: string) {
  return {
    createAction: jest.fn(async (args: any) => {
      if (args?.options?.sendWith) {
        return { sendWithResults: [{ txid: args.options.sendWith[0], status: 'sending' }] }
      }
      const tx = new Transaction()
      for (const o of args.outputs) {
        tx.addOutput({ lockingScript: LockingScript.fromHex(o.lockingScript), satoshis: o.satoshis })
      }
      return { txid: tx.id('hex'), tx: tx.toAtomicBEEF() }
    }),
    listActions: jest.fn(async () => ({ actions: txid ? [{ txid, reference: 'ref1' }] : [] })),
    abortAction: jest.fn().mockResolvedValue({})
  }
}

const known = (txid: string) => ({ status: 'success', results: [{ txid, status: 'known' }] })
const unknown = { status: 'success', results: [] }

async function setup(
  over: {
    post?: any
    status?: any
    row?: Partial<PaymailOutboxEntry>
    beefTx?: Transaction
  } = {}
) {
  const storage = fakeStorage()
  const tx = over.beefTx ?? mintTx()
  const txid = tx.id('hex')
  const beefHex = tx.toHexBEEF()
  const id = await savePaymailOutboxEntry(storage, {
    paymail: 'deggen@handcash.io',
    endpoint: ENDPOINT,
    paymailReference: 'pm-ref-1',
    beefHex,
    satoshis: 1000,
    txid
  })
  if (over.row) await updateOutboxEntry(storage, id, over.row)
  const wallet = fakeWallet(txid)
  const client = {
    getP2pDestination: jest.fn(),
    postBeef: jest.fn(async () => over.post ?? { kind: 'accepted', txid, note: 'thanks' })
  }
  const getStatusForTxids = over.status ?? jest.fn().mockResolvedValue(unknown)
  const row = async () =>
    ((await getOutboxEntries(storage)) as PaymailOutboxEntry[]).find(e => e.id === id) as PaymailOutboxEntry
  const deps = {
    wallet: wallet as never,
    adminOriginator: 'admin.com',
    storage,
    client: client as never,
    getStatusForTxids,
    recheckDelayMs: 0
  }
  return { storage, tx, txid, beefHex, id, wallet, client, getStatusForTxids, row, deps }
}

async function rejection(p: Promise<unknown>): Promise<PaymailSendError> {
  try {
    await p
  } catch (e) {
    return e as PaymailSendError
  }
  throw new Error('expected rejection')
}

beforeEach(() => TaskDrainOutbox.resetForTests())
afterEach(() => jest.restoreAllMocks())

describe('retryPaymailDelivery', () => {
  it('never aborts: 503 and unknown twice sets refused, keeps the row, throws refused_unconfirmed', async () => {
    const s = await setup({ post: { kind: 'http', status: 503, message: 'parse error' } })
    const err = await rejection(retryPaymailDelivery({ ...s.deps, entry: await s.row() }))
    expect(err.kind).toBe('maybe_sent')
    expect(err.code).toBe('refused_unconfirmed')
    expect(s.wallet.abortAction).not.toHaveBeenCalled()
    expect(await s.row()).toMatchObject({ status: 'unsent', refused: true })
  })

  it('a retry of a row with refused: true is a no-op', async () => {
    const s = await setup({ row: { refused: true } })
    await retryPaymailDelivery({ ...s.deps, entry: await s.row() })
    expect(s.client.postBeef).not.toHaveBeenCalled()
    expect(s.wallet.createAction).not.toHaveBeenCalled()
  })

  it('is a no-op while a send holds the txid', async () => {
    const storage = fakeStorage()
    const wallet = fakeWallet()
    let release!: () => void
    const gate = new Promise<void>(r => (release = r))
    const dest = {
      outputs: [{ script: new P2PKH().lock(new PrivateKey(9).toAddress()).toHex(), satoshis: 1000 }],
      reference: 'r',
      beefEndpoint: ENDPOINT
    }
    const client = {
      getP2pDestination: jest.fn().mockResolvedValue({ kind: 'ok', destination: dest }),
      postBeef: jest.fn(async (a: { beefHex: string }) => {
        await gate
        return { kind: 'accepted', txid: Transaction.fromHexBEEF(a.beefHex).id('hex'), note: '' }
      })
    }
    const deps = {
      wallet: wallet as never,
      adminOriginator: 'admin.com',
      storage,
      client: client as never,
      getStatusForTxids: jest.fn().mockResolvedValue(unknown),
      recheckDelayMs: 0
    }
    const sending = sendViaPaymail({ ...deps, paymail: 'a@b.io', satoshis: 1000 })
    for (let i = 0; i < 50 && client.postBeef.mock.calls.length === 0; i++) await new Promise(r => setTimeout(r, 0))
    const [row] = (await getOutboxEntries(storage)) as PaymailOutboxEntry[]
    await retryPaymailDelivery({ ...deps, entry: row })
    release()
    await sending
    expect(client.postBeef).toHaveBeenCalledTimes(1)
  })

  it('reposts the same beefHex, reference and endpoint', async () => {
    const s = await setup()
    await retryPaymailDelivery({ ...s.deps, entry: await s.row() })
    expect(s.client.postBeef).toHaveBeenCalledWith({
      endpoint: ENDPOINT,
      beefHex: s.beefHex,
      reference: 'pm-ref-1'
    })
  })

  it('after a network error then success marks the row sent and broadcasts', async () => {
    const s = await setup({ post: { kind: 'network', message: 'timeout' } })
    const err = await rejection(retryPaymailDelivery({ ...s.deps, entry: await s.row() }))
    expect(err.kind).toBe('maybe_sent')
    expect(await s.row()).toMatchObject({ status: 'unsent', delivering: true })
    s.client.postBeef.mockResolvedValue({ kind: 'accepted', txid: s.txid, note: 'ok' } as never)
    await retryPaymailDelivery({ ...s.deps, entry: await s.row() })
    expect(await s.row()).toMatchObject({ status: 'sent', delivered: true })
    expect(s.wallet.createAction).toHaveBeenCalledWith(
      expect.objectContaining({ options: { sendWith: [s.txid] } }),
      'admin.com'
    )
  })

  it('of a delivered row only broadcasts', async () => {
    const s = await setup({ row: { delivered: true } })
    await retryPaymailDelivery({ ...s.deps, entry: await s.row() })
    expect(s.client.postBeef).not.toHaveBeenCalled()
    expect(s.wallet.createAction).toHaveBeenCalledTimes(1)
    expect(await s.row()).toMatchObject({ status: 'sent' })
  })

  it('throws outbox_txid_mismatch for a row whose beefHex hashes to another txid', async () => {
    const s = await setup({ row: { txid: 'ab'.repeat(32) } })
    await expect(retryPaymailDelivery({ ...s.deps, entry: await s.row() })).rejects.toThrow('outbox_txid_mismatch')
    expect(s.client.postBeef).not.toHaveBeenCalled()
    expect(s.wallet.createAction).not.toHaveBeenCalled()
  })

  it('stops cleanly when the row was removed during the call', async () => {
    const s = await setup()
    s.client.postBeef.mockImplementation((async () => {
      await removeOutboxEntry(s.storage, s.id)
      return { kind: 'accepted', txid: s.txid, note: '' }
    }) as never)
    await retryPaymailDelivery({ ...s.deps, entry: await s.row() })
    expect(s.wallet.createAction).not.toHaveBeenCalled()
  })

  it('is a no-op for a sent or import_hold row', async () => {
    for (const status of ['sent', 'import_hold'] as const) {
      const s = await setup({ row: { status } })
      await retryPaymailDelivery({ ...s.deps, entry: await s.row() })
      expect(s.client.postBeef).not.toHaveBeenCalled()
    }
  })

  it('after a confirmed refusal never aborts and keeps the row', async () => {
    // Plan wording said abort; the plan's own rule (a retry never aborts) wins.
    const s = await setup({ post: { kind: 'http', status: 400, message: 'bad' } })
    await rejection(retryPaymailDelivery({ ...s.deps, entry: await s.row() }))
    expect(s.wallet.abortAction).not.toHaveBeenCalled()
    expect((await s.row()).refused).toBe(true)
  })
})

describe('cancelPaymailPayment', () => {
  it('with the network unknown aborts and removes the row', async () => {
    const s = await setup()
    const res = await cancelPaymailPayment({ ...s.deps, entry: await s.row() })
    expect(res).toEqual({ aborted: true, sent: false })
    expect(s.wallet.abortAction).toHaveBeenCalledWith({ reference: 'ref1' }, 'admin.com')
    expect(await getOutboxEntries(s.storage)).toHaveLength(0)
  })

  it('with the network knowing the txid broadcasts and marks sent', async () => {
    const s = await setup()
    s.getStatusForTxids.mockResolvedValue(known(s.txid))
    const res = await cancelPaymailPayment({ ...s.deps, entry: await s.row() })
    expect(res).toEqual({ aborted: false, sent: true })
    expect(s.wallet.abortAction).not.toHaveBeenCalled()
    expect((await s.row()).status).toBe('sent')
  })

  it('with the status service down keeps the row and throws status_unavailable', async () => {
    const s = await setup({ status: jest.fn().mockRejectedValue(new Error('down')) })
    const err = await rejection(cancelPaymailPayment({ ...s.deps, entry: await s.row() }))
    expect(err.code).toBe('status_unavailable')
    expect(s.wallet.abortAction).not.toHaveBeenCalled()
    expect(await s.row()).toBeDefined()
  })

  it('when the abort is refused keeps the row', async () => {
    const s = await setup()
    s.wallet.abortAction.mockResolvedValue({ aborted: false } as never)
    const err = await rejection(cancelPaymailPayment({ ...s.deps, entry: await s.row() }))
    expect(err.kind).toBe('abort_failed')
    expect(await s.row()).toBeDefined()
  })

  it('of a delivered row throws already_delivered', async () => {
    const s = await setup({ row: { delivered: true } })
    const err = await rejection(cancelPaymailPayment({ ...s.deps, entry: await s.row() }))
    expect(err.code).toBe('already_delivered')
    expect(s.wallet.abortAction).not.toHaveBeenCalled()
  })

  it('of a delivering row asks the network instead of refusing', async () => {
    const s = await setup({ row: { delivering: true } })
    const res = await cancelPaymailPayment({ ...s.deps, entry: await s.row() })
    expect(res.aborted).toBe(true)
    expect(s.getStatusForTxids).toHaveBeenCalledTimes(2)
  })

  it('with a delivering row and unknown-then-known on the recheck broadcasts and does not abort', async () => {
    const s = await setup({ row: { delivering: true } })
    s.getStatusForTxids.mockResolvedValueOnce(unknown).mockResolvedValue(known(s.txid))
    const res = await cancelPaymailPayment({ ...s.deps, entry: await s.row() })
    expect(res).toEqual({ aborted: false, sent: true })
    expect(s.wallet.abortAction).not.toHaveBeenCalled()
  })

  it('while a send holds the txid throws in_progress', async () => {
    const s = await setup()
    let release!: () => void
    const gate = new Promise<void>(r => (release = r))
    s.client.postBeef.mockImplementation((async () => {
      await gate
      return { kind: 'accepted', txid: s.txid, note: '' }
    }) as never)
    const retrying = retryPaymailDelivery({ ...s.deps, entry: await s.row() })
    for (let i = 0; i < 50 && s.client.postBeef.mock.calls.length === 0; i++) await new Promise(r => setTimeout(r, 0))
    const err = await rejection(cancelPaymailPayment({ ...s.deps, entry: await s.row() }))
    expect(err.code).toBe('in_progress')
    release()
    await retrying
  })
})

describe('resolveOrphanPaymailAction', () => {
  const orphan = () => {
    const txid = mintTx().id('hex')
    const wallet = fakeWallet(txid)
    const getStatusForTxids = jest.fn().mockResolvedValue(unknown)
    return { txid, wallet, getStatusForTxids }
  }

  it('unknown twice aborts', async () => {
    const o = orphan()
    const res = await resolveOrphanPaymailAction({
      wallet: o.wallet as never,
      adminOriginator: 'admin.com',
      getStatusForTxids: o.getStatusForTxids,
      recheckDelayMs: 0,
      txid: o.txid
    })
    expect(res).toEqual({ aborted: true, sent: false })
    expect(o.getStatusForTxids).toHaveBeenCalledTimes(2)
  })

  it('known broadcasts', async () => {
    const o = orphan()
    o.getStatusForTxids.mockResolvedValue(known(o.txid))
    const res = await resolveOrphanPaymailAction({
      wallet: o.wallet as never,
      adminOriginator: 'admin.com',
      getStatusForTxids: o.getStatusForTxids,
      recheckDelayMs: 0,
      txid: o.txid
    })
    expect(res).toEqual({ aborted: false, sent: true })
    expect(o.wallet.abortAction).not.toHaveBeenCalled()
    expect(o.wallet.createAction).toHaveBeenCalledWith(
      expect.objectContaining({ options: { sendWith: [o.txid] } }),
      'admin.com'
    )
  })

  it('status error keeps the action and throws', async () => {
    const o = orphan()
    o.getStatusForTxids.mockRejectedValue(new Error('down'))
    const err = await rejection(
      resolveOrphanPaymailAction({
        wallet: o.wallet as never,
        adminOriginator: 'admin.com',
        getStatusForTxids: o.getStatusForTxids,
        recheckDelayMs: 0,
        txid: o.txid
      })
    )
    expect(err.code).toBe('status_unavailable')
    expect(o.wallet.abortAction).not.toHaveBeenCalled()
  })
})

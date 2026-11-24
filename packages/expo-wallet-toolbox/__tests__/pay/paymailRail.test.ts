import { P2PKH, PrivateKey, Transaction } from '@bsv/sdk'
import {
  PAYMAIL_LABEL,
  PaymailSendError,
  confirmUnknown,
  paymailAddressLabel,
  sendViaPaymail,
  withTxidLock
} from '../../core/pay/rails/paymail'
import { getOutboxEntries, type PaymailOutboxEntry } from '../../core/peerpay/outbox'
import { TaskDrainOutbox } from '../../core/monitor/TaskDrainOutbox'

function fakeStorage() {
  const map = new Map<string, string>()
  return {
    map,
    getKeyValue: async (k: string) => map.get(k),
    setKeyValue: async (k: string, v: string) => void map.set(k, v)
  }
}

const PM = 'Deggen@HandCash.io'

function scriptFor(seed: number) {
  return new P2PKH().lock(new PrivateKey(seed).toAddress()).toHex()
}

function destination(parts: number[] = [1000]) {
  return {
    outputs: parts.map((satoshis, i) => ({ script: scriptFor(i + 7), satoshis })),
    reference: 'pm-ref-1',
    beefEndpoint: 'https://hc.example/api/receive-beef/deggen'
  }
}

function fakeWallet(overrides: Record<string, unknown> = {}) {
  let minted: string | undefined
  return {
    createAction: jest.fn(async (args: any) => {
      if (args?.options?.sendWith) {
        return { sendWithResults: [{ txid: args.options.sendWith[0], status: 'sending' }] }
      }
      const tx = new Transaction()
      for (const o of args.outputs) {
        tx.addOutput({ lockingScript: new P2PKH().lock(new PrivateKey(1).toAddress()), satoshis: 1 })
        const last = tx.outputs[tx.outputs.length - 1]
        last.lockingScript = (require('@bsv/sdk') as typeof import('@bsv/sdk')).LockingScript.fromHex(o.lockingScript)
        last.satoshis = o.satoshis
      }
      minted = tx.id('hex')
      return { txid: minted, tx: tx.toAtomicBEEF() }
    }),
    listActions: jest.fn(async () => ({ actions: minted ? [{ txid: minted, reference: 'ref1' }] : [] })),
    abortAction: jest.fn().mockResolvedValue({}),
    ...overrides
  }
}

function setup(over: { parts?: number[]; post?: any; status?: any; wallet?: any; storage?: any } = {}) {
  const storage = over.storage ?? fakeStorage()
  const wallet = over.wallet ?? fakeWallet()
  const client = {
    getP2pDestination: jest.fn().mockResolvedValue({ kind: 'ok', destination: destination(over.parts) }),
    postBeef: jest.fn(
      async (a: { beefHex: string }) =>
        over.post ?? { kind: 'accepted', txid: Transaction.fromHexBEEF(a.beefHex).id('hex'), note: 'thanks' }
    )
  }
  const getStatusForTxids = over.status ?? jest.fn().mockResolvedValue({ status: 'success', results: [] })
  const args = {
    wallet: wallet as never,
    adminOriginator: 'admin.com',
    storage,
    client: client as never,
    getStatusForTxids,
    recheckDelayMs: 0,
    paymail: PM,
    satoshis: 1000
  }
  return { storage, wallet, client, getStatusForTxids, args }
}

const rows = async (s: ReturnType<typeof fakeStorage>) => (await getOutboxEntries(s)) as PaymailOutboxEntry[]
const known = (txid: string) => ({ status: 'success', results: [{ txid, status: 'known' }] })
const unknown = { status: 'success', results: [] }

async function rejection(p: Promise<unknown>): Promise<PaymailSendError> {
  try {
    await p
  } catch (e) {
    return e as PaymailSendError
  }
  throw new Error('expected rejection')
}

beforeEach(() => TaskDrainOutbox.resetForTests())
afterEach(() => {
  jest.restoreAllMocks()
  jest.useRealTimers()
})

describe('sendViaPaymail', () => {
  it('happy path: mints noSend, posts plain BEEF, broadcasts, marks sent', async () => {
    const { args, wallet, client, storage } = setup()
    const res = await sendViaPaymail(args)
    expect(res).toMatchObject({ satoshis: 1000, broadcastPending: false })
    const mint = wallet.createAction.mock.calls[0][0] as any
    expect(mint.options).toEqual({ noSend: true, randomizeOutputs: false })
    expect(mint.labels).toEqual(['paymail', 'paymail:deggen@handcash.io'])
    expect(mint.outputs[0].lockingScript).toBe(destination().outputs[0].script)
    const post = (client.postBeef.mock.calls[0] as any[])[0]
    const created = await wallet.createAction.mock.results[0].value
    expect(post.beefHex).toBe(Transaction.fromAtomicBEEF(created.tx).toHexBEEF())
    expect(post.beefHex).not.toBe(Buffer.from(created.tx).toString('hex'))
    expect(post.reference).toBe('pm-ref-1')
    expect(wallet.createAction.mock.calls[1][0]).toMatchObject({ options: { sendWith: [res.txid] } })
    const [row] = await rows(storage)
    expect(row).toMatchObject({ status: 'sent', delivered: true, receiverTxid: res.txid, receiverNote: 'thanks' })
    expect(res.txid).toBe(created.txid)
  })

  it('the outbox row exists before the POST', async () => {
    const { args, client, storage } = setup()
    client.postBeef.mockImplementation((async () => {
      const [row] = await rows(storage)
      expect(row).toMatchObject({
        status: 'unsent',
        delivering: true,
        paymailReference: 'pm-ref-1',
        endpoint: destination().beefEndpoint
      })
      expect(typeof row.beefHex).toBe('string')
      return { kind: 'accepted', txid: row.txid, note: '' }
    }) as any)
    await sendViaPaymail(args)
    expect(client.postBeef).toHaveBeenCalled()
  })

  it('a receiver txid that differs from ours logs a warning and still sends', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
    const { args, storage } = setup({ post: { kind: 'accepted', txid: 'ab'.repeat(32), note: '' } })
    const res = await sendViaPaymail(args)
    expect(res.broadcastPending).toBe(false)
    expect(warn).toHaveBeenCalled()
    expect((await rows(storage))[0].status).toBe('sent')
  })

  it('multi-output destination', async () => {
    const { args, wallet } = setup({ parts: [600, 400] })
    const res = await sendViaPaymail(args)
    expect(res.satoshis).toBe(1000)
    const mint = wallet.createAction.mock.calls[0][0] as any
    expect(mint.outputs).toHaveLength(2)
    expect(mint.outputs[1]).toMatchObject({ satoshis: 400, lockingScript: destination([600, 400]).outputs[1].script })
  })

  it('send-all sentinel throws send_all_unsupported with no network call', async () => {
    const { args, client } = setup()
    const e = await rejection(sendViaPaymail({ ...args, satoshis: 2099999999999999 }))
    expect(e).toBeInstanceOf(PaymailSendError)
    expect(e).toMatchObject({ kind: 'not_sent', code: 'send_all_unsupported' })
    expect(client.getP2pDestination).not.toHaveBeenCalled()
  })

  it.each([0, -5, NaN])('amount %p throws invalid_amount', async amount => {
    const { args, client } = setup()
    const e = await rejection(sendViaPaymail({ ...args, satoshis: amount }))
    expect(e).toMatchObject({ kind: 'not_sent', code: 'invalid_amount' })
    expect(client.getP2pDestination).not.toHaveBeenCalled()
  })

  it.each(['invalid_paymail', 'unsupported', 'unreachable', 'refused', 'invalid_destination'])(
    'destination failure %s maps to not_sent',
    async reason => {
      const { args, client, wallet } = setup()
      client.getP2pDestination.mockResolvedValue({ kind: 'failed', reason, message: 'nope' } as any)
      const e = await rejection(sendViaPaymail(args))
      expect(e).toMatchObject({ kind: 'not_sent', code: reason })
      expect(wallet.createAction).not.toHaveBeenCalled()
    }
  )

  it('createAction throwing on the mint gives not_sent / mint_failed and no row', async () => {
    const wallet = fakeWallet({ createAction: jest.fn().mockRejectedValue(new Error('Insufficient funds')) })
    const { args, storage } = setup({ wallet })
    const e = await rejection(sendViaPaymail(args))
    expect(e).toMatchObject({ kind: 'not_sent', code: 'mint_failed', message: 'Insufficient funds' })
    expect(await rows(storage)).toHaveLength(0)
  })

  it('mint without tx throws mint_failed', async () => {
    const wallet = fakeWallet({ createAction: jest.fn().mockResolvedValue({ txid: 'a'.repeat(64) }) })
    const { args } = setup({ wallet })
    expect(await rejection(sendViaPaymail(args))).toMatchObject({ kind: 'not_sent', code: 'mint_failed' })
  })

  it('a tx whose output differs from the destination aborts and throws mint_failed', async () => {
    const wallet = fakeWallet()
    const inner = wallet.createAction.getMockImplementation()!
    wallet.createAction.mockImplementation(async (a: any) => {
      if (a?.options?.sendWith) return inner(a)
      return inner({ ...a, outputs: [{ ...a.outputs[0], satoshis: 999 }] })
    })
    const { args, storage, client } = setup({ wallet })
    expect(await rejection(sendViaPaymail(args))).toMatchObject({ kind: 'not_sent', code: 'mint_failed' })
    expect(wallet.abortAction).toHaveBeenCalledWith({ reference: 'ref1' }, 'admin.com')
    expect(client.postBeef).not.toHaveBeenCalled()
    expect(await rows(storage)).toHaveLength(0)
  })

  it('a malformed tx from the wallet aborts and throws mint_failed', async () => {
    const wallet = fakeWallet({
      createAction: jest.fn().mockResolvedValue({ txid: 'a'.repeat(64), tx: [1, 2, 3] }),
      listActions: jest.fn(async () => ({ actions: [{ txid: 'a'.repeat(64), reference: 'ref1' }] }))
    })
    const { args, client, storage } = setup({ wallet })
    expect(await rejection(sendViaPaymail(args))).toMatchObject({ kind: 'not_sent', code: 'mint_failed' })
    expect(wallet.abortAction).toHaveBeenCalledWith({ reference: 'ref1' }, 'admin.com')
    expect(client.postBeef).not.toHaveBeenCalled()
    expect(await rows(storage)).toHaveLength(0)
  })

  it('a tx whose id differs from created.txid aborts and throws mint_failed', async () => {
    const wallet = fakeWallet()
    const inner = wallet.createAction.getMockImplementation()!
    wallet.createAction.mockImplementation(async (a: any) => {
      const r: any = await inner(a)
      return a?.options?.sendWith ? r : { ...r, txid: 'b'.repeat(64) }
    })
    wallet.listActions.mockImplementation(async () => ({ actions: [{ txid: 'b'.repeat(64), reference: 'ref1' }] }))
    const { args, client } = setup({ wallet })
    expect(await rejection(sendViaPaymail(args))).toMatchObject({ kind: 'not_sent', code: 'mint_failed' })
    expect(wallet.abortAction).toHaveBeenCalledWith({ reference: 'ref1' }, 'admin.com')
    expect(client.postBeef).not.toHaveBeenCalled()
  })

  it('the txid is locked while the row exists unsent', async () => {
    const { args, client } = setup()
    client.postBeef.mockImplementation((async () => {
      const [row] = await rows(args.storage)
      expect(await withTxidLock(row.txid, async () => 1)).toBeUndefined()
      return { kind: 'accepted', txid: row.txid, note: '' }
    }) as any)
    await sendViaPaymail(args)
  })

  it('a save failure aborts the nosend and rethrows', async () => {
    const storage = fakeStorage()
    storage.setKeyValue = async () => {
      throw new Error('disk full')
    }
    const { args, wallet, client } = setup({ storage })
    await expect(sendViaPaymail(args)).rejects.toThrow('disk full')
    expect(wallet.abortAction).toHaveBeenCalledWith({ reference: 'ref1' }, 'admin.com')
    expect(client.postBeef).not.toHaveBeenCalled()
  })

  it('network error: row stays unsent, no abort, maybe_sent / no_answer', async () => {
    const { args, wallet, storage, getStatusForTxids } = setup({ post: { kind: 'network', message: 'timeout' } })
    const e = await rejection(sendViaPaymail(args))
    expect(e).toMatchObject({ kind: 'maybe_sent', code: 'no_answer' })
    expect((await rows(storage))[0]).toMatchObject({ status: 'unsent', lastError: 'timeout' })
    expect(TaskDrainOutbox.hasPending).toBe(true)
    expect(getStatusForTxids).not.toHaveBeenCalled()
    expect(wallet.abortAction).not.toHaveBeenCalled()
  })

  it('a 2xx with a bad body: maybe_sent / unreadable_receipt, no abort', async () => {
    const { args, wallet } = setup({ post: { kind: 'network', message: 'unreadable_receipt' } })
    const e = await rejection(sendViaPaymail(args))
    expect(e).toMatchObject({ kind: 'maybe_sent', code: 'unreadable_receipt' })
    expect(wallet.abortAction).not.toHaveBeenCalled()
  })

  describe('a non-2xx answer', () => {
    const http503 = { kind: 'http', status: 503, message: 'parse error' }

    it.each([503, 404, 302])('HTTP %i, network knows the txid on the first check: broadcast, row sent', async code => {
      const status = jest.fn()
      const { args, wallet, storage } = setup({ post: { kind: 'http', status: code, message: 'x' }, status })
      status.mockImplementation(async (t: string[]) => known(t[0]))
      const res = await sendViaPaymail(args)
      expect(res.broadcastPending).toBe(false)
      expect(wallet.abortAction).not.toHaveBeenCalled()
      expect(wallet.createAction.mock.calls[1][0]).toMatchObject({ options: { sendWith: [res.txid] } })
      expect((await rows(storage))[0].status).toBe('sent')
    })

    it('unknown then known on the recheck: no abort, row sent', async () => {
      const status = jest.fn().mockResolvedValueOnce(unknown)
      status.mockImplementation(async (t: string[]) => known(t[0]))
      const { args, wallet, storage } = setup({ post: http503, status })
      const res = await sendViaPaymail(args)
      expect(status).toHaveBeenCalledTimes(2)
      expect(res.broadcastPending).toBe(false)
      expect(wallet.abortAction).not.toHaveBeenCalled()
      expect((await rows(storage))[0].status).toBe('sent')
    })

    it('unknown twice, abort works: refused / recipient_refused, row removed', async () => {
      const { args, wallet, storage } = setup({ post: http503, status: jest.fn().mockResolvedValue(unknown) })
      const e = await rejection(sendViaPaymail(args))
      expect(e).toMatchObject({ kind: 'refused', code: 'recipient_refused', message: 'parse error' })
      expect(wallet.abortAction).toHaveBeenCalledWith({ reference: 'ref1' }, 'admin.com')
      expect(wallet.listActions).toHaveBeenCalledWith({ labels: ['paymail'], limit: 1000 }, 'admin.com')
      expect(await rows(storage)).toHaveLength(0)
    })

    it('unknown twice, abortAction returns aborted:false: abort_failed, row stays unsent', async () => {
      const wallet = fakeWallet({ abortAction: jest.fn().mockResolvedValue({ aborted: false }) })
      const { args, storage } = setup({ wallet, post: http503, status: jest.fn().mockResolvedValue(unknown) })
      const e = await rejection(sendViaPaymail(args))
      expect(e).toMatchObject({ kind: 'abort_failed', code: 'abort_failed' })
      const [row] = await rows(storage)
      expect(row).toMatchObject({ status: 'unsent', lastError: 'abort_failed' })
      expect(TaskDrainOutbox.hasPending).toBe(true)
    })

    it('getStatusForTxids never resolves: after 10 s maybe_sent / status_unavailable, no abort', async () => {
      jest.useFakeTimers()
      const status = jest.fn(() => new Promise(() => {}))
      const { args, wallet, storage } = setup({ post: http503, status: status as any })
      const p = rejection(sendViaPaymail(args))
      await jest.advanceTimersByTimeAsync(10_001)
      const e = await p
      expect(e).toMatchObject({ kind: 'maybe_sent', code: 'status_unavailable' })
      expect(wallet.abortAction).not.toHaveBeenCalled()
      expect((await rows(storage))[0]).toMatchObject({ status: 'unsent', lastError: 'status_unavailable' })
    })

    it('abortAction never resolves: after 10 s abort_failed, row stays unsent', async () => {
      jest.useFakeTimers()
      const wallet = fakeWallet({ abortAction: jest.fn(() => new Promise(() => {})) })
      const { args, storage } = setup({ wallet, post: http503, status: jest.fn().mockResolvedValue(unknown) })
      const p = rejection(sendViaPaymail(args))
      await jest.advanceTimersByTimeAsync(10_001)
      const e = await p
      expect(e).toMatchObject({ kind: 'abort_failed' })
      expect((await rows(storage))[0]).toMatchObject({ status: 'unsent', lastError: 'abort_failed' })
    })

    it.each([
      ['throws', () => jest.fn().mockRejectedValue(new Error('down'))],
      ['reports error', () => jest.fn().mockResolvedValue({ status: 'error' })]
    ])('status service %s: maybe_sent / status_unavailable, no abort', async (_n, mk) => {
      const { args, wallet, storage } = setup({ post: http503, status: mk() })
      const e = await rejection(sendViaPaymail(args))
      expect(e).toMatchObject({ kind: 'maybe_sent', code: 'status_unavailable' })
      expect(wallet.abortAction).not.toHaveBeenCalled()
      expect((await rows(storage))[0].status).toBe('unsent')
    })
  })

  it('accepted but the sendWith broadcast fails: broadcastPending, row unsent but delivered', async () => {
    const wallet = fakeWallet()
    const inner = wallet.createAction.getMockImplementation()!
    wallet.createAction.mockImplementation(async (a: any) => {
      if (a?.options?.sendWith) throw new Error('offline')
      return inner(a)
    })
    const { args, storage } = setup({ wallet, status: jest.fn().mockResolvedValue(unknown) })
    const res = await sendViaPaymail(args)
    expect(res.broadcastPending).toBe(true)
    expect((await rows(storage))[0]).toMatchObject({ status: 'unsent', delivered: true })
    expect(TaskDrainOutbox.hasPending).toBe(true)
  })

  it('sendWith answers failed but the network says known: row sent, not pending', async () => {
    const wallet = fakeWallet()
    const inner = wallet.createAction.getMockImplementation()!
    wallet.createAction.mockImplementation(async (a: any) => {
      if (a?.options?.sendWith) return { sendWithResults: [{ txid: a.options.sendWith[0], status: 'failed' }] }
      return inner(a)
    })
    const status = jest.fn(async (t: string[]) => known(t[0]))
    const { args, storage } = setup({ wallet, status })
    const res = await sendViaPaymail(args)
    expect(res.broadcastPending).toBe(false)
    expect((await rows(storage))[0]).toMatchObject({ status: 'sent', lastError: 'broadcast_not_confirmed' })
  })
})

describe('labels', () => {
  it('exports the label helpers', () => {
    expect(PAYMAIL_LABEL).toBe('paymail')
    expect(paymailAddressLabel('A@B.io')).toBe('paymail:a@b.io')
  })
})

describe('confirmUnknown', () => {
  const T = 'c'.repeat(64)
  const mk = (fn: jest.Mock) => ({ getStatusForTxids: fn as any, recheckDelayMs: 0 })

  it('known when the second check is known', async () => {
    const fn = jest.fn().mockResolvedValueOnce(unknown).mockResolvedValueOnce(known(T))
    expect(await confirmUnknown(mk(fn), T)).toBe('known')
  })
  it('error when either errors', async () => {
    expect(await confirmUnknown(mk(jest.fn().mockRejectedValue(new Error('x'))), T)).toBe('error')
    const fn = jest.fn().mockResolvedValueOnce(unknown).mockResolvedValueOnce({ status: 'error' })
    expect(await confirmUnknown(mk(fn), T)).toBe('error')
  })
  it('unknown when both are unknown, with a sleep between', async () => {
    const sleep = jest.fn().mockResolvedValue(undefined)
    const fn = jest.fn().mockResolvedValue(unknown)
    expect(await confirmUnknown({ ...mk(fn), sleep }, T)).toBe('unknown')
    expect(sleep).toHaveBeenCalledTimes(1)
    expect(fn).toHaveBeenCalledTimes(2)
  })
})

describe('withTxidLock', () => {
  it('a second flow on the same txid gets undefined at once; released after a throw', async () => {
    let release!: () => void
    const gate = new Promise<void>(r => (release = r))
    const first = withTxidLock('t1', async () => {
      await gate
      return 'a'
    })
    const second = await withTxidLock('t1', async () => 'b')
    expect(second).toBeUndefined()
    release()
    expect(await first).toBe('a')
    await expect(
      withTxidLock('t1', async () => {
        throw new Error('boom')
      })
    ).rejects.toThrow('boom')
    expect(await withTxidLock('t1', async () => 'c')).toBe('c')
  })
})

/**
 * The direct rail (core/pay/rails/direct.ts) with a mocked DirectPayClient: one transaction and
 * one outbox row per payment, broadcast only after the recipient's ack, and a link that fails
 * after sending left to the outbox drain, which delivers the same token through the message box.
 */
import { P2PKH, PrivateKey, Transaction } from '@bsv/sdk'
import { DirectDeliveryUnconfirmedError, sendViaDirect } from '../../core/pay/rails/direct'
import { retryDelivery } from '../../core/pay/rails/handle'
import { getOutboxEntries, unsentEntries } from '../../core/peerpay/outbox'
import { TaskDrainOutbox } from '../../core/monitor/TaskDrainOutbox'
import { NotSentError, payIdentity } from '../../core/directpay/payFlow'
import { loadWebRTPay, type WebRTPayModule } from '../../core/directpay/webrtpay'

const webrtpay = loadWebRTPay() as WebRTPayModule
const KEY = PrivateKey.fromRandom().toPublicKey().toString()

function fakeStorage() {
  const map = new Map<string, string>()
  return {
    map,
    getKeyValue: async (k: string) => map.get(k),
    setKeyValue: async (k: string, v: string) => void map.set(k, v)
  }
}

function fakeWallet(order: string[] = []) {
  return {
    getPublicKey: jest.fn().mockResolvedValue({ publicKey: KEY }),
    createAction: jest.fn(async (args: any) => {
      if (args?.options?.sendWith) {
        order.push('broadcast')
        return { sendWithResults: [{ txid: args.options.sendWith[0], status: 'sending' }] }
      }
      order.push('mint')
      const tx = new Transaction()
      tx.addOutput({
        lockingScript: new P2PKH().lock(PrivateKey.fromRandom().toAddress()),
        satoshis: args.outputs[0].satoshis
      })
      return { txid: tx.id('hex'), tx: tx.toAtomicBEEF() }
    }),
    listActions: jest.fn(async () => ({ actions: [] as { txid?: string; reference?: string }[] })),
    abortAction: jest.fn().mockResolvedValue({ aborted: true })
  }
}

function fakePeer(open = true) {
  return { peerIdentityKey: KEY, isOpen: open, close: jest.fn() }
}

function fakeClient(order: string[] = [], peer = fakePeer()) {
  return {
    peer,
    connect: jest.fn(async () => {
      order.push('dial')
      return peer
    }),
    sendPayment: jest.fn(async (_peer: unknown, _token: any, _options?: { note?: string }) => {
      order.push('send')
      return { status: 'accepted' as const, txid: 'x' }
    })
  }
}

function args(o: {
  wallet?: ReturnType<typeof fakeWallet>
  client?: ReturnType<typeof fakeClient>
  storage?: ReturnType<typeof fakeStorage>
  extra?: Record<string, unknown>
}) {
  return {
    wallet: (o.wallet ?? fakeWallet()) as never,
    adminOriginator: 'admin.com',
    client: (o.client ?? fakeClient()) as never,
    webrtpay,
    storage: o.storage ?? fakeStorage(),
    recipient: KEY,
    satoshis: 700,
    messageBoxUrl: 'https://mb.example',
    ...o.extra
  }
}

beforeEach(() => TaskDrainOutbox.resetForTests())

describe('sendViaDirect', () => {
  it('dials first, then mints, saves the row, sends, and broadcasts only after the ack', async () => {
    const order: string[] = []
    const storage = fakeStorage()
    const wallet = fakeWallet(order)
    const client = fakeClient(order)
    client.sendPayment.mockImplementation(async () => {
      order.push('send')
      // The row exists and is marked delivering before anything goes over the link.
      const [row] = await getOutboxEntries(storage)
      expect(row).toMatchObject({ via: 'direct', delivering: true, status: 'unsent' })
      expect(row.delivered).toBeUndefined()
      return { status: 'accepted', txid: 'x' }
    })
    const result = await sendViaDirect(args({ wallet, client, storage, extra: { note: 'coffee' } }))
    expect(order).toEqual(['dial', 'mint', 'send', 'broadcast'])
    expect(result).toMatchObject({ ackStatus: 'accepted', broadcast: 'sent', satoshis: 700 })
    const [row] = await getOutboxEntries(storage)
    expect(row).toMatchObject({ status: 'sent', delivered: true, via: 'direct', txid: result.txid })
    expect(wallet.createAction.mock.calls[0][0].labels).toEqual(['peerpay', KEY])
    expect(client.sendPayment.mock.calls[0][2]).toEqual({ note: 'coffee' })
    expect(client.peer.close).toHaveBeenCalled()
  })

  it('a dial nobody answered mints nothing and says offline', async () => {
    const wallet = fakeWallet()
    const client = fakeClient()
    client.connect.mockRejectedValue(new webrtpay.WebRTPayError('peer_unreachable' as never, 'no reply'))
    const err = await sendViaDirect(args({ wallet, client })).catch(e => e)
    expect(err).toBeInstanceOf(NotSentError)
    expect(err.failure).toBe('offline')
    expect(wallet.createAction).not.toHaveBeenCalled()
  })

  it('says unavailable, not offline, when this wallet cannot reach its own signaling', async () => {
    const client = fakeClient()
    client.connect.mockRejectedValue(new webrtpay.WebRTPayError('peer_unreachable' as never, 'no relay'))
    const err = await sendViaDirect(args({ client, extra: { signalingDown: async () => true } })).catch(e => e)
    expect(err.failure).toBe('unavailable')
  })

  it('a cancelled dial is aborted, by its own signal rather than the wording', async () => {
    const controller = new AbortController()
    const client = fakeClient()
    client.connect.mockImplementation(async () => {
      controller.abort()
      throw new Error('anything')
    })
    const err = await sendViaDirect(args({ client, extra: { signal: controller.signal } })).catch(e => e)
    expect(err).toMatchObject({ name: 'NotSentError', failure: 'aborted' })
  })

  it('a wallet that cannot make the payment spent nothing and leaves no row', async () => {
    const storage = fakeStorage()
    const wallet = fakeWallet()
    wallet.createAction.mockRejectedValue(new Error('Insufficient funds'))
    const err = await sendViaDirect(args({ wallet, storage })).catch(e => e)
    expect(err).toBeInstanceOf(NotSentError)
    expect(err.failure).toBeUndefined()
    expect(err.detail).toBe('Insufficient funds')
    expect(await getOutboxEntries(storage)).toEqual([])
  })

  it('a link that closed before sending aborts the minted payment and leaves no row', async () => {
    const storage = fakeStorage()
    const wallet = fakeWallet()
    wallet.listActions.mockImplementation(async () => {
      const txid = (await wallet.createAction.mock.results[0].value).txid
      return { actions: [{ txid, reference: 'ref-1' }] }
    })
    const client = fakeClient([], fakePeer(false))
    const err = await sendViaDirect(args({ wallet, client, storage })).catch(e => e)
    expect(err).toMatchObject({ name: 'NotSentError', failure: 'unknown' })
    expect(wallet.abortAction).toHaveBeenCalledWith({ reference: 'ref-1' }, 'admin.com')
    expect(client.sendPayment).not.toHaveBeenCalled()
    expect(await getOutboxEntries(storage)).toEqual([])
  })

  it('refuses to pay live without a message box to finish through, before dialing', async () => {
    const client = fakeClient()
    const err = await sendViaDirect(args({ client, extra: { messageBoxUrl: 'noMessageBox' } })).catch(e => e)
    expect(err).toBeInstanceOf(NotSentError)
    expect(client.connect).not.toHaveBeenCalled()
  })

  it.each([
    ['the link fails before the ack', 'throw', 'no_ack'],
    ['the recipient refuses it', 'rejected', 'rejected']
  ])('when %s, the row goes forward to the message box, never aborted', async (_case, how, why) => {
    const order: string[] = []
    const storage = fakeStorage()
    const wallet = fakeWallet(order)
    const client = fakeClient(order)
    client.sendPayment.mockImplementation(async () => {
      order.push('send')
      if (how === 'throw') throw new Error('closed')
      return { status: 'rejected', reason: 'busy' } as never
    })
    const err = await sendViaDirect(args({ wallet, client, storage })).catch(e => e)
    expect(err).toBeInstanceOf(DirectDeliveryUnconfirmedError)
    expect(err.why).toBe(why)
    expect(order).toEqual(['dial', 'mint', 'send'])
    expect(wallet.abortAction).not.toHaveBeenCalled()
    const [row] = await getOutboxEntries(storage)
    expect(row).toMatchObject({ status: 'unsent', delivering: true, via: 'direct' })
    expect(row.delivered).toBeUndefined()
    expect(TaskDrainOutbox.hasPending).toBe(true)
    // payIdentity reads it as "may already have been sent", and offers nothing more.
    const outcome = await payIdentity({ direct: () => Promise.reject(err), messageBox: async () => {}, name: 'Bob' })
    expect(outcome).toMatchObject({ kind: 'failed', spent: 'maybe' })
  })

  it('the drain then delivers the same token through the message box and broadcasts it once', async () => {
    const order: string[] = []
    const storage = fakeStorage()
    const wallet = fakeWallet(order)
    const client = fakeClient(order)
    let sentToken: unknown
    client.sendPayment.mockImplementation(async (_peer: unknown, token: unknown) => {
      sentToken = token
      throw new Error('closed')
    })
    await sendViaDirect(args({ wallet, client, storage })).catch(() => {})
    const box = { sendMessage: jest.fn().mockResolvedValue(undefined) }
    const [row] = unsentEntries(await getOutboxEntries(storage))
    await retryDelivery({
      wallet: wallet as never,
      adminOriginator: 'admin.com',
      client: box as never,
      storage,
      entry: row
    })
    const body = JSON.parse(box.sendMessage.mock.calls[0][0].body)
    expect(body.customInstructions).toEqual((sentToken as any).customInstructions)
    expect(body.transaction).toEqual((sentToken as any).transaction)
    expect(order.filter(s => s === 'mint')).toHaveLength(1)
    expect(order.filter(s => s === 'broadcast')).toHaveLength(1)
    expect((await getOutboxEntries(storage))[0].status).toBe('sent')
  })

  it('a broadcast that fails after a good ack is left to the drain, and the payment counts as paid', async () => {
    const storage = fakeStorage()
    const wallet = fakeWallet()
    const mint = wallet.createAction.getMockImplementation()!
    wallet.createAction.mockImplementation(async (a: any) => {
      if (a?.options?.sendWith) throw new Error('ARC unreachable')
      return mint(a)
    })
    const result = await sendViaDirect(args({ wallet, storage }))
    expect(result).toMatchObject({ ackStatus: 'accepted', broadcast: 'pending' })
    const [row] = await getOutboxEntries(storage)
    expect(row).toMatchObject({ status: 'unsent', delivered: true, lastError: 'ARC unreachable' })
    expect(TaskDrainOutbox.hasPending).toBe(true)
  })

  it('a kept payment (received) is still paid live and broadcast', async () => {
    const client = fakeClient()
    client.sendPayment.mockResolvedValue({ status: 'received', txid: 'x' } as never)
    await expect(sendViaDirect(args({ client }))).resolves.toMatchObject({ ackStatus: 'received', broadcast: 'sent' })
  })
})

describe('payIdentity over the direct rail', () => {
  it('asks before using the message box when the recipient is offline', async () => {
    const client = fakeClient()
    client.connect.mockRejectedValue(new webrtpay.WebRTPayError('peer_unreachable' as never, 'no reply'))
    const outcome = await payIdentity({
      direct: () => sendViaDirect(args({ client })),
      messageBox: async () => {},
      name: 'Bob'
    })
    expect(outcome).toEqual({ kind: 'ask_fallback', reason: 'offline' })
  })

  it('reports a live payment as paid_live with the ack status', async () => {
    const outcome = await payIdentity({ direct: () => sendViaDirect(args({})), name: 'Bob' })
    expect(outcome).toEqual({ kind: 'paid_live', ackStatus: 'accepted' })
  })
})

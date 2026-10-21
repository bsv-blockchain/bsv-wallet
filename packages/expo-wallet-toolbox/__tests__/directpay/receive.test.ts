/**
 * Receiving a direct payment (core/directpay/receive.ts) with the real @bsv/webrtpay verify and
 * accept, a fake wallet and an in-memory device store: taken once whichever way it arrives (live
 * or through the inbox), kept on environmental failures, refused otherwise, and kept payments
 * retried until the wallet has them.
 */
import { P2PKH, PrivateKey, Transaction, Utils } from '@bsv/sdk'
import {
  createDirectPaySeenStore,
  dismissKeptDirectPayment,
  KEPT_LIMIT,
  listKeptDirectPayments,
  NEEDS_ATTENTION_AGE_MS,
  NEEDS_ATTENTION_ATTEMPTS,
  receiveDirectPayment,
  retryKeptDirectPayments,
  RetryStopped,
  type DirectPayStore
} from '../../core/directpay/receive'
import { loadWebRTPay, type IncomingDirectPayment, type WebRTPayModule } from '../../core/directpay/webrtpay'
import { inboxPaymentKey, internalizeIncoming, resetCreditAckQueueForTests } from '../../core/pay/rails/handle'
import { abbreviateKey } from '../../core/pay/counterparty'
import { classifyCreditError } from '../../core/pay/creditErrors'

const webrtpay = loadWebRTPay() as WebRTPayModule
const recipient = PrivateKey.fromRandom()
const SENDER = PrivateKey.fromRandom().toPublicKey().toString()
const IDENTITY = recipient.toPublicKey().toString()

function memoryStorage() {
  const map = new Map<string, string>()
  return {
    map,
    getKeyValue: jest.fn(async (k: string) => map.get(k)),
    setKeyValue: jest.fn(async (k: string, v: string) => void map.set(k, v))
  }
}

let nonce = 0
/** A payment that pays the fake wallet's key `amount` satoshis, with its own txid. */
function makePayment(amount = 1000): IncomingDirectPayment {
  const tx = new Transaction()
  tx.addOutput({ lockingScript: new P2PKH().lock(recipient.toPublicKey().toAddress()), satoshis: amount })
  tx.lockTime = ++nonce
  return {
    messageId: `m${nonce}`,
    sender: SENDER,
    token: {
      customInstructions: {
        derivationPrefix: 'cHJlZml4',
        derivationSuffix: Utils.toBase64([nonce & 255, nonce >> 8, 7])
      },
      transaction: tx.toAtomicBEEF(),
      amount,
      outputIndex: 0
    }
  }
}

function fakeWallet(internalize: () => Promise<unknown> = async () => ({ accepted: true })) {
  return {
    getPublicKey: jest.fn(async () => ({ publicKey: recipient.toPublicKey().toString() })),
    internalizeAction: jest.fn(internalize)
  }
}

const classify = (e: unknown) => classifyCreditError(e)

function setup(wallet = fakeWallet()) {
  const storage = memoryStorage()
  const store: DirectPayStore = { storage, identity: IDENTITY, chain: 'main' }
  const receive = (payment: IncomingDirectPayment, note?: string) =>
    receiveDirectPayment({ webrtpay, wallet: wallet as never, originator: 'admin.com', store, payment, note, classify })
  const retry = (o: Partial<Parameters<typeof retryKeptDirectPayments>[0]> = {}) =>
    retryKeptDirectPayments({ webrtpay, wallet: wallet as never, originator: 'admin.com', store, classify, ...o })
  return { storage, store, wallet, receive, retry }
}

beforeEach(() => resetCreditAckQueueForTests())

describe('receiveDirectPayment', () => {
  it('internalizes with the peerpay label and the sender note as the description', async () => {
    const { wallet, receive } = setup()
    await expect(receive(makePayment(), 'lunch')).resolves.toEqual({ status: 'accepted', repeat: false, added: true })
    const [args, originator] = wallet.internalizeAction.mock.calls[0] as unknown as [any, string]
    expect(originator).toBe('admin.com')
    expect(args.labels).toEqual(['peerpay'])
    expect(args.description).toBe('lunch')
    expect(args.outputs[0]).toMatchObject({ protocol: 'wallet payment', outputIndex: 0 })
    expect(args.outputs[0].paymentRemittance.senderIdentityKey).toBe(SENDER)
  })

  it('names the sender by abbreviated key without a note, as the inbox does', async () => {
    const { wallet, receive } = setup()
    await receive(makePayment())
    expect((wallet.internalizeAction.mock.calls[0] as unknown as [any])[0].description).toBe(abbreviateKey(SENDER))
  })

  it('takes a redelivered payment once and says it is a repeat', async () => {
    const { wallet, receive } = setup()
    const p = makePayment()
    await receive(p)
    await expect(receive(p)).resolves.toEqual({ status: 'accepted', repeat: true, added: false })
    expect(wallet.internalizeAction).toHaveBeenCalledTimes(1)
  })

  it('refuses a payment that does not pay this wallet (invalid_payment), keeping nothing', async () => {
    const { storage, receive } = setup()
    const p = makePayment()
    p.token.amount = 999 // the output pays 1000
    await expect(receive(p)).rejects.toMatchObject({ name: 'WebRTPayError', code: 'invalid_payment' })
    expect([...storage.map.keys()]).toEqual([])
  })

  it('refuses a payment the wallet rejects for good (structural), keeping nothing', async () => {
    const { store, receive } = setup(
      fakeWallet(async () => {
        throw new Error('The tx parameter must be valid AtomicBEEF')
      })
    )
    await expect(receive(makePayment())).rejects.toMatchObject({ code: 'rejected' })
    expect((await listKeptDirectPayments(store)).payments).toEqual([])
  })

  it('keeps a payment the wallet cannot take right now (environmental) and answers received', async () => {
    const { store, receive } = setup(
      fakeWallet(async () => {
        throw new Error('database is locked')
      })
    )
    const p = makePayment(1500)
    await expect(receive(p, 'rent')).resolves.toEqual({ status: 'received', repeat: false, added: false })
    const { payments } = await listKeptDirectPayments(store)
    expect(payments).toHaveLength(1)
    expect(payments[0]).toMatchObject({ sender: SENDER, amount: 1500, attempts: 0, error: 'database is locked' })
    expect(payments[0].payment.note).toBe('rent')
    // Delivered again while kept: acknowledged, not kept twice, not announced again.
    await expect(receive(p)).resolves.toEqual({ status: 'received', repeat: true, added: false })
    expect((await listKeptDirectPayments(store)).payments).toHaveLength(1)
  })

  it('refuses rather than keeps once the kept limit is reached', async () => {
    const { storage, store, receive } = setup(
      fakeWallet(async () => {
        throw new Error('Network request failed')
      })
    )
    for (let i = 0; i < KEPT_LIMIT; i++) await receive(makePayment())
    await expect(receive(makePayment())).rejects.toMatchObject({ code: 'rejected' })
    expect((await listKeptDirectPayments(store)).payments).toHaveLength(KEPT_LIMIT)
    expect(storage.map.size).toBe(1)
  })

  it('never writes over a kept list it cannot read, and keeps nothing meanwhile', async () => {
    const { storage, store, receive } = setup(
      fakeWallet(async () => {
        throw new Error('database is locked')
      })
    )
    const key = `direct_pay_kept_v1:${IDENTITY}:main`
    storage.map.set(key, '{not json')
    await expect(receive(makePayment())).rejects.toMatchObject({ code: 'rejected' })
    expect(storage.map.get(key)).toBe('{not json')
    expect(await listKeptDirectPayments(store)).toEqual({ payments: [], unreadable: true, unknown: 0 })
  })

  it('a payment taken on redelivery after being kept is a repeat (announced when kept)', async () => {
    let fail = true
    const { store, receive } = setup(
      fakeWallet(async () => {
        if (fail) throw new Error('database is locked')
        return { accepted: true }
      })
    )
    const p = makePayment()
    await receive(p)
    fail = false
    await expect(receive(p)).resolves.toEqual({ status: 'accepted', repeat: true, added: true })
    expect((await listKeptDirectPayments(store)).payments).toEqual([])
  })
})

describe('the seen store shared with the inbox', () => {
  const inbox = (p: IncomingDirectPayment) => ({ ...p, token: { ...p.token } }) as never
  const client = () => ({ acknowledgeMessage: jest.fn().mockResolvedValue(undefined) })

  it('an inbox copy of a payment taken live is acknowledged, not credited again', async () => {
    const { store, wallet, receive } = setup()
    const p = makePayment()
    await receive(p)
    const box = client()
    const outcome = await internalizeIncoming(
      wallet as never,
      box as never,
      'admin.com',
      inbox(p),
      undefined,
      createDirectPaySeenStore(store)
    )
    expect(outcome).toBe('duplicate')
    expect(wallet.internalizeAction).toHaveBeenCalledTimes(1)
    expect(box.acknowledgeMessage).toHaveBeenCalledWith({ messageIds: [p.messageId] })
  })

  it('a live copy of a payment credited from the inbox is a repeat', async () => {
    const { store, wallet, receive } = setup()
    const p = makePayment()
    await expect(
      internalizeIncoming(
        wallet as never,
        client() as never,
        'admin.com',
        inbox(p),
        undefined,
        createDirectPaySeenStore(store)
      )
    ).resolves.toBe('credited')
    await expect(receive(p)).resolves.toEqual({ status: 'accepted', repeat: true, added: false })
    expect(wallet.internalizeAction).toHaveBeenCalledTimes(1)
  })

  it('both sides compute the same key', async () => {
    const { store, receive } = setup()
    const p = makePayment()
    await receive(p)
    const key = inboxPaymentKey(inbox(p))
    expect(key).toMatch(/^[0-9a-f]{64}:0:cHJlZml4:[A-Za-z0-9+/=]+$/)
    expect(await createDirectPaySeenStore(store).has(key!)).toBe(true)
  })

  it('an unreadable seen store counts as not seen', async () => {
    const { wallet } = setup()
    const seen = {
      has: jest.fn().mockRejectedValue(new Error('io')),
      add: jest.fn().mockRejectedValue(new Error('io'))
    }
    await expect(
      internalizeIncoming(wallet as never, client() as never, 'admin.com', inbox(makePayment()), undefined, seen)
    ).resolves.toBe('credited')
    expect(wallet.internalizeAction).toHaveBeenCalledTimes(1)
  })
})

describe('retryKeptDirectPayments', () => {
  afterEach(() => jest.useRealTimers())

  async function keptOne(failWith: string) {
    let failure: string | undefined = failWith
    const env = setup(
      fakeWallet(async () => {
        if (failure) throw new Error(failure)
        return { accepted: true }
      })
    )
    const p = makePayment()
    await env.receive(p)
    return { ...env, p, setFailure: (f: string | undefined) => (failure = f) }
  }

  it('takes a kept payment once the wallet can, and forgets it', async () => {
    const { store, retry, setFailure } = await keptOne('database is locked')
    setFailure(undefined)
    await expect(retry()).resolves.toBe(1)
    expect((await listKeptDirectPayments(store)).payments).toEqual([])
  })

  it('does not count an environmental failure as a try', async () => {
    const { store, retry } = await keptOne('database is locked')
    await retry()
    expect((await listKeptDirectPayments(store)).payments[0].attempts).toBe(0)
  })

  it('counts a structural failure, and flags it after enough tries more than a day old', async () => {
    const { store, retry, setFailure } = await keptOne('database is locked')
    setFailure('The tx parameter must be valid AtomicBEEF')
    const onNeedsAttention = jest.fn()
    for (let i = 0; i < NEEDS_ATTENTION_ATTEMPTS; i++) await retry({ onNeedsAttention })
    let kept = (await listKeptDirectPayments(store)).payments[0]
    expect(kept.attempts).toBe(NEEDS_ATTENTION_ATTEMPTS)
    expect(kept.needsAttention).toBeUndefined()
    jest.useFakeTimers({ now: Date.now() + NEEDS_ATTENTION_AGE_MS + 1000 })
    await retry({ onNeedsAttention })
    kept = (await listKeptDirectPayments(store)).payments[0]
    expect(kept.needsAttention?.reason).toBe('unverifiable')
    expect(onNeedsAttention).toHaveBeenCalledTimes(1)
  })

  it('flags a double-spent payment at once, and offers it again only when asked', async () => {
    const { store, wallet, retry, setFailure } = await keptOne('database is locked')
    setFailure('doubleSpend detected')
    const onNeedsAttention = jest.fn()
    await retry({ onNeedsAttention })
    expect((await listKeptDirectPayments(store)).payments[0].needsAttention?.reason).toBe('refused')
    expect(onNeedsAttention).toHaveBeenCalledTimes(1)
    const calls = wallet.internalizeAction.mock.calls.length
    await retry()
    expect(wallet.internalizeAction.mock.calls.length).toBe(calls)
    await retry({ includeNeedsAttention: true })
    expect(wallet.internalizeAction.mock.calls.length).toBe(calls + 1)
    expect(onNeedsAttention).toHaveBeenCalledTimes(1)
  })

  it('stops the pass where run says so, leaving the payment kept', async () => {
    const { store, wallet, retry, setFailure } = await keptOne('database is locked')
    setFailure(undefined)
    const calls = wallet.internalizeAction.mock.calls.length
    await expect(
      retry({
        run: async () => {
          throw new RetryStopped()
        }
      })
    ).resolves.toBe(0)
    expect(wallet.internalizeAction.mock.calls.length).toBe(calls)
    expect((await listKeptDirectPayments(store)).payments).toHaveLength(1)
  })

  it('lets the user dismiss only a payment that needs attention', async () => {
    const { store, retry, setFailure } = await keptOne('database is locked')
    const [kept] = (await listKeptDirectPayments(store)).payments
    await expect(dismissKeptDirectPayment(store, kept.key)).rejects.toThrow(/needs attention/)
    setFailure('doubleSpend detected')
    await retry()
    await expect(dismissKeptDirectPayment(store, kept.key)).resolves.toBe(true)
    expect((await listKeptDirectPayments(store)).payments).toEqual([])
    await expect(dismissKeptDirectPayment(store, kept.key)).resolves.toBe(false)
  })

  it('passes entries it does not recognise through untouched', async () => {
    const { storage, store, retry, setFailure } = await keptOne('database is locked')
    const key = `direct_pay_kept_v1:${IDENTITY}:main`
    const stored = JSON.parse(storage.map.get(key)!)
    storage.map.set(key, JSON.stringify([{ future: 'entry' }, ...stored]))
    setFailure(undefined)
    await retry()
    expect(JSON.parse(storage.map.get(key)!)).toEqual([{ future: 'entry' }])
    expect((await listKeptDirectPayments(store)).unknown).toBe(1)
  })
})

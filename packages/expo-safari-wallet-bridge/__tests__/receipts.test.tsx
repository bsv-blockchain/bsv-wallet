import {
  aggregate,
  createReceiptDispatch,
  createReceiptTracker,
  siteOf,
  summarize,
  type Receipt
} from '../src/receipts'

const fmt = (sats: number) => `<${sats}>`
const request = (over: Record<string, unknown> = {}) =>
  ({
    epoch: 'e1',
    instanceId: 'i',
    continuityKey: 'k',
    origin: 'https://shop.example',
    method: 'createSignature',
    args: {},
    sizeBytes: 2,
    ...over
  }) as any

describe('neededApproval', () => {
  function setup(
    during: (t: ReturnType<typeof createReceiptTracker>) => void,
    outcome: any = { ok: true, result: {} }
  ) {
    const tracker = createReceiptTracker()
    const receipts: Receipt[] = []
    const dispatch = createReceiptDispatch(
      async () => {
        during(tracker)
        return outcome
      },
      tracker,
      { format: fmt, onReceipt: r => receipts.push(r) }
    )
    return { dispatch, receipts, tracker }
  }

  it('is set with consent, with wallet-not-ready and with a foreground prompt', async () => {
    // The transport callbacks all mark the epoch; the host maps consent, wallet-not-ready and onPromptRaised to mark().
    for (const _kind of ['consent', 'wallet-not-ready', 'prompt']) {
      const { dispatch, receipts } = setup(t => t.mark('e1'))
      await dispatch({ transport: 'safari-extension', request: request() })
      expect(receipts[0].neededApproval).toBe(true)
    }
  })

  it('is not set for an auto-approved call', async () => {
    const { dispatch, receipts } = setup(() => undefined)
    await dispatch({ transport: 'safari-extension', request: request() })
    expect(receipts[0]).toMatchObject({ neededApproval: false, ok: true, origin: 'https://shop.example', epoch: 'e1' })
  })

  it('a mark made for another epoch, or while nothing is in flight, does not leak into the next call', async () => {
    const { dispatch, receipts, tracker } = setup(t => t.mark('other'))
    tracker.mark('e1')
    await dispatch({ transport: 'safari-extension', request: request() })
    expect(receipts[0].neededApproval).toBe(false)
  })

  it('ok follows the outcome', async () => {
    const { dispatch, receipts } = setup(() => undefined, { ok: false, walletError: {}, delivery: 'not-sent' })
    await dispatch({ transport: 'safari-extension', request: request() })
    expect(receipts[0].ok).toBe(false)
  })

  it('returns the dispatcher outcome unchanged and survives a throwing listener', async () => {
    const tracker = createReceiptTracker()
    const out = { ok: true, result: { a: 1 } }
    const d = createReceiptDispatch(async () => out as any, tracker, {
      onReceipt: () => {
        throw new Error('boom')
      }
    })
    jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    await expect(d({ transport: 'x', request: request() })).resolves.toBe(out)
  })

  it('a rejecting dispatch yields no receipt and clears the tracker', async () => {
    const tracker = createReceiptTracker()
    const receipts: Receipt[] = []
    const d = createReceiptDispatch(
      async () => {
        tracker.mark('e1')
        throw new Error('x')
      },
      tracker,
      { onReceipt: r => receipts.push(r) }
    )
    await expect(d({ transport: 'x', request: request() })).rejects.toThrow('x')
    expect(receipts).toHaveLength(0)
    tracker.begin?.('e1')
    expect(tracker.neededApproval('e1')).toBe(false)
  })
})

describe('summarize', () => {
  const pay = (sats: number[]) => ({ outputs: sats.map(satoshis => ({ satoshis, lockingScript: '00' })) })
  it.each([
    ['createAction', pay([1500]), { kind: 'payment', amount: '<1500>' }],
    ['createAction', pay([1000, 500, 0]), { kind: 'payment', amount: '<1500>' }],
    ['signAction', pay([700]), { kind: 'payment', amount: '<700>' }],
    ['createAction', pay([0]), { kind: 'action' }],
    ['createAction', {}, { kind: 'action' }],
    ['signAction', { spends: {}, reference: 'r' }, { kind: 'action' }],
    ['createSignature', {}, { kind: 'signed' }],
    ['createHmac', {}, { kind: 'signed' }],
    ['verifyHmac', {}, { kind: 'signed' }],
    ['encrypt', {}, { kind: 'encrypted' }],
    ['decrypt', {}, { kind: 'encrypted' }],
    ['acquireCertificate', {}, { kind: 'certificate' }],
    ['proveCertificate', {}, { kind: 'certificate' }],
    ['getPublicKey', {}, { kind: 'approved' }],
    ['revealCounterpartyKeyLinkage', {}, { kind: 'approved' }],
    ['listOutputs', {}, { kind: 'approved' }],
    ['somethingElse', undefined, { kind: 'approved' }]
  ])('%s %j', (method, args, expected) => {
    expect(summarize(method, args, fmt)).toEqual(expected)
  })

  it('a first-ever call still summarises as the method', () => {
    expect(summarize('createSignature', { protocolID: [1, 'x'] }, fmt)).toEqual({ kind: 'signed' })
  })

  it('BSV, sats and fiat display formats exact', () => {
    // Uses the real formatter the host uses, exact (not abbreviated), for each display currency.
    const { formatAmount } = require('@bsv/expo-wallet-toolbox/core/amountFormatHelpers')
    const out = (currency: string) =>
      summarize('createAction', pay([123456]), s => formatAmount(s, currency, 20000, { usdToFiat: { EUR: 0.9 } }))
    const amounts = ['BSV', 'USD', 'EUR'].map(c => (out(c) as { amount: string }).amount)
    expect(amounts[0]).toMatch(/123,?456|0\.00123456/)
    expect(amounts[1]).toContain('$')
    expect(new Set(amounts).size).toBe(3)
    expect(summarize('createAction', pay([5]), s => formatAmount(s, 'BSV', 0, {}))).toEqual({
      kind: 'payment',
      amount: formatAmount(5, 'BSV', 0, {})
    })
  })
})

describe('aggregate', () => {
  const rcpt = (origin: string, summary: Receipt['summary'] = { kind: 'signed' }): Receipt => ({
    origin,
    method: 'm',
    summary,
    ok: true,
    neededApproval: true,
    epoch: 'e'
  })
  it('one receipt is that receipt', () => {
    expect(aggregate([rcpt('https://a.example', { kind: 'payment', amount: '1' })])).toEqual({
      site: 'a.example',
      summary: { kind: 'payment', amount: '1' }
    })
  })
  it('three receipts of one site say "n requests approved"', () => {
    expect(aggregate([rcpt('https://a.example'), rcpt('https://a.example'), rcpt('https://a.example')])).toEqual({
      site: 'a.example',
      summary: { kind: 'requests', n: 3 }
    })
  })
  it('receipts for two sites say "Sent to n sites"', () => {
    expect(aggregate([rcpt('https://a.example'), rcpt('https://b.example'), rcpt('https://a.example')])).toEqual({
      sites: 2
    })
  })
  it('siteOf falls back to the origin text', () => {
    expect(siteOf('not a url')).toBe('not a url')
  })
})

import { PrivateKey } from '@bsv/sdk'
import { applyIncoming, matchPaid, type PaymentRequest, type RequestMessage } from '../src/requests/requests'

// real keys: a request's link is checked against its sender
const ANA = PrivateKey.fromString('11'.repeat(32), 'hex').toPublicKey().toString()
const BEN = PrivateKey.fromString('22'.repeat(32), 'hex').toPublicKey().toString()
const NOW = '2026-10-10T12:00:00.000Z'
const ASSET = 'ab'.repeat(32) + '_0'

const base: PaymentRequest = {
  id: 'r1',
  direction: 'out',
  counterparty: ANA,
  units: 150000,
  link: `peerpay:${BEN}?sats=150000`,
  createdAt: '2026-10-10T10:00:00.000Z',
  status: 'pending'
}

const ask = (over: Partial<Extract<RequestMessage, { type: 'payment-request' }>> = {}) => ({
  sender: BEN,
  message: {
    type: 'payment-request' as const,
    id: 'r9',
    units: 5000,
    link: `peerpay:${BEN}?sats=5000`,
    createdAt: '2026-10-10T11:00:00.000Z',
    fromName: 'Ben',
    ...over
  }
})

describe('requests arriving', () => {
  it('adds a new request once, however often it is read', () => {
    const once = applyIncoming([], [ask()], NOW)
    expect(once.arrived).toHaveLength(1)
    expect(once.list[0]).toMatchObject({ id: 'r9', direction: 'in', counterparty: BEN, status: 'pending', name: 'Ben' })
    expect(applyIncoming(once.list, [ask()], NOW).list).toHaveLength(1)
  })

  it('says a reminder again while the request is still to pay', () => {
    const once = applyIncoming([], [ask()], NOW)
    expect(applyIncoming(once.list, [ask()], NOW).arrived).toHaveLength(1)
    const declined = once.list.map(r => ({ ...r, status: 'declined' as const }))
    expect(applyIncoming(declined, [ask()], NOW).arrived).toHaveLength(0)
  })

  it('drops a request whose link pays someone else, or another amount or money', () => {
    for (const link of [`peerpay:${ANA}?sats=5000`, `peerpay:${BEN}?sats=500000000`, `peerpay:${BEN}?asset=${ASSET}&amount=5000`, 'peerpay:nope', 'https://evil.example'])
      expect(applyIncoming([], [ask({ link })], NOW).list).toHaveLength(0)
  })

  it('drops an amount that isn’t a whole positive number, and a badly named token', () => {
    for (const units of [0, -5, 1.5, Number.NaN, '5000' as never]) expect(applyIncoming([], [ask({ units })], NOW).list).toHaveLength(0)
    expect(applyIncoming([], [ask({ asset: { assetId: ASSET, ticker: '<b>', decimals: 2 }, link: `peerpay:${BEN}?asset=${ASSET}&amount=5000` })], NOW).list).toHaveLength(0)
  })

  it('takes a token request whose link names it', () => {
    const r = applyIncoming([], [ask({ asset: { assetId: ASSET, ticker: 'USDC', decimals: 2 }, link: `peerpay:${BEN}?asset=${ASSET}&amount=5000` })], NOW)
    expect(r.list[0]).toMatchObject({ units: 5000, asset: { assetId: ASSET, ticker: 'USDC', decimals: 2 } })
  })

  it('reads a bad or future date as now, and keeps names and notes to one short line', () => {
    expect(applyIncoming([], [ask({ createdAt: 'zzz' })], NOW).list[0].createdAt).toBe(NOW)
    expect(applyIncoming([], [ask({ createdAt: '2099-01-01T00:00:00Z' })], NOW).list[0].createdAt).toBe(NOW)
    const r = applyIncoming([], [ask({ fromName: `Mom\n${'x'.repeat(100)}`, note: 'a\nb' })], NOW).list[0]
    expect(r.name).toHaveLength(40)
    expect(r.note).toBe('a b')
  })

  it('takes a cancel only from who asked, and a decline only from who was asked', () => {
    const incoming: PaymentRequest = { ...base, direction: 'in', counterparty: BEN }
    expect(applyIncoming([incoming], [{ sender: BEN, message: { type: 'request-cancelled', id: 'r1' } }]).list[0].status).toBe('cancelled')
    expect(applyIncoming([incoming], [{ sender: BEN, message: { type: 'request-declined', id: 'r1' } }]).list[0].status).toBe('pending')
    expect(applyIncoming([base], [{ sender: ANA, message: { type: 'request-declined', id: 'r1' } }]).list[0].status).toBe('declined')
    expect(applyIncoming([base], [{ sender: ANA, message: { type: 'request-cancelled', id: 'r1' } }]).list[0].status).toBe('pending')
  })

  it('takes "paid" as their word for it, never as paid', () => {
    const r = applyIncoming([base], [{ sender: ANA, message: { type: 'request-paid', id: 'r1' } }], NOW).list[0]
    expect(r.status).toBe('pending')
    expect(r.claimedPaidAt).toBe(NOW)
  })

  it('ignores word about a request from anyone but its other side', () => {
    expect(applyIncoming([base], [{ sender: BEN, message: { type: 'request-declined', id: 'r1' } }]).list[0].status).toBe('pending')
  })

  it('keeps nothing for a pay link: it has no amount to wait for', () => {
    const r = applyIncoming([], [{ sender: BEN, message: { type: 'pay-link', id: 'l1', link: 'peerpay:z' } }])
    expect(r.list).toHaveLength(0)
    expect(r.arrived).toHaveLength(0)
  })
})

describe('a sent request is paid', () => {
  it('by a payment in from that person, for at least the amount, after asking', () => {
    const paid = matchPaid([base], [{ counterparty: ANA, incoming: true, units: 150000, createdAt: '2026-10-10T10:05:00.000Z' }])
    expect(paid[0].status).toBe('paid')
  })

  it('not by a smaller payment, an earlier one, someone else, or money going out', () => {
    for (const p of [
      { counterparty: ANA, incoming: true, units: 100000, createdAt: '2026-10-10T10:05:00.000Z' },
      { counterparty: ANA, incoming: true, units: 150000, createdAt: '2026-10-10T09:00:00.000Z' },
      { counterparty: BEN, incoming: true, units: 150000, createdAt: '2026-10-10T10:05:00.000Z' },
      { counterparty: ANA, incoming: false, units: 150000, createdAt: '2026-10-10T10:05:00.000Z' }
    ])
      expect(matchPaid([base], [p])[0].status).toBe('pending')
  })

  it('one payment settles one request', () => {
    const two = [base, { ...base, id: 'r2' }]
    const out = matchPaid(two, [{ counterparty: ANA, incoming: true, units: 150000, createdAt: '2026-10-10T10:05:00.000Z' }])
    expect(out.map(r => r.status)).toEqual(['paid', 'pending'])
  })

  it('a token request, by the token amount as the row shows it', () => {
    const asked = { ...base, units: 5000, asset: { assetId: ASSET, ticker: 'USDC', decimals: 2 } }
    const row = (figure: string) => ({ counterparty: ANA, incoming: true, units: 0, figure, assetId: ASSET, createdAt: '2026-10-10T10:05:00.000Z' })
    expect(matchPaid([asked], [row('+50.00')])[0].status).toBe('paid')
    expect(matchPaid([asked], [row('+49.99')])[0].status).toBe('pending')
  })
})

import { NO_MORE_FILTERS, passes } from '../src/activity/filters'

const at = (iso: string) =>
  ({ createdAt: iso, pending: false, status: { tone: 'completed' }, token: undefined }) as never
const custom = (from: string, to: string) => ({ ...NO_MORE_FILTERS, range: 'custom' as const, from, to })
// local times, as the calendar's days are
const local = (y: number, m: number, d: number, h = 12) => new Date(y, m - 1, d, h).toISOString()

describe('a custom range', () => {
  it('takes the first and last days whole', () => {
    const f = custom('2026-10-03', '2026-10-05')
    expect(passes(at(local(2026, 10, 3, 0)), f)).toBe(true)
    expect(passes(at(local(2026, 10, 5, 23)), f)).toBe(true)
    expect(passes(at(local(2026, 10, 2, 23)), f)).toBe(false)
    expect(passes(at(local(2026, 10, 6, 0)), f)).toBe(false)
  })

  it('is one day with only a first day picked, and everything with none', () => {
    expect(passes(at(local(2026, 10, 3)), custom('2026-10-03', ''))).toBe(true)
    expect(passes(at(local(2026, 10, 4)), custom('2026-10-03', ''))).toBe(false)
    expect(passes(at(local(2026, 1, 1)), custom('', ''))).toBe(true)
  })
})

describe('requests through the filters', () => {
  const { requestPasses, requestState, NO_MORE_FILTERS: none } = require('../src/activity/filters') as typeof import('../src/activity/filters')
  const req = (status: 'pending' | 'paid' | 'declined' | 'cancelled', extra: object = {}) =>
    ({ id: 'r', direction: 'out', counterparty: '02aa', units: 1000, link: '', createdAt: new Date().toISOString(), status, ...extra }) as never
  it('are unpaid or paid: only a paid one counts as paid', () => {
    expect(requestState(req('paid'))).toBe('paid')
    expect(requestState(req('pending'))).toBe('unpaid')
    expect(requestState(req('declined'))).toBe('unpaid')
    expect(requestState(req('cancelled'))).toBe('unpaid')
  })
  it('show only what’s ticked', () => {
    expect(requestPasses(req('paid'), none)).toBe(true)
    expect(requestPasses(req('paid'), { ...none, states: ['completed', 'pending', 'unpaid'] })).toBe(false)
    expect(requestPasses(req('pending'), { ...none, states: ['paid'] })).toBe(false)
    expect(requestPasses(req('pending'), { ...none, states: ['unpaid'] })).toBe(true)
  })
  it('keep to the range and the currencies', () => {
    expect(requestPasses(req('paid', { createdAt: '2020-01-01T00:00:00Z' }), { ...none, range: '30d' })).toBe(false)
    expect(requestPasses(req('paid'), { ...none, hiddenCoins: ['BSV'] })).toBe(false)
    expect(requestPasses(req('paid', { asset: { assetId: 'u', ticker: 'USDsv', decimals: 2 } }), { ...none, hiddenCoins: ['BSV'] })).toBe(true)
  })
})

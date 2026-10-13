// Activity's filters (the prototype's lib/tx-filters.ts): when (a preset, or
// a custom range of days), which currency, and what it is: settled, pending,
// or a request, unpaid or paid. Pure, for src/activity/ActivityExtras.tsx's
// sheet and the Activity screen.
import { parseDay } from '../ui/days'
import type { ActivityItem } from './useActivity'
import type { PaymentRequest } from '../requests/requests'

export type Range = 'all' | 'today' | '7d' | '30d' | 'year' | 'custom'
export const RANGES: { id: Range; label: string }[] = [
  { id: 'all', label: 'All time' },
  { id: 'today', label: 'Today' },
  { id: '7d', label: 'Last 7 days' },
  { id: '30d', label: 'Last 30 days' },
  { id: 'year', label: 'This year' },
  { id: 'custom', label: 'Custom range' }
]
export type TxState = 'completed' | 'pending' | 'unpaid' | 'paid'
export const STATES: { id: TxState; label: string; hint: string }[] = [
  { id: 'completed', label: 'Completed', hint: 'Payments that are settled' },
  { id: 'pending', label: 'Pending', hint: 'Not settled yet' },
  { id: 'unpaid', label: 'Unpaid requests', hint: 'Money you asked for that hasn’t come in' },
  { id: 'paid', label: 'Paid requests', hint: 'Requests that were paid' }
]

/** A request's place in the Show list: paid, or not (waiting, declined or cancelled). */
export const requestState = (r: Pick<PaymentRequest, 'status'>): TxState => (r.status === 'paid' ? 'paid' : 'unpaid')

export interface MoreFilters {
  range: Range
  /** a custom range's first and last days, yyyy-mm-dd ("" = open) */
  from: string
  to: string
  /** the currencies unticked ('BSV' or a token's ticker); all ticked to start */
  hiddenCoins: string[]
  states: TxState[]
}
export const NO_MORE_FILTERS: MoreFilters = { range: 'all', from: '', to: '', hiddenCoins: [], states: STATES.map(s => s.id) }
export const moreCount = (m: MoreFilters) => (m.range !== 'all' ? 1 : 0) + (m.hiddenCoins.length ? 1 : 0) + (m.states.length < STATES.length ? 1 : 0)

function since(range: Range, now = new Date()): number {
  const d = new Date(now)
  if (range === 'today') d.setHours(0, 0, 0, 0)
  else if (range === '7d') d.setDate(d.getDate() - 7)
  else if (range === '30d') d.setDate(d.getDate() - 30)
  else if (range === 'year') d.setMonth(0, 1), d.setHours(0, 0, 0, 0)
  else return -Infinity
  return d.getTime()
}

/** Within the range picked (a preset, or the days of a custom one, whole). */
function inRange(createdAt: string | undefined, m: MoreFilters): boolean {
  if (m.range === 'custom') {
    const at = createdAt ? Date.parse(createdAt) : NaN
    if (m.from && !(at >= parseDay(m.from).getTime())) return false
    const last = parseDay(m.to || m.from)
    if ((m.to || m.from) && !(at < new Date(last.getFullYear(), last.getMonth(), last.getDate() + 1).getTime())) return false
    return true
  }
  return m.range === 'all' || (!!createdAt && Date.parse(createdAt) >= since(m.range))
}

/** A request through the finer filters: its day, its currency, unpaid or paid. */
export function requestPasses(r: PaymentRequest, m: MoreFilters): boolean {
  if (!inRange(r.createdAt, m)) return false
  if (m.hiddenCoins.includes(r.asset ? r.asset.ticker : 'BSV')) return false
  return m.states.includes(requestState(r))
}

export function passes(tx: ActivityItem, m: MoreFilters): boolean {
  if (!inRange(tx.createdAt, m)) return false
  if (m.hiddenCoins.includes(tx.token ? tx.token.unit : 'BSV')) return false
  const state: TxState = tx.pending ? 'pending' : 'completed'
  if (tx.status.tone !== 'failed' && !m.states.includes(state)) return false
  return true
}

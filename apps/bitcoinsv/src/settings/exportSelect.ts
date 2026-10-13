// What an export takes (the prototype's lib/export-transactions.ts): a period
// (the last 30 days, this year, all time, or days picked on a calendar) and
// which payments (all, received, sent). Pure, for src/settings/ExportSheet.tsx
// and its tests.
import { parseDay } from '../ui/days'

export type ExportPeriod = '30d' | 'year' | 'all' | 'custom'
export const PERIODS: { id: ExportPeriod; label: string }[] = [
  { id: '30d', label: 'Last 30 days' },
  { id: 'year', label: 'This year' },
  { id: 'all', label: 'All time' },
  { id: 'custom', label: 'Custom range' }
]

export type ExportType = 'all' | 'received' | 'sent'
export const TYPES: { id: ExportType; label: string }[] = [
  { id: 'all', label: 'All payments' },
  { id: 'received', label: 'Received' },
  { id: 'sent', label: 'Sent' }
]

export interface ExportChoice {
  period: ExportPeriod
  /** a custom period's first and last days, yyyy-mm-dd ("" = open) */
  from: string
  to: string
  type: ExportType
}

/** The slice of an action this needs: when, and which way. */
export interface ExportableAction {
  created_at?: string | Date
  isOutgoing: boolean
}

/** The period's bounds, in ms: [start, end) — either open. */
export function periodBounds(c: ExportChoice, now = new Date()): [number, number] {
  if (c.period === '30d') return [new Date(now.getFullYear(), now.getMonth(), now.getDate() - 30).getTime(), Infinity]
  if (c.period === 'year') return [new Date(now.getFullYear(), 0, 1).getTime(), Infinity]
  if (c.period === 'custom') {
    const start = c.from ? parseDay(c.from).getTime() : -Infinity
    const lastDay = c.to || c.from
    const last = lastDay ? parseDay(lastDay) : null
    return [start, last ? new Date(last.getFullYear(), last.getMonth(), last.getDate() + 1).getTime() : Infinity]
  }
  return [-Infinity, Infinity]
}

export function selector(c: ExportChoice, now = new Date()) {
  const [start, end] = periodBounds(c, now)
  return (a: ExportableAction): boolean => {
    if (c.type === 'received' && a.isOutgoing) return false
    if (c.type === 'sent' && !a.isOutgoing) return false
    if (start === -Infinity && end === Infinity) return true
    const at = a.created_at ? new Date(a.created_at).getTime() : NaN
    return at >= start && at < end
  }
}

/** A day as YYMMDD, from a date (local) or a yyyy-mm-dd day */
const yymmdd = (d: Date | string) =>
  typeof d === 'string'
    ? d.slice(2).replace(/-/g, '')
    : `${String(d.getFullYear() % 100).padStart(2, '0')}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`

/** The period, for a file name: none for all time */
function periodPart(c: ExportChoice, now: Date): string | null {
  if (c.period === '30d') return 'last-30-days'
  if (c.period === 'year') return String(now.getFullYear())
  if (c.period === 'custom') {
    const last = c.to || c.from
    if (!c.from && !last) return null
    if (!c.from) return `to-${yymmdd(last)}`
    return last === c.from ? yymmdd(c.from) : `${yymmdd(c.from)}-to-${yymmdd(last)}`
  }
  return null
}

/**
 * The export's file name: the day it was made first (YYMMDD, so a folder of
 * them sorts by date), the app, what's in it, and its period unless that's
 * all time. "261012-bitcoinsv-wallet-sent-2026.csv".
 */
export const exportFileName = (c: ExportChoice, ext: string, now = new Date()) =>
  [yymmdd(now), 'bitcoinsv-wallet', c.type === 'all' ? 'payments' : c.type, periodPart(c, now)].filter(Boolean).join('-') + `.${ext}`

// Dates and amounts the way the prototype writes them (lib/format.ts).

const dayFmt = new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })
const dayFmtYear = new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
const timeFmt = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' })
const dateFmt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' })

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()

/** "Today", "Yesterday", "Sunday 26 July", with the year past six months. */
export function dayLabel(iso: string, now = new Date()): string {
  const date = new Date(iso)
  const days = Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000)
  if (days === 0) return 'Today'
  if (days === 1) return 'Yesterday'
  return days < 180 ? dayFmt.format(date) : dayFmtYear.format(date)
}

export const timeLabel = (iso: string) => timeFmt.format(new Date(iso))

/** "Jul 26, 2026 at 6:05 PM" */
export const whenLabel = (iso: string) => `${dateFmt.format(new Date(iso))} at ${timeFmt.format(new Date(iso))}`

/** Rows grouped into day buckets, newest first. */
export function groupByDay<T extends { createdAt?: string }>(items: T[]): { label: string; items: T[] }[] {
  const groups: { label: string; items: T[] }[] = []
  for (const it of items) {
    const label = it.createdAt ? dayLabel(it.createdAt) : 'Earlier'
    const last = groups[groups.length - 1]
    if (last && last.label === label) last.items.push(it)
    else groups.push({ label, items: [it] })
  }
  return groups
}

const SATS_PER_BSV = 100_000_000

/** "0.0015" from satoshis: up to eight places, no trailing zeros. */
export function bsvFigure(sats: number): string {
  return (Math.abs(sats) / SATS_PER_BSV).toFixed(8).replace(/\.?0+$/, '') || '0'
}

/** "+0.0015 BSV" / "−0.0015 BSV" */
export function signedBsv(sats: number): string {
  return `${sats > 0 ? '+' : sats < 0 ? '−' : ''}${bsvFigure(sats)} BSV`
}

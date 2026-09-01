import { partitionQueueByGrace, QUEUE_GRACE_MS } from '../../core/offline/queueGrace'

const NOW = new Date('2026-09-01T12:00:00.000Z').getTime()
const at = (msAgo: number) => new Date(NOW - msAgo).toISOString()

it('says nothing about a payment queued a moment ago while online', () => {
  const rows = [{ status: 'queued', updated_at: at(200) }]
  const r = partitionQueueByGrace(rows, { online: true, nowMs: NOW })
  expect(r.shown).toEqual([])
  // The banner becomes true by the passage of time alone, so the caller has to
  // be told to look again.
  expect(r.nextCheckMs).toBe(QUEUE_GRACE_MS - 200)
})

it('shows one that is still queued after the grace', () => {
  const rows = [{ status: 'queued', updated_at: at(QUEUE_GRACE_MS + 1) }]
  const r = partitionQueueByGrace(rows, { online: true, nowMs: NOW })
  expect(r.shown).toHaveLength(1)
  expect(r.nextCheckMs).toBeUndefined()
})

it('grants no grace at all when offline', () => {
  const rows = [{ status: 'queued', updated_at: at(10) }]
  expect(partitionQueueByGrace(rows, { online: false, nowMs: NOW }).shown).toHaveLength(1)
})

it('schedules the next look for the youngest row', () => {
  const rows = [
    { status: 'queued', updated_at: at(1000) },
    { status: 'queued', updated_at: at(5000) },
    { status: 'queued', updated_at: at(QUEUE_GRACE_MS + 10) }
  ]
  const r = partitionQueueByGrace(rows, { online: true, nowMs: NOW })
  expect(r.shown).toHaveLength(1)
  expect(r.nextCheckMs).toBe(QUEUE_GRACE_MS - 5000)
})

it('shows a row with an unreadable timestamp rather than hiding it', () => {
  const rows = [{ status: 'queued', updated_at: 'not a date' }, { status: 'queued' }]
  expect(partitionQueueByGrace(rows, { online: true, nowMs: NOW }).shown).toHaveLength(2)
})

it('does not hide a row whose timestamp is in the future', () => {
  const rows = [{ status: 'queued', updated_at: at(-60_000) }]
  const r = partitionQueueByGrace(rows, { online: true, nowMs: NOW })
  expect(r.shown).toEqual([])
  expect(r.nextCheckMs).toBe(QUEUE_GRACE_MS)
})

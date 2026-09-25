import {
  MAX_RECEIVE_HISTORY,
  RECEIVE_HISTORY_KEY,
  getIssuedDates,
  recordIssuedDate,
  setIssuedDates
} from '../../core/pay/receiveHistory'

function fakeStorage() {
  const map = new Map<string, string>()
  return {
    map,
    getKeyValue: async (k: string) => map.get(k),
    setKeyValue: async (k: string, v: string) => void map.set(k, v)
  }
}

describe('XR-055: receiveHistory', () => {
  it('returns [] for a fresh install', async () => {
    await expect(getIssuedDates(fakeStorage())).resolves.toEqual([])
  })

  it('treats corrupt storage as empty rather than throwing', async () => {
    const s = fakeStorage()
    s.map.set(RECEIVE_HISTORY_KEY, 'not json')
    await expect(getIssuedDates(s)).resolves.toEqual([])
  })

  it('records a date under the history key', async () => {
    const s = fakeStorage()
    await recordIssuedDate(s, '2026-08-01')
    expect(s.map.has(RECEIVE_HISTORY_KEY)).toBe(true)
    await expect(getIssuedDates(s)).resolves.toEqual(['2026-08-01'])
  })

  it('is idempotent — recording the same date twice does not duplicate it', async () => {
    const s = fakeStorage()
    await recordIssuedDate(s, '2026-08-01')
    await recordIssuedDate(s, '2026-08-01')
    await expect(getIssuedDates(s)).resolves.toEqual(['2026-08-01'])
  })

  it('does NOT age out an old date the way the watchlist does — count-capped, not calendar-capped', async () => {
    const s = fakeStorage()
    await recordIssuedDate(s, '2020-01-01') // far older than any calendar-age cap
    await expect(getIssuedDates(s)).resolves.toEqual(['2020-01-01'])
  })

  it('does not lose entries when two writes race', async () => {
    const s = fakeStorage()
    await Promise.all([recordIssuedDate(s, '2026-08-01'), recordIssuedDate(s, '2026-08-02')])
    await expect(getIssuedDates(s)).resolves.toEqual(['2026-08-01', '2026-08-02'])
  })

  it('caps at MAX_RECEIVE_HISTORY, keeping the most recent dates', async () => {
    const many = Array.from({ length: MAX_RECEIVE_HISTORY + 5 }, (_, i) => {
      const d = new Date(Date.UTC(2000, 0, 1 + i))
      return d.toISOString().slice(0, 10)
    })
    const s = fakeStorage()
    await setIssuedDates(s, many)
    const kept = await getIssuedDates(s)
    expect(kept).toHaveLength(MAX_RECEIVE_HISTORY)
    expect(kept[kept.length - 1]).toBe(many[many.length - 1])
    expect(kept).not.toContain(many[0])
  })

  it('setIssuedDates deduplicates and sorts', async () => {
    const s = fakeStorage()
    await setIssuedDates(s, ['2026-08-02', '2026-08-01', '2026-08-02'])
    await expect(getIssuedDates(s)).resolves.toEqual(['2026-08-01', '2026-08-02'])
  })
})

import {
  configureWocLimiter,
  resetWocLimiter,
  WOC_ANON_INTERVAL_MS,
  WOC_RATE_LIMIT_PAUSE_MS,
  wocLimitedFetch,
  wocRateLimited,
  wocSlot
} from '../../core/net/wocLimiter'

const API = 'https://api.whatsonchain.com/v1/bsv/main'

/** A fake clock: sleep moves time forward and records each wait. */
function fakeClock() {
  let t = 1_000_000
  const sleeps: number[] = []
  configureWocLimiter({
    now: () => t,
    sleep: async ms => {
      const start = t
      sleeps.push(ms)
      // Advance after the caller's synchronous reservation, like a real timer.
      await Promise.resolve()
      t = Math.max(t, start + ms)
    }
  })
  return { sleeps, advance: (ms: number) => (t += ms), now: () => t }
}

const res = (status: number) => ({ status, ok: status >= 200 && status < 300 }) as Response

afterEach(() => resetWocLimiter())

describe('wocSlot', () => {
  it('lets the first request go at once and spaces the next ones', async () => {
    const clock = fakeClock()
    await wocSlot(`${API}/a`)
    await wocSlot(`${API}/b`)
    await wocSlot(`${API}/c`)
    expect(clock.sleeps).toEqual([WOC_ANON_INTERVAL_MS, WOC_ANON_INTERVAL_MS])
  })

  it('stays under 3 requests per second for a burst of concurrent callers', async () => {
    const clock = fakeClock()
    await Promise.all(Array.from({ length: 10 }, (_, i) => wocSlot(`${API}/tx/${i}`)))
    // All ten reserve at the same instant, so each wait is its offset from the first request.
    const reserved = [0, ...clock.sleeps]
    expect(reserved).toEqual(Array.from({ length: 10 }, (_, i) => i * WOC_ANON_INTERVAL_MS))
    for (let i = 3; i < reserved.length; i++) expect(reserved[i] - reserved[i - 3]).toBeGreaterThanOrEqual(1000)
  })

  it('gives each API origin a lane of its own', async () => {
    const clock = fakeClock()
    await wocSlot(`${API}/a`)
    await wocSlot('https://api.woc-ttn.bsvblockchain.tech/v1/bsv/teratest/a')
    expect(clock.sleeps).toEqual([])
  })

  it('gives requests with a key a lane of their own, with the same spacing by default', async () => {
    const clock = fakeClock()
    await wocSlot(`${API}/a`, true)
    await wocSlot(`${API}/b`)
    await wocSlot(`${API}/c`, true)
    expect(clock.sleeps).toEqual([WOC_ANON_INTERVAL_MS])
  })

  it('lets a host with a paid key lower the keyed spacing', async () => {
    const clock = fakeClock()
    configureWocLimiter({ keyedIntervalMs: 0 })
    await wocSlot(`${API}/a`, true)
    await wocSlot(`${API}/b`, true)
    expect(clock.sleeps).toEqual([])
  })

  it('does not hold a request after the lane is idle', async () => {
    const clock = fakeClock()
    await wocSlot(`${API}/a`)
    clock.advance(WOC_ANON_INTERVAL_MS + 1)
    await wocSlot(`${API}/b`)
    expect(clock.sleeps).toEqual([])
  })

  it('pauses the lane after a 429', async () => {
    const clock = fakeClock()
    await wocSlot(`${API}/a`)
    wocRateLimited(`${API}/a`)
    await wocSlot(`${API}/b`)
    expect(clock.sleeps).toEqual([WOC_RATE_LIMIT_PAUSE_MS])
  })
})

describe('wocLimitedFetch', () => {
  it('sends a GET once more after a 429 and returns the second answer', async () => {
    const clock = fakeClock()
    const fetchImpl = jest.fn().mockResolvedValueOnce(res(429)).mockResolvedValueOnce(res(200))
    const response = await wocLimitedFetch(`${API}/tx/1/beef`, undefined, fetchImpl)
    expect(response.status).toBe(200)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(clock.sleeps).toEqual([WOC_RATE_LIMIT_PAUSE_MS])
  })

  it('returns a 429 that lasts after one retry', async () => {
    fakeClock()
    const fetchImpl = jest.fn().mockResolvedValue(res(429))
    const response = await wocLimitedFetch(`${API}/tx/1/beef`, undefined, fetchImpl)
    expect(response.status).toBe(429)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('does not send a POST again after a 429', async () => {
    fakeClock()
    const fetchImpl = jest.fn().mockResolvedValue(res(429))
    const response = await wocLimitedFetch(`${API}/utxos/spent`, { method: 'POST', body: '{}' }, fetchImpl)
    expect(response.status).toBe(429)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('puts a request with a woc-api-key header in the keyed lane', async () => {
    const clock = fakeClock()
    const fetchImpl = jest.fn().mockResolvedValue(res(200))
    await wocLimitedFetch(`${API}/a`, { headers: { 'woc-api-key': 'k' } }, fetchImpl)
    await wocLimitedFetch(`${API}/b`, { headers: new Headers({ 'woc-api-key': 'k' }) }, fetchImpl)
    await wocLimitedFetch(`${API}/c`, { headers: [['woc-api-key', 'k']] }, fetchImpl)
    await wocLimitedFetch(`${API}/d`, undefined, fetchImpl)
    // Three keyed requests spaced on their lane; the keyless one goes at once on its own.
    expect(clock.sleeps).toEqual([WOC_ANON_INTERVAL_MS, WOC_ANON_INTERVAL_MS])
    expect(fetchImpl).toHaveBeenCalledWith(`${API}/a`, { headers: { 'woc-api-key': 'k' } })
  })

  it('uses the global fetch when none is given', async () => {
    fakeClock()
    const spy = jest.spyOn(globalThis, 'fetch' as never).mockResolvedValue(res(200) as never)
    try {
      await wocLimitedFetch(`${API}/a`)
      expect(spy).toHaveBeenCalledWith(`${API}/a`)
    } finally {
      spy.mockRestore()
    }
  })
})

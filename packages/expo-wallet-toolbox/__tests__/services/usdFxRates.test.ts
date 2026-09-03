import { FIAT_CURRENCIES, FRANKFURTER_RATES_URL } from '../../core/displayCurrencies'
import {
  FX_CACHE_KEY,
  FX_FETCH_TIMEOUT_MS,
  FX_TTL_MS,
  loadUsdFxRates,
  parseFrankfurterResponse,
  resolveUsdFxRates
} from '../../core/services/usdFxRates'

const HOUR = 60 * 60 * 1000

describe('parseFrankfurterResponse', () => {
  it('maps v2 quote rows to a USD→fiat rate table', () => {
    const parsed = parseFrankfurterResponse([
      { date: '2026-09-03', base: 'USD', quote: 'EUR', rate: 0.85 },
      { date: '2026-09-03', base: 'USD', quote: 'JPY', rate: 150 }
    ])
    expect(parsed).toEqual({ EUR: 0.85, JPY: 150 })
  })

  it('drops non-positive or non-finite rates and returns null when nothing valid remains', () => {
    expect(parseFrankfurterResponse([{ quote: 'EUR', rate: -1 }])).toBeNull()
    expect(parseFrankfurterResponse({ rates: { EUR: 0.85 } })).toBeNull()
    expect(parseFrankfurterResponse([])).toBeNull()
  })

  it('keeps valid rows when mixed with junk', () => {
    const parsed = parseFrankfurterResponse([
      { quote: 'EUR', rate: 0.85 },
      { quote: 'NOPE', rate: 'n/a' },
      { quote: 'JPY', rate: 0 }
    ])
    expect(parsed).toEqual({ EUR: 0.85 })
  })
})

describe('resolveUsdFxRates', () => {
  const now = Date.parse('2026-09-03T12:00:00.000Z')

  it('uses the baked-in snapshot and asks to fetch when there is no cache', () => {
    const { rates, shouldFetch } = resolveUsdFxRates(null, now)
    expect(rates.USD).toBe(1)
    for (const code of FIAT_CURRENCIES) {
      expect(rates[code]).toBeGreaterThan(0)
    }
    expect(shouldFetch).toBe(true)
  })

  it('returns the cached table and skips fetch when the cache is younger than 24h', () => {
    const { rates, shouldFetch } = resolveUsdFxRates(
      { rates: { EUR: 0.9 }, timestamp: new Date(now - HOUR).toISOString() },
      now
    )
    expect(rates.EUR).toBe(0.9)
    expect(rates.USD).toBe(1)
    expect(shouldFetch).toBe(false)
  })

  it('returns the cached table but asks to fetch when the cache is older than 24h', () => {
    const { shouldFetch, rates } = resolveUsdFxRates(
      { rates: { EUR: 0.9 }, timestamp: new Date(now - FX_TTL_MS - 1).toISOString() },
      now
    )
    expect(rates.EUR).toBe(0.9)
    expect(shouldFetch).toBe(true)
  })
})

describe('loadUsdFxRates', () => {
  const now = Date.parse('2026-09-03T12:00:00.000Z')

  it('does not hit the network when a fresh cache is already stored', async () => {
    const fetchImpl = jest.fn()
    const storage = {
      getItem: jest.fn(async () =>
        JSON.stringify({ rates: { EUR: 0.91 }, timestamp: new Date(now - HOUR).toISOString() })
      ),
      setItem: jest.fn(async () => {})
    }
    const rates = await loadUsdFxRates({ storage, fetchImpl, now })
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(storage.setItem).not.toHaveBeenCalled()
    expect(rates.EUR).toBe(0.91)
  })

  it('fetches, persists, and returns Frankfurter rates when the cache is missing', async () => {
    const fetchImpl = jest.fn(async () => ({
      ok: true,
      json: async () => [{ date: '2026-09-03', base: 'USD', quote: 'EUR', rate: 0.88 }]
    })) as unknown as typeof fetch
    const stored: Record<string, string> = {}
    const storage = {
      getItem: jest.fn(async (key: string) => stored[key] ?? null),
      setItem: jest.fn(async (key: string, value: string) => {
        stored[key] = value
      })
    }
    const rates = await loadUsdFxRates({ storage, fetchImpl, now })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(fetchImpl).toHaveBeenCalledWith(FRANKFURTER_RATES_URL, expect.objectContaining({ signal: expect.any(AbortSignal) }))
    expect(storage.setItem).toHaveBeenCalledWith(FX_CACHE_KEY, expect.any(String))
    expect(rates.EUR).toBe(0.88)
    const persisted = JSON.parse(stored[FX_CACHE_KEY])
    expect(persisted.rates.EUR).toBe(0.88)
    expect(typeof persisted.timestamp).toBe('string')
  })

  it('keeps the previous table when Frankfurter is unreachable', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const fetchImpl = jest.fn(async () => {
        throw new Error('network down')
      })
      const storage = {
        getItem: jest.fn(async () =>
          JSON.stringify({
            rates: { EUR: 0.77 },
            timestamp: new Date(now - FX_TTL_MS - HOUR).toISOString()
          })
        ),
        setItem: jest.fn(async () => {})
      }
      const rates = await loadUsdFxRates({ storage, fetchImpl, now })
      expect(rates.EUR).toBe(0.77)
      expect(storage.setItem).not.toHaveBeenCalled()
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('aborts a hung Frankfurter fetch and keeps the snapshot', async () => {
    jest.useFakeTimers()
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const fetchImpl = jest.fn((_url: string, init?: RequestInit) => {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const err = new Error('aborted')
            err.name = 'AbortError'
            reject(err)
          })
        })
      }) as unknown as typeof fetch
      const storage = {
        getItem: jest.fn(async () => null),
        setItem: jest.fn(async () => {})
      }
      const pending = loadUsdFxRates({ storage, fetchImpl, now })
      await jest.advanceTimersByTimeAsync(FX_FETCH_TIMEOUT_MS)
      const rates = await pending
      expect(rates.EUR).toBeGreaterThan(0)
      expect(storage.setItem).not.toHaveBeenCalled()
    } finally {
      errorSpy.mockRestore()
      jest.useRealTimers()
    }
  })
})

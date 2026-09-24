import AsyncStorage from '@react-native-async-storage/async-storage'
import { CACHE_KEY, FALLBACK_RATE, getExchangeRate } from '../../core/services/exchangeRate'

describe('getExchangeRate', () => {
  const originalFetch = global.fetch
  let errorSpy: jest.SpyInstance

  beforeEach(async () => {
    await AsyncStorage.clear()
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
    // Rejects immediately: getExchangeRate must resolve without ever awaiting
    // this — the background refresh is fire-and-forget.
    global.fetch = jest.fn(async () => {
      throw new Error('network down')
    }) as unknown as typeof fetch
  })

  afterEach(() => {
    global.fetch = originalFetch
    errorSpy.mockRestore()
  })

  it('falls back to FALLBACK_RATE when there is no cache', async () => {
    const result = await getExchangeRate()
    expect(result.rate).toBe(FALLBACK_RATE)
    expect(result.base).toBe('USD')
  })

  it('uses a cached rate over the fallback', async () => {
    await AsyncStorage.setItem(CACHE_KEY, JSON.stringify({ usdPerBsv: 42, timestamp: new Date().toISOString() }))
    const result = await getExchangeRate()
    expect(result.rate).toBe(42)
  })

  it('falls back when the cached value is not a positive number', async () => {
    await AsyncStorage.setItem(CACHE_KEY, JSON.stringify({ usdPerBsv: -5, timestamp: new Date().toISOString() }))
    const result = await getExchangeRate()
    expect(result.rate).toBe(FALLBACK_RATE)
  })

  it('never awaits the network refresh (resolves before the fetch settles)', async () => {
    await expect(getExchangeRate()).resolves.toEqual(expect.objectContaining({ rate: FALLBACK_RATE }))
  })
})

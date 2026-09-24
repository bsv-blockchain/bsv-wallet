import AsyncStorage from '@react-native-async-storage/async-storage'
import type { BsvExchangeRate } from '../toolboxTypes'

// Shared with context/ExchangeRateContext.tsx so a single cache serves both the
// fiat-display UI and the wallet-build seed. Same key + same { usdPerBsv } shape.
// Exported (misc-p2-05) so ExchangeRateContext no longer keeps its own,
// disagreeing copies of the cache key and the fallback rate.
export const CACHE_KEY = 'cached_exchange_rate'
export const FALLBACK_RATE = 16.75
const REFRESH_TIMEOUT_MS = 4000

/**
 * `getExchangeRate()`'s own return, plus a handle on the SAME background
 * refresh it kicks off — so a caller that wants the live rate once it lands
 * (ExchangeRateContext) does not need a second fetch/timeout of its own.
 * `refreshed` never rejects: every failure mode inside the refresh (network,
 * abort, a malformed body) is caught and reported as `undefined`, exactly as
 * `refreshExchangeRateCache` always resolved before this — a caller that
 * ignores `refreshed` entirely (the wallet-build seed) sees no change at all.
 */
export interface ExchangeRateSeed extends BsvExchangeRate {
  refreshed: Promise<number | undefined>
}

/**
 * Timeout-guarded refresh of the cached BSV/USD rate. NEVER hangs the JS
 * thread or the wallet build: `getExchangeRate` does not await this before
 * returning, only the promise it hands back for whoever wants to know when
 * it lands. The live rate, once fetched, is persisted to AsyncStorage for the
 * next cold start regardless of whether anyone is listening this session.
 */
function refreshExchangeRateCache(): Promise<number | undefined> {
  return (async () => {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), REFRESH_TIMEOUT_MS)
    try {
      const res = await fetch('https://api.whatsonchain.com/v1/bsv/main/exchangerate', {
        signal: controller.signal
      })
      const data = await res.json()
      const usdPerBsv = Number(data?.rate)
      if (Number.isFinite(usdPerBsv) && usdPerBsv > 0) {
        await AsyncStorage.setItem(CACHE_KEY, JSON.stringify({ usdPerBsv, timestamp: new Date().toISOString() }))
        return usdPerBsv
      }
      return undefined
    } catch (error) {
      console.error('Error refreshing exchange rate:', error)
      return undefined
    } finally {
      clearTimeout(timeout)
    }
  })()
}

/**
 * Return a BSV/USD seed rate for the wallet build WITHOUT blocking on the network.
 *
 * Previously this awaited an un-timed `fetch()` on the wallet-build critical path.
 * With the web3 wallet gate holding the UI until the build resolves, a stalled
 * cold-start network (≈60s NSURLSession timeout) could exceed the iOS launch
 * watchdog and get the whole app killed. The rate only seeds the Services rate
 * cache (refreshed periodically) and feeds fiat display — it is never read by the
 * CWI provider before page JS — so a cached/hardcoded seed is fully correct.
 *
 * Reads the shared cache (one fast AsyncStorage get), falls back to a hardcoded
 * value, and kicks off a background refresh for next time. Never hangs: the
 * refresh itself is only awaited by a caller that chooses to await `refreshed`.
 */
export async function getExchangeRate(): Promise<ExchangeRateSeed> {
  let rate = FALLBACK_RATE
  try {
    const cached = await AsyncStorage.getItem(CACHE_KEY)
    if (cached) {
      const { usdPerBsv } = JSON.parse(cached)
      if (typeof usdPerBsv === 'number' && usdPerBsv > 0) rate = usdPerBsv
    }
  } catch (error) {
    console.error('Error reading cached exchange rate:', error)
  }
  // One fetch, kicked off here and never awaited by this function — the
  // build seed above is already resolved. `refreshed` is the SAME promise,
  // just handed to the caller instead of dropped.
  const refreshed = refreshExchangeRateCache()
  return { timestamp: new Date(), rate, base: 'USD', refreshed }
}

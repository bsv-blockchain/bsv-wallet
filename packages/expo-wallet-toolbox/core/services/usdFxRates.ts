import AsyncStorage from '@react-native-async-storage/async-storage'
import { FALLBACK_USD_FX, FRANKFURTER_RATES_URL } from '../displayCurrencies'

export const FX_CACHE_KEY = 'cached_usd_fx_rates'
export const FX_TTL_MS = 24 * 60 * 60 * 1000
export const FX_FETCH_TIMEOUT_MS = 4000

export type UsdFxCache = { rates: Record<string, number>; timestamp: string }

export type FxStorage = {
  getItem(key: string): Promise<string | null>
  setItem(key: string, value: string): Promise<void>
}

const snapshotRates = (): Record<string, number> => ({ USD: 1, ...FALLBACK_USD_FX })

export function parseFrankfurterResponse(json: unknown): Record<string, number> | null {
  if (!Array.isArray(json)) return null
  const rates: Record<string, number> = {}
  for (const row of json) {
    if (!row || typeof row !== 'object') continue
    const quote = (row as { quote?: unknown }).quote
    const rate = Number((row as { rate?: unknown }).rate)
    if (typeof quote !== 'string' || quote.length === 0) continue
    if (!Number.isFinite(rate) || rate <= 0) continue
    rates[quote] = rate
  }
  return Object.keys(rates).length > 0 ? rates : null
}

export function fxCacheIsFresh(timestamp: string, now: number): boolean {
  const t = Date.parse(timestamp)
  if (!Number.isFinite(t)) return false
  return now - t < FX_TTL_MS
}

export function resolveUsdFxRates(
  cached: UsdFxCache | null,
  now: number
): { rates: Record<string, number>; shouldFetch: boolean } {
  const fallback = snapshotRates()
  if (!cached?.rates) return { rates: fallback, shouldFetch: true }
  const rates = { ...fallback, ...cached.rates, USD: 1 }
  const shouldFetch = !cached.timestamp || !fxCacheIsFresh(cached.timestamp, now)
  return { rates, shouldFetch }
}

function readCache(raw: string | null): UsdFxCache | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as { rates?: unknown; timestamp?: unknown }
    if (!parsed || typeof parsed !== 'object' || !parsed.rates || typeof parsed.rates !== 'object') {
      return null
    }
    const rates: Record<string, number> = {}
    for (const [code, value] of Object.entries(parsed.rates as Record<string, unknown>)) {
      const n = Number(value)
      if (Number.isFinite(n) && n > 0) rates[code] = n
    }
    if (Object.keys(rates).length === 0) return null
    return { rates, timestamp: typeof parsed.timestamp === 'string' ? parsed.timestamp : '' }
  } catch {
    return null
  }
}

export async function loadUsdFxRates(
  deps: {
    storage?: FxStorage
    fetchImpl?: typeof fetch
    now?: number
  } = {}
): Promise<Record<string, number>> {
  const storage = deps.storage ?? AsyncStorage
  const fetchImpl = deps.fetchImpl ?? fetch
  const now = deps.now ?? Date.now()

  const cached = readCache(await storage.getItem(FX_CACHE_KEY))
  const { rates, shouldFetch } = resolveUsdFxRates(cached, now)
  if (!shouldFetch) return rates

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), FX_FETCH_TIMEOUT_MS)
  try {
    const res = await fetchImpl(FRANKFURTER_RATES_URL, { signal: controller.signal })
    if (!res.ok) return rates
    const parsed = parseFrankfurterResponse(await res.json())
    if (!parsed) return rates
    const next = { ...rates, ...parsed, USD: 1 }
    await storage.setItem(
      FX_CACHE_KEY,
      JSON.stringify({ rates: parsed, timestamp: new Date(now).toISOString() })
    )
    return next
  } catch (error) {
    console.error('Error fetching USD FX rates from Frankfurter:', error)
    return rates
  } finally {
    clearTimeout(timeout)
  }
}

import { ReactNode, createContext, useEffect, useState } from 'react'
import { fallbackUsdToFiat } from '../displayCurrencies'
import { loadUsdFxRates } from '../services/usdFxRates'
import { FALLBACK_RATE, getExchangeRate } from '../services/exchangeRate'

const SATS_PER_BSV = 100_000_000

interface ExchangeRateState {
  satoshisPerUSD: number
  usdToFiat: Record<string, number>
}

// Was its own hardcoded 16, disagreeing with exchangeRate.ts's 16.75 fallback
// (misc-p2-05) — both now read the ONE fallback constant, so the fiat-display
// UI and the wallet-build seed can never quote a different "no data yet" rate.
const defaultState: ExchangeRateState = {
  satoshisPerUSD: SATS_PER_BSV / FALLBACK_RATE,
  usdToFiat: fallbackUsdToFiat()
}

// Create the exchange rate context and provider to use in the amount component
export const ExchangeRateContext = createContext<ExchangeRateState>(defaultState)

export const ExchangeRateContextProvider: React.FC<{
  children: ReactNode
}> = ({ children }) => {
  const [state, setState] = useState<ExchangeRateState>(defaultState)

  useEffect(() => {
    const init = async () => {
      // exchangeRate.ts owns the single timeout-guarded fetch, the single
      // fallback constant, and the shared AsyncStorage cache key — this used
      // to be a second, independent fetch/cache/fallback implementation that
      // could (and did) disagree with it. getExchangeRate() reads the cache
      // (or falls back) and kicks off its own background refresh for next
      // time; it never hangs, so no separate timeout is needed here.
      try {
        const { rate } = await getExchangeRate()
        if (typeof rate === 'number' && rate > 0) {
          setState(prev => ({ ...prev, satoshisPerUSD: SATS_PER_BSV / rate }))
        }
      } catch (error) {
        console.error('Error loading exchange rate:', error)
      }

      try {
        const usdToFiat = await loadUsdFxRates()
        setState(prev => ({ ...prev, usdToFiat }))
      } catch (error) {
        console.error('Error loading USD FX rates:', error)
      }
    }

    init()
  }, [])

  return <ExchangeRateContext.Provider value={state}>{children}</ExchangeRateContext.Provider>
}

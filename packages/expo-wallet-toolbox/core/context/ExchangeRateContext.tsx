import { ReactNode, createContext, useEffect, useState } from 'react'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { fallbackUsdToFiat } from '../displayCurrencies'
import { loadUsdFxRates } from '../services/usdFxRates'

const CACHE_KEY = 'cached_exchange_rate'
const HARDCODED_USD_PER_BSV = 16
const SATS_PER_BSV = 100_000_000

interface ExchangeRateState {
  satoshisPerUSD: number
  usdToFiat: Record<string, number>
}

const defaultState: ExchangeRateState = {
  satoshisPerUSD: SATS_PER_BSV / HARDCODED_USD_PER_BSV,
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
      // Tier 2: Try loading cached rate from AsyncStorage
      try {
        const cached = await AsyncStorage.getItem(CACHE_KEY)
        if (cached) {
          const { usdPerBsv } = JSON.parse(cached)
          if (typeof usdPerBsv === 'number' && usdPerBsv > 0) {
            setState(prev => ({ ...prev, satoshisPerUSD: SATS_PER_BSV / usdPerBsv }))
          }
        }
      } catch (error) {
        console.error('Error loading cached exchange rate:', error)
      }

      const fxPromise = loadUsdFxRates()
        .then(usdToFiat => setState(prev => ({ ...prev, usdToFiat })))
        .catch(error => console.error('Error loading USD FX rates:', error))

      // Tier 1: Attempt live fetch from WhatsonChain
      try {
        const response = await fetch('https://api.whatsonchain.com/v1/bsv/main/exchangerate')
        const data = await response.json()
        const usdPerBsv = data?.rate
        if (typeof usdPerBsv === 'number' && usdPerBsv > 0) {
          setState(prev => ({ ...prev, satoshisPerUSD: SATS_PER_BSV / usdPerBsv }))
          // Cache the successful result
          await AsyncStorage.setItem(CACHE_KEY, JSON.stringify({ usdPerBsv, timestamp: new Date().toISOString() }))
        }
      } catch (error) {
        console.error('Error fetching exchange rate from WhatsonChain:', error)
        // Tier 2/3 already loaded above -- state remains as cached or hardcoded default
      }

      await fxPromise
    }

    init()
  }, [])

  return <ExchangeRateContext.Provider value={state}>{children}</ExchangeRateContext.Provider>
}

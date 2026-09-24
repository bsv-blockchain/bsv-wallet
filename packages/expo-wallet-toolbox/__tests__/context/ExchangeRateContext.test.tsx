import React, { useContext } from 'react'
import { create, act } from 'react-test-renderer'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { ExchangeRateContext, ExchangeRateContextProvider } from '../../core/context/ExchangeRateContext'
import { FALLBACK_RATE } from '../../core/services/exchangeRate'

const SATS_PER_BSV = 100_000_000

function Reader({ onRender }: { onRender: (satoshisPerUSD: number) => void }) {
  const state = useContext(ExchangeRateContext)
  onRender(state.satoshisPerUSD)
  return null
}

describe('ExchangeRateContextProvider', () => {
  const originalFetch = global.fetch
  let errorSpy: jest.SpyInstance

  beforeEach(async () => {
    await AsyncStorage.clear()
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
    global.fetch = jest.fn(async () => {
      throw new Error('network down')
    }) as unknown as typeof fetch
  })

  afterEach(() => {
    global.fetch = originalFetch
    errorSpy.mockRestore()
  })

  it('agrees with exchangeRate.ts on the fallback rate (misc-p2-05)', async () => {
    let latest = 0
    await act(async () => {
      create(
        <ExchangeRateContextProvider>
          <Reader onRender={v => (latest = v)} />
        </ExchangeRateContextProvider>
      )
      await Promise.resolve()
    })
    expect(latest).toBe(SATS_PER_BSV / FALLBACK_RATE)
  })

  it('picks up a cached exchange rate written under the shared cache key', async () => {
    await AsyncStorage.setItem(
      'cached_exchange_rate',
      JSON.stringify({ usdPerBsv: 20, timestamp: new Date().toISOString() })
    )
    let latest = 0
    await act(async () => {
      create(
        <ExchangeRateContextProvider>
          <Reader onRender={v => (latest = v)} />
        </ExchangeRateContextProvider>
      )
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(latest).toBe(SATS_PER_BSV / 20)
  })
})

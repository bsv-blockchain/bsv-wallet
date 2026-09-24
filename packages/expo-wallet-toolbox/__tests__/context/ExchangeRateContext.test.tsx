import React, { useContext } from 'react'
import { create, act } from 'react-test-renderer'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { ExchangeRateContext, ExchangeRateContextProvider } from '../../core/context/ExchangeRateContext'
import { CACHE_KEY, FALLBACK_RATE } from '../../core/services/exchangeRate'

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

  // exchangeRate.ts's background refresh used to be pure fire-and-forget: its
  // result only ever reached the UI on the NEXT cold start, so a session that
  // opened while stale showed a one-session-stale fiat rate throughout. The
  // context now learns when that same timeout-guarded refresh resolves and
  // updates its state a second time — still one fetch, still one fallback.
  it('cold start: shows the cached rate immediately, then the live rate once the background refresh resolves', async () => {
    await AsyncStorage.setItem(CACHE_KEY, JSON.stringify({ usdPerBsv: 20, timestamp: new Date().toISOString() }))
    let resolveFetch: (value: unknown) => void = () => {}
    global.fetch = jest.fn(
      () =>
        new Promise(resolve => {
          resolveFetch = resolve
        })
    ) as unknown as typeof fetch

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
    // The cache is read on a fast local AsyncStorage get, well before any
    // network response — this must be showing already.
    expect(latest).toBe(SATS_PER_BSV / 20)

    await act(async () => {
      resolveFetch({ json: async () => ({ rate: 30 }) })
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(latest).toBe(SATS_PER_BSV / 30)
  })

  it('a background refresh that fails leaves the cached rate in place', async () => {
    await AsyncStorage.setItem(CACHE_KEY, JSON.stringify({ usdPerBsv: 20, timestamp: new Date().toISOString() }))
    global.fetch = jest.fn(async () => {
      throw new Error('network down')
    }) as unknown as typeof fetch

    let latest = 0
    await act(async () => {
      create(
        <ExchangeRateContextProvider>
          <Reader onRender={v => (latest = v)} />
        </ExchangeRateContextProvider>
      )
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(latest).toBe(SATS_PER_BSV / 20)
  })
})

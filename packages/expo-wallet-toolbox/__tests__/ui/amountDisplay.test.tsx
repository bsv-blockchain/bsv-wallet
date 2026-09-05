jest.mock('@bsv/expo-wallet-toolbox', () => {
  const React = require('react')
  const walletContext = React.createContext({ settings: { currency: 'BSV' } })
  return {
    ...require('../../core/amountFormatHelpers'),
    WalletContext: walletContext,
    useWallet: () => React.useContext(walletContext),
    ExchangeRateContext: React.createContext({ satoshisPerUSD: 5_000_000, usdToFiat: { EUR: 0.9 } })
  }
})

import React, { Profiler } from 'react'
import { Text } from 'react-native'
import { render } from '@testing-library/react-native'
import { ExchangeRateContext, WalletContext, formatAmount } from '@bsv/expo-wallet-toolbox'
import AmountDisplay from '../../ui/components/wallet/AmountDisplay'

it('formats amount, currency and exchange-rate changes in one commit each', () => {
  const onRender = jest.fn()
  const draw = (amount: number, currency = 'BSV', satoshisPerUSD = 5_000_000) => (
    <WalletContext.Provider value={{ settings: { currency } } as any}>
      <ExchangeRateContext.Provider value={{ satoshisPerUSD, usdToFiat: { EUR: 0.9 } }}>
        <Profiler id="amount" onRender={onRender}>
          <Text testID="amount"><AmountDisplay abbreviate showPlus>{amount}</AmountDisplay></Text>
        </Profiler>
      </ExchangeRateContext.Provider>
    </WalletContext.Provider>
  )
  const screen = render(draw(1200))
  const expected = (amount: number, currency: string, rate: number) =>
    formatAmount(amount, currency, rate, { abbreviate: true, showPlus: true, usdToFiat: { EUR: 0.9 } })
  expect(screen.getByText(expected(1200, 'BSV', 5_000_000))).toBeTruthy()
  expect(onRender).toHaveBeenCalledTimes(1)

  for (const [amount, currency, rate] of [
    [2000, 'BSV', 5_000_000],
    [2000, 'USD', 5_000_000],
    [2000, 'EUR', 2_500_000]
  ] as const) {
    onRender.mockClear()
    screen.rerender(draw(amount, currency, rate))
    expect(screen.getByText(expected(amount, currency, rate))).toBeTruthy()
    expect(onRender).toHaveBeenCalledTimes(1)
  }
})

it('keeps the placeholder for invalid amounts and respects formatting options', () => {
  const screen = render(<Text><AmountDisplay>{1.5}</AmountDisplay></Text>)
  expect(screen.getByText('...')).toBeTruthy()
  screen.rerender(<Text><AmountDisplay>{100_000_000}</AmountDisplay></Text>)
  expect(screen.getByText(formatAmount(100_000_000, 'BSV', 5_000_000))).toBeTruthy()
  screen.rerender(<Text><AmountDisplay abbreviate>{100_000_000}</AmountDisplay></Text>)
  expect(screen.getByText(formatAmount(100_000_000, 'BSV', 5_000_000, { abbreviate: true }))).toBeTruthy()
})

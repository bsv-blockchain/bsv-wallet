import React from 'react'
import { render, waitFor } from '@testing-library/react-native'

let mockCurrency = 'USD'
const mockGetHeight = jest.fn(async (_txid: string): Promise<number | null> => null)
// Stable, like the real hook, so the lookup effect runs once per screen.
const mockManagers = { storage: { getProvenTxHeight: (txid: string) => mockGetHeight(txid) } }

jest.mock('@bsv/expo-wallet-toolbox', () => {
  const React = require('react')
  const helpers = jest.requireActual('../../core/amountFormatHelpers')
  return {
    ...jest.requireActual('../../core/theme/tokens'),
    useTheme: () => ({ colors: {} }),
    useWallet: () => ({ settings: { currency: mockCurrency }, walletUserId: null }),
    useWalletManagers: () => mockManagers,
    ExchangeRateContext: React.createContext({ satoshisPerUSD: 100_000, usdToFiat: {} }),
    formatAmount: helpers.formatAmount,
    formatSatoshisExact: helpers.formatSatoshisExact,
    isFiatCurrency: helpers.isFiatCurrency
  }
})
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }))
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, o?: { defaultValue?: string }) => o?.defaultValue ?? key })
}))
jest.mock('../../ui/components/ui/CustomSafeArea', () => {
  const { View } = require('react-native')
  return ({ children }: { children: React.ReactNode }) => <View>{children}</View>
})
jest.mock('../../ui/components/wallet/ContactSigil', () => () => null)
jest.mock('../../ui/components/ui/Toast', () => ({ showToast: jest.fn() }))
jest.mock('../../ui/hooks/useContactsStore', () => ({ useContactsStore: () => null }))

import TransactionDetailScreen from '../../ui/screens/TransactionDetailScreen'

const tx = {
  txid: 'a'.repeat(64),
  satoshis: 250_000_000, // 2.5 BSV, $2,500 at 100,000 sats/USD
  status: 'completed',
  isOutgoing: false,
  createdAt: '2026-09-22T10:00:00Z'
}

describe('TransactionDetailScreen amount', () => {
  it('shows exact sats and the fiat equivalent when the display currency is fiat', () => {
    mockCurrency = 'USD'
    const screen = render(<TransactionDetailScreen tx={tx} onBack={jest.fn()} />)
    expect(screen.getAllByText('+250,000,000 sats').length).toBeGreaterThan(0)
    expect(screen.getByText('+$2,500.00')).toBeTruthy()
  })

  it('shows exact sats and no fiat when the display currency is BSV', () => {
    mockCurrency = 'BSV'
    const screen = render(<TransactionDetailScreen tx={tx} onBack={jest.fn()} />)
    expect(screen.getAllByText('+250,000,000 sats').length).toBeGreaterThan(0)
    expect(screen.queryByText(/\$/)).toBeNull()
    expect(screen.queryByText(/BSV/)).toBeNull()
  })

  it('shows the block height once the transaction is in a block', async () => {
    mockGetHeight.mockResolvedValueOnce(915_123)
    const screen = render(<TransactionDetailScreen tx={tx} onBack={jest.fn()} />)
    await waitFor(() => expect(screen.getByText('915123')).toBeTruthy())
    expect(mockGetHeight).toHaveBeenCalledWith(tx.txid)
  })

  it('says it is waiting for a block while unproven', async () => {
    mockGetHeight.mockResolvedValueOnce(null)
    const screen = render(<TransactionDetailScreen tx={tx} onBack={jest.fn()} />)
    await waitFor(() => expect(screen.getByText('tx_detail_block_pending')).toBeTruthy())
  })
})

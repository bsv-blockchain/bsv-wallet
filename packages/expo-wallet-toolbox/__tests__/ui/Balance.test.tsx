/**
 * XR-058: the legacy `Balance` component (still publicly exported from
 * ui/index.ts) used to paint a cached balance figure straight out of
 * AsyncStorage on mount, unconditionally, before ever checking whether
 * `managers.permissionsManager` reflected an active wallet for the current
 * network — so a second wallet/user context on the same installation (or a
 * fresh, walletless mount) could momentarily show a prior context's cached
 * satoshi figure. The cache key was also a single unscoped global
 * (`cached_wallet_balance`), so nothing distinguished one network/identity's
 * figure from another's.
 */
import React from 'react'
import { act, render } from '@testing-library/react-native'
import AsyncStorage from '@react-native-async-storage/async-storage'

/**
 * `waitFor(() => expect(tree).not.toMatch(...))` is satisfied on its very
 * first (synchronous, pre-effect) poll whenever the assertion already holds
 * before any state update has run — which defeats the point of waiting for
 * the vulnerable async effect to actually paint its (wrong) value. This
 * flushes the microtask queue under `act` instead, so every pending state
 * update from the mount effect has actually applied before we read the tree.
 */
async function flush(): Promise<void> {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 50))
  })
}

let mockWallet: any

jest.mock('@bsv/expo-wallet-toolbox', () => ({
  useTheme: () => ({ colors: {} }),
  useWallet: () => mockWallet
}))
jest.mock('../../ui/components/wallet/AmountDisplay', () => {
  const { Text } = require('react-native')
  return { __esModule: true, default: ({ children }: any) => <Text>{String(children)}</Text> }
})
jest.mock('../../ui/components/ui/AppLogo', () => ({ __esModule: true, default: () => null }))

import Balance from '../../ui/components/wallet/Balance'

beforeEach(async () => {
  await AsyncStorage.clear()
  mockWallet = {
    managers: {},
    adminOriginator: 'admin',
    txStatusVersion: 0,
    selectedNetwork: 'main'
  }
})

describe('Balance (XR-058)', () => {
  it('never paints a cached figure — legacy unscoped or network-scoped — while no wallet context is active', async () => {
    // A prior wallet/session left both the legacy unscoped key and a
    // correctly-scoped key for this exact network behind.
    await AsyncStorage.setItem('cached_wallet_balance', '9999')
    await AsyncStorage.setItem('cached_wallet_balance_timestamp', String(Date.now()))
    await AsyncStorage.setItem('cached_wallet_balance_main', '8888')
    await AsyncStorage.setItem('cached_wallet_balance_main_timestamp', String(Date.now()))
    // No permissionsManager: a fresh/walletless mount, or a not-yet-built
    // wallet after a logout — the finding's exact scenario.
    mockWallet.managers = {}

    const screen = render(<Balance />)
    await flush()
    const tree = JSON.stringify(screen.toJSON())
    expect(tree).not.toMatch(/9999/)
    expect(tree).not.toMatch(/8888/)
  })

  it('shows the correctly-scoped cached figure once a wallet context for this network is active', async () => {
    await AsyncStorage.setItem('cached_wallet_balance_main', '4242')
    await AsyncStorage.setItem('cached_wallet_balance_main_timestamp', String(Date.now()))
    mockWallet.managers = { permissionsManager: { listOutputs: jest.fn(async () => ({ totalOutputs: 4242 })) } }

    const screen = render(<Balance />)
    await flush()
    const tree = JSON.stringify(screen.toJSON())
    expect(tree).toMatch(/4242/)
  })

  it("never bleeds a cached figure across a network switch (a different network's scoped key)", async () => {
    // Cached figure belongs to 'test', not the active 'main' network.
    await AsyncStorage.setItem('cached_wallet_balance_test', '7777')
    await AsyncStorage.setItem('cached_wallet_balance_test_timestamp', String(Date.now()))
    mockWallet.managers = {}
    mockWallet.selectedNetwork = 'main'

    const screen = render(<Balance />)
    await flush()
    const tree = JSON.stringify(screen.toJSON())
    expect(tree).not.toMatch(/7777/)
  })
})

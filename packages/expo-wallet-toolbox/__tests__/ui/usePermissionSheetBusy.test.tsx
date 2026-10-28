/**
 * `usePermissionSheetBusy` is the done screen's "no sheet open or queued" signal (spec 6.12): true while
 * any manager queue or a website connection request is waiting.
 */
jest.mock('@bsv/expo-wallet-toolbox', () => {
  const React = require('react')
  return {
    spacing: {},
    radii: {},
    typography: {},
    useTheme: () => ({ colors: {} }),
    WalletContext: React.createContext({}),
    UserContext: React.createContext({}),
    ExchangeRateContext: React.createContext({}),
    formatAmountParts: () => ({ value: '0', unit: '' }),
    haptics: {}
  }
})
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }))
jest.mock('../../ui/components/ui/Sheet', () => ({ __esModule: true, default: () => null }))
jest.mock('../../ui/components/ui/PressableScale', () => ({ __esModule: true, default: () => null }))
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }))
jest.mock('../../ui/components/wallet/AmountDisplay', () => ({ __esModule: true, default: () => null }))

import React from 'react'
import { act, create } from 'react-test-renderer'
import { WalletContext } from '@bsv/expo-wallet-toolbox'
import { usePermissionSheetBusy } from '../../ui/components/ui/PermissionSheet'
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

function busyWith(ctx: Record<string, unknown>): boolean {
  let out: boolean | undefined
  function Probe() {
    out = usePermissionSheetBusy()
    return null
  }
  act(() => {
    create(
      <WalletContext.Provider value={ctx as any}>
        <Probe />
      </WalletContext.Provider>
    )
  })
  return out!
}

describe('usePermissionSheetBusy', () => {
  it('is false with every queue empty', () => {
    expect(busyWith({ protocolRequests: [], spendingRequests: [], btmsRequests: [] })).toBe(false)
    expect(busyWith({})).toBe(false)
  })

  it.each([
    'protocolRequests',
    'basketRequests',
    'certificateRequests',
    'spendingRequests',
    'groupRequests',
    'btmsRequests',
    'mandalaRequests'
  ])('is true while %s holds a request', key => {
    expect(busyWith({ [key]: [{}] })).toBe(true)
  })
})

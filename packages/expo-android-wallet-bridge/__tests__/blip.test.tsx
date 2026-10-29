/**
 * The overlay root with the REAL PermissionSheet, over contexts relayed from a first root. Only the native modules
 * that do not exist under jest are replaced; the package self-import is the toolbox's stand-in (real contexts).
 */
jest.mock('expo-secure-store', () => require('../../expo-wallet-toolbox/__tests__/__mocks__/secureStoreFake').fake)
jest.mock(
  'expo-local-authentication',
  () => require('../../expo-wallet-toolbox/__tests__/__mocks__/localAuthFake').fake
)
jest.mock('@bsv/expo-wallet-toolbox', () =>
  require('../../expo-wallet-toolbox/__tests__/ui/bridgeSheet/mockToolboxPackage').toolboxPackageStandIn()
)
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }))
jest.mock('react-native-gesture-handler', () => ({
  ...jest.requireActual('react-native-gesture-handler'),
  GestureHandlerRootView: require('react-native').View
}))
jest.mock('react-native-safe-area-context', () => {
  const actual = jest.requireActual('react-native-safe-area-context')
  const React = require('react')
  return {
    ...actual,
    SafeAreaProvider: ({ children }: any) =>
      React.createElement(
        actual.SafeAreaProvider,
        {
          initialMetrics: {
            frame: { x: 0, y: 0, width: 360, height: 800 },
            insets: { top: 0, left: 0, right: 0, bottom: 0 }
          }
        },
        children
      )
  }
})

import React from 'react'
import { AppState } from 'react-native'
import { act, fireEvent, render } from '@testing-library/react-native'
import { setConsentSheetSource } from '@bsv/expo-wallet-toolbox/core/bridge/consentSheetSource'
import { lightColors } from '@bsv/expo-wallet-toolbox/core/theme/tokens'
import { RELAYED_CONTEXTS } from '@bsv/expo-wallet-toolbox/ui/bridgeSheet/relayedContexts'
import { ContextRelayPublisher, resetContextRelay } from '@bsv/expo-wallet-toolbox/ui/bridgeSheet/ContextRelay'
import { createAttention, OWNER_NONE_MS } from '../src/controller/attention'
import { createFakeNative, type FakeNative } from '../src/testing/fakeNative'
import { BridgeSheetRoot, setBridgeSheetNative } from '../src/ui/BridgeSheetRoot'
import { ownerFromNative, setSheetOwnerSource } from '../src/ui/sheetOwner'
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const wallet = {
  managers: { sentinel: true },
  settings: { currency: 'USD' },
  protocolRequests: [],
  basketRequests: [],
  certificateRequests: [],
  spendingRequests: [],
  groupRequests: [],
  btmsRequests: [],
  mandalaRequests: [],
  advanceProtocolQueue: jest.fn(),
  advanceBasketQueue: jest.fn(),
  advanceCertificateQueue: jest.fn(),
  advanceSpendingQueue: jest.fn(),
  advanceGroupQueue: jest.fn(),
  advanceBtmsQueue: jest.fn(),
  advanceMandalaQueue: jest.fn()
}
const providerValues: Record<string, any> = {
  ThemeContext: { mode: 'system', setThemeMode: () => {}, colors: lightColors, isDark: false },
  WalletContext: wallet,
  ExchangeRateContext: { satoshisPerUSD: 2000, usdToFiat: { USD: 1 } },
  UserContext: {
    protocolAccessModalOpen: false,
    basketAccessModalOpen: false,
    certificateAccessModalOpen: false,
    spendingAuthorizationModalOpen: false,
    setProtocolAccessModalOpen: () => {},
    setBasketAccessModalOpen: () => {},
    setCertificateAccessModalOpen: () => {},
    setSpendingAuthorizationModalOpen: () => {}
  }
}

function FirstRoot() {
  return RELAYED_CONTEXTS.reduceRight<React.ReactNode>(
    (inner, { name, context }) => <context.Provider value={providerValues[name]}>{inner}</context.Provider>,
    <ContextRelayPublisher />
  ) as React.ReactElement
}

const entry = {
  requestId: 'k1',
  origin: 'https://shop.example',
  attestation: 'browser' as const,
  transportId: 'loop',
  connectedBefore: false,
  walletRevision: 1,
  profileKey: '0'
}

function consent(initial: unknown[]) {
  const listeners = new Set<() => void>()
  let pending = initial
  const store = {
    listPending: () => pending,
    answerConsent: jest.fn(async () => undefined),
    onChange: (fn: () => void) => {
      listeners.add(fn)
      return () => listeners.delete(fn)
    }
  }
  setConsentSheetSource({ store: store as any, context: () => ({ walletRevision: 1, profileKey: '0' }) })
  return {
    store,
    raise(e: unknown) {
      pending = [e]
      listeners.forEach(fn => fn())
    },
    clear() {
      pending = []
      listeners.forEach(fn => fn())
    }
  }
}

let native: FakeNative
let appStateHandlers: Array<(s: string) => void>
beforeEach(() => {
  jest.useFakeTimers()
  resetContextRelay()
  native = createFakeNative()
  setSheetOwnerSource(native)
  setBridgeSheetNative(native)
  native.setHostLifecycle({ registered: true, mainAlive: true, mainResumed: false, sheetResumed: true })
  appStateHandlers = []
  jest.spyOn(AppState, 'addEventListener').mockImplementation(((_: string, handler: any) => {
    appStateHandlers.push(handler)
    return { remove: () => void appStateHandlers.splice(appStateHandlers.indexOf(handler), 1) }
  }) as any)
  ;(AppState as any).currentState = 'active'
})
afterEach(() => {
  setSheetOwnerSource(undefined)
  setBridgeSheetNative(undefined)
  setConsentSheetSource(undefined)
  resetContextRelay()
  jest.useRealTimers()
  jest.restoreAllMocks()
})

const advance = async (ms: number) => {
  await act(async () => {
    jest.advanceTimersByTime(ms)
  })
}
/** What the platform does at a Main-to-sheet handover: `background`, no Activity resumed, then `active` about 50 ms later. */
async function blip() {
  await act(async () => {
    ;(AppState as any).currentState = 'background'
    appStateHandlers.forEach(fn => fn('background'))
    native.setHostLifecycle({ sheetResumed: false })
  })
  await advance(50)
  await act(async () => {
    ;(AppState as any).currentState = 'active'
    native.setHostLifecycle({ sheetResumed: true })
    appStateHandlers.forEach(fn => fn('active'))
  })
  await advance(1)
}

describe('handover blip', () => {
  it('background then active 50 ms apart closes no binding, fails no request and locks nothing', async () => {
    const attention = createAttention({
      native,
      clock: () => native.elapsedRealtime(),
      owner: () => ownerFromNative(native)
    })
    attention.requestAttention('prompt', { epoch: 'e1' } as any)
    const first = render(<FirstRoot />)
    const second = render(<BridgeSheetRoot />)
    await advance(1)
    const before = native.calls.length
    await blip()
    attention.refreshFront()
    await advance(10_000)
    const after = native.calls.slice(before).map(c => c.name)
    // Only sheet bookkeeping and the cancel of a heads-up that was never needed: no close, no abort, no respond, no stop.
    for (const forbidden of [
      'respond',
      'abortConnection',
      'stopServer',
      'stopSession',
      'postAttention',
      'showSheet',
      'returnToBrowser'
    ])
      expect(after).not.toContain(forbidden)
    second.unmount()
    first.unmount()
  })

  it('blip neither hides the sheet nor loses or duplicates an approved grant', async () => {
    const c = consent([entry])
    const first = render(<FirstRoot />)
    const second = render(<BridgeSheetRoot />)
    await advance(1)
    await advance(700)
    fireEvent.press(second.getByTestId('bridge-approve'))
    await advance(100)
    await blip()
    await advance(2000)
    expect(c.store.answerConsent).toHaveBeenCalledTimes(1)
    // The prompt is answered; a second one raised after the blip still has a sheet to show it.
    await act(async () => c.raise({ ...entry, requestId: 'k2' }))
    expect(second.getByTestId('bridge-approve')).toBeTruthy()
    second.unmount()
    first.unmount()
  })

  it('a pending, not yet approved prompt is still shown after the blip', async () => {
    consent([entry])
    const first = render(<FirstRoot />)
    const second = render(<BridgeSheetRoot />)
    await advance(1)
    expect(second.getByTestId('bridge-approve')).toBeTruthy()
    await blip()
    await advance(OWNER_NONE_MS)
    expect(second.getByTestId('bridge-sheet-root')).toBeTruthy()
    expect(second.getByTestId('bridge-approve')).toBeTruthy()
    second.unmount()
    first.unmount()
  })
})

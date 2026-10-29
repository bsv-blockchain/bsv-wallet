/**
 * The overlay root with the REAL PermissionSheet, over contexts relayed from a first root. Only the native modules
 * that do not exist under jest are replaced; the package self-import is the toolbox's stand-in (real contexts).
 */
jest.mock('expo-secure-store', () => require('../../../expo-wallet-toolbox/__tests__/__mocks__/secureStoreFake').fake)
jest.mock(
  'expo-local-authentication',
  () => require('../../../expo-wallet-toolbox/__tests__/__mocks__/localAuthFake').fake
)
jest.mock('@bsv/expo-wallet-toolbox', () =>
  require('../../../expo-wallet-toolbox/__tests__/ui/bridgeSheet/mockToolboxPackage').toolboxPackageStandIn()
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

import fs from 'fs'
import path from 'path'
import React from 'react'
import { AppRegistry } from 'react-native'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { act, fireEvent, render } from '@testing-library/react-native'
import * as Reanimated from 'react-native-reanimated'
import { fireGestureHandler, getByGestureTestId } from 'react-native-gesture-handler/jest-utils'
import { setConsentSheetSource } from '@bsv/expo-wallet-toolbox/core/bridge/consentSheetSource'
import { lightColors } from '@bsv/expo-wallet-toolbox/core/theme/tokens'
import { RELAYED_CONTEXTS } from '@bsv/expo-wallet-toolbox/ui/bridgeSheet/relayedContexts'
import { ContextRelayPublisher, resetContextRelay } from '@bsv/expo-wallet-toolbox/ui/bridgeSheet/ContextRelay'
import * as resumeSignal from '@bsv/expo-wallet-toolbox/ui/components/ui/sheetResumeSignal'
import PermissionSheet from '@bsv/expo-wallet-toolbox/ui/components/ui/PermissionSheet'
import { createFakeNative, type FakeNative } from '../../src/testing/fakeNative'
import { AndroidBridgeSheetGate } from '../../src/ui/AndroidBridgeSheetGate'
import { BridgeSheetRoot, SCRIM_COLOR, setBridgeSheetNative } from '../../src/ui/BridgeSheetRoot'
import { __resetSheetRootRegistrationForTests, registerSheetRoot } from '../../src/ui/registerSheetRoot'
import { setSheetOwnerSource } from '../../src/ui/sheetOwner'
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
beforeEach(() => {
  jest.useFakeTimers()
  resetContextRelay()
  native = createFakeNative()
  setSheetOwnerSource(native)
  setBridgeSheetNative(native)
  native.setHostLifecycle({ registered: true, mainAlive: true, mainResumed: false, sheetResumed: true })
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
const interactive = () => native.calls.filter(c => c.name === 'setSheetInteractive').map(c => c.args[0])

describe('BridgeSheetRoot', () => {
  it('the root testID is bridge-sheet-root, with filterTouchesWhenObscured, a scrim that is 0.9 while pending and transparent while idle, and no press handler on the scrim', async () => {
    const c = consent([])
    const first = render(<FirstRoot />)
    const second = render(<BridgeSheetRoot />)
    await advance(1)
    const root = second.getByTestId('bridge-sheet-root')
    expect(root.props.filterTouchesWhenObscured).toBe(true)
    const scrim = () => second.getByTestId('bridge-sheet-scrim')
    expect(scrim().props.style).toEqual(
      expect.arrayContaining([expect.objectContaining({ backgroundColor: 'transparent' })])
    )
    await act(async () => c.raise(entry))
    expect(SCRIM_COLOR).toBe('rgba(0,0,0,0.9)')
    expect(scrim().props.style).toEqual(
      expect.arrayContaining([expect.objectContaining({ backgroundColor: SCRIM_COLOR })])
    )
    expect(scrim().props.onPress).toBeUndefined()
    expect(scrim().props.onStartShouldSetResponder).toBeUndefined()
    expect(scrim().props.onResponderRelease).toBeUndefined()
    second.unmount()
    first.unmount()
  })

  it('a tap on the sheet backdrop does not answer under the overlay root', async () => {
    const c = consent([entry])
    const first = render(<FirstRoot />)
    const second = render(<BridgeSheetRoot />)
    await advance(1)
    const backdrops = second.UNSAFE_queryAllByProps({ accessibilityLabel: 'Close' })
    expect(backdrops.length).toBeGreaterThan(0)
    for (const b of backdrops) fireEvent.press(b)
    await advance(450)
    expect(c.store.answerConsent).not.toHaveBeenCalled()
    second.unmount()
    first.unmount()
  })

  it('a swipe down on the sheet does not answer or leave it off screen under the overlay root', async () => {
    // spied before the render: the sheet's worklets capture `withSpring` when they are created
    const spring = jest.spyOn(Reanimated, 'withSpring')
    const c = consent([entry])
    const first = render(<FirstRoot />)
    const second = render(<BridgeSheetRoot />)
    await advance(1)
    spring.mockClear()
    fireGestureHandler(getByGestureTestId('sheet-pan'), [
      { state: 2 },
      { translationY: 700, velocityY: 2000 },
      { state: 5, translationY: 700, velocityY: 2000 }
    ] as any)
    await advance(450)
    expect(spring).toHaveBeenCalled()
    expect(spring.mock.calls[spring.mock.calls.length - 1][0]).toBe(0)
    expect(c.store.answerConsent).not.toHaveBeenCalled()
    spring.mockRestore()
    second.unmount()
    first.unmount()
  })

  it('renders nothing unless the owner is overlay', async () => {
    consent([entry])
    native.setHostLifecycle({ mainResumed: true, sheetResumed: false })
    const first = render(<FirstRoot />)
    const second = render(<BridgeSheetRoot />)
    await advance(1)
    expect(second.queryByTestId('bridge-sheet-root')).toBeNull()
    second.unmount()
    first.unmount()
  })

  it('Approve ignores taps for 700 ms under the overlay root', async () => {
    const c = consent([entry])
    const first = render(<FirstRoot />)
    const second = render(<BridgeSheetRoot />)
    await advance(1)
    await advance(698)
    fireEvent.press(second.getByTestId('bridge-approve'))
    await advance(450)
    expect(c.store.answerConsent).not.toHaveBeenCalled()
    await advance(1)
    fireEvent.press(second.getByTestId('bridge-approve'))
    await advance(450)
    expect(c.store.answerConsent).toHaveBeenCalledTimes(1)
    second.unmount()
    first.unmount()
  })

  it('setSheetInteractive follows the pending state', async () => {
    const c = consent([])
    const first = render(<FirstRoot />)
    const second = render(<BridgeSheetRoot />)
    await advance(1)
    expect(interactive()).toEqual([false])
    await act(async () => c.raise(entry))
    expect(interactive()).toEqual([false, true])
    await act(async () => c.clear())
    expect(interactive()).toEqual([false, true, false])
    second.unmount()
    first.unmount()
  })

  it('locked then unlocked: a connect parked while the wallet is blocked is shown once it is ready', async () => {
    // The session parks a connect and the consent store lists it only when the wallet is ready.
    const c = consent([])
    const first = render(<FirstRoot />)
    const second = render(<BridgeSheetRoot />)
    await advance(1)
    expect(second.queryByTestId('bridge-approve')).toBeNull()
    await act(async () => c.raise(entry))
    expect(second.getByTestId('bridge-approve')).toBeTruthy()
    second.unmount()
    first.unmount()
  })

  it('an owner flip mid-grant answers the grant exactly once', async () => {
    const c = consent([entry])
    const main = render(
      <>
        <FirstRoot />
        <SafeAreaProvider>
          <AndroidBridgeSheetGate>
            <PermissionSheet />
          </AndroidBridgeSheetGate>
        </SafeAreaProvider>
      </>
    )
    const second = render(<BridgeSheetRoot />)
    await advance(1)
    await advance(700)
    fireEvent.press(second.getByTestId('bridge-approve'))
    await advance(100)
    // The user is handed back to the wallet inside the 400 ms window.
    await act(async () => native.setHostLifecycle({ sheetResumed: false, mainResumed: true }))
    await advance(1)
    await advance(2000)
    expect(c.store.answerConsent).toHaveBeenCalledTimes(1)
    second.unmount()
    main.unmount()
  })

  it('nudges the Sheet when the sheet window resumes, even though AppState never changes', async () => {
    const signal = jest.spyOn(resumeSignal, 'signalSheetResumed')
    consent([entry])
    const first = render(<FirstRoot />)
    const second = render(<BridgeSheetRoot />)
    await advance(1)
    // Mounted with the window already resumed: one nudge for the missed transition.
    expect(signal).toHaveBeenCalledTimes(1)
    await act(async () => native.setHostLifecycle({ sheetResumed: false }))
    expect(signal).toHaveBeenCalledTimes(1)
    // Resuming again remounts the root one tick later, and that mount nudges once more.
    await act(async () => native.setHostLifecycle({ sheetResumed: true }))
    await advance(1)
    expect(signal).toHaveBeenCalledTimes(2)
    second.unmount()
    first.unmount()
  })

  it('adds no hard-coded strings', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../src/ui/BridgeSheetRoot.tsx'), 'utf8')
    // JSX text nodes: text between a closing '>' and an opening '<' that holds a letter.
    const body = src.slice(src.indexOf('return ('))
    const nodes = body.match(/>[^<>{}\n]*[A-Za-z][^<>{}\n]*</g) ?? []
    expect(nodes).toEqual([])
  })
})

describe('registerSheetRoot', () => {
  it('registers BsvBridgeSheet once', () => {
    __resetSheetRootRegistrationForTests()
    const spy = jest.spyOn(AppRegistry, 'registerComponent').mockImplementation(() => 'BsvBridgeSheet')
    registerSheetRoot()
    registerSheetRoot()
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.calls[0][0]).toBe('BsvBridgeSheet')
    expect((spy.mock.calls[0][1] as () => unknown)()).toBe(BridgeSheetRoot)
  })
})

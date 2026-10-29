/**
 * Review Focus 7: PermissionSheet is never mounted twice, even transiently, whichever root is notified first.
 * The sheet itself is a counting probe here; the real one is rendered in sheetRoot.test.tsx.
 */
jest.mock('expo-secure-store', () => require('../../../expo-wallet-toolbox/__tests__/__mocks__/secureStoreFake').fake)
jest.mock(
  'expo-local-authentication',
  () => require('../../../expo-wallet-toolbox/__tests__/__mocks__/localAuthFake').fake
)
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }))
// The native gesture module is not present under jest: the root view degrades to a plain View.
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
let mockPending = true
let mockLive = 0
let mockMax = 0
jest.mock('@bsv/expo-wallet-toolbox/ui/components/ui/PermissionSheet', () => {
  const React = require('react')
  const Probe = () => {
    React.useEffect(() => {
      mockLive += 1
      mockMax = Math.max(mockMax, mockLive)
      return () => {
        mockLive -= 1
      }
    }, [])
    return null
  }
  return { __esModule: true, default: Probe, usePermissionSheetBusy: () => mockPending }
})
jest.mock('@bsv/expo-wallet-toolbox/ui/components/ui/sheetResumeSignal', () => ({
  signalSheetResumed: jest.fn(),
  setSheetBackdropDismisses: jest.fn()
}))

import React from 'react'
import { Text } from 'react-native'
import { act, render } from '@testing-library/react-native'
import PermissionSheet from '@bsv/expo-wallet-toolbox/ui/components/ui/PermissionSheet'
import { ContextRelayPublisher, resetContextRelay } from '@bsv/expo-wallet-toolbox/ui/bridgeSheet/ContextRelay'
import { createFakeNative } from '../../src/testing/fakeNative'
import { AndroidBridgeSheetGate } from '../../src/ui/AndroidBridgeSheetGate'
import { BridgeSheetRoot, setBridgeSheetNative } from '../../src/ui/BridgeSheetRoot'
import { setSheetOwnerSource } from '../../src/ui/sheetOwner'
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

beforeEach(() => {
  jest.useFakeTimers()
  mockPending = true
  mockLive = 0
  mockMax = 0
  resetContextRelay()
})
afterEach(() => {
  setSheetOwnerSource(undefined)
  setBridgeSheetNative(undefined)
  resetContextRelay()
  jest.useRealTimers()
})

const tick = () => act(() => void jest.advanceTimersByTime(1))

describe('AndroidBridgeSheetGate', () => {
  it('renders its child when the owner is main or none and not when it is overlay', () => {
    const n = createFakeNative()
    setSheetOwnerSource(n)
    n.setHostLifecycle({ registered: true, mainAlive: true, mainResumed: true })
    const r = render(
      <AndroidBridgeSheetGate>
        <Text>child</Text>
      </AndroidBridgeSheetGate>
    )
    expect(r.queryByText('child')).toBeTruthy()
    act(() => n.setHostLifecycle({ mainResumed: false }))
    expect(r.queryByText('child')).toBeTruthy()
    act(() => n.setHostLifecycle({ sheetResumed: true }))
    expect(r.queryByText('child')).toBeNull()
    act(() => n.setHostLifecycle({ sheetResumed: false, mainResumed: true }))
    tick()
    expect(r.queryByText('child')).toBeTruthy()
    r.unmount()
  })

  for (const order of ['gate first', 'root first'] as const) {
    it(`max concurrent PermissionSheet is 1 under both subscription orders (${order})`, () => {
      const n = createFakeNative()
      setSheetOwnerSource(n)
      setBridgeSheetNative(n)
      n.setHostLifecycle({ registered: true, mainAlive: true, mainResumed: true })
      // Two separate React roots, as in the app: each owner change reaches them as separate commits, in the order the
      // roots subscribed.
      const gate = (
        <AndroidBridgeSheetGate>
          <PermissionSheet />
        </AndroidBridgeSheetGate>
      )
      const mainRoot = () =>
        render(
          <>
            {gate}
            <ContextRelayPublisher />
          </>
        )
      const overlayRoot = () => render(<BridgeSheetRoot />)
      const roots = order === 'gate first' ? [mainRoot(), overlayRoot()] : [overlayRoot(), mainRoot()]
      const r = { unmount: () => roots.forEach(x => x.unmount()) }
      tick()
      expect(mockLive).toBe(1)
      for (let i = 0; i < 3; i++) {
        act(() => n.setHostLifecycle({ mainResumed: false }))
        act(() => n.setHostLifecycle({ sheetResumed: true }))
        tick()
        expect(mockLive).toBe(1)
        act(() => n.setHostLifecycle({ sheetResumed: false }))
        act(() => n.setHostLifecycle({ mainResumed: true }))
        tick()
        expect(mockLive).toBe(1)
      }
      // Both flips inside one tick pair, no timer run in between.
      act(() => n.setHostLifecycle({ mainResumed: false, sheetResumed: true }))
      act(() => n.setHostLifecycle({ mainResumed: true, sheetResumed: false }))
      act(() => n.setHostLifecycle({ mainResumed: false, sheetResumed: true }))
      tick()
      expect(mockLive).toBe(1)
      expect(mockMax).toBe(1)
      r.unmount()
      expect(mockLive).toBe(0)
    })
  }
})

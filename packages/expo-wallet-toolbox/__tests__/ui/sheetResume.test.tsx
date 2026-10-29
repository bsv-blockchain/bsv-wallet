jest.mock('expo-secure-store', () => require('../__mocks__/secureStoreFake').fake)
jest.mock('expo-local-authentication', () => require('../__mocks__/localAuthFake').fake)
jest.mock('@bsv/expo-wallet-toolbox', () => require('./bridgeSheet/mockToolboxPackage').toolboxPackageStandIn())
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }))

import React from 'react'
import { AppState } from 'react-native'
import { act, fireEvent, render } from '@testing-library/react-native'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { fireGestureHandler, getByGestureTestId } from 'react-native-gesture-handler/jest-utils'
import * as Reanimated from 'react-native-reanimated'
import Sheet from '../../ui/components/ui/Sheet'
import { signalSheetResumed } from '../../ui/components/ui/sheetResumeSignal'

const Safe = ({ children }: { children: React.ReactNode }) => (
  <SafeAreaProvider
    initialMetrics={{
      frame: { x: 0, y: 0, width: 360, height: 800 },
      insets: { top: 0, left: 0, right: 0, bottom: 0 }
    }}
  >
    {children}
  </SafeAreaProvider>
)

describe('Sheet re-applies its open position', () => {
  it('on a sheet-resumed signal even when AppState never changes (the stale paint of a fresh second root)', () => {
    const timing = jest.spyOn(Reanimated, 'withTiming')
    const view = render(
      <Safe>
        <Sheet visible onClose={() => {}} />
      </Safe>
    )
    timing.mockClear()
    act(() => signalSheetResumed())
    expect(timing).toHaveBeenCalledTimes(1)
    expect(timing.mock.calls[0][0]).toBe(0)
    view.unmount()
    timing.mockClear()
    // No listener is left behind by an unmounted sheet.
    act(() => signalSheetResumed())
    expect(timing).not.toHaveBeenCalled()
    timing.mockRestore()
  })

  it('a closed sheet ignores the signal', () => {
    const timing = jest.spyOn(Reanimated, 'withTiming')
    const view = render(
      <Safe>
        <Sheet visible={false} onClose={() => {}} />
      </Safe>
    )
    timing.mockClear()
    act(() => signalSheetResumed())
    expect(timing).not.toHaveBeenCalled()
    view.unmount()
    timing.mockRestore()
  })

  it('still re-applies on AppState active', () => {
    let handler: ((s: string) => void) | undefined
    jest.spyOn(AppState, 'addEventListener').mockImplementation(((_: string, h: any) => {
      handler = h
      return { remove: () => {} }
    }) as any)
    const timing = jest.spyOn(Reanimated, 'withTiming')
    render(
      <Safe>
        <Sheet visible onClose={() => {}} />
      </Safe>
    )
    timing.mockClear()
    act(() => handler?.('active'))
    expect(timing).toHaveBeenCalledTimes(1)
    jest.restoreAllMocks()
  })
})

describe('Sheet dismissible={false}', () => {
  const swipeDown = (onClose: () => void, dismissible: boolean) => {
    const spring = jest.spyOn(Reanimated, 'withSpring')
    const view = render(
      <Safe>
        <Sheet visible dismissible={dismissible} onClose={onClose} />
      </Safe>
    )
    spring.mockClear()
    // a long, fast swipe down: past a third of the sheet and past the fling velocity
    fireGestureHandler(getByGestureTestId('sheet-pan'), [
      { state: 2 },
      { translationY: 600, velocityY: 2000 },
      { state: 5, translationY: 600, velocityY: 2000 }
    ] as any)
    return { view, spring }
  }

  it('a swipe down springs back to the open position and does not close', () => {
    const onClose = jest.fn()
    const { view, spring } = swipeDown(onClose, false)
    expect(spring).toHaveBeenCalled()
    expect(spring.mock.calls[spring.mock.calls.length - 1][0]).toBe(0)
    expect(onClose).not.toHaveBeenCalled()
    view.unmount()
    spring.mockRestore()
  })

  it('a swipe down closes by default (control)', () => {
    const { view, spring } = swipeDown(() => {}, true)
    expect(spring.mock.calls[spring.mock.calls.length - 1][0]).toBeGreaterThan(0)
    view.unmount()
    spring.mockRestore()
  })

  it('a backdrop press calls onClose only when dismissible', () => {
    for (const dismissible of [true, false]) {
      const onClose = jest.fn()
      const view = render(
        <Safe>
          <Sheet visible dismissible={dismissible} onClose={onClose} />
        </Safe>
      )
      fireEvent.press(view.getByTestId('sheet-backdrop', { hidden: true }))
      expect(onClose).toHaveBeenCalledTimes(dismissible ? 1 : 0)
      view.unmount()
    }
  })
})

describe('Sheet backdrop accessibility', () => {
  it('a non-dismissible sheet does not expose its backdrop as a Close button', () => {
    const view = render(
      <Safe>
        <Sheet visible dismissible={false} onClose={() => {}} />
      </Safe>
    )
    expect(view.queryByLabelText('Close')).toBeNull()
    view.unmount()
  })

  it('a dismissible sheet still exposes it (control)', () => {
    const view = render(
      <Safe>
        <Sheet visible onClose={() => {}} />
      </Safe>
    )
    expect(view.queryByLabelText('Close')).not.toBeNull()
    view.unmount()
  })
})

describe('Sheet open-spring completion', () => {
  it('does not re-apply the open position once the sheet was closed in the meantime', () => {
    const callbacks: Array<(finished?: boolean) => void> = []
    const spring = jest.spyOn(Reanimated, 'withSpring').mockImplementation(((to: number, _c: any, cb: any) => {
      if (cb) callbacks.push(cb)
      return to
    }) as any)
    const timing = jest.spyOn(Reanimated, 'withTiming')
    const view = render(
      <Safe>
        <Sheet visible onClose={() => {}} />
      </Safe>
    )
    const openDone = callbacks[0]
    expect(openDone).toBeDefined()
    view.rerender(
      <Safe>
        <Sheet visible={false} onClose={() => {}} />
      </Safe>
    )
    timing.mockClear()
    act(() => openDone(true))
    expect(timing).not.toHaveBeenCalled()
    view.unmount()
    spring.mockRestore()
    timing.mockRestore()
  })
})

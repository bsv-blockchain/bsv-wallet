import React from 'react'
import { Text } from 'react-native'
import { AppState } from 'react-native'
import { act, render } from '@testing-library/react-native'
import { createFakeNative } from '../../src/testing/fakeNative'
import { ownerOf, setSheetOwnerSource, sheetOwner, useSheetOwner } from '../../src/ui/sheetOwner'
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

afterEach(() => {
  setSheetOwnerSource(undefined)
  ;(AppState as any).currentState = 'active'
})

describe('sheetOwner', () => {
  const rows: Array<[boolean, boolean, string]> = [
    [true, false, 'main'],
    [false, true, 'overlay'],
    [true, true, 'main'],
    [false, false, 'none']
  ]
  for (const [mainResumed, sheetResumed, expected] of rows) {
    it(`truth table: main=${mainResumed} sheet=${sheetResumed} gives ${expected} whatever AppState says`, () => {
      const n = createFakeNative()
      setSheetOwnerSource(n)
      n.setHostLifecycle({ registered: true, mainAlive: true, mainResumed, sheetResumed })
      for (const state of ['active', 'background', 'inactive']) {
        ;(AppState as any).currentState = state
        expect(sheetOwner()).toBe(expected)
      }
      expect(ownerOf({ mainResumed, sheetResumed })).toBe(expected)
    })
  }

  it('unregistered falls back to AppState: active gives main, background gives none', () => {
    const n = createFakeNative()
    setSheetOwnerSource(n)
    // The tracker claims an overlay but has not caught up: its fields are not trusted.
    n.setHostLifecycle({ registered: false, sheetResumed: true })
    ;(AppState as any).currentState = 'active'
    expect(sheetOwner()).toBe('main')
    ;(AppState as any).currentState = 'background'
    expect(sheetOwner()).toBe('none')
  })

  it('without a source it behaves as unregistered', () => {
    ;(AppState as any).currentState = 'active'
    expect(sheetOwner()).toBe('main')
  })

  it('useSheetOwner follows onHostLifecycle', () => {
    const n = createFakeNative()
    setSheetOwnerSource(n)
    n.setHostLifecycle({ registered: true, mainAlive: true, mainResumed: true })
    const seen: string[] = []
    const Probe = () => {
      const o = useSheetOwner()
      seen.push(o)
      return <Text>{o}</Text>
    }
    const r = render(<Probe />)
    expect(r.getByText('main')).toBeTruthy()
    act(() => n.setHostLifecycle({ mainResumed: false }))
    expect(r.getByText('none')).toBeTruthy()
    act(() => n.setHostLifecycle({ sheetResumed: true }))
    expect(r.getByText('overlay')).toBeTruthy()
    r.unmount()
  })
})

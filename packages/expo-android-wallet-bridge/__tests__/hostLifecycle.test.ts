import { createFakeNative } from '../src/testing/fakeNative'

describe('fake native host lifecycle surface', () => {
  it('the fake native defaults to unregistered', () => {
    const n = createFakeNative()
    expect(n.hostLifecycle()).toEqual({
      registered: false,
      mainAlive: false,
      mainResumed: false,
      sheetResumed: false
    })
  })

  it('setHostLifecycle fires onHostLifecycle once per change and not for a no-op', () => {
    const n = createFakeNative()
    const seen: unknown[] = []
    n.addListener('onHostLifecycle', p => seen.push(p))
    n.setHostLifecycle({ registered: true, mainAlive: true, mainResumed: true })
    n.setHostLifecycle({ mainResumed: true })
    n.setHostLifecycle({ mainResumed: false, sheetResumed: true })
    expect(seen).toEqual([
      { registered: true, mainAlive: true, mainResumed: true, sheetResumed: false },
      { registered: true, mainAlive: true, mainResumed: false, sheetResumed: true }
    ])
    expect(n.hostLifecycle().sheetResumed).toBe(true)
  })

  it('setHostState, setSheetInteractive, showSheet and hideSheet are recorded', () => {
    const n = createFakeNative()
    n.setHostState({ attached: true, ready: false })
    n.setSheetInteractive(true)
    n.showSheet('prompt')
    n.hideSheet()
    expect(n.calls).toEqual([
      { name: 'setHostState', args: [{ attached: true, ready: false }] },
      { name: 'setSheetInteractive', args: [true] },
      { name: 'showSheet', args: ['prompt'] },
      { name: 'hideSheet', args: [] }
    ])
  })
})

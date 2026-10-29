import { createFakeNative } from '../src/testing/fakeNative'

// The window protections (FLAG_SECURE, hide-overlay, obscured-touch drop, non-touchable idle window) are device
// behaviour, verified on the emulator in M2 Task 7 step 4 and Task 13. This file pins only the JS surface that drives
// the idle window: `setSheetInteractive` exists on the native seam and records each call in order.
describe('sheet protections JS surface', () => {
  it('setSheetInteractive exists and records calls', () => {
    const n = createFakeNative()
    expect(typeof n.setSheetInteractive).toBe('function')
    n.setSheetInteractive(true)
    n.setSheetInteractive(false)
    expect(n.calls).toEqual([
      { name: 'setSheetInteractive', args: [true] },
      { name: 'setSheetInteractive', args: [false] }
    ])
  })
})

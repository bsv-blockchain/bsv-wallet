import { shouldDeferSendWaiting } from '../../core/storage/skipQueuedAncestors'
import { canInternalizePending } from '../../core/localpay/pending'

describe('shouldDeferSendWaiting', () => {
  it('defers a request whose input is still queued', () => {
    expect(shouldDeferSendWaiting(['aa'], new Set(['aa']))).toBe(true)
    expect(shouldDeferSendWaiting(['bb'], new Set(['aa']))).toBe(false)
  })

  it('defers when any input intersects the queued set', () => {
    expect(shouldDeferSendWaiting(['aa', 'bb'], new Set(['bb', 'cc']))).toBe(true)
    expect(shouldDeferSendWaiting([], new Set(['aa']))).toBe(false)
  })
})

describe('canInternalizePending', () => {
  it('is true even when online is false', () => {
    expect(canInternalizePending(false)).toBe(true)
    expect(canInternalizePending(true)).toBe(true)
  })
})

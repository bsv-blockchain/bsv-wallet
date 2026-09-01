import { shouldFailUnprovenTx } from '../../core/pay/refreshProofGuard'

const IN_FLIGHT = { txStatus: 'nosend', updatedAtMs: 0, nowMs: 10 * 60 * 1000 }

describe('shouldFailUnprovenTx', () => {
  it('never fails a queued or posting offline row', () => {
    expect(shouldFailUnprovenTx({ ...IN_FLIGHT, offlineStatus: 'queued' })).toBe('pending')
    expect(shouldFailUnprovenTx({ ...IN_FLIGHT, offlineStatus: 'posting' })).toBe('pending')
  })

  it('still fails a stale in-flight tx with no queue row', () => {
    expect(shouldFailUnprovenTx({ ...IN_FLIGHT })).toBe('failed')
  })
})

// A parked payment was held back on purpose and is still cancellable. Letting
// Refresh mark it failed would release inputs the payee may yet spend.
describe('parked payments', () => {
  it('is pending, never failed', () => {
    expect(
      shouldFailUnprovenTx({
        offlineStatus: 'parked',
        txStatus: 'nosend',
        updatedAtMs: 0,
        nowMs: 10 * 60 * 1000
      })
    ).toBe('pending')
  })
})

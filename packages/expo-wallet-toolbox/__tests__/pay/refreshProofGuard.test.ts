import { isChainAbsenceConfirmed, shouldFailUnprovenTx } from '../../core/pay/refreshProofGuard'

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

// XR-085: a raw database import downgrades a copied-in 'queued'/'posting' row
// to 'import_hold' so the automatic drain cannot rebroadcast it. That same row
// must not be failed by Refresh either — it is still an unresolved, possibly
// already-handed-off spend, and failing it would release its inputs.
describe('import_hold payments', () => {
  it('is pending, never failed', () => {
    expect(
      shouldFailUnprovenTx({
        offlineStatus: 'import_hold',
        txStatus: 'nosend',
        updatedAtMs: 0,
        nowMs: 10 * 60 * 1000
      })
    ).toBe('pending')
  })
})

// XR-030: refreshProof's /tx/hash/{txid} probe must only treat an
// authoritative 404 as proof the network doesn't have the tx. Any other
// completed non-OK response (429/500/401/403/...) is a service problem, not
// evidence of absence, and must be as inconclusive as a thrown network error.
describe('XR-030: isChainAbsenceConfirmed', () => {
  it('treats a 404 as confirmed absence', () => {
    expect(isChainAbsenceConfirmed(404)).toBe(true)
  })

  it('does not treat a transient or auth error as confirmed absence', () => {
    for (const status of [429, 500, 502, 503, 401, 403]) {
      expect(isChainAbsenceConfirmed(status)).toBe(false)
    }
  })
})

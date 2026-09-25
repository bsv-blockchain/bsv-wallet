import { boundedHexResponse, isChainAbsenceConfirmed, shouldFailUnprovenTx } from '../../core/pay/refreshProofGuard'

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

// XR-059 remainder: refreshProof's merkle-BUMP and raw-tx hex reads were
// unbounded, unlike the address-sweep/BEEF reads XR-059 already bounded
// elsewhere with this exact guard shape (address.ts's parseWocBeefBody,
// beefRepair.ts's refetchAtomicBeef).
describe('XR-059 remainder: boundedHexResponse', () => {
  it('trims and returns ordinary hex unchanged', () => {
    expect(boundedHexResponse('  deadBEEF01  ', 1000)).toBe('deadBEEF01')
  })

  it('rejects an empty body', () => {
    expect(boundedHexResponse('', 1000)).toBeUndefined()
    expect(boundedHexResponse('   ', 1000)).toBeUndefined()
  })

  it('rejects a body over the byte cap, without ever hex-decoding it', () => {
    // A compromised/misbehaving indexer answering with far more bytes than
    // any real merkle proof or raw tx could legitimately carry.
    const oversized = 'ab'.repeat(600_000) // 1,200,000 hex chars
    expect(boundedHexResponse(oversized, 1_000_000)).toBeUndefined()
  })

  it('accepts a body exactly at the cap', () => {
    const atCap = 'ab'.repeat(500_000) // exactly 1,000,000 hex chars
    expect(boundedHexResponse(atCap, 1_000_000)).toBe(atCap)
  })

  it('rejects odd-length hex', () => {
    expect(boundedHexResponse('abc', 1000)).toBeUndefined()
  })

  it('rejects non-hex characters', () => {
    expect(boundedHexResponse('not hex at all', 1000)).toBeUndefined()
    expect(boundedHexResponse('<html>404</html>', 1000)).toBeUndefined()
  })
})

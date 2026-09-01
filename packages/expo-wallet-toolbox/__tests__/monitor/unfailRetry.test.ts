import {
  isResolved,
  MAX_UNFAIL_RETRIES,
  selectRetryableInvalidReqs,
  type TxStatusesByTxid
} from '../../core/monitor/unfailRetry'

const statuses = (entries: [string, string[]][]): TxStatusesByTxid => new Map(entries)

describe('isResolved', () => {
  it('treats a failed or completed transaction as nothing left to rescue', () => {
    expect(isResolved(['failed'])).toBe(true)
    expect(isResolved(['completed'])).toBe(true)
    expect(isResolved(['failed', 'completed'])).toBe(true)
  })

  it('treats a live transaction as still worth a lookup', () => {
    expect(isResolved(['unproven'])).toBe(false)
    expect(isResolved(['failed', 'unproven'])).toBe(false)
  })

  it('treats a req with no transaction left as resolved', () => {
    expect(isResolved([])).toBe(true)
    expect(isResolved(undefined)).toBe(true)
  })
})

describe('selectRetryableInvalidReqs', () => {
  // The reported symptom: three invalid reqs whose transactions reviewStatus
  // had already failed, re-looked-up every ten minutes, forever.
  it('drops reqs whose transaction is already failed', () => {
    const reqs = [
      { provenTxReqId: 3, txid: 'a' },
      { provenTxReqId: 4, txid: 'b' },
      { provenTxReqId: 7, txid: 'c' }
    ]
    const picked = selectRetryableInvalidReqs(
      reqs,
      statuses([
        ['a', ['failed']],
        ['b', ['failed']],
        ['c', ['failed']]
      ])
    )
    expect(picked).toEqual([])
  })

  it('keeps a req whose transaction is still live', () => {
    const reqs = [{ provenTxReqId: 1, txid: 'a' }]
    expect(selectRetryableInvalidReqs(reqs, statuses([['a', ['unproven']]]))).toHaveLength(1)
  })

  it('gives up on a live transaction after enough failed lookups', () => {
    const live = statuses([['a', ['unproven']]])
    expect(
      selectRetryableInvalidReqs([{ provenTxReqId: 1, txid: 'a', attempts: MAX_UNFAIL_RETRIES - 1 }], live)
    ).toHaveLength(1)
    expect(
      selectRetryableInvalidReqs([{ provenTxReqId: 1, txid: 'a', attempts: MAX_UNFAIL_RETRIES }], live)
    ).toHaveLength(0)
  })

  it('treats a missing attempts count as none used', () => {
    const live = statuses([['a', ['unproven']]])
    expect(selectRetryableInvalidReqs([{ provenTxReqId: 1, txid: 'a', attempts: null }], live)).toHaveLength(1)
  })
})

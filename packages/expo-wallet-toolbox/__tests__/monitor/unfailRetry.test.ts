import {
  isResolved,
  MAX_UNFAIL_RETRIES,
  runBoundedUnfail,
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

// A monitor task's `storage` is the WalletStorageManager, which has
// findProvenTxReqs but neither findTransactions nor updateProvenTxReq. Calling
// one of those on it threw and took the whole UnFail task down.
describe('runBoundedUnfail', () => {
  type Req = { provenTxReqId: number; txid: string; attempts?: number }

  function fakeStorage(reqs: Req[], txStatuses: Record<string, string[]>) {
    const updates: { id: number; attempts: number }[] = []
    const provider = {
      findTransactions: async ({ partial }: { partial: { txid: string } }) =>
        (txStatuses[partial.txid] ?? []).map(status => ({ status })),
      updateProvenTxReq: async (id: number, update: { attempts: number }) => {
        updates.push({ id, attempts: update.attempts })
        const r = reqs.find(x => x.provenTxReqId === id)
        if (r) r.attempts = update.attempts
      }
    }
    return {
      updates,
      storage: {
        findProvenTxReqs: async () => reqs.map(r => ({ ...r })),
        runAsStorageProvider: async <T,>(fn: (sp: typeof provider) => Promise<T>) => await fn(provider)
      }
    }
  }

  it('says nothing and asks nothing when every invalid req is already resolved', async () => {
    const f = fakeStorage([{ provenTxReqId: 3, txid: 'a' }], { a: ['failed'] })
    const unfail = jest.fn()
    const log = await runBoundedUnfail({ storage: f.storage, unfail })
    expect(log).toBe('')
    expect(unfail).not.toHaveBeenCalled()
    expect(f.updates).toEqual([])
  })

  it('retries a live one and counts the failure so it can age out', async () => {
    const f = fakeStorage([{ provenTxReqId: 1, txid: 'a' }], { a: ['unproven'] })
    const log = await runBoundedUnfail({
      storage: f.storage,
      unfail: async () => ({ log: "  reqId 1: returned to status 'invalid'\n" })
    })
    expect(log).toContain('1 invalid reqs')
    expect(f.updates).toEqual([{ id: 1, attempts: 1 }])
  })

  it('stops asking once the bound is reached', async () => {
    const f = fakeStorage([{ provenTxReqId: 1, txid: 'a', attempts: MAX_UNFAIL_RETRIES }], { a: ['unproven'] })
    const unfail = jest.fn()
    expect(await runBoundedUnfail({ storage: f.storage, unfail })).toBe('')
    expect(unfail).not.toHaveBeenCalled()
  })

  it('does not count an attempt against a req that recovered', async () => {
    // Gone from the invalid list on the second read: it was unfailed.
    let reads = 0
    const provider = {
      findTransactions: async () => [{ status: 'unproven' }],
      updateProvenTxReq: jest.fn()
    }
    const storage = {
      findProvenTxReqs: async () => (reads++ === 0 ? [{ provenTxReqId: 1, txid: 'a' }] : []),
      runAsStorageProvider: async <T,>(fn: (sp: typeof provider) => Promise<T>) => await fn(provider)
    }
    await runBoundedUnfail({ storage, unfail: async () => ({ log: 'unfailed\n' }) })
    expect(provider.updateProvenTxReq).not.toHaveBeenCalled()
  })

  it('is silent when there are no invalid reqs at all', async () => {
    const f = fakeStorage([], {})
    expect(await runBoundedUnfail({ storage: f.storage, unfail: jest.fn() })).toBe('')
  })
})

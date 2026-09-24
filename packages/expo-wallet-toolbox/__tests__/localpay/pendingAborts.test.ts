import {
  loadPendingAborts,
  PENDING_ABORTS_KEY,
  queuePendingAbort,
  replayPendingAborts,
  loadDeclinedAbortWatch,
  queueDeclinedAbortWatch,
  verifyDeclinedAborts
} from '../../core/localpay/pendingAborts'
import { ADMIN_ORIGINATOR } from '../../core/config'

function fakeStorage() {
  const map = new Map<string, string>()
  return {
    map,
    getKeyValue: async (k: string) => map.get(k),
    setKeyValue: async (k: string, v: string) => void map.set(k, v)
  }
}

describe('pending_aborts', () => {
  it('reads an abort queued under the pre-2.8 internal authority label as the current one', async () => {
    const storage = fakeStorage()
    storage.map.set(
      PENDING_ABORTS_KEY,
      JSON.stringify([{ reference: 'ref-old', originator: 'urn:bsv-wallet:internal-admin' }])
    )
    expect(await loadPendingAborts(storage)).toEqual([{ reference: 'ref-old', originator: ADMIN_ORIGINATOR }])
  })

  it('queues a failed abort and replays it on wallet build', async () => {
    const storage = fakeStorage()
    await queuePendingAbort(storage, { reference: 'ref-1', originator: 'admin.com' })
    expect(storage.map.has(PENDING_ABORTS_KEY)).toBe(true)
    expect(await loadPendingAborts(storage)).toEqual([{ reference: 'ref-1', originator: 'admin.com' }])

    const wallet = { abortAction: jest.fn().mockResolvedValue({ aborted: true }) }
    await replayPendingAborts({ wallet, storage })
    expect(wallet.abortAction).toHaveBeenCalledWith({ reference: 'ref-1' }, 'admin.com')
    expect(await loadPendingAborts(storage)).toEqual([])
  })

  it('keeps an abort that still fails', async () => {
    const storage = fakeStorage()
    await queuePendingAbort(storage, { reference: 'ref-stuck', originator: 'admin.com' })
    const wallet = { abortAction: jest.fn().mockResolvedValue({ aborted: false }) }
    await replayPendingAborts({ wallet, storage })
    expect(await loadPendingAborts(storage)).toEqual([{ reference: 'ref-stuck', originator: 'admin.com' }])
  })

  it('does not duplicate the same reference', async () => {
    const storage = fakeStorage()
    await queuePendingAbort(storage, { reference: 'ref-1', originator: 'admin.com' })
    await queuePendingAbort(storage, { reference: 'ref-1', originator: 'admin.com' })
    expect(await loadPendingAborts(storage)).toHaveLength(1)
  })
})

describe('declined_abort_watch', () => {
  const TXID = 'aa'.repeat(32)

  function fakeStorage2() {
    const map = new Map<string, string>()
    return {
      map,
      getKeyValue: async (k: string) => map.get(k),
      setKeyValue: async (k: string, v: string) => void map.set(k, v)
    }
  }

  it('queues a declined-abort watch entry and does not duplicate it', async () => {
    const storage = fakeStorage2()
    await queueDeclinedAbortWatch(storage, { txid: TXID, reference: 'ref-1', at: 1000 })
    await queueDeclinedAbortWatch(storage, { txid: TXID, reference: 'ref-1', at: 2000 })
    const all = await loadDeclinedAbortWatch(storage)
    expect(all).toHaveLength(1)
    expect(all[0]).toEqual({ txid: TXID, reference: 'ref-1', at: 1000 })
  })

  it('surfaces and removes a watched txid the network reports as mined or known', async () => {
    const storage = fakeStorage2()
    await queueDeclinedAbortWatch(storage, { txid: TXID, reference: 'ref-1', at: Date.now() })
    const getStatusForTxids = jest.fn().mockResolvedValue({ results: [{ txid: TXID, status: 'known' }] })

    const surfaced = await verifyDeclinedAborts({ storage, getStatusForTxids })

    expect(surfaced).toEqual([expect.objectContaining({ txid: TXID, reference: 'ref-1' })])
    expect(await loadDeclinedAbortWatch(storage)).toEqual([])
  })

  it('keeps watching a txid the network has not seen yet', async () => {
    const storage = fakeStorage2()
    await queueDeclinedAbortWatch(storage, { txid: TXID, reference: 'ref-1', at: Date.now() })
    const getStatusForTxids = jest.fn().mockResolvedValue({ results: [{ txid: TXID, status: 'unknown' }] })

    const surfaced = await verifyDeclinedAborts({ storage, getStatusForTxids })

    expect(surfaced).toEqual([])
    expect(await loadDeclinedAbortWatch(storage)).toHaveLength(1)
  })

  it('drops a watch entry once it exceeds the bounded age, even if still unknown', async () => {
    const storage = fakeStorage2()
    const EIGHT_DAYS_MS = 8 * 24 * 60 * 60 * 1000
    await queueDeclinedAbortWatch(storage, { txid: TXID, reference: 'ref-1', at: Date.now() - EIGHT_DAYS_MS })
    const getStatusForTxids = jest.fn().mockResolvedValue({ results: [] })

    const surfaced = await verifyDeclinedAborts({ storage, getStatusForTxids })

    expect(surfaced).toEqual([])
    expect(await loadDeclinedAbortWatch(storage)).toEqual([])
  })

  it('an honest decline (network never reports the txid) never surfaces a warning', async () => {
    const storage = fakeStorage2()
    await queueDeclinedAbortWatch(storage, { txid: TXID, reference: 'ref-1', at: Date.now() })
    const getStatusForTxids = jest.fn().mockResolvedValue({ results: [] })

    const surfaced = await verifyDeclinedAborts({ storage, getStatusForTxids })
    expect(surfaced).toEqual([])
  })

  it('treats a getStatusForTxids failure as still-unknown and keeps watching', async () => {
    const storage = fakeStorage2()
    await queueDeclinedAbortWatch(storage, { txid: TXID, reference: 'ref-1', at: Date.now() })
    const getStatusForTxids = jest.fn().mockRejectedValue(new Error('network down'))

    const surfaced = await verifyDeclinedAborts({ storage, getStatusForTxids })

    expect(surfaced).toEqual([])
    expect(await loadDeclinedAbortWatch(storage)).toHaveLength(1)
  })
})

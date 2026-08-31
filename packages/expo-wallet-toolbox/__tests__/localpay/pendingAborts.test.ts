import {
  loadPendingAborts,
  PENDING_ABORTS_KEY,
  queuePendingAbort,
  replayPendingAborts
} from '../../core/localpay/pendingAborts'

function fakeStorage() {
  const map = new Map<string, string>()
  return {
    map,
    getKeyValue: async (k: string) => map.get(k),
    setKeyValue: async (k: string, v: string) => void map.set(k, v)
  }
}

describe('pending_aborts', () => {
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

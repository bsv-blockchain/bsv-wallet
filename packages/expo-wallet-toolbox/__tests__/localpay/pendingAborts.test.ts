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
import { guardVaultAccess, VAULT_ABORT_REPLAY_MARKER } from '../../core/services/vault/guard'
import { buildLock } from '../../core/services/vault/r1comb'

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
    // XR-102: the persisted `originator` is NEVER trusted, even a genuine-
    // looking one — replay always calls with the real, imported
    // ADMIN_ORIGINATOR, marked so a guardVaultAccess-wrapped wallet runs the
    // same vault-inventory check a non-admin caller gets, rather than a
    // forged-or-real admin string racing straight past it (see
    // __tests__/vault/guard.test.ts and the end-to-end case below).
    expect(wallet.abortAction).toHaveBeenCalledWith(
      { reference: 'ref-1', [VAULT_ABORT_REPLAY_MARKER]: true },
      ADMIN_ORIGINATOR
    )
    expect(await loadPendingAborts(storage)).toEqual([])
  })

  // XR-102. A raw edit of the pending_aborts KV record — writable by anything
  // with local storage access — used to be replayed unauthenticated at every
  // wallet build, with the persisted `originator` trusted verbatim. Even
  // with that closed (above), replay's own originator is necessarily the
  // real ADMIN_ORIGINATOR (the underlying wallet's assertPendingActionOriginator
  // requires it), which guardVaultAccess would otherwise trust unconditionally.
  // This is the end-to-end case: a forged Vault reference must still be
  // refused when replayed against the REAL guarded wallet.
  describe('replay against a real guardVaultAccess-wrapped wallet', () => {
    const TXID = 'ab'.repeat(32)
    const vaultLock = () =>
      buildLock({ commitments: ['11'.repeat(20), '22'.repeat(20)], saltHex64: '33'.repeat(32) }).toHex()

    function vaultTaggedWallet() {
      const abortAction = jest.fn().mockResolvedValue({ aborted: true })
      const vaultAction = {
        txid: TXID,
        satoshis: 50_000,
        status: 'nosend',
        isOutgoing: true,
        description: 'Vault deposit',
        version: 1,
        lockTime: 0,
        reference: 'vault-ref-1',
        labels: ['vault', 'vault-deposit'],
        inputs: [],
        outputs: [
          {
            satoshis: 50_000,
            spendable: false,
            tags: ['vault'],
            outputIndex: 0,
            outputDescription: 'Vault deposit',
            basket: 'admin vault',
            lockingScript: vaultLock()
          }
        ]
      }
      const listActions = jest.fn(async (args: { labels?: string[]; limit?: number; offset?: number } = {}) => {
        const labels = args.labels ?? []
        const matching =
          labels.length === 0 ? [vaultAction] : labels.every(l => vaultAction.labels.includes(l)) ? [vaultAction] : []
        const offset = args.offset ?? 0
        const limit = args.limit ?? 10
        return { totalActions: matching.length, actions: matching.slice(offset, offset + limit) }
      })
      return { wallet: { abortAction, listActions } as never, abortAction }
    }

    it('never invokes the underlying abortAction for a forged Vault reference, even with the real admin originator', async () => {
      const { wallet, abortAction } = vaultTaggedWallet()
      const guarded = guardVaultAccess(wallet, ADMIN_ORIGINATOR)

      const storage = fakeStorage()
      // Imported constant, not a copy-pasted string — this is exactly what a
      // raw KV edit forging the (now load-bearing) admin originator produces.
      storage.map.set(PENDING_ABORTS_KEY, JSON.stringify([{ reference: 'vault-ref-1', originator: ADMIN_ORIGINATOR }]))

      await replayPendingAborts({ wallet: guarded as never, storage })

      expect(abortAction).not.toHaveBeenCalled()
      // Refused, not silently dropped: kept for the next replay attempt,
      // exactly like any other abort that failed.
      expect(await loadPendingAborts(storage)).toEqual([{ reference: 'vault-ref-1', originator: ADMIN_ORIGINATOR }])
    })

    it('still replays an ordinary, non-Vault reference through the same guarded wallet', async () => {
      const { wallet, abortAction } = vaultTaggedWallet()
      const guarded = guardVaultAccess(wallet, ADMIN_ORIGINATOR)

      const storage = fakeStorage()
      storage.map.set(
        PENDING_ABORTS_KEY,
        JSON.stringify([{ reference: 'localpay-ref-1', originator: 'forged.example' }])
      )

      await replayPendingAborts({ wallet: guarded as never, storage })

      expect(abortAction).toHaveBeenCalledWith({ reference: 'localpay-ref-1' }, ADMIN_ORIGINATOR)
      expect(await loadPendingAborts(storage)).toEqual([])
    })
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

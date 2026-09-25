import { PrivateKey, ProtoWallet } from '@bsv/sdk'
import {
  loadPendingAborts,
  PENDING_ABORTS_KEY,
  queuePendingAbort,
  replayPendingAborts,
  loadDeclinedAbortWatch,
  queueDeclinedAbortWatch,
  verifyDeclinedAborts
} from '../../core/localpay/pendingAborts'
import { computePendingAbortAuthorityTag } from '../../core/localpay/pendingAbortAuthority'
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

// A real (ProtoWallet-backed) admin wallet, shared by every test below that
// needs to queue an authentically-tagged entry — mirrors
// __tests__/services/connectionAuthority.test.ts's own "real crypto" wallet.
const authorityWallet = () => new ProtoWallet(new PrivateKey(1))
const authority = () => ({ wallet: authorityWallet(), originator: ADMIN_ORIGINATOR })

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
    const wallet = authorityWallet()
    await queuePendingAbort(storage, { reference: 'ref-1', originator: 'admin.com' }, { wallet, originator: ADMIN_ORIGINATOR })
    expect(storage.map.has(PENDING_ABORTS_KEY)).toBe(true)
    const loaded = await loadPendingAborts(storage)
    expect(loaded).toEqual([{ reference: 'ref-1', originator: 'admin.com', tag: expect.any(String) }])

    const abortAction = jest.fn().mockResolvedValue({ aborted: true })
    const replayWallet = { abortAction, createHmac: wallet.createHmac.bind(wallet), verifyHmac: wallet.verifyHmac.bind(wallet) }
    await replayPendingAborts({ wallet: replayWallet, storage })
    // XR-102: the persisted `originator` is NEVER trusted, even a genuine-
    // looking one — replay always calls with the real, imported
    // ADMIN_ORIGINATOR, marked so a guardVaultAccess-wrapped wallet runs the
    // same vault-inventory check a non-admin caller gets, rather than a
    // forged-or-real admin string racing straight past it (see
    // __tests__/vault/guard.test.ts and the end-to-end case below).
    expect(abortAction).toHaveBeenCalledWith({ reference: 'ref-1', [VAULT_ABORT_REPLAY_MARKER]: true }, ADMIN_ORIGINATOR)
    expect(await loadPendingAborts(storage)).toEqual([])
  })

  // XR-102 (non-Vault residual): the vault-inventory replay marker only
  // protects a Vault reference — nothing else stopped a forged pending_aborts
  // entry naming an ordinary (non-Vault) reference from being replayed
  // unauthenticated. An entry queuePendingAbort never tagged (a raw KV edit,
  // exactly what a local-storage attacker can produce) must be dropped, not
  // replayed, however plausible its reference/originator look.
  it('XR-102: drops (never replays) an untagged pending-abort entry', async () => {
    const storage = fakeStorage()
    storage.map.set(
      PENDING_ABORTS_KEY,
      JSON.stringify([{ reference: 'forged-ref-1', originator: ADMIN_ORIGINATOR }])
    )
    const wallet = authorityWallet()
    const abortAction = jest.fn().mockResolvedValue({ aborted: true })
    const replayWallet = { abortAction, createHmac: wallet.createHmac.bind(wallet), verifyHmac: wallet.verifyHmac.bind(wallet) }

    const result = await replayPendingAborts({ wallet: replayWallet, storage })

    expect(abortAction).not.toHaveBeenCalled()
    expect(result).toEqual({ droppedUntrusted: 1 })
    // Fail-closed by DROPPING, not by keeping for retry: a kept-forever entry
    // would just be retried (and re-refused) at every future wallet build for
    // no benefit, and dropping only ever costs a reservation that manual
    // per-row abort (WalletHomeScreen) can still release.
    expect(await loadPendingAborts(storage)).toEqual([])
  })

  it('XR-102: drops an entry whose tag was computed for a different reference', async () => {
    const storage = fakeStorage()
    const wallet = authorityWallet()
    const tag = await computePendingAbortAuthorityTag(wallet, ADMIN_ORIGINATOR, 'ref-A')
    // Tag is authentic for 'ref-A', but the entry claims 'ref-B'.
    storage.map.set(PENDING_ABORTS_KEY, JSON.stringify([{ reference: 'ref-B', originator: ADMIN_ORIGINATOR, tag }]))
    const abortAction = jest.fn().mockResolvedValue({ aborted: true })
    const replayWallet = { abortAction, createHmac: wallet.createHmac.bind(wallet), verifyHmac: wallet.verifyHmac.bind(wallet) }

    const result = await replayPendingAborts({ wallet: replayWallet, storage })

    expect(abortAction).not.toHaveBeenCalled()
    expect(result).toEqual({ droppedUntrusted: 1 })
    expect(await loadPendingAborts(storage)).toEqual([])
  })

  it('XR-102: replays a genuinely-tagged entry normally, alongside a dropped untagged one', async () => {
    const storage = fakeStorage()
    const wallet = authorityWallet()
    await queuePendingAbort(storage, { reference: 'ref-good', originator: ADMIN_ORIGINATOR }, { wallet, originator: ADMIN_ORIGINATOR })
    // Simulate a forged second entry appended by a local-storage attacker.
    const existing = JSON.parse(storage.map.get(PENDING_ABORTS_KEY)!)
    storage.map.set(
      PENDING_ABORTS_KEY,
      JSON.stringify([...existing, { reference: 'ref-forged', originator: ADMIN_ORIGINATOR }])
    )
    const abortAction = jest.fn().mockResolvedValue({ aborted: true })
    const replayWallet = { abortAction, createHmac: wallet.createHmac.bind(wallet), verifyHmac: wallet.verifyHmac.bind(wallet) }

    const result = await replayPendingAborts({ wallet: replayWallet, storage })

    expect(abortAction).toHaveBeenCalledTimes(1)
    expect(abortAction).toHaveBeenCalledWith({ reference: 'ref-good', [VAULT_ABORT_REPLAY_MARKER]: true }, ADMIN_ORIGINATOR)
    expect(result).toEqual({ droppedUntrusted: 1 })
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
      // A real admin wallet backs createHmac/verifyHmac here (guardVaultAccess
      // passes both straight through to the target when called with
      // ADMIN_ORIGINATOR — see guard.ts's PRIVILEGED_CAPABLE fallthrough), so
      // these tests can prove the authority-tag layer and the vault-inventory
      // layer are independent: a genuinely-tagged Vault reference is still
      // refused (by the inventory check), and a genuinely-tagged non-Vault
      // reference still replays (the tag alone is not a bypass).
      const admin = new ProtoWallet(new PrivateKey(7))
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
      const wallet = {
        abortAction,
        listActions,
        createHmac: admin.createHmac.bind(admin),
        verifyHmac: admin.verifyHmac.bind(admin)
      }
      return { wallet: wallet as never, abortAction, admin }
    }

    it('never invokes the underlying abortAction for a forged, but genuinely-tagged, Vault reference', async () => {
      const { wallet, abortAction, admin } = vaultTaggedWallet()
      const guarded = guardVaultAccess(wallet, ADMIN_ORIGINATOR)

      const storage = fakeStorage()
      // Imported constant, not a copy-pasted string — this is exactly what a
      // raw KV edit forging the (now load-bearing) admin originator produces.
      // Genuinely tagged: this proves the vault-inventory check refuses it on
      // its OWN merits, independent of the authority-tag layer below.
      const tag = await computePendingAbortAuthorityTag(admin, ADMIN_ORIGINATOR, 'vault-ref-1')
      storage.map.set(
        PENDING_ABORTS_KEY,
        JSON.stringify([{ reference: 'vault-ref-1', originator: ADMIN_ORIGINATOR, tag }])
      )

      await replayPendingAborts({ wallet: guarded as never, storage })

      expect(abortAction).not.toHaveBeenCalled()
      // Refused by the vault guard, not dropped as untrusted: kept for the
      // next replay attempt, exactly like any other abort that failed.
      expect(await loadPendingAborts(storage)).toEqual([
        { reference: 'vault-ref-1', originator: ADMIN_ORIGINATOR, tag }
      ])
    })

    // XR-102 (non-Vault residual): this is the exact gap the completeness
    // critic flagged — a forged pending_aborts entry naming a live, ORDINARY
    // (non-Vault) reference has no settlement row and no vault-inventory
    // entry, so nothing but the authority tag can tell it apart from a
    // genuine queued abort. Untagged, it must be dropped, never replayed.
    it('XR-102: drops an UNTAGGED, forged non-Vault reference instead of replaying it', async () => {
      const { wallet, abortAction } = vaultTaggedWallet()
      const guarded = guardVaultAccess(wallet, ADMIN_ORIGINATOR)

      const storage = fakeStorage()
      storage.map.set(
        PENDING_ABORTS_KEY,
        JSON.stringify([{ reference: 'localpay-ref-1', originator: 'forged.example' }])
      )

      const result = await replayPendingAborts({ wallet: guarded as never, storage })

      expect(abortAction).not.toHaveBeenCalled()
      expect(result).toEqual({ droppedUntrusted: 1 })
      expect(await loadPendingAborts(storage)).toEqual([])
    })

    it('still replays a genuinely-tagged, ordinary non-Vault reference through the same guarded wallet', async () => {
      const { wallet, abortAction, admin } = vaultTaggedWallet()
      const guarded = guardVaultAccess(wallet, ADMIN_ORIGINATOR)

      const storage = fakeStorage()
      const tag = await computePendingAbortAuthorityTag(admin, ADMIN_ORIGINATOR, 'localpay-ref-1')
      storage.map.set(
        PENDING_ABORTS_KEY,
        JSON.stringify([{ reference: 'localpay-ref-1', originator: ADMIN_ORIGINATOR, tag }])
      )

      await replayPendingAborts({ wallet: guarded as never, storage })

      expect(abortAction).toHaveBeenCalledWith({ reference: 'localpay-ref-1' }, ADMIN_ORIGINATOR)
      expect(await loadPendingAborts(storage)).toEqual([])
    })
  })

  it('keeps an abort that still fails', async () => {
    const storage = fakeStorage()
    const wallet = authorityWallet()
    await queuePendingAbort(storage, { reference: 'ref-stuck', originator: 'admin.com' }, { wallet, originator: ADMIN_ORIGINATOR })
    const abortAction = jest.fn().mockResolvedValue({ aborted: false })
    const replayWallet = { abortAction, createHmac: wallet.createHmac.bind(wallet), verifyHmac: wallet.verifyHmac.bind(wallet) }
    await replayPendingAborts({ wallet: replayWallet, storage })
    const loaded = await loadPendingAborts(storage)
    expect(loaded).toEqual([{ reference: 'ref-stuck', originator: 'admin.com', tag: expect.any(String) }])
  })

  it('does not duplicate the same reference', async () => {
    const storage = fakeStorage()
    const auth = authority()
    await queuePendingAbort(storage, { reference: 'ref-1', originator: 'admin.com' }, auth)
    await queuePendingAbort(storage, { reference: 'ref-1', originator: 'admin.com' }, auth)
    expect(await loadPendingAborts(storage)).toHaveLength(1)
  })

  // XR-088. queuePendingAbort and replayPendingAborts were each a bare
  // load-then-setKeyValue on the SAME PENDING_ABORTS_KEY, with no lock
  // between them (unlike core/localpay/pending.ts's withQueueLock, which
  // this codebase already uses for exactly this shape of race). A queue that
  // starts while a replay is still in flight would build its own read from
  // whatever was on disk before replay's read, and lose one of the two
  // writes silently, whichever landed last.
  it('XR-088: a queue that starts while a replay is in flight does not lose either reference', async () => {
    const wallet = authorityWallet()
    const oldTag = await computePendingAbortAuthorityTag(wallet, ADMIN_ORIGINATOR, 'ref-old')
    const map = new Map<string, string>()
    map.set(PENDING_ABORTS_KEY, JSON.stringify([{ reference: 'ref-old', originator: 'admin.com', tag: oldTag }]))

    let replayReachedWrite!: () => void
    const replayAtWrite = new Promise<void>(r => {
      replayReachedWrite = r
    })
    let releaseReplayWrite!: () => void
    const replayWriteGate = new Promise<void>(r => {
      releaseReplayWrite = r
    })
    let writes = 0

    const storage = {
      map,
      getKeyValue: async (k: string) => map.get(k),
      setKeyValue: async (k: string, v: string) => {
        writes++
        if (writes === 1) {
          // This is replay's own write — pause it right here, the same
          // "before the final setKeyValue" window the row's own
          // regression_test_plan names.
          replayReachedWrite()
          await replayWriteGate
        }
        map.set(k, v)
      }
    }

    const abortAction = jest.fn().mockResolvedValue({ aborted: true })
    const replayWallet = { abortAction, createHmac: wallet.createHmac.bind(wallet), verifyHmac: wallet.verifyHmac.bind(wallet) }

    const replay = replayPendingAborts({ wallet: replayWallet, storage })
    await replayAtWrite

    // Not awaited yet: under the fix this call must queue behind the
    // still-in-flight replay and only run once the gate below is released —
    // awaiting it here would hang the fixed version forever.
    const queued = queuePendingAbort(
      storage,
      { reference: 'ref-new', originator: 'admin.com' },
      { wallet, originator: ADMIN_ORIGINATOR }
    )

    releaseReplayWrite()
    await replay
    await queued

    // Not just "ref-new survives" — 'ref-old' aborted successfully and must
    // actually be gone, not resurrected by a queue that read a stale
    // snapshot from before replay's write landed.
    const all = JSON.parse(map.get(PENDING_ABORTS_KEY)!) as { reference: string }[]
    expect(all.map(x => x.reference)).toEqual(['ref-new'])
  })

  // XR-088 (SEC1-026's other, separately-named defect): a transient read or
  // parse failure used to be silently normalized to an empty array, and
  // queuePendingAbort would then overwrite PENDING_ABORTS_KEY with just the
  // new item — permanently erasing every other durable, not-yet-replayed
  // abort reference already on disk. A read failure must instead fail the
  // queue call itself, so nothing already on disk is ever touched.
  it('XR-088: a transient read failure never overwrites the existing queue', async () => {
    const map = new Map<string, string>()
    // A genuinely different, already-durably-queued reference sitting on
    // "disk" the whole time — this must survive.
    map.set(PENDING_ABORTS_KEY, JSON.stringify([{ reference: 'ref-already-queued', originator: 'admin.com' }]))
    let fail = true
    const storage = {
      map,
      getKeyValue: async (k: string) => {
        if (fail) throw new Error('storage read failed')
        return map.get(k)
      },
      setKeyValue: async (k: string, v: string) => void map.set(k, v)
    }

    await expect(
      queuePendingAbort(storage, { reference: 'ref-new', originator: 'admin.com' }, authority())
    ).rejects.toThrow()

    // Not overwritten: the pre-existing reference is exactly as it was, and
    // the new one was never queued (the caller's own best-effort retry logic
    // is what tries again later, not this call silently losing state).
    const stillThere = JSON.parse(map.get(PENDING_ABORTS_KEY)!) as { reference: string }[]
    expect(stillThere.map(x => x.reference)).toEqual(['ref-already-queued'])

    fail = false
    expect(await loadPendingAborts(storage)).toEqual([{ reference: 'ref-already-queued', originator: 'admin.com' }])
  })

  it('XR-088: a corrupt (non-JSON) queue value also fails the call rather than overwriting it', async () => {
    const map = new Map<string, string>()
    map.set(PENDING_ABORTS_KEY, 'not valid json{{{')
    const storage = {
      map,
      getKeyValue: async (k: string) => map.get(k),
      setKeyValue: async (k: string, v: string) => void map.set(k, v)
    }

    await expect(
      queuePendingAbort(storage, { reference: 'ref-new', originator: 'admin.com' }, authority())
    ).rejects.toThrow()

    // The corrupt value is left exactly as found, not replaced by `[item]`.
    expect(map.get(PENDING_ABORTS_KEY)).toBe('not valid json{{{')
  })

  it('XR-088: a queue value that is not an array also fails the call rather than overwriting it', async () => {
    const map = new Map<string, string>()
    map.set(PENDING_ABORTS_KEY, JSON.stringify({ not: 'an array' }))
    const storage = {
      map,
      getKeyValue: async (k: string) => map.get(k),
      setKeyValue: async (k: string, v: string) => void map.set(k, v)
    }

    await expect(
      queuePendingAbort(storage, { reference: 'ref-new', originator: 'admin.com' }, authority())
    ).rejects.toThrow()

    expect(map.get(PENDING_ABORTS_KEY)).toBe(JSON.stringify({ not: 'an array' }))
  })

  it('a genuinely empty (never-written) queue still queues normally', async () => {
    const storage = fakeStorage()
    await queuePendingAbort(storage, { reference: 'ref-1', originator: 'admin.com' }, authority())
    expect(await loadPendingAborts(storage)).toEqual([
      { reference: 'ref-1', originator: 'admin.com', tag: expect.any(String) }
    ])
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

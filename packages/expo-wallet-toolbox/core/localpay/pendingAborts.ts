/**
 * Durable retry list for `abortAction` calls that failed after a decline.
 *
 * A failed abort is a stuck UTXO, not a lost payment. The decline still
 * stands; the reference is retried on the next wallet build.
 */
import { ADMIN_ORIGINATOR, LEGACY_ADMIN_ORIGINATOR } from '../config'
import { VAULT_ABORT_REPLAY_MARKER } from '../services/vault/guard'
import {
  computePendingAbortAuthorityTag,
  verifyPendingAbortAuthorityTag,
  type PendingAbortTagWallet,
  type PendingAbortVerifyWallet
} from './pendingAbortAuthority'

interface StorageLike {
  getKeyValue: (key: string) => Promise<string | undefined>
  setKeyValue: (key: string, value: string) => Promise<void>
}

export const PENDING_ABORTS_KEY = 'pending_aborts'

export interface PendingAbort {
  reference: string
  originator: string
  /** XR-102: HMAC over `reference`, computed by `queuePendingAbort` with the
   * ADMIN-scoped wallet under the reserved `pending abort authority`
   * namespace (see pendingAbortAuthority.ts). Absent on a legacy pre-XR-102
   * entry or a forged one — `replayPendingAborts` drops either, never
   * replays them. */
  tag?: string
}

function messageOf(e: unknown): string {
  return e instanceof Error && e.message ? e.message : String(e)
}

// XR-088: every read-modify-write sequence on PENDING_ABORTS_KEY shares one
// storage key, so they must not interleave — a concurrent write built from a
// stale read silently drops (or resurrects) an entry. `queuePendingAbort` and
// `replayPendingAborts` each used to be a bare load-then-setKeyValue with no
// lock between them; both now run through this chain. Same pattern as
// core/localpay/pending.ts's own withQueueLock, for the identical reason.
let pendingAbortsLock: Promise<unknown> = Promise.resolve()

function withPendingAbortsLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = pendingAbortsLock.then(fn, fn)
  pendingAbortsLock = run.catch(() => undefined)
  return run
}

/** XR-088 (SEC1-026's own second, separately-named defect): a sentinel that
 * distinguishes "the key is genuinely absent/empty" from "the read or parse
 * itself failed" — the two used to be collapsed into the same `[]`, which let
 * `queuePendingAbort` treat a transient storage hiccup as an authoritative
 * empty queue and overwrite every other durable, not-yet-replayed reference
 * with just the one item it was trying to add. */
const READ_FAILED = Symbol('pending-aborts-read-failed')

function parsePendingAborts(parsed: unknown): PendingAbort[] | typeof READ_FAILED {
  if (!Array.isArray(parsed)) return READ_FAILED
  const out: PendingAbort[] = []
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue
    const reference = (item as { reference?: unknown }).reference
    const originator = (item as { originator?: unknown }).originator
    const tag = (item as { tag?: unknown }).tag
    if (typeof reference === 'string' && reference && typeof originator === 'string') {
      out.push({
        reference,
        // An abort queued before the internal label moved into hostname space
        // would otherwise fail originator validation on every replay, forever.
        originator: originator === LEGACY_ADMIN_ORIGINATOR ? ADMIN_ORIGINATOR : originator,
        ...(typeof tag === 'string' && tag ? { tag } : {})
      })
    }
  }
  return out
}

async function loadPendingAbortsOrFail(storage: StorageLike): Promise<PendingAbort[] | typeof READ_FAILED> {
  let raw: string | undefined
  try {
    raw = await storage.getKeyValue(PENDING_ABORTS_KEY)
  } catch (e) {
    console.warn('[localpay] could not read the pending-abort queue:', messageOf(e))
    return READ_FAILED
  }
  if (!raw) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    console.warn('[localpay] the pending-abort queue is not valid JSON:', messageOf(e))
    return READ_FAILED
  }
  return parsePendingAborts(parsed)
}

export async function loadPendingAborts(storage: StorageLike): Promise<PendingAbort[]> {
  const result = await loadPendingAbortsOrFail(storage)
  return result === READ_FAILED ? [] : result
}

export async function queuePendingAbort(
  storage: StorageLike,
  item: PendingAbort,
  /** XR-102: the ADMIN-scoped wallet (and its originator) this entry's
   * authenticity tag is computed with — every real call site already has
   * one, since it is the same wallet `abortAction` itself is called on. */
  authority: { wallet: PendingAbortTagWallet; originator: string }
): Promise<void> {
  if (!item.reference) return
  return withPendingAbortsLock(async () => {
    const loaded = await loadPendingAbortsOrFail(storage)
    if (loaded === READ_FAILED) {
      // XR-088: never overwrite on a read/parse failure — fail this queue
      // call instead. Every real call site already wraps queuePendingAbort in
      // its own best-effort `.catch()`, so this costs exactly one reference
      // not being queued THIS attempt (the same outcome a rejected write
      // would have had); what it does NOT cost is every other, unrelated,
      // already-durable abort reference silently erased underneath it.
      throw new Error('pending_aborts: could not read the existing queue, refusing to overwrite it')
    }
    if (loaded.some(a => a.reference === item.reference)) return
    let tag: string | undefined
    try {
      tag = await computePendingAbortAuthorityTag(authority.wallet, authority.originator, item.reference)
    } catch (e) {
      // An untagged entry can never pass replayPendingAborts's verification
      // (below) and so can never auto-release — but it is still worth
      // recording durably rather than losing the reference outright: it stays
      // visible, and a stuck `nosend` row remains recoverable through
      // WalletHomeScreen's manual per-row abort, which does not go through
      // this queue or its authority check at all.
      console.warn('[localpay] could not tag a pending abort for authenticated replay:', messageOf(e))
    }
    await storage.setKeyValue(PENDING_ABORTS_KEY, JSON.stringify([...loaded, { ...item, ...(tag ? { tag } : {}) }]))
  })
}

export interface ReplayPendingAbortsResult {
  /** XR-102: entries dropped because their authority tag was missing or did
   * not verify — never replayed, never called abortAction. Surfaced so the
   * UI can tell the user something was ignored, in case it corresponds to a
   * payment that now looks stuck (still recoverable via WalletHomeScreen's
   * per-row Cancel, which does not depend on this queue). */
  droppedUntrusted: number
}

export async function replayPendingAborts(args: {
  wallet: {
    abortAction: (
      args: { reference: string; [VAULT_ABORT_REPLAY_MARKER]?: true },
      originator?: string
    ) => Promise<{ aborted?: boolean } | void>
  } & PendingAbortVerifyWallet
  storage: StorageLike
}): Promise<ReplayPendingAbortsResult> {
  return withPendingAbortsLock(async () => {
    const pending = await loadPendingAborts(args.storage)
    if (pending.length === 0) return { droppedUntrusted: 0 }
    const kept: PendingAbort[] = []
    let droppedUntrusted = 0
    for (const item of pending) {
      // XR-102 (non-Vault residual): the vault-inventory replay marker below
      // only protects a Vault reference — an ordinary localpay/PeerPay
      // reference has no settlement row and no vault-inventory entry, so
      // nothing else stops a forged `pending_aborts` entry naming one from
      // being replayed. Authenticate first: an entry this wallet did not
      // itself tag at queue time (queuePendingAbort) is dropped, never
      // replayed — fail closed, since the only thing a replay ever does is
      // free a reservation, and a dropped reference stays recoverable through
      // WalletHomeScreen's manual per-row abort.
      const authentic = await verifyPendingAbortAuthorityTag(args.wallet, ADMIN_ORIGINATOR, item.reference, item.tag)
      if (!authentic) {
        droppedUntrusted++
        continue
      }
      try {
        // XR-102: the persisted `originator` is never trusted here — this is a
        // raw KV record, writable by anything with local storage access, and a
        // forged admin-originator string used to replay straight past
        // guardVaultAccess's inventory check. The ONLY originator ever used to
        // replay is the real, imported constant every legitimate queued abort
        // was already created under (see queuePendingAbort's call sites — all
        // pass `adminOriginator`), never the field read back off disk.
        //
        // That alone is not enough: `assertPendingActionOriginator` requires
        // this exact originator for a legitimate replay to succeed at all, and
        // guardVaultAccess treats every admin-originator call as trusted. The
        // marker opts this specific call OUT of that trust and into the same
        // vault-inventory reference check a non-admin caller gets — so a
        // reference an attacker injected that happens to name a Vault action is
        // refused, while an ordinary (and authentically-tagged) localpay/
        // PeerPay reference still replays.
        const result = await args.wallet.abortAction(
          { reference: item.reference, [VAULT_ABORT_REPLAY_MARKER]: true },
          ADMIN_ORIGINATOR
        )
        if (result && typeof result === 'object' && result.aborted === false) {
          kept.push(item)
        }
      } catch {
        kept.push(item)
      }
    }
    await args.storage.setKeyValue(PENDING_ABORTS_KEY, JSON.stringify(kept))
    return { droppedUntrusted }
  })
}

/**
 * Durable watch list for a DECLINED payment (build.ts's `finalizeDelivery`)
 * whose txid might, despite the decline, still reach the chain.
 *
 * A negative ack is the payee's own unverifiable claim that nothing was
 * queued — this codebase's own abort-chain-protection only refuses an abort
 * while a service is reachable AND the chain already knows the tx, so a
 * decline made while offline (or a dishonest one) still releases the payer's
 * inputs. Policy here is detect-and-warn, never block: the inputs are freed
 * immediately either way, exactly as before this existed, and this list only
 * exists so a later reappearance of that same txid on chain can be surfaced
 * rather than silently missed — see `verifyDeclinedAborts`.
 */
export const DECLINED_ABORT_WATCH_KEY = 'declined_abort_watch'

export interface DeclinedAbortWatch {
  txid: string
  reference: string
  /** Best-effort; presentational only, never used to key the watch itself. */
  peerIdentityKey?: string
  /** `Date.now()` when the decline was recorded, for the bounded-age drop. */
  at: number
}

/** How long an unresolved watch entry is kept before it is dropped unsurfaced. */
export const DECLINED_ABORT_WATCH_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

export async function loadDeclinedAbortWatch(storage: StorageLike): Promise<DeclinedAbortWatch[]> {
  try {
    const raw = await storage.getKeyValue(DECLINED_ABORT_WATCH_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    const out: DeclinedAbortWatch[] = []
    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue
      const { txid, reference, peerIdentityKey, at } = item as Record<string, unknown>
      if (typeof txid === 'string' && txid && typeof reference === 'string' && typeof at === 'number') {
        out.push({ txid, reference, at, ...(typeof peerIdentityKey === 'string' ? { peerIdentityKey } : {}) })
      }
    }
    return out
  } catch {
    return []
  }
}

export async function queueDeclinedAbortWatch(storage: StorageLike, item: DeclinedAbortWatch): Promise<void> {
  if (!item.txid) return
  const all = await loadDeclinedAbortWatch(storage)
  if (all.some(a => a.txid === item.txid)) return
  await storage.setKeyValue(DECLINED_ABORT_WATCH_KEY, JSON.stringify([...all, item]))
}

/**
 * Asks the network about every watched txid and returns the ones it now
 * reports mined or known — a declined payment that went through anyway.
 * Those are removed from the watch list (surfaced once, not repeatedly); an
 * unresolved one is kept, up to `DECLINED_ABORT_WATCH_MAX_AGE_MS`, after which
 * it is dropped unsurfaced rather than watched forever. An honest decline,
 * where the network never reports the txid, never surfaces anything.
 *
 * `getStatusForTxids` is the exact call this codebase already makes for the
 * same question elsewhere (core/storage/methods/processOfflineActions.ts's
 * `networkAlreadyHas`) — injected here rather than imported so this stays
 * unit-testable without a real storage/services object.
 */
export async function verifyDeclinedAborts(args: {
  storage: StorageLike
  getStatusForTxids: (txids: string[]) => Promise<{ results?: { txid: string; status: string }[] }>
}): Promise<DeclinedAbortWatch[]> {
  const watched = await loadDeclinedAbortWatch(args.storage)
  if (watched.length === 0) return []
  const now = Date.now()
  const surfaced: DeclinedAbortWatch[] = []
  const kept: DeclinedAbortWatch[] = []
  for (const item of watched) {
    let status: string | undefined
    try {
      const r = await args.getStatusForTxids([item.txid])
      status = r.results?.find(x => x.txid === item.txid)?.status
    } catch {
      // Treat a failed probe as still-unknown, not as a negative result —
      // the next reconnect tries again.
      status = undefined
    }
    if (status === 'mined' || status === 'known') {
      surfaced.push(item)
      continue
    }
    if (now - item.at < DECLINED_ABORT_WATCH_MAX_AGE_MS) kept.push(item)
  }
  await args.storage.setKeyValue(DECLINED_ABORT_WATCH_KEY, JSON.stringify(kept))
  return surfaced
}

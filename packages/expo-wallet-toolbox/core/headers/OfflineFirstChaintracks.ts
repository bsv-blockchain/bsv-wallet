/**
 * The chain tracker the wallet uses. Answers merkle roots from the local header
 * window first, the network second, and nothing at all when offline and the
 * height is outside the window.
 *
 * This is the single seam that makes offline payments possible: both BEEF
 * verification call sites — `signer/methods/internalizeAction.js:96` and
 * `storage/methods/createAction.js:495` — reach it through
 * `Services.getChainTracker()`, which wraps whatever sits in
 * `options.chaintracks` (`services/Services.js:149-154`).
 *
 * On a miss it calls `findHeaderForHeight` rather than the remote's own
 * `isValidRootForHeight`, because we want the root itself to cache — a coin
 * whose ancestry we resolved once should verify offline forever after.
 */
import { Utils } from '@bsv/sdk'
import { utils as chaintracksUtils, type Chain, type ChaintracksClientApi } from '@bsv/wallet-toolbox-mobile'
import type { HeaderStore } from './headerStore'

const { blockHash, validateHeaderProofOfWork } = chaintracksUtils

/** A merkle root as display-order hex, whether the source gave us a hex string
 * or raw bytes. The remote's `findHeaderForHeight` may return either; plain
 * `String(bytes)` yields "1,2,3,…" which never matches a real root — the source
 * of a chain-tracker that rejects valid proofs. Mirrors the toolbox's own
 * `asString(merkleRoot)`. */
function rootHex(v: unknown): string {
  return typeof v === 'string' ? v : Utils.toHex(Array.from(v as ArrayLike<number>))
}

/** Handed out when the remote cannot subscribe; never reaches the remote. */
const INERT_SUBSCRIPTION_PREFIX = 'offline-first:inert:'

export class OfflineFirstChaintracks implements ChaintracksClientApi {
  private store: HeaderStore | undefined
  /**
   * Height of the most recent root we could not resolve. The UI reads it to
   * explain a refusal ("this coin's history is older than the headers on this
   * device") instead of showing a bare verification failure.
   */
  lastMissHeight: number | undefined

  private inertSubscriptions = 0

  /**
   * @param chain The chain the remote serves. When given, `getChain` answers
   * from it instead of asking the network.
   */
  constructor(
    private readonly remote: ChaintracksClientApi,
    private readonly online: () => Promise<boolean>,
    private readonly chain?: Chain
  ) {}

  /** Consume the most recent unresolved height, if any. Kept for tests; classifiers must peek. */
  takeLastMissHeight(): number | undefined {
    const height = this.lastMissHeight
    this.lastMissHeight = undefined
    return height
  }

  /** Read the most recent unresolved height without clearing it. */
  peekLastMissHeight(): number | undefined {
    return this.lastMissHeight
  }

  setStore(store: HeaderStore): void {
    this.store = store
  }

  async isValidRootForHeight(root: string, height: number): Promise<boolean> {
    // Fast path: a local root that AGREES is trusted offline forever (validated
    // window headers, or a previously-resolved root).
    const local = this.store?.rootForHeight(height)
    if (local === root) return true

    // A DISAGREEMENT for a height the window has already PoW-validated (its
    // body — everything except the last 6 heights) is refused outright: no
    // remote lookup, no putExtraRoot. Either the window is right and the BEEF
    // is lying, or the window is corrupt — deferring to an unauthenticated
    // network answer and caching it over headers we linked ourselves is
    // exactly the hole this closes (misc-p2-02; a MITM has the same power as a
    // compromised chaintracks deployment absent TLS pinning, misc-p2-13).
    // Everything else — the last-6 reorg tail, and any height the window does
    // not cover at all — keeps the old behaviour below: a disagreement can be
    // a stale/poisoned cache entry or a legitimate reorg, so it falls through
    // to the authoritative network.
    if (local !== undefined && this.store?.isWindowBody(height)) {
      console.warn(
        `[OfflineFirstChaintracks] REFUSED height ${height}: window-covered mismatch ` +
          `(local=${local} wanted=${root}); not consulting the network.`
      )
      this.lastMissHeight = height
      return false
    }

    if (!(await this.online())) {
      // Logged, because this branch is otherwise indistinguishable from a bad
      // proof: it returns false without consulting anything, and the caller
      // (`Beef.verify` -> the toolbox's validateAtomicBeef) reports that as
      // "The tx parameter must be valid AtomicBEEF". A device whose NetInfo
      // says not-connected therefore rejects every incoming payment with an
      // error blaming the sender's transaction, silently and forever.
      console.warn(
        `[OfflineFirstChaintracks] REFUSED height ${height}: offline (getOnline() false), no lookup attempted. ` +
          'BEEF verification will fail and be reported as an invalid transaction.'
      )
      this.lastMissHeight = height
      return false
    }

    try {
      const header = await this.remote.findHeaderForHeight(height)
      if (!header) {
        console.warn(
          `[OfflineFirstChaintracks] REFUSED height ${height}: the chaintracks service has no header ` +
            'for it (behind the chain tip, or pruned).'
        )
        this.lastMissHeight = height
        return false
      }

      // XR-068: outside the PoW-validated window body (a miss entirely, or the
      // last-6 reorg tail) this response is otherwise a bare, unauthenticated
      // claim from a single chaintracks call — exactly what a compromised or
      // MITM'd deployment would need to make a forged BEEF root verify. Never
      // trust the remote's self-reported `header.hash`: recompute it from the
      // header's own fields (the same way HeaderStore.append does for window
      // headers) and require it to satisfy its own declared difficulty. This
      // does not establish chain-of-custody back to a trusted anchor — it
      // only turns a zero-cost forgery into one that needs a real,
      // difficulty-valid header.
      let computedHash: string
      try {
        computedHash = blockHash(header)
        validateHeaderProofOfWork({ ...header, hash: computedHash })
      } catch (e: any) {
        console.warn(
          `[OfflineFirstChaintracks] REFUSED height ${height}: chaintracks-reported header failed ` +
            `proof-of-work validation (${e?.message ?? e}).`
        )
        this.lastMissHeight = height
        return false
      }

      const remoteRoot = rootHex(header.merkleRoot)
      // Refresh the cache with the authoritative value (self-heals a poisoned
      // extra entry from an earlier bad conversion).
      await this.store?.putExtraRoot(height, remoteRoot)
      if (local !== undefined && local !== remoteRoot) {
        console.warn(
          `[OfflineFirstChaintracks] local root disagreed with network at height ${height} (local=${local} network=${remoteRoot}); healed`
        )
      }
      const agrees = remoteRoot === root
      if (!agrees) {
        // The comparison is ===, so a root that is "correct" to the eye still
        // fails on hex case or byte order. Print both to make which one it is
        // obvious from a device log.
        console.warn(
          `[OfflineFirstChaintracks] REFUSED height ${height}: root mismatch\n` +
            `  wanted (from the BEEF's merkle path): ${root}\n` +
            `  got    (from chaintracks)           : ${remoteRoot}`
        )
      }
      return agrees
    } catch (e: any) {
      // A verification path must never throw a network error at the caller:
      // `Beef.verify` treats false as "not proven", which is the truth here.
      console.warn('[OfflineFirstChaintracks] isValidRootForHeight lookup failed:', e?.message)
      this.lastMissHeight = height
      return false
    }
  }

  async currentHeight(): Promise<number> {
    if (await this.online()) return await this.remote.currentHeight()
    return this.store?.tipHeight ?? 0
  }

  /**
   * The remote's own answer. `false` (the HTTP ChaintracksServiceClient) tells
   * the Monitor and other toolbox consumers not to subscribe at all.
   */
  get supportsReorgEvents(): boolean | undefined {
    return this.remote.supportsReorgEvents
  }

  // The toolbox Monitor passes this object as `chaintracksWithEvents` and, unless
  // `supportsReorgEvents` is false, calls `getChain` and both subscriptions from
  // every `runOnce` (via `Monitor.ready`) until they succeed. A rejection there
  // stopped the whole task loop in 2.13 and is retried, with a network
  // `getChain`, on every tick since 2.14, so these three answer offline and
  // never reject. TaskReviewProvenTxs remains the reorg audit without live events.
  async getChain(): Promise<Chain> {
    return this.chain ?? (await this.remote.getChain())
  }
  async subscribeHeaders(listener: Parameters<ChaintracksClientApi['subscribeHeaders']>[0]): Promise<string> {
    try {
      return await this.remote.subscribeHeaders(listener)
    } catch (e: any) {
      return this.inertSubscription('headers', e)
    }
  }
  async subscribeReorgs(listener: Parameters<ChaintracksClientApi['subscribeReorgs']>[0]): Promise<string> {
    try {
      return await this.remote.subscribeReorgs(listener)
    } catch (e: any) {
      return this.inertSubscription('reorgs', e)
    }
  }
  async unsubscribe(subscriptionId: string): Promise<boolean> {
    if (subscriptionId.startsWith(INERT_SUBSCRIPTION_PREFIX)) return true
    return await this.remote.unsubscribe(subscriptionId)
  }
  private inertSubscription(kind: string, e: any): string {
    console.warn(`[OfflineFirstChaintracks] ${kind} subscription unavailable, no live events: ${e?.message ?? e}`)
    return `${INERT_SUBSCRIPTION_PREFIX}${kind}:${++this.inertSubscriptions}`
  }

  // ── Everything below is pure delegation ───────────────────────────────────
  getInfo() {
    return this.remote.getInfo()
  }
  getPresentHeight() {
    return this.remote.getPresentHeight()
  }
  getHeaders(height: number, count: number) {
    return this.remote.getHeaders(height, count)
  }
  findChainTipHeader() {
    return this.remote.findChainTipHeader()
  }
  findChainTipHash() {
    return this.remote.findChainTipHash()
  }
  findHeaderForHeight(height: number) {
    return this.remote.findHeaderForHeight(height)
  }
  findHeaderForBlockHash(hash: string) {
    return this.remote.findHeaderForBlockHash(hash)
  }
  addHeader(header: Parameters<ChaintracksClientApi['addHeader']>[0]) {
    return this.remote.addHeader(header)
  }
  startListening() {
    return this.remote.startListening()
  }
  listening() {
    return this.remote.listening()
  }
  isListening() {
    return this.remote.isListening()
  }
  isSynchronized() {
    return this.remote.isSynchronized()
  }
}

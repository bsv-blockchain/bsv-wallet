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
import type { Chain, ChaintracksClientApi } from '@bsv/wallet-toolbox-mobile'
import type { HeaderStore } from './headerStore'

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
    // window headers, or a previously-resolved root). We do NOT trust a local
    // DISAGREEMENT — it can be a stale/poisoned cache entry or an index error —
    // so a miss OR a mismatch both fall through to the authoritative network.
    const local = this.store?.rootForHeight(height)
    if (local === root) return true

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

  // The toolbox Monitor passes this object as `chaintracksWithEvents` and, since
  // 2.13, awaits `getChain` and both subscriptions inside every `runOnce` (via
  // `Monitor.ready`). A network call or a throw there stops the whole task loop,
  // not just live reorg events, so these three must answer offline and never
  // reject. TaskReviewProvenTxs remains the reorg audit without live events.
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

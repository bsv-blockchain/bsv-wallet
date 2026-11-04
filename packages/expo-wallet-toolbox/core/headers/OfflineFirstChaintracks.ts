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
 * Misses require a complete expected-difficulty/work-validated extension, or
 * a historical hash-link proof ending at a trusted checkpoint. Authenticated
 * roots remain available offline; isolated provider headers never suffice.
 */
import type { Chain, ChaintracksClientApi } from '@bsv/wallet-toolbox-mobile'
import { HeaderStore } from './headerStore'
import { syncHeaders } from './syncHeaders'
import { Utils } from '@bsv/sdk'

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
    if (this.chain && store.chain !== this.chain) throw new Error('Header store belongs to a different network')
    this.store = store
  }

  async isValidRootForHeight(root: string, height: number): Promise<boolean> {
    if (!Number.isSafeInteger(height) || height < 0 || !/^[0-9a-f]{64}$/.test(root)) return false
    const store = this.store
    const local = store?.rootForHeight(height)
    if (local === root) return true
    // Both checkpoint ancestors and the stable window body are authenticated.
    // An isolated network answer cannot override either commitment.
    if (local !== undefined && (height <= store!.anchor.height || store!.isWindowBody(height))) {
      this.lastMissHeight = height
      return false
    }
    if (!store || !(await this.online())) {
      this.lastMissHeight = height
      return false
    }
    try {
      if (height > store.anchor.height) {
        // Forward misses and reorg-tail disagreements share the full expected-
        // difficulty / accumulated-work synchronization path. A claimed height,
        // standalone header hash or provider chainWork is never an authority.
        await syncHeaders({ store, client: this.remote })
      } else {
        await store.withUpdateLock(async () => {
          while (store.rootForHeight(height) === undefined && store.nextHistoricalHeight >= height) {
            const end = store.nextHistoricalHeight
            const from = Math.max(0, end - HeaderStore.HISTORICAL_PAGE_HEADERS + 1)
            const count = end - from + 1
            const hex = await this.remote.getHeaders(from, count)
            if (hex.length !== count * 160 || !/^[0-9a-f]+$/i.test(hex)) {
              throw new Error('Historical chain proof unavailable or malformed')
            }
            await store.addHistoricalPage(new Uint8Array(Utils.toArray(hex, 'hex')), from)
          }
        })
      }
      const agrees = store.rootForHeight(height) === root
      if (!agrees) this.lastMissHeight = height
      return agrees
    } catch (error) {
      console.warn(
        '[OfflineFirstChaintracks] anchored header verification failed:',
        error instanceof Error ? error.message : String(error)
      )
      this.lastMissHeight = height
      return false
    }
  }

  /**
   * Verification height is the locally validated chain tip. An online refresh
   * can advance it only through consensus synchronization; a missing/failed
   * refresh leaves a conservative, potentially stale validated height.
   */
  async currentHeight(): Promise<number> {
    const store = this.store
    if (!store) throw new Error('Validated header store unavailable for verification height')
    if (await this.online()) {
      try {
        await syncHeaders({ store, client: this.remote })
      } catch (error) {
        console.warn(
          '[OfflineFirstChaintracks] height refresh unavailable; retaining validated tip:',
          error instanceof Error ? error.message : String(error)
        )
      }
    }
    return store.tipHeight
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

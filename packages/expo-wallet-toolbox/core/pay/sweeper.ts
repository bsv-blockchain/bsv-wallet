/**
 * The background address sweep.
 *
 * "Get paid → a conventional wallet" is: show the address, and money appears.
 * That means the sweep cannot live in a screen — the screen is exactly what the
 * user no longer has to visit — so this module is the callable pass and
 * WalletContext owns its lifecycle, beside the localpay retry loop that already
 * runs there.
 *
 * Every bound is deliberate and tested: see shouldSweepNow for when a pass may
 * run at all, and pay/watchlist.ts for which addresses it may touch.
 */
import { sweepAddress, WocRateLimited, type AddressRailWallet, type WocConfig } from './rails/address'
import { getWatchlist, touchWatched, type KVStorage } from './watchlist'

/**
 * One poll every 5s, foreground only (shouldSweepNow refuses in the background).
 *
 * An address payment announces itself to no one: unlike the handle and nearby
 * rails there is no MessageBox message to push, so the only way this wallet
 * learns of one is to look. 5s is what makes "show the address, money appears"
 * feel immediate to a user watching the screen. The cost is up to ~1.6 WhatsOnChain
 * requests/s on a device with the full 8 watched addresses, which is why the
 * requests carry the host's API key and a 429 backs the sweep off
 * (SWEEP_BACKOFF_TICKS) rather than being retried on the next tick.
 */
export const SWEEP_INTERVAL_MS = 5_000

/** Ticks to sit out after a WhatsOnChain 429: 30s at SWEEP_INTERVAL_MS. */
export const SWEEP_BACKOFF_TICKS = 6

/**
 * Spend one tick of a pending backoff. Pure so the caller's counter (a plain
 * variable in the sweep effect's closure) is tested here rather than through a
 * provider.
 */
export function consumeBackoff(remaining: number): { skip: boolean; remaining: number } {
  return remaining > 0 ? { skip: true, remaining: remaining - 1 } : { skip: false, remaining: 0 }
}

/**
 * The backoff after a failed pass: a full SWEEP_BACKOFF_TICKS for a rate limit,
 * unchanged for anything else (those stay best-effort — the next tick retries).
 */
export function backoffAfterSweepError(error: unknown, remaining: number): number {
  return error instanceof WocRateLimited ? SWEEP_BACKOFF_TICKS : remaining
}

export interface SweepOutcome {
  address: string
  importedSatoshis: number
  failureCount: number
}

/**
 * Whether a pass may run right now.
 *
 * Pure so the four conditions are stated in one place and tested: no polling
 * before the wallet exists, none in the background, none offline, and never two
 * at once (each pass writes to the wallet).
 */
export function shouldSweepNow(state: {
  walletBuilt: boolean
  appActive: boolean
  online: boolean
  inFlight: boolean
}): boolean {
  return state.walletBuilt && state.appActive && state.online && !state.inFlight
}

export async function runSweep(args: {
  wallet: AddressRailWallet
  storage: KVStorage
  adminOriginator: string
  woc: WocConfig
}): Promise<SweepOutcome[]> {
  const { wallet, storage, adminOriginator, woc } = args
  const outcomes: SweepOutcome[] = []

  for (const watched of await getWatchlist(storage)) {
    try {
      const { importedSatoshis, failureCount, foundOnChain } = await sweepAddress({
        wallet,
        adminOriginator,
        woc,
        address: watched.address,
        derivationPrefix: watched.derivationPrefix
      })
      outcomes.push({ address: watched.address, importedSatoshis, failureCount })
      // Money arrived here once, so it may again: keep this address alive
      // rather than retiring it the moment it pays out. A funded address whose
      // import failed must stay watched too, or a bad BEEF fetch TTL-drops it.
      if (importedSatoshis > 0 || foundOnChain) await touchWatched(storage, watched.address)
    } catch (error) {
      // A rate limit is the one failure that does stop the pass: the other
      // addresses would be refused the same way and only deepen the limit.
      if (error instanceof WocRateLimited) throw error
      // A dead WoC host or a locked wallet must not stop the rest of the pass.
      // The entry stays watched and the next pass retries it.
    }
  }

  return outcomes
}

export function sweptTotal(outcomes: SweepOutcome[]): number {
  return outcomes.reduce((sum, o) => sum + o.importedSatoshis, 0)
}

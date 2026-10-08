/**
 * Is the mounted storage the one this network's screens should be reading?
 *
 * A network switch tears the wallet down and rebuilds it, and for the length of
 * that rebuild the previous chain's storage is still mounted. Anything that
 * reads it in that window answers with the OLD chain's money: the balance, the
 * activity list, and the per-network balance cache the screen writes on the way
 * past — which is how a testnet wallet came to display a mainnet balance and a
 * mainnet list of payments.
 *
 * The app's chain names and the toolbox's do not match ('teratest' is 'ttn' and
 * 'scaletest' is 'regtest' to the toolbox), and storage records the toolbox's
 * name — it is built with `createStorageBaseOptions(walletChain)` — so the
 * comparison goes through the same mapping the wallet build uses.
 */

import { NETWORKS, isAppChain, type AppChain } from '../networks'

export type { AppChain } from '../networks'

/** The storage chain an app-level network is expected to be backed by. */
export function storageChainFor(network: AppChain | string): string | undefined {
  return isAppChain(network) ? NETWORKS[network].walletChain : undefined
}

/**
 * True only when `storage` is present AND belongs to `network`. A null storage
 * is not a match: there is nothing to read, which is different from — and
 * safer than — reading whatever was there before.
 */
export function storageMatchesNetwork(
  storage: { chain?: string } | null | undefined,
  network: AppChain | string
): boolean {
  if (!storage?.chain) return false
  return storage.chain === storageChainFor(network)
}

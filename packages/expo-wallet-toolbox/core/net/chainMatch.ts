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
 * The app's chain names and the toolbox's do not match ('teratest' is 'ttn' to
 * the toolbox, and both testnets share the 'test' storage chain), so the
 * comparison goes through the same mapping the wallet build uses.
 */

export type AppChain = 'main' | 'test' | 'teratest'

/** The storage chain an app-level network is expected to be backed by. */
export function storageChainFor(network: AppChain | string): string {
  return network === 'main' ? 'main' : 'test'
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

export type AppChain = 'main' | 'test' | 'teratest'

/**
 * The wallet-toolbox `Chain` type used by @bsv/wallet-toolbox-mobile.
 * Mirrors `Chain = 'main' | 'test' | 'ttn' | 'mock'` from the toolbox sdk.
 */
export type WalletChain = 'main' | 'test' | 'ttn'

/**
 * Map our app-level chain id to the wallet-toolbox `Chain` value.
 * The app persists/displays `'teratest'`, but the toolbox (and its default
 * wallet-client service paths — e.g. WhatsOnChain `api.woc-ttn.bsvblockchain.tech`)
 * identify TeraTestNet as `'ttn'`. Keep `'teratest'` for AsyncStorage keys,
 * env var names (`EXPO_PUBLIC_TERATEST_*`) and UI; convert only at toolbox boundaries.
 */
export function toWalletChain(chain: AppChain): WalletChain {
  return chain === 'teratest' ? 'ttn' : chain
}

export const DEFAULT_WAB_URL = 'noWAB'
export const DEFAULT_STORAGE_URL = 'local'
export const DEFAULT_MESSAGEBOX_URL = 'https://gmb.bsvblockchain.tech'
/**
 * Encrypted wallet-backup log.
 *
 * The backup endpoint is no longer a constant here: it is supplied by the host app
 * through `configureToolbox({ backupUrl })` and read back with `getBackupUrl()`.
 * See `toolboxConfig.ts` for why (Expo does not inline `EXPO_PUBLIC_*` inside
 * `node_modules`, so an env read in this package is empty in any host that
 * installs it from npm).
 *
 * The design intent is unchanged — the value is still not defaulted in code, so
 * every build states its endpoint. Only the speaker changed, from this package's
 * environment to the host's explicit call. `backupUrl: null` disables backup
 * entirely: no monitor task is registered and nothing is sent.
 *
 * The endpoint must be an origin with no trailing slash and no path: the
 * BRC-103/104 handshake is posted to the origin root, so a path prefix makes
 * every request fail authentication.
 */
export const DEFAULT_CHAIN: AppChain = 'main'
/**
 * Internal authority label passed only by the wallet shell.
 *
 * Keep this deliberately outside the hostname namespace. The permissions
 * manager grants this originator administrative access, so using an ordinary
 * DNS name would let whoever controls that host acquire the same authority
 * through a paired connection.
 */
export const ADMIN_ORIGINATOR = 'urn:bsv-wallet:internal-admin'

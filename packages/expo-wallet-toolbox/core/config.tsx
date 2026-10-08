import type { Chain as ToolboxChain } from '@bsv/wallet-toolbox-mobile'
import { NETWORKS, type AppChain } from './networks'

export type { AppChain, WalletChain } from './networks'

/**
 * Map our app-level chain id to the wallet-toolbox `Chain` value.
 * The app persists/displays `'teratest'` and `'scaletest'`, but the toolbox
 * identifies them as `'ttn'` and `'regtest'`. Keep the app names for
 * AsyncStorage keys, env var names (`EXPO_PUBLIC_TERATEST_*`) and UI; convert
 * only at toolbox boundaries.
 *
 * The one cast in the chain mapping: `'regtest'` joins the toolbox's `Chain`
 * in @bsv/wallet-toolbox 2.15.0 (bsv-blockchain/ts-stack#819). Only scaletest
 * maps to it, and scaletest is not available (NETWORKS.scaletest.available),
 * so the installed 2.14.x never receives it. Drop the cast when the
 * dependency is bumped.
 */
export function toWalletChain(chain: AppChain): ToolboxChain {
  return NETWORKS[chain].walletChain as ToolboxChain
}

export const DEFAULT_WAB_URL = 'noWAB'
export const DEFAULT_STORAGE_URL = 'local'
/** Mainnet's MessageBox server. Each network has its own: see `NETWORKS`. */
export const DEFAULT_MESSAGEBOX_URL = NETWORKS.main.messageBoxUrl
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
 * The permissions manager grants this originator administrative access, so it
 * must be a name no external caller can present. It used to sit outside the
 * hostname namespace altogether (`urn:bsv-wallet:internal-admin`), but
 * @bsv/sdk 2.8 accepts only canonical hostnames as originators. It now lives
 * in the RFC 6761 `.invalid` TLD, which never resolves, so no host can be
 * served from it, and `parseExternalOrigin` refuses that whole TLD at the
 * external trust boundary. An ordinary DNS name would let whoever controls
 * that host acquire the same authority through a paired connection.
 */
export const ADMIN_ORIGINATOR = 'internal-admin.bsv-wallet.invalid'

/** The label before @bsv/sdk 2.8, still found in data persisted by older builds. */
export const LEGACY_ADMIN_ORIGINATOR = 'urn:bsv-wallet:internal-admin'

/**
 * Per-network facts, in one table.
 *
 * Every place that used to branch on the network with a ternary (`main ? … :
 * test ? … : <teratest>`) reads it from here instead. The ternaries silently
 * sent any network they did not name to the last branch, which was harmless
 * while there were three and wrong the moment a fourth arrived: the scaling
 * teratestnet would have broadcast to teratest's Arcade and opened teratest's
 * database. A `Record<AppChain, …>` makes a missing network a type error.
 *
 * App ids vs toolbox ids: the app persists and displays its own names
 * (`'teratest'`, `'scaletest'` — AsyncStorage keys, database filenames, env var
 * names, the backup log), and the toolbox identifies the same chains as `'ttn'`
 * and `'regtest'`. Convert only at toolbox boundaries, with `toWalletChain`.
 *
 * This module is a leaf: it imports nothing, so `config.tsx`, `chainMatch.ts`
 * and the vault/backup modules can all depend on it without a cycle.
 */

export const APP_CHAINS = ['main', 'test', 'teratest', 'scaletest'] as const
export type AppChain = (typeof APP_CHAINS)[number]

/**
 * The wallet-toolbox `Chain` values this app uses.
 *
 * `'regtest'` is the chain the scaling teratestnet actually runs: Teranode
 * regtest parameters (regtest genesis, proof-of-work limit 0x207fffff), which
 * is not the toolbox's `'tstn'` (go-chaincfg TeraScalingTestNetParams, real
 * proof of work). The toolbox gains `'regtest'` in @bsv/wallet-toolbox 2.15.0
 * (bsv-blockchain/ts-stack#819); `toWalletChain` bridges the type until then.
 */
export type WalletChain = 'main' | 'test' | 'ttn' | 'regtest'

/** The overlay preset `@bsv/sdk`'s LookupResolver and the MessageBox client accept. */
export type OverlayPreset = 'mainnet' | 'testnet' | 'teratestnet' | 'local'

/** WhatsOnChain-compatible API for a network that has one. */
export interface WocEndpoints {
  /** API origin, no trailing slash. Requests go to `${apiBase}/v1/bsv/${segment}/…`. */
  apiBase: string
  /** The path segment: WoC serves teratest under `test`, too. */
  segment: 'main' | 'test'
  /** Explorer origin for transaction links. */
  explorerBase: string
}

export interface NetworkProfile {
  walletChain: WalletChain
  /**
   * Whether the network may be chosen in the picker. A network that is not
   * available keeps its whole configuration so it can be switched on in one
   * place, but no new wallet can be put on it.
   */
  available: boolean
  /** Default Arcade origin (broadcast, SSE, and `/chaintracks/v1`). */
  arcadeUrl: string
  /** Default MessageBox origin. Each network has its own server. */
  messageBoxUrl: string
  /** Undefined on a network with no WhatsOnChain: address rails, WoC proofs and explorer links are off. */
  woc?: WocEndpoints
  /** TAAL ARC broadcast fallback, where TAAL runs one. */
  taalArcUrl?: string
  /** GorillaPool ARC broadcast fallback, where GorillaPool runs one. */
  gorillaPoolArcUrl?: string
  /** Whether Bitails (the toolbox's built-in provider) serves this network. */
  bitails: boolean
  /**
   * The overlay preset for MessageBox / identity lookups.
   *
   * `'local'` marks a network with no overlay at all: nothing can be looked up
   * or advertised, so identity search is skipped and MessageBox routes only to
   * its configured host.
   */
  overlayPreset: OverlayPreset
  /** Whether the MessageBox server for this network sends push notifications. */
  push: boolean
}

export const NETWORKS: Record<AppChain, NetworkProfile> = {
  main: {
    available: true,
    walletChain: 'main',
    arcadeUrl: 'https://arcade-v2-us-1.bsvblockchain.tech',
    messageBoxUrl: 'https://messagebox.bsvblockchain.tech',
    woc: { apiBase: 'https://api.whatsonchain.com', segment: 'main', explorerBase: 'https://whatsonchain.com' },
    taalArcUrl: 'https://arc.taal.com',
    gorillaPoolArcUrl: 'https://arc.gorillapool.io',
    bitails: true,
    overlayPreset: 'mainnet',
    push: true
  },
  test: {
    available: true,
    walletChain: 'test',
    arcadeUrl: 'https://arcade-v2-testnet-us-1.bsvblockchain.tech',
    messageBoxUrl: 'https://messagebox-testnet.bsvblockchain.tech',
    woc: { apiBase: 'https://api.whatsonchain.com', segment: 'test', explorerBase: 'https://test.whatsonchain.com' },
    taalArcUrl: 'https://arc-test.taal.com',
    bitails: true,
    overlayPreset: 'testnet',
    push: false
  },
  teratest: {
    available: true,
    walletChain: 'ttn',
    arcadeUrl: 'https://arcade-v2-ttn-us-1.bsvblockchain.tech',
    messageBoxUrl: 'https://messagebox-ttn.bsvblockchain.tech',
    woc: {
      apiBase: 'https://api.woc-ttn.bsvblockchain.tech',
      segment: 'test',
      explorerBase: 'https://woc-ttn.bsvblockchain.tech'
    },
    bitails: false,
    overlayPreset: 'teratestnet',
    push: false
  },
  // The scaling teratestnet. Arcade, chaintracks and MessageBox only: there is
  // no WhatsOnChain, explorer or overlay for it.
  //
  // Not available yet. The deployed chain runs Teranode regtest parameters
  // (regtest genesis 0f9188f1…, bits 0x207fffff; its chaintracks reports
  // 'regtest'), so the toolbox chain is 'regtest', not 'tstn'. The installed
  // @bsv/wallet-toolbox-mobile 2.14.x has no 'regtest' chain and rejects every
  // header above the mainnet proof-of-work limit, so nothing on it can be
  // verified. Switch it on once the dependency is 2.15.0 or later
  // (bsv-blockchain/ts-stack#819).
  scaletest: {
    walletChain: 'regtest',
    available: false,
    arcadeUrl: 'https://arcade-tstn-us-1.bsvblockchain.tech',
    messageBoxUrl: 'https://messagebox-tstn.bsvblockchain.tech',
    bitails: false,
    overlayPreset: 'local',
    push: false
  }
}

export function isAppChain(value: unknown): value is AppChain {
  return typeof value === 'string' && (APP_CHAINS as readonly string[]).includes(value)
}

/** Whether the network has any overlay to look identities up in. */
export function hasOverlay(chain: AppChain): boolean {
  return NETWORKS[chain].overlayPreset !== 'local'
}

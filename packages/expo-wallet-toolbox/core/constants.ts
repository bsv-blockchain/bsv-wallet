/** Auto-approve transactions below this satoshi amount without showing the spend modal */
export const DEFAULT_AUTO_APPROVE_THRESHOLD = 100_000
/** Minimum milliseconds between auto-approved transactions (global, origin-agnostic) */
export const AUTO_APPROVE_COOLDOWN_MS = 10_000
/** AsyncStorage key for persisted auto-approve threshold */
export const AUTO_APPROVE_STORAGE_KEY = 'autoApproveThreshold'

/** AsyncStorage key for custom ARC URL override (per network) */
export const arcUrlStorageKey = (network: string) => `arc_custom_url_${network}`
/** AsyncStorage key for custom ARC API token override (per network) */
export const arcApiTokenStorageKey = (network: string) => `arc_custom_api_token_${network}`

/** Default ARC URLs per network */
export const DEFAULT_ARC_URLS: Record<string, string> = {
  main: 'https://arcade-v2-us-1.bsvblockchain.tech',
  test: 'https://arcade-v2-testnet-us-1.bsvblockchain.tech',
  teratest: 'https://arcade-v2-ttn-us-1.bsvblockchain.tech'
}

/** Known ARC endpoint presets (mainnet-focused, user edits for other regions) */
export const KNOWN_ARC_URLS = [
  { label: 'Arcade v2 (default)', url: 'https://arcade-v2-us-1.bsvblockchain.tech', requiresToken: false },
  { label: 'Arcade', url: 'https://arcade-us-1.bsvb.tech', requiresToken: false },
  { label: 'TAAL', url: 'https://arc.taal.com', requiresToken: true },
  { label: 'GorillaPool', url: 'https://arc.gorillapool.io', requiresToken: false }
]

/** Auto-approve transactions below this satoshi amount without showing the spend modal */
export const DEFAULT_AUTO_APPROVE_THRESHOLD = 100_000
/** Minimum milliseconds between two auto-approved transactions from the SAME originator */
export const AUTO_APPROVE_COOLDOWN_MS = 10_000
/** AsyncStorage key for persisted auto-approve threshold */
export const AUTO_APPROVE_STORAGE_KEY = 'autoApproveThreshold'
/**
 * Global rolling 24h cumulative cap (satoshis) on auto-approved spending,
 * across every originator combined — closes the gap where a single origin
 * (or several) could otherwise auto-approve an unbounded total by staying
 * under the per-request threshold and cooldown forever (misc-p2-04).
 *
 * PROVISIONAL: 10x the default per-request threshold, chosen only so the cap
 * cannot bind in ordinary single-payment use. Pending product sign-off on
 * the real number.
 */
export const AUTO_APPROVE_DAILY_CAP_SATS = 10 * DEFAULT_AUTO_APPROVE_THRESHOLD
/** AsyncStorage key for the persisted rolling auto-approve ledger (best-effort; survives app restart) */
export const AUTO_APPROVE_LEDGER_STORAGE_KEY = 'auto_approve_ledger'

/**
 * AsyncStorage key for whether Settings' Advanced group is expanded.
 *
 * Persisted so the split is a default, not a wall: a holder who never opens it
 * gets a four-row screen forever, and an operator who lives in Network/ARC
 * finds it open on every visit rather than re-tapping it each time.
 */
export const ADVANCED_SETTINGS_EXPANDED_KEY = 'settingsAdvancedExpanded'

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

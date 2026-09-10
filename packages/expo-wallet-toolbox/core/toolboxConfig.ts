import type { AppChain } from './config'

/**
 * Service endpoints and API keys for one chain.
 *
 * Every field is optional: an omitted field falls back to the built-in public
 * default in `walletServiceConfig.ts`. Omitting the whole chain entry is the
 * same as passing `{}`.
 */
export interface ToolboxServiceConfig {
  arcUrl?: string
  arcApiKey?: string
  chaintracksUrl?: string
  whatsOnChainApiKey?: string
  taalApiKey?: string
}

/**
 * Runtime configuration supplied by the host app.
 *
 * The toolbox reads no `process.env` of its own. Expo's Babel preset refuses to
 * inline `EXPO_PUBLIC_*` for any file whose path contains `node_modules`
 * (`babel-preset-expo/build/common.js` — `!isNodeModule && ...`), so an env read
 * inside this package is `undefined` in every production bundle of a host that
 * installs it from npm, while working fine in dev and in a host that consumes it
 * from source. That asymmetry is what silently disabled backup for three weeks.
 *
 * So the host reads its own env — where inlining works — and states the values
 * here, once, before rendering:
 *
 *   configureToolbox({
 *     backupUrl: process.env.EXPO_PUBLIC_BACKUP_URL ?? null,
 *     services: { main: { arcUrl: process.env.EXPO_PUBLIC_ARC_URL } }
 *   })
 *
 * There is deliberately no env fallback here. A fallback would restore exactly
 * the silent path this seam exists to close.
 */
export interface ToolboxConfig {
  /**
   * Origin of the encrypted wallet-backup service — no trailing slash, no path.
   * The BRC-103/104 handshake is posted to the origin root, so a path prefix
   * makes every request fail authentication.
   *
   * `null` disables backup entirely: no monitor task is registered, nothing is
   * sent, and the backup UI does not render. It is required rather than
   * optional so that every build states its endpoint — including stating that
   * it has none. An upgrading host that passes nothing gets a type error, not
   * another empty string.
   */
  backupUrl: string | null
  /** Per-chain service endpoints and keys. Omitted chains use built-in defaults. */
  services?: Partial<Record<AppChain, ToolboxServiceConfig>>
  /**
   * Release gate for the YubiKey vault (spec §0, D15). Default false: the home
   * button and Settings row are hidden, the vault route shows "Not available
   * yet", and no code path may enrol hardware or create a vault output. Turned
   * on per build profile by the host (EXPO_PUBLIC_VAULT_ENABLED in eas.json),
   * never read from process.env here.
   */
  vaultEnabled?: boolean
}

interface ResolvedConfig {
  backupUrl: string
  services: Partial<Record<AppChain, ToolboxServiceConfig>>
  vaultEnabled: boolean
}

let current: ResolvedConfig | null = null

const NOT_CONFIGURED =
  'expo-wallet-toolbox is not configured. Call configureToolbox({ backupUrl, services }) ' +
  'from the host app entry point, before rendering WalletContextProvider. ' +
  'Pass backupUrl: null to disable backup deliberately.'

function normalizeBackupUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '')
  if (trimmed === '') return ''
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    throw new Error(`configureToolbox: backupUrl is not a valid URL: ${raw}`)
  }
  if (parsed.pathname !== '' && parsed.pathname !== '/') {
    throw new Error(
      `configureToolbox: backupUrl must be an origin with no path (got "${parsed.pathname}"). ` +
        'The BRC-103/104 handshake posts to the origin root, so a path prefix fails authentication.'
    )
  }
  if (parsed.search !== '' || parsed.hash !== '') {
    throw new Error(`configureToolbox: backupUrl must be a bare origin, with no query or fragment: ${raw}`)
  }
  return trimmed
}

/**
 * Install the host's runtime configuration. Call once, at app entry, before
 * anything from this package renders or builds a wallet.
 *
 * Calling it again replaces the configuration wholesale — it is not merged.
 */
export function configureToolbox(config: ToolboxConfig): void {
  if (config == null || !('backupUrl' in config)) {
    throw new Error('configureToolbox: backupUrl is required. Pass null to disable backup.')
  }
  current = {
    backupUrl: config.backupUrl == null ? '' : normalizeBackupUrl(config.backupUrl),
    services: config.services ?? {},
    vaultEnabled: config.vaultEnabled === true
  }
}

/** True once `configureToolbox` has run. For hosts that want to assert their own ordering. */
export function isToolboxConfigured(): boolean {
  return current !== null
}

/**
 * The configured backup origin, or `''` when the host passed `null`.
 * Throws if the host never configured the toolbox at all — an unconfigured
 * build must fail loudly, not quietly behave like a disabled one.
 */
export function getBackupUrl(): string {
  if (current === null) throw new Error(NOT_CONFIGURED)
  return current.backupUrl
}

/** Service endpoints for a chain. Missing fields are the caller's to default. */
export function getServiceConfig(chain: AppChain): ToolboxServiceConfig {
  if (current === null) throw new Error(NOT_CONFIGURED)
  return current.services[chain] ?? {}
}

/**
 * Whether this build may enrol vault hardware or create vault outputs.
 *
 * Deliberately NOT throwing when unconfigured: this is read while rendering
 * the home screen, and "unconfigured" must look like "vault off", not crash.
 */
export function isVaultEnabled(): boolean {
  return current?.vaultEnabled ?? false
}

/** Test-only: drop the installed configuration. */
export function resetToolboxConfig(): void {
  current = null
}

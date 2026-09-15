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
 * The three endpoints a Mandala stablecoin deployment is addressed by, for one
 * chain (offline-settlement spec §12: endpoints live in the host's toolbox
 * config, never in an env read inside this package).
 *
 * All three are required together, and that is the point: `overlayUrl` without
 * `overlayIdentityKey` is an overlay whose σ_I nothing can verify, which is
 * indistinguishable from no overlay at all — so a half-stated chain entry is
 * treated as an unstated one (`getMandalaEndpoints` returns undefined) rather
 * than producing a runtime that can submit but never prove.
 */
export interface MandalaEndpointConfig {
  /** Origin of the issuer's overlay, no trailing slash — `${overlayUrl}/submit` is posted to. */
  overlayUrl: string
  /** 66-hex compressed key; the ONLY key an admission signature may come from. */
  overlayIdentityKey: string
  /** MessageBox host for the `'mandala-payments'` box (the handle rail). */
  messageBoxUrl: string
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
   * Per-chain Mandala stablecoin endpoints. There is deliberately NO default:
   * an issuer's overlay and its identity key are deployment facts this package
   * cannot guess, and guessing one would mean verifying admissions against the
   * wrong key. A chain with no complete entry has no Mandala runtime
   * (`useWallet().mandala` is undefined). Which chains carry an entry is the
   * host's whole policy — e.g. testnet only while the issuer's overlay is a
   * testnet deployment.
   */
  mandala?: Partial<Record<AppChain, MandalaEndpointConfig>>
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
  mandala: Partial<Record<AppChain, MandalaEndpointConfig>>
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
    mandala: config.mandala ?? {},
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

const COMPRESSED_KEY = /^0[23][0-9a-fA-F]{64}$/

/**
 * The Mandala endpoints for a chain, or undefined when this build has none.
 *
 * Deliberately NOT throwing when the toolbox is unconfigured, for the same
 * reason `isVaultEnabled` does not: this is read while building the wallet and
 * while rendering, and "unconfigured" must look like "Mandala off" rather than
 * crash a wallet that never wanted stablecoins.
 *
 * A partial or malformed entry answers undefined rather than a half-usable
 * object: an overlay URL with no verifiable identity key can submit but can
 * never prove an admission, which is the one shape this feature must not have.
 */
export function getMandalaEndpoints(chain: AppChain): MandalaEndpointConfig | undefined {
  const entry = current?.mandala[chain]
  if (!entry) return undefined
  const overlayUrl = entry.overlayUrl?.trim().replace(/\/+$/, '') ?? ''
  const overlayIdentityKey = entry.overlayIdentityKey?.trim() ?? ''
  const messageBoxUrl = entry.messageBoxUrl?.trim().replace(/\/+$/, '') ?? ''
  if (overlayUrl === '' || messageBoxUrl === '') return undefined
  if (!COMPRESSED_KEY.test(overlayIdentityKey)) return undefined
  return { overlayUrl, overlayIdentityKey, messageBoxUrl }
}

/**
 * Whether Mandala stablecoins are available on this network.
 *
 * Exactly the chains the host stated complete endpoints for — nothing else
 * gates it. (v1 hardcoded mainnet on top of that, ux §2; since 2026-09-15 the
 * host's `mandala` map is the whole policy, so a testnet-only rollout is a
 * config choice, not a code change.) Chain is a parameter, not a module read,
 * for the same reason `isVaultAvailable`'s is: screens must re-render when the
 * user switches network.
 */
export function isMandalaAvailable(chain: AppChain): boolean {
  return getMandalaEndpoints(chain) !== undefined
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

/**
 * Whether the vault may be used on this network.
 *
 * Vault is mainnet-only by product decision (2026-09-12): there is no reason to
 * hold different hardware keys per network, and high-value storage is
 * meaningless on a chain whose coins are worthless. Keeping it off testnet also
 * removes a fund-loss path — the enrollment wizard's reset offer reads enrolled
 * serials from one wallet+chain namespace, but a YubiKey is physical and shared
 * across all of them, so a testnet wizard could offer to factory-reset a live
 * mainnet signer.
 *
 * Chain is a parameter, not a module read: screens must re-render when the user
 * switches network, and `selectedNetwork` from the wallet context is what makes
 * that reactive. Keeping it a parameter also keeps this module a leaf — it must
 * never import `vaultStore`.
 */
export function isVaultAvailable(chain: AppChain): boolean {
  return isVaultEnabled() && chain === 'main'
}

/** Test-only: drop the installed configuration. */
export function resetToolboxConfig(): void {
  current = null
}

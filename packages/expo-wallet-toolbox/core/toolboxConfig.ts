import type { AppChain } from './config'
import type { PushAdapter } from './push/types'
import { trimTrailingSlashes } from './net/trimTrailingSlashes'
import { isRelayUrl, isStunUrl } from './directpay/settings'
import type { PermissionPolicyOverride } from './bridge/permissionPolicy'

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
  /**
   * The chain's default MessageBox origin. A user's own choice in Settings
   * still wins; this only replaces the built-in default in `NETWORKS`.
   */
  messageBoxUrl?: string
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

/** The paymail handle registry this build talks to, for one chain. */
export interface HandleRegistryConfig {
  /** The domain handles live under here, e.g. `deggen.com`. Bare and lowercase. */
  domain: string
  /** Origin of the registry that serves that domain — no path, query or fragment. */
  url: string
}

/**
 * What the host states about direct (push) payments, the live WebRTC link tried before the
 * message box. Every field is optional, and the whole entry is: a host that states nothing
 * here keeps today's behaviour. The package never imports a WebRTC implementation itself —
 * the native module would have to be linked by every host that merely installs it — so the
 * host that ships one passes it in.
 *
 * `relayUrl` and `stunUrls` are checked when the toolbox is configured, by the same rules as
 * the user's own settings (`isRelayUrl`, `isStunUrl`). They are this build's defaults: they
 * stand in for the built-in ones, and what the user saves in `DirectPaySettings` wins over both.
 */
export interface DirectPayHostConfig {
  /**
   * Whether this build offers direct payments at all, as `vaultEnabled` gates the vault. The
   * user's own receive switch is a separate setting (`DirectPaySettings.receiveEnabled`).
   * Unset means off.
   */
  enabled?: boolean
  /** This build's signaling relay, `wss://` only, a host with no credentials. Unset means the built-in one. */
  relayUrl?: string
  /** This build's `stun:` / `stuns:` servers, as written (none is trimmed). Unset means the built-in ones. */
  stunUrls?: string[]
  /**
   * The host's `RTCPeerConnection` constructor (e.g. from react-native-webrtc). Typed
   * `unknown` because this package ships no WebRTC types and must not depend on any.
   */
  RTCPeerConnection?: unknown
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
   * The paymail handle registry, per chain: the domain this build's handles
   * live under, and the host that serves it. Both together or neither — a
   * domain with no URL is a registry nothing can reach, and a URL with no
   * domain is a host whose certificates nothing can be checked against.
   *
   * There is deliberately no default. A chain with no complete entry shows
   * the existing "not available yet" copy in Profile and adds no registry tier
   * to Pay's recipient search.
   */
  handleRegistry?: Partial<Record<AppChain, HandleRegistryConfig>>
  /**
   * The shortest handle this host lets people register: 1, 2 or 3 characters
   * (default 3). The rest of the format is fixed (a-z 0-9 . _ -, at most 32,
   * starting and ending with a letter or digit). A host that lowers it must
   * use a registry that accepts the shorter handles.
   */
  handleMinLength?: 1 | 2 | 3
  /**
   * Release gate for the YubiKey vault (spec §0, D15). Default false: the home
   * button and Settings row are hidden, the vault route shows "Not available
   * yet", and no code path may enrol hardware or create a vault output. Turned
   * on per build profile by the host (EXPO_PUBLIC_VAULT_ENABLED in eas.json),
   * never read from process.env here.
   */
  vaultEnabled?: boolean
  /**
   * The host's push implementation. Optional: a host that ships no push SDK
   * omits it and every push feature stays off. The package never imports a
   * push SDK itself — the SDK's native module would have to be linked by every
   * host that merely installs this package — so the host wraps its own and
   * states it here, like the URLs above.
   */
  push?: PushAdapter
  /**
   * Direct (push) payments. Optional, and unset by default: a host that omits it sees no
   * change.
   */
  directPay?: DirectPayHostConfig
  /**
   * The browser bridge (BRC-185). Optional; a host that omits it gets the built-in policy.
   * `allowLocalhostHttp` lets a development build accept `http://localhost` origins.
   * `permissionPolicy` states this build's default prompt settings for verified and
   * unverified origins; the user's own stored policy wins over it.
   */
  browserBridge?: { allowLocalhostHttp?: boolean; permissionPolicy?: PermissionPolicyOverride }
}

export type BrowserBridgeHostConfig = NonNullable<ToolboxConfig['browserBridge']>

interface ResolvedConfig {
  backupUrl: string
  services: Partial<Record<AppChain, ToolboxServiceConfig>>
  mandala: Partial<Record<AppChain, MandalaEndpointConfig>>
  handleRegistry: Partial<Record<AppChain, HandleRegistryConfig>>
  handleMinLength: 1 | 2 | 3
  vaultEnabled: boolean
  push: PushAdapter | undefined
  directPay: DirectPayHostConfig | undefined
  browserBridge: BrowserBridgeHostConfig | undefined
}

let current: ResolvedConfig | null = null

const NOT_CONFIGURED =
  'expo-wallet-toolbox is not configured. Call configureToolbox({ backupUrl, services }) ' +
  'from the host app entry point, before rendering WalletContextProvider. ' +
  'Pass backupUrl: null to disable backup deliberately.'

/**
 * Hosts a development build may reach over plain http: the simulator's own
 * machine, the Android emulator's alias for it, and RFC 1918 space. Everything
 * else must be https — which key owns a handle (or holds a backup, or admits
 * a Mandala settlement) is precisely what a reader on the path would want to
 * change.
 */
const PRIVATE_HOST =
  /^(localhost|127\.0\.0\.1|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})$/

/**
 * XR-065 (SEC2-074): the https-except-private-network policy
 * `getHandleRegistryConfig` already applied to the paymail registry origin,
 * shared here so `normalizeBackupUrl` and `getMandalaEndpoints` stop
 * accepting a plain http: or credential-bearing origin with no policy at
 * all. A host's own backup service, Mandala overlay, and Mandala MessageBox
 * are each configuration-time, host-trusted values, not remote/runtime
 * input — but a misconfigured or copy-pasted http: URL, or one carrying a
 * bearer credential, still exposes every request this package makes over
 * that origin to an on-path attacker.
 */
export function isAllowedServiceOrigin(parsed: URL): boolean {
  if (parsed.username || parsed.password) return false
  if (parsed.protocol === 'https:') return true
  return parsed.protocol === 'http:' && PRIVATE_HOST.test(parsed.hostname)
}

function normalizeBackupUrl(raw: string): string {
  const trimmed = trimTrailingSlashes(raw.trim())
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
  if (!isAllowedServiceOrigin(parsed)) {
    throw new Error(
      `configureToolbox: backupUrl must be https (plain http is allowed only for a local-dev host): ${raw}`
    )
  }
  return trimmed
}

/** Throws unless the host's direct pay addresses are acceptable; unset fields are fine. */
function checkDirectPayHostConfig(directPay: DirectPayHostConfig | undefined): void {
  if (directPay === undefined) return
  const { relayUrl, stunUrls } = directPay
  if (relayUrl !== undefined && !(typeof relayUrl === 'string' && isRelayUrl(relayUrl))) {
    throw new Error(`configureToolbox: directPay.relayUrl must be a wss:// address without credentials: ${relayUrl}`)
  }
  if (stunUrls !== undefined && !(Array.isArray(stunUrls) && stunUrls.every(url => isStunUrl(url)))) {
    throw new Error(
      `configureToolbox: directPay.stunUrls must be a list of stun: or stuns: addresses: ${JSON.stringify(stunUrls)}`
    )
  }
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
  checkDirectPayHostConfig(config.directPay)
  current = {
    backupUrl: config.backupUrl == null ? '' : normalizeBackupUrl(config.backupUrl),
    services: config.services ?? {},
    mandala: config.mandala ?? {},
    handleRegistry: config.handleRegistry ?? {},
    handleMinLength: config.handleMinLength === 1 || config.handleMinLength === 2 ? config.handleMinLength : 3,
    vaultEnabled: config.vaultEnabled === true,
    push: config.push,
    directPay: config.directPay,
    browserBridge: config.browserBridge
  }
}

/**
 * The shortest registrable handle (3 unless the host lowered it). Readable
 * before configuration, so pure format checks work in tests and early code.
 */
export function getHandleMinLength(): 1 | 2 | 3 {
  return current?.handleMinLength ?? 3
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
 * The host's default MessageBox origin for a chain, or undefined to use the
 * built-in one. Never throws, like `getMandalaEndpoints`: it is read while
 * rendering, and an unconfigured or malformed value must look like "no
 * override" rather than crash.
 */
export function getMessageBoxUrlOverride(chain: AppChain): string | undefined {
  const url = trimTrailingSlashes(current?.services[chain]?.messageBoxUrl?.trim() ?? '')
  if (url === '') return undefined
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return undefined
  }
  return isAllowedServiceOrigin(parsed) ? url : undefined
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
  const overlayUrl = trimTrailingSlashes(entry.overlayUrl?.trim() ?? '')
  const overlayIdentityKey = entry.overlayIdentityKey?.trim() ?? ''
  const messageBoxUrl = trimTrailingSlashes(entry.messageBoxUrl?.trim() ?? '')
  if (overlayUrl === '' || messageBoxUrl === '') return undefined
  if (!COMPRESSED_KEY.test(overlayIdentityKey)) return undefined
  // XR-065 (SEC2-074): neither URL had a scheme policy at all before this --
  // a plain http: overlay or MessageBox origin (or one carrying embedded
  // credentials) resolved to a fully populated, "working" config.
  for (const url of [overlayUrl, messageBoxUrl]) {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return undefined
    }
    if (!isAllowedServiceOrigin(parsed)) return undefined
  }
  return { overlayUrl, overlayIdentityKey, messageBoxUrl }
}

/**
 * The same rule as `DOMAIN_FORMAT` in `identity/handleRegistry/rules.ts`, which
 * backs the `looksLikeDomain` the resolver and `parsePaymail` apply to the same
 * strings. Restated rather than imported so this module stays a leaf and does
 * not depend on a feature directory — change both together, because a domain
 * this accepts and that one rejects is a configured registry nothing resolves.
 */
const REGISTRY_DOMAIN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/

/**
 * The handle registry for a chain, or undefined when this build has none.
 *
 * Same fail-closed posture as `getMandalaEndpoints`: never throws, and a
 * partial or malformed entry answers undefined rather than a half-usable
 * object. `10.0.2.2` — the Android emulator's route to its host — falls out of
 * the RFC 1918 branch and needs no case of its own.
 *
 * `url` must be a bare origin, for the reason `normalizeBackupUrl` says it
 * above: every route is built by appending to it (`${url}/api/handle/dee`), so
 * a configured `https://host/?x=1` addresses neither the host's registry nor
 * anything else — exactly the half-usable entry this getter exists to refuse.
 */
export function getHandleRegistryConfig(chain: AppChain): HandleRegistryConfig | undefined {
  const entry = current?.handleRegistry[chain]
  if (!entry) return undefined
  const domain = entry.domain?.trim().toLowerCase() ?? ''
  const url = trimTrailingSlashes(entry.url?.trim() ?? '')
  if (!REGISTRY_DOMAIN.test(domain) || url === '') return undefined
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return undefined
  }
  if (parsed.search !== '' || parsed.hash !== '') return undefined
  if (parsed.pathname !== '' && parsed.pathname !== '/') return undefined
  return isAllowedServiceOrigin(parsed) ? { domain, url } : undefined
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
 * The host's push implementation, if it wired one. The package never imports a
 * push SDK itself.
 *
 * Deliberately NOT throwing when unconfigured, like `isVaultEnabled`: push
 * listeners are set up while rendering, and "unconfigured" must look like
 * "no push" rather than crash a wallet that never wanted notifications.
 */
export function getPushAdapter(): PushAdapter | undefined {
  return current?.push
}

/**
 * What the host stated about direct payments, or undefined when it stated nothing.
 *
 * Deliberately NOT throwing when unconfigured, like `getPushAdapter`: it is read while
 * building the wallet, and "unconfigured" must look like "not stated".
 */
export function getDirectPayConfig(): DirectPayHostConfig | undefined {
  return current?.directPay
}

/** What the host stated about the browser bridge; `{}` when it stated nothing. Never throws. */
export function getBrowserBridgeConfig(): BrowserBridgeHostConfig {
  return current?.browserBridge ?? {}
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
 * Only the default wallet profile (index 0) has a vault: a YubiKey is enrolled
 * against one identity, and showing an empty vault on another profile would read
 * as the user's vault being gone.
 *
 * Chain and profile are parameters, not module reads: screens must re-render when the user
 * switches network, and `selectedNetwork` from the wallet context is what makes
 * that reactive. Keeping it a parameter also keeps this module a leaf — it must
 * never import `vaultStore`.
 */
export function isVaultAvailable(chain: AppChain, profileIndex: number): boolean {
  return isVaultEnabled() && chain === 'main' && profileIndex === 0
}

/** Test-only: drop the installed configuration. */
export function resetToolboxConfig(): void {
  current = null
}

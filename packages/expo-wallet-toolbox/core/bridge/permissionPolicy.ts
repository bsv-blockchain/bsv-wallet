/**
 * Which permission prompts each kind of browser origin gets (spec 6.5).
 *
 * The permissions managers take their `seek*` settings from here instead of a literal in
 * WalletContext. `verified` is exactly what the attested manager has always used; `unverified`
 * can only be stricter, because an unverified origin is one a local app could be claiming.
 *
 * Pure policy: nothing here imports React or the permissions manager. The stored user policy
 * is HMAC-tagged by the admin-scoped wallet (like `connectionAuthority.ts`), so a raw
 * AsyncStorage edit cannot loosen prompts.
 */
import AsyncStorage from '@react-native-async-storage/async-storage'
import type { WalletInterface, WalletProtocol } from '@bsv/sdk'
import { ADMIN_ORIGINATOR } from '../config'
import { getBrowserBridgeConfig } from '../toolboxConfig'

export interface SeekFlags {
  seekBasketInsertionPermissions: boolean
  seekBasketListingPermissions: boolean
  seekBasketRemovalPermissions: boolean
  seekCertificateAcquisitionPermissions: boolean
  seekCertificateDisclosurePermissions: boolean
  seekCertificateRelinquishmentPermissions: boolean
  seekCertificateListingPermissions: boolean
  seekGroupedPermission: boolean
  seekPermissionsForIdentityKeyRevelation: boolean
  seekPermissionsForIdentityResolution: boolean
  seekPermissionsForKeyLinkageRevelation: boolean
  seekPermissionsForPublicKeyRevelation: boolean
  seekPermissionWhenApplyingActionLabels: boolean
  seekPermissionWhenListingActionsByLabel: boolean
  seekProtocolPermissionsForEncrypting: boolean
  seekProtocolPermissionsForHMAC: boolean
  seekProtocolPermissionsForSigning: boolean
  seekSpendingPermissions: boolean
}

export interface PermissionPolicy {
  verified: SeekFlags
  unverified: SeekFlags
}

/** What a host may state in `configureToolbox`: any subset of either half. */
export interface PermissionPolicyOverride {
  verified?: Partial<SeekFlags>
  unverified?: Partial<SeekFlags>
}

export const SEEK_FLAG_KEYS: ReadonlyArray<keyof SeekFlags> = [
  'seekBasketInsertionPermissions',
  'seekBasketListingPermissions',
  'seekBasketRemovalPermissions',
  'seekCertificateAcquisitionPermissions',
  'seekCertificateDisclosurePermissions',
  'seekCertificateRelinquishmentPermissions',
  'seekCertificateListingPermissions',
  'seekGroupedPermission',
  'seekPermissionsForIdentityKeyRevelation',
  'seekPermissionsForIdentityResolution',
  'seekPermissionsForKeyLinkageRevelation',
  'seekPermissionsForPublicKeyRevelation',
  'seekPermissionWhenApplyingActionLabels',
  'seekPermissionWhenListingActionsByLabel',
  'seekProtocolPermissionsForEncrypting',
  'seekProtocolPermissionsForHMAC',
  'seekProtocolPermissionsForSigning',
  'seekSpendingPermissions'
]

/**
 * The attested manager's configuration, moved verbatim from WalletContext.
 * Changing any value here changes what every attested site is asked.
 */
export const DEFAULT_VERIFIED_SEEK_FLAGS: SeekFlags = {
  seekBasketInsertionPermissions: false,
  seekBasketListingPermissions: false,
  seekBasketRemovalPermissions: false,
  seekCertificateAcquisitionPermissions: false,
  seekCertificateDisclosurePermissions: false,
  seekCertificateRelinquishmentPermissions: false,
  seekCertificateListingPermissions: false,
  // A site whose manifest declares metanet.groupPermissions is asked for them all in one sheet
  // during waitForAuthentication. The request holds that origin's permission lock until
  // answered, so it MUST be handled (onGroupedPermissionRequested) or the site hangs.
  seekGroupedPermission: true,
  seekPermissionsForIdentityKeyRevelation: false,
  seekPermissionsForIdentityResolution: false,
  seekPermissionsForKeyLinkageRevelation: false,
  seekPermissionsForPublicKeyRevelation: false,
  seekPermissionWhenApplyingActionLabels: false,
  seekPermissionWhenListingActionsByLabel: false,
  seekProtocolPermissionsForEncrypting: false,
  seekProtocolPermissionsForHMAC: false,
  // On, unlike Metanet Desktop: the vault guard no longer refuses external BRC-29
  // ([2,'3241645161d8']) signing outright, and that namespace also derives this wallet's own
  // address-rail keys (counterparty 'anyone'), so a site signing under it must be asked first
  // -- for BRC-29, on every signature. BRC-103/104 auth signing is exempt
  // (SigningPolicyPermissionsManager).
  seekProtocolPermissionsForSigning: true,
  seekSpendingPermissions: true
}

/** Unverified origins are also asked before they touch baskets. */
export const DEFAULT_UNVERIFIED_SEEK_FLAGS: SeekFlags = {
  ...DEFAULT_VERIFIED_SEEK_FLAGS,
  seekBasketInsertionPermissions: true,
  seekBasketListingPermissions: true,
  seekBasketRemovalPermissions: true
}

/** The flags an unverified origin can never be spared, whatever the policy says. */
const FORCED_UNVERIFIED: ReadonlyArray<keyof SeekFlags> = [
  'seekSpendingPermissions',
  'seekProtocolPermissionsForSigning',
  'seekGroupedPermission'
]

/**
 * The flags the unverified manager is actually built from: verified OR unverified for each
 * flag, so it can only be stricter than the attested one, with the forced three always on.
 */
export function effectiveUnverified(p: PermissionPolicy): SeekFlags {
  const out = {} as SeekFlags
  for (const key of SEEK_FLAG_KEYS) out[key] = p.verified[key] === true || p.unverified[key] === true
  for (const key of FORCED_UNVERIFIED) out[key] = true
  return out
}

/**
 * Connection-sheet wording for each flag (i18n keys): `off` is the line shown when the flag is
 * false (the site is NOT asked), `on` when it is true (asked first). Keyed by `SeekFlags`, so
 * adding a flag without wording fails to compile.
 */
export const SEEK_FLAG_DISCLOSURE: Record<keyof SeekFlags, { off: string; on: string }> = Object.fromEntries(
  SEEK_FLAG_KEYS.map(key => [key, { off: `bridge.policy.${key}.off`, on: `bridge.policy.${key}.on` }])
) as Record<keyof SeekFlags, { off: string; on: string }>

function mergeFlags(base: SeekFlags, over: Partial<SeekFlags> | undefined): SeekFlags {
  const out = { ...base }
  if (over === undefined || over === null || typeof over !== 'object') return out
  for (const key of SEEK_FLAG_KEYS) {
    const v = over[key]
    if (typeof v === 'boolean') out[key] = v
  }
  return out
}

/**
 * Defaults, then the host's statement from `configureToolbox`, then the user's stored policy.
 * `stored` must already have passed `loadStoredPolicy` (which authenticates it).
 */
export function resolvePermissionPolicy(stored?: PermissionPolicy): PermissionPolicy {
  const host = getBrowserBridgeConfig().permissionPolicy
  const hosted: PermissionPolicy = {
    verified: mergeFlags(DEFAULT_VERIFIED_SEEK_FLAGS, host?.verified),
    unverified: mergeFlags(DEFAULT_UNVERIFIED_SEEK_FLAGS, host?.unverified)
  }
  if (stored === undefined) return hosted
  return {
    verified: mergeFlags(hosted.verified, stored.verified),
    unverified: mergeFlags(hosted.unverified, stored.unverified)
  }
}

// ---- Stored user policy -------------------------------------------------------------------

type PolicyTagWallet = Pick<WalletInterface, 'createHmac' | 'verifyHmac'>

/** Reserved in `core/services/vault/guard.ts`: no connected origin may mint or verify this tag. */
export const BRIDGE_SITE_AUTHORITY_PROTOCOL_ID: WalletProtocol = [2, 'bridge site authority']
const POLICY_KEY_ID = 'permission-policy'
const POLICY_DOMAIN = 'bsv-wallet-bridge-permission-policy-v1'

const storageKey = (profileKey: string) => `bsv-bridge-permission-policy:${profileKey}`

function isFlags(v: unknown): v is SeekFlags {
  if (v === null || typeof v !== 'object') return false
  return SEEK_FLAG_KEYS.every(k => typeof (v as Record<string, unknown>)[k] === 'boolean')
}

function policyMessage(profileKey: string, p: PermissionPolicy): number[] {
  // Fixed key order, so the bytes do not depend on how the record was serialized.
  const bits = (f: SeekFlags) => SEEK_FLAG_KEYS.map(k => (f[k] ? '1' : '0')).join('')
  return Array.from(
    new TextEncoder().encode(`${POLICY_DOMAIN}|${profileKey}|${bits(p.verified)}|${bits(p.unverified)}`)
  )
}

async function computeTag(wallet: PolicyTagWallet, originator: string, profileKey: string, p: PermissionPolicy) {
  const { hmac } = await wallet.createHmac(
    {
      protocolID: BRIDGE_SITE_AUTHORITY_PROTOCOL_ID,
      keyID: POLICY_KEY_ID,
      counterparty: 'self',
      data: policyMessage(profileKey, p)
    },
    originator
  )
  return Buffer.from(hmac).toString('base64url')
}

/** The user's stored policy for a profile, or undefined when absent, malformed or not authentic. */
export async function loadStoredPolicy(
  profileKey: string,
  adminWallet: PolicyTagWallet,
  adminOriginator: string = ADMIN_ORIGINATOR
): Promise<PermissionPolicy | undefined> {
  try {
    const raw = await AsyncStorage.getItem(storageKey(profileKey))
    if (raw === null) return undefined
    const parsed = JSON.parse(raw) as { policy?: { verified?: unknown; unverified?: unknown }; tag?: unknown }
    const policy = parsed?.policy
    if (!policy || !isFlags(policy.verified) || !isFlags(policy.unverified) || typeof parsed.tag !== 'string') {
      return undefined
    }
    const checked: PermissionPolicy = { verified: policy.verified, unverified: policy.unverified }
    const { valid } = await adminWallet.verifyHmac(
      {
        protocolID: BRIDGE_SITE_AUTHORITY_PROTOCOL_ID,
        keyID: POLICY_KEY_ID,
        counterparty: 'self',
        data: policyMessage(profileKey, checked),
        hmac: Array.from(Buffer.from(parsed.tag, 'base64url'))
      },
      adminOriginator
    )
    return valid === true ? checked : undefined
  } catch {
    // verifyHmac rejects on a mismatch; storage and JSON failures land here too. All mean "no policy".
    return undefined
  }
}

/** Stores the policy with its tag. Takes effect from the next wallet build. */
export async function saveStoredPolicy(
  profileKey: string,
  policy: PermissionPolicy,
  adminWallet: PolicyTagWallet,
  adminOriginator: string = ADMIN_ORIGINATOR
): Promise<void> {
  const clean: PermissionPolicy = {
    verified: mergeFlags(DEFAULT_VERIFIED_SEEK_FLAGS, policy.verified),
    unverified: mergeFlags(DEFAULT_UNVERIFIED_SEEK_FLAGS, policy.unverified)
  }
  const tag = await computeTag(adminWallet, adminOriginator, profileKey, clean)
  await AsyncStorage.setItem(storageKey(profileKey), JSON.stringify({ policy: clean, tag }))
}

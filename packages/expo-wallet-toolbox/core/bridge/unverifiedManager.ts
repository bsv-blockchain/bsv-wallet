/**
 * The permissions manager for unverified (unattested) browser origins (spec 6.5).
 *
 * The same class as the attested manager, configured differently: its prompt settings come from
 * the effective unverified policy, the token modules refuse, and it reads a site's manifest from
 * the real hostname rather than the `<hostname>.<grantTag>.unverified.invalid` namespace name it
 * sees as the originator. The caller applies the same wrapper stack as the attested manager.
 */
import type { WalletInterface } from '@bsv/sdk'
import { SigningPolicyPermissionsManager, isAskEveryTimeProtocol } from '../services/signingPermissionPolicy'
import type { SeekFlags } from './permissionPolicy'
import { hostnameOfUnattested, isUnattestedOriginator } from './unverifiedOriginator'

/** A token module that refuses everything: these modules move tokens and keep their own
 * approval sessions per originator, which a forging local app could ride. */
export const refusingModule = {
  onRequest: async () => {
    const error = new Error('Token modules are not available to unverified origins') as Error & { code: string }
    error.code = 'ERR_PERMISSION_DENIED'
    throw error
  },
  onResponse: async (res: unknown) => res
}

const SPECIAL_SUFFIXES = ['.localhost', '.local', '.internal', '.lan', '.home.arpa', '.test', '.example', '.onion']

/** Hosts whose manifest proves nothing or must never be fetched on a site's say-so (spec 6.5). */
export function isUnreadableManifestHost(host: string): boolean {
  if (host === 'localhost' || !host.includes('.')) return true
  if (/^[0-9]+$/.test(host.slice(host.lastIndexOf('.') + 1))) return true
  return SPECIAL_SUFFIXES.some(s => host.endsWith(s))
}

interface Manifest {
  groupPermissions: Record<string, any> | null
  counterpartyPermissions: Record<string, any> | null
}

/** A token-module name: raw, exact-case `p <scheme> …`, the form the manager routes on. */
function routesToTokenModule(name: unknown): boolean {
  if (typeof name !== 'string' || !name.startsWith('p ')) return false
  const scheme = name.split(' ')[1]
  return scheme === 'btms' || scheme === 'color'
}

/** Fresh shallow copies; the delegate's objects are never edited. */
export function filterUnverifiedManifest(manifest: Manifest): Manifest {
  const { groupPermissions, counterpartyPermissions } = manifest
  let group: Manifest['groupPermissions'] = null
  if (groupPermissions != null) {
    const { spendingAuthorization: _dropped, ...rest } = groupPermissions
    group = { ...rest }
    if (Array.isArray(rest.protocolPermissions)) {
      group.protocolPermissions = rest.protocolPermissions.filter(
        (p: any) => !routesToTokenModule(p?.protocolID?.[1]) && !isAskEveryTimeProtocol(p?.protocolID)
      )
    }
    if (Array.isArray(rest.basketAccess)) {
      group.basketAccess = rest.basketAccess.filter((b: any) => !routesToTokenModule(b?.basket))
    }
  }
  let counterparty: Manifest['counterpartyPermissions'] = null
  if (counterpartyPermissions != null) {
    counterparty = { ...counterpartyPermissions }
    if (Array.isArray(counterpartyPermissions.protocols)) {
      counterparty.protocols = counterpartyPermissions.protocols.filter(
        (p: any) =>
          !routesToTokenModule(p?.protocolID?.[1] ?? p?.protocolName) && !isAskEveryTimeProtocol(p?.protocolID)
      )
    }
  }
  return { groupPermissions: group, counterpartyPermissions: counterparty }
}

export function buildUnverifiedPermissionsManager(
  wallet: WalletInterface,
  adminOriginator: string,
  flags: SeekFlags
): SigningPolicyPermissionsManager {
  const manager = new SigningPolicyPermissionsManager(wallet, adminOriginator, {
    differentiatePrivilegedOperations: true,
    ...flags,
    permissionModules: { btms: refusingModule, color: refusingModule }
  } as any)

  // Instance-level override of the manager's (type-private) fetch: the attested manager is
  // untouched, and this manager's own manifest cache is keyed by the real hostname.
  const internals = manager as unknown as { fetchManifestPermissions(originator: string): Promise<Manifest> }
  const fetchManifest = internals.fetchManifestPermissions.bind(manager)
  internals.fetchManifestPermissions = async originator => {
    if (!isUnattestedOriginator(originator)) return { groupPermissions: null, counterpartyPermissions: null }
    const host = hostnameOfUnattested(originator)
    if (isUnreadableManifestHost(host)) return { groupPermissions: null, counterpartyPermissions: null }
    return filterUnverifiedManifest(await fetchManifest(host))
  }
  return manager
}

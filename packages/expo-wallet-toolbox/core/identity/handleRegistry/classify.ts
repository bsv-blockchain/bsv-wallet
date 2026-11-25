/**
 * Classify a paymail domain by its capability map.
 *
 * `peerpay`: the domain runs the profile lookup (`0ace65da5987`), so it is a
 * MessageBox registry. `legacy`: it serves the paymail P2P pair that HandCash
 * serves, so it can be paid by `sendViaPaymail`. `unsupported`: the document
 * loaded and has neither, or the SRV answer was not authenticated. `failed`:
 * DNS or HTTP gave no answer.
 */
import { isPublicHttpsUrl } from '../../net/publicDestination'
import { BRFC_LOOKUP, BRFC_P2P_DESTINATION, BRFC_P2P_RECEIVE_BEEF, looksLikeDomain } from './rules'
import type { RegistryResolver } from './resolver'

export type PaymailClass = 'peerpay' | 'legacy' | 'unsupported' | 'failed'
export type UnsupportedReason = 'unsecured' | 'no_capabilities'
export interface PaymailClassification {
  kind: PaymailClass
  /** Only when `kind` is `unsupported`. */
  reason?: UnsupportedReason
}
export interface ClassifyArgs {
  resolver: Pick<RegistryResolver, 'discoverCapabilities'>
  ownDomains: readonly string[]
}

const LEGACY_PLACEHOLDERS = ['{alias}', '{domain.tld}'] as const

/**
 * A string that starts with `https://`, holds every placeholder, has none in
 * the authority (a placeholder in the host would let user input choose the
 * host), and passes `isPublicHttpsUrl`.
 */
export function isLegacyCapabilityUrl(value: unknown, placeholders: readonly string[]): value is string {
  if (typeof value !== 'string' || !value.startsWith('https://')) return false
  if (!placeholders.every(p => value.includes(p))) return false
  const rest = value.slice('https://'.length)
  const end = rest.search(/[/?#]/)
  const authority = end === -1 ? rest : rest.slice(0, end)
  if (placeholders.some(p => authority.includes(p))) return false
  return isPublicHttpsUrl(value)
}

export async function classifyPaymailDomainDetailed(
  args: ClassifyArgs,
  domain: string
): Promise<PaymailClassification> {
  const d = domain.trim().toLowerCase()
  if (args.ownDomains.some(own => own.toLowerCase() === d)) return { kind: 'peerpay' }
  if (!looksLikeDomain(d)) return { kind: 'unsupported', reason: 'no_capabilities' }
  const found = await args.resolver.discoverCapabilities(d)
  switch (found.kind) {
    case 'failed':
      return { kind: 'failed' }
    case 'unsecured':
      return { kind: 'unsupported', reason: 'unsecured' }
    case 'none':
      return { kind: 'unsupported', reason: 'no_capabilities' }
    case 'ok': {
      const caps = found.capabilities
      if (typeof caps[BRFC_LOOKUP] === 'string') return { kind: 'peerpay' }
      if (
        isLegacyCapabilityUrl(caps[BRFC_P2P_DESTINATION], LEGACY_PLACEHOLDERS) &&
        isLegacyCapabilityUrl(caps[BRFC_P2P_RECEIVE_BEEF], LEGACY_PLACEHOLDERS)
      ) {
        return { kind: 'legacy' }
      }
      return { kind: 'unsupported', reason: 'no_capabilities' }
    }
  }
}

export async function classifyPaymailDomain(args: ClassifyArgs, domain: string): Promise<PaymailClass> {
  return (await classifyPaymailDomainDetailed(args, domain)).kind
}

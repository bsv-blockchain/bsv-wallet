/**
 * Handle registration — a certificate, not a payment rail.
 *
 * "Handle" already names the identity-key pay rail in this codebase
 * (`RailId 'handle'`, `HandleRailWallet`, `sendViaHandle` — core/pay/rails/handle.ts),
 * so nothing here reuses that word as a type or export name; it is a
 * `handle` FIELD on an identity certificate, the same way `name` and
 * `avatarURL` already are.
 *
 * The flow is exactly `acquireCertificate` → `IdentityClient.publiclyRevealAttributes`,
 * the same two calls this app already trusts for name/avatar (see
 * `resolveIdentity.ts`). What is genuinely new, and stated plainly rather than
 * hidden: there is no certifier-side uniqueness authority for this attribute
 * anywhere this package can reach as of 2026-09. `checkHandleAvailability`
 * below is the only real check available — an overlay search, advisory only —
 * and `getHandleCertifierConfig` (toolboxConfig.ts) answers `undefined` until
 * a host configures one, in which case registration reports `unavailable`
 * rather than acquiring a certificate nobody can issue.
 */
import type { AcquisitionProtocol, WalletCertificate } from '@bsv/sdk'
import type { HandleCertifierConfig } from '../toolboxConfig'
import { searchIdentities } from '../../ui/resolveIdentity'
import type { IdentityClient } from '@bsv/sdk'

/**
 * This app's certificate type id for the `handle` field. A fixed, arbitrary
 * base64 constant — certificate types are namespaced by convention, not by
 * registry, so this only has to be stable across app versions and distinct
 * from other certificate types this wallet acquires. Whatever certifier is
 * eventually deployed must be told to issue against this exact type.
 */
export const HANDLE_CERT_TYPE = 'wJ9F3z8fW0mYV6b0Yh0YsQ2xQwqK8oQe1v0k5m6h5eE='

/** Minimal slice of `WalletInterface` this module needs. */
export interface HandleCertWallet {
  acquireCertificate(
    args: {
      type: string
      certifier: string
      acquisitionProtocol: AcquisitionProtocol
      fields: Record<string, string>
      certifierUrl?: string
    },
    originator?: string
  ): Promise<WalletCertificate>
}

/** 3-20 lowercase letters, digits, underscore or hyphen — a conservative
 * handle shape until a real certifier states its own rules. */
const HANDLE_FORMAT = /^[a-z0-9_-]{3,20}$/

export function isValidHandleFormat(handle: string): boolean {
  return HANDLE_FORMAT.test(handle)
}

export type HandleAvailability = 'checking' | 'available' | 'taken' | 'invalid' | 'failed'

/**
 * The only real availability signal this app can ask for today: whether the
 * overlay already resolves someone by this handle. Advisory, not
 * authoritative — a certifier-side uniqueness endpoint would win over this
 * the moment one exists (see the module doc above).
 */
export async function checkHandleAvailability(idClient: IdentityClient, handle: string): Promise<HandleAvailability> {
  if (!isValidHandleFormat(handle)) return 'invalid'
  try {
    const matches = await searchIdentities(idClient, handle)
    return matches.some(m => m.name?.toLowerCase() === handle.toLowerCase()) ? 'taken' : 'available'
  } catch {
    return 'failed'
  }
}

export type RegisterHandleResult =
  | { kind: 'registered' }
  | { kind: 'unavailable' }
  | { kind: 'invalid' }
  | { kind: 'failed'; message: string }

/**
 * Acquire the handle certificate and reveal it publicly. `unavailable` means
 * this build has no certifier configured (`getHandleCertifierConfig`), not
 * that the handle itself is taken — callers should have already refused a
 * `taken`/`invalid` handle via `checkHandleAvailability` before calling this.
 */
export async function registerHandle(args: {
  wallet: HandleCertWallet
  idClient: IdentityClient
  adminOriginator?: string
  certifier: HandleCertifierConfig | undefined
  handle: string
}): Promise<RegisterHandleResult> {
  const { wallet, idClient, adminOriginator, certifier, handle } = args
  if (!isValidHandleFormat(handle)) return { kind: 'invalid' }
  if (!certifier) return { kind: 'unavailable' }
  try {
    const cert = await wallet.acquireCertificate(
      {
        type: HANDLE_CERT_TYPE,
        certifier: certifier.certifierIdentityKey,
        acquisitionProtocol: 'issuance',
        fields: { handle },
        certifierUrl: certifier.certifierUrl
      },
      adminOriginator
    )
    await idClient.publiclyRevealAttributes(cert, ['handle'])
    return { kind: 'registered' }
  } catch (e) {
    return { kind: 'failed', message: e instanceof Error ? e.message : String(e) }
  }
}

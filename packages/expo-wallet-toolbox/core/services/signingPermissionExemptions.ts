import { WalletPermissionsManager } from '@bsv/wallet-toolbox-mobile'

/**
 * Protocols a connected app may sign under without a protocol prompt, even
 * though seekProtocolPermissionsForSigning is on.
 *
 * `auth message signature` is the one protocol @bsv/auth signs under: BRC-103
 * mutual authentication and its BRC-104 HTTP transport (AuthFetch) both sign
 * every handshake and message with it. Any site that talks to an
 * authenticated server does this on its first request, so prompting for it
 * would ask on nearly every connection. Names are compared the way
 * KeyDeriver.computeInvoiceNumber normalizes them, since that is the key the
 * signature is made with.
 */
export const PROMPT_FREE_SIGNING_PROTOCOLS = new Set(['auth message signature'])

type EnsureProtocolPermissionArgs = Parameters<WalletPermissionsManager['ensureProtocolPermission']>[0]

export function isPromptFreeSigning({ usageType, privileged, protocolID }: EnsureProtocolPermissionArgs): boolean {
  return (
    usageType === 'signing' &&
    !privileged &&
    Array.isArray(protocolID) &&
    typeof protocolID[1] === 'string' &&
    PROMPT_FREE_SIGNING_PROTOCOLS.has(protocolID[1].toLowerCase().trim())
  )
}

/** WalletPermissionsManager that skips the signing prompt for
 * PROMPT_FREE_SIGNING_PROTOCOLS. Every other check runs unchanged. */
export class AuthSigningPermissionsManager extends WalletPermissionsManager {
  override async ensureProtocolPermission(args: EnsureProtocolPermissionArgs): Promise<boolean> {
    if (isPromptFreeSigning(args)) {
      // Still refuse a missing or malformed originator, as the full check
      // does first. prepareOriginator is private in the typings only.
      ;(this as unknown as { prepareOriginator(originator: string): unknown }).prepareOriginator(args.originator)
      return true
    }
    return await super.ensureProtocolPermission(args)
  }
}

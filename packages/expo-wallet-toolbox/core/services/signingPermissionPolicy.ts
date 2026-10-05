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

/**
 * Protocols whose approval is never stored: every protocol permission under
 * them is asked for again, one call at a time.
 *
 * BRC-29 (`3241645161d8`) is where this wallet keeps money: BSV address
 * receipts (counterparty 'anyone', date key IDs), change (counterparty self)
 * and payments from other parties. A grant is keyed by origin, protocol and
 * counterparty, never key ID, so a stored approval for one app key would also
 * cover every one of those. Asking per call keeps each signature the user's
 * decision.
 */
export const ASK_EVERY_TIME_PROTOCOLS = new Set(['3241645161d8'])

type EnsureProtocolPermissionArgs = Parameters<WalletPermissionsManager['ensureProtocolPermission']>[0]
type GrantPermissionArgs = Parameters<WalletPermissionsManager['grantPermission']>[0]
type GrantGroupedPermissionArgs = Parameters<WalletPermissionsManager['grantGroupedPermission']>[0]

function protocolName(protocolID: unknown): string | undefined {
  return Array.isArray(protocolID) && typeof protocolID[1] === 'string' ? protocolID[1].toLowerCase().trim() : undefined
}

export function isPromptFreeSigning({ usageType, privileged, protocolID }: EnsureProtocolPermissionArgs): boolean {
  const name = protocolName(protocolID)
  return usageType === 'signing' && !privileged && name !== undefined && PROMPT_FREE_SIGNING_PROTOCOLS.has(name)
}

export function isAskEveryTimeProtocol(protocolID: unknown): boolean {
  const name = protocolName(protocolID)
  return name !== undefined && ASK_EVERY_TIME_PROTOCOLS.has(name)
}

/** The manager's internals this class reaches. They are private in the
 * typings only; __tests__/services/signingPermissionPolicy.test.ts runs
 * against the real manager, so an upgrade that renames one fails there. */
interface ManagerInternals {
  prepareOriginator(originator: string): unknown
  activeRequests: Map<string, { request: { type?: string; protocolID?: unknown } }>
  findProtocolToken(originator: string, privileged: boolean, protocolID: unknown, ...rest: unknown[]): Promise<unknown>
  markRecentGrant(request: { type?: string; protocolID?: unknown }): void
}

/**
 * WalletPermissionsManager with this wallet's signing policy:
 * - PROMPT_FREE_SIGNING_PROTOCOLS sign with no prompt;
 * - ASK_EVERY_TIME_PROTOCOLS never keep an approval. A grant is always
 *   one-time, any stored token or recent-grant cover is ignored, a grouped
 *   grant leaves them out, and one origin's signing calls under them are
 *   asked one at a time, so a burst of calls cannot ride on one approval.
 * Every other check runs unchanged.
 */
export class SigningPolicyPermissionsManager extends WalletPermissionsManager {
  private readonly askEveryTimeQueues = new Map<string, Promise<unknown>>()

  constructor(...args: ConstructorParameters<typeof WalletPermissionsManager>) {
    super(...args)
    const internals = this as unknown as ManagerInternals
    const findProtocolToken = internals.findProtocolToken.bind(this)
    internals.findProtocolToken = async (originator, privileged, protocolID, ...rest) =>
      isAskEveryTimeProtocol(protocolID)
        ? undefined
        : await findProtocolToken(originator, privileged, protocolID, ...rest)
    const markRecentGrant = internals.markRecentGrant.bind(this)
    internals.markRecentGrant = request => {
      if (request?.type === 'protocol' && isAskEveryTimeProtocol(request.protocolID)) return
      markRecentGrant(request)
    }
  }

  private get internals(): ManagerInternals {
    return this as unknown as ManagerInternals
  }

  override async ensureProtocolPermission(args: EnsureProtocolPermissionArgs): Promise<boolean> {
    if (isPromptFreeSigning(args)) {
      // Still refuse a missing or malformed originator, as the full check
      // does first.
      this.internals.prepareOriginator(args.originator)
      return true
    }
    if (args.usageType !== 'signing' || !isAskEveryTimeProtocol(args.protocolID)) {
      return await super.ensureProtocolPermission(args)
    }
    // One origin's signing calls wait for each other: the manager hands every
    // call already waiting on a request the same answer, so concurrent calls
    // would otherwise share a single approval. Only signing is queued; the
    // other usages under this protocol are not prompted (WalletContext.tsx).
    const queueKey = String(args.originator)
    const previous = this.askEveryTimeQueues.get(queueKey) ?? Promise.resolve()
    const current = previous.catch(() => {}).then(async () => await super.ensureProtocolPermission(args))
    this.askEveryTimeQueues.set(queueKey, current)
    try {
      return await current
    } finally {
      if (this.askEveryTimeQueues.get(queueKey) === current) this.askEveryTimeQueues.delete(queueKey)
    }
  }

  override async grantPermission(params: GrantPermissionArgs): Promise<void> {
    const request = this.internals.activeRequests.get(params.requestID)?.request
    if (request?.type === 'protocol' && isAskEveryTimeProtocol(request.protocolID)) {
      return await super.grantPermission({ ...params, ephemeral: true })
    }
    return await super.grantPermission(params)
  }

  override async grantGroupedPermission(params: GrantGroupedPermissionArgs): Promise<void> {
    const protocols = params.granted?.protocolPermissions
    if (!protocols?.some(p => isAskEveryTimeProtocol(p.protocolID))) {
      return await super.grantGroupedPermission(params)
    }
    return await super.grantGroupedPermission({
      ...params,
      granted: { ...params.granted, protocolPermissions: protocols.filter(p => !isAskEveryTimeProtocol(p.protocolID)) }
    })
  }
}

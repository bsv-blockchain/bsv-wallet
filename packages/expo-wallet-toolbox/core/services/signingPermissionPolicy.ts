import { Hash, Utils } from '@bsv/sdk'
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
 * Protocols whose approval is never reused: every signature under them is
 * asked for again, one call at a time. Each approval is still recorded as a
 * permission token, tagged with the key ID it was given for, as a history of
 * what the user approved; the manager just never looks those tokens up.
 *
 * BRC-29 (`3241645161d8`) is where this wallet keeps money: BSV address
 * receipts (counterparty 'anyone', date key IDs), change (counterparty self)
 * and payments from other parties. A grant is keyed by origin, protocol and
 * counterparty, never key ID, so a reused approval for one app key would also
 * cover every one of those. Asking per call keeps each signature the user's
 * decision.
 */
export const ASK_EVERY_TIME_PROTOCOLS = new Set(['3241645161d8'])

type EnsureProtocolPermissionArgs = Parameters<WalletPermissionsManager['ensureProtocolPermission']>[0]
type GrantPermissionArgs = Parameters<WalletPermissionsManager['grantPermission']>[0]
type CreateSignatureArgs = Parameters<WalletPermissionsManager['createSignature']>
type VerifySignatureArgs = Parameters<WalletPermissionsManager['verifySignature']>

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

/** Matches the manager's protocol cache key,
 * `proto:<origin>:<privileged>:<level>,<name>:<counterparty>`, capturing the
 * name. Origins may carry a port, so the match anchors on the privileged flag. */
const PROTOCOL_CACHE_KEY = /^proto:.*:(?:true|false):\d+,([^:]*):/

function isAskEveryTimeCacheKey(key: unknown): boolean {
  const match = typeof key === 'string' ? PROTOCOL_CACHE_KEY.exec(key) : null
  return match !== null && isAskEveryTimeProtocol([2, match[1]])
}

/** Largest tag the wallet stores (validateTag: 1..300 bytes). */
const MAX_TAG_BYTES = 300

/** The token tag recording which key ID an approval was given for. Tags are
 * lowercased by the wallet and key IDs are case-sensitive (often base64), so
 * the key ID is stored as hex of its UTF-8 bytes, or as its SHA-256 when that
 * would not fit in a tag. */
export function keyIDTag(keyID: string): string {
  const bytes = Utils.toArray(keyID, 'utf8')
  const tag = `keyid ${Utils.toHex(bytes)}`
  return tag.length <= MAX_TAG_BYTES ? tag : `keyidhash ${Utils.toHex(Hash.sha256(bytes))}`
}

/** A protocol permission request with the key ID this class attaches to it. */
interface ProtocolRequest {
  type?: string
  originator?: string
  protocolID?: unknown
  keyID?: string
}

/** The manager's internals this class reaches. They are private in the
 * typings only; __tests__/services/signingPermissionPolicy.test.ts runs
 * against the real manager, so an upgrade that renames one fails there. */
interface ManagerInternals {
  prepareOriginator(originator: string): { normalized: string }
  activeRequests: Map<string, { request: ProtocolRequest }>
  findProtocolToken(originator: string, privileged: boolean, protocolID: unknown, ...rest: unknown[]): Promise<unknown>
  markRecentGrant(request: ProtocolRequest): void
  cachePermission(key: string, expiry: number): void
  buildTagsForRequest(request: ProtocolRequest): string[]
  fetchManifestPermissions(originator: string): Promise<ManifestPermissions>
}

/** The parts of a site's manifest.json permissions the manager reads. */
interface ManifestPermissions {
  groupPermissions: { protocolPermissions?: Array<{ protocolID?: unknown }> } | null
  counterpartyPermissions: { protocols?: Array<{ protocolName?: unknown }> } | null
}

/** The manifest's permissions without ASK_EVERY_TIME_PROTOCOLS. A site's
 * manifest may list them in its grouped (bulk) request, but such a grant is
 * never kept, so the manager would find it missing on every call and raise
 * the bulk sheet again before each signature prompt. */
function withoutAskEveryTime(manifest: ManifestPermissions): ManifestPermissions {
  const { groupPermissions, counterpartyPermissions } = manifest
  return {
    groupPermissions:
      groupPermissions?.protocolPermissions == null
        ? groupPermissions
        : {
            ...groupPermissions,
            protocolPermissions: groupPermissions.protocolPermissions.filter(
              p => !isAskEveryTimeProtocol(p?.protocolID)
            )
          },
    counterpartyPermissions:
      counterpartyPermissions?.protocols == null
        ? counterpartyPermissions
        : {
            ...counterpartyPermissions,
            protocols: counterpartyPermissions.protocols.filter(p => !isAskEveryTimeProtocol([2, p?.protocolName]))
          }
  }
}

/**
 * WalletPermissionsManager with this wallet's signing policy:
 * - PROMPT_FREE_SIGNING_PROTOCOLS sign with no prompt;
 * - ASK_EVERY_TIME_PROTOCOLS never reuse an approval. Each one is minted as
 *   a token tagged with its key ID, but no token, cache entry or recent-grant
 *   cover is ever read back for them; a site's manifest never puts them in a
 *   grouped request; and one origin's signature calls under them run one at
 *   a time, so a burst of calls cannot ride on one approval.
 * Every other check runs unchanged.
 */
export class SigningPolicyPermissionsManager extends WalletPermissionsManager {
  private readonly askEveryTimeQueues = new Map<string, Promise<unknown>>()
  /** Key ID of the ask-every-time signature call each (normalized) origin
   * has in flight. The per-origin queue keeps it to one at a time. */
  private readonly keyIDInFlight = new Map<string, string>()

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
    const cachePermission = internals.cachePermission.bind(this)
    internals.cachePermission = (key, expiry) => {
      if (isAskEveryTimeCacheKey(key)) return
      cachePermission(key, expiry)
    }
    const buildTagsForRequest = internals.buildTagsForRequest.bind(this)
    internals.buildTagsForRequest = request => {
      const tags = buildTagsForRequest(request)
      return typeof request?.keyID === 'string' ? [...tags, keyIDTag(request.keyID)] : tags
    }
    const fetchManifestPermissions = internals.fetchManifestPermissions.bind(this)
    internals.fetchManifestPermissions = async originator =>
      withoutAskEveryTime(await fetchManifestPermissions(originator))
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
    return await super.ensureProtocolPermission(args)
  }

  override async createSignature(
    ...args: CreateSignatureArgs
  ): ReturnType<WalletPermissionsManager['createSignature']> {
    return await this.oneAtATime(args[0], args[1], async () => await super.createSignature(...args))
  }

  override async verifySignature(
    ...args: VerifySignatureArgs
  ): ReturnType<WalletPermissionsManager['verifySignature']> {
    return await this.oneAtATime(args[0], args[1], async () => await super.verifySignature(...args))
  }

  /**
   * Runs an ask-every-time signature call after the same origin's previous
   * one. The manager hands every call already waiting on a request the same
   * answer, so concurrent calls would otherwise share a single approval.
   * While it runs, its key ID is what a grant of its request records.
   */
  private async oneAtATime<T>(
    args: { protocolID?: unknown; keyID?: string },
    originator: string | undefined,
    call: () => Promise<T>
  ): Promise<T> {
    if (!isAskEveryTimeProtocol(args?.protocolID)) return await call()
    let origin: string
    try {
      origin = this.internals.prepareOriginator(String(originator)).normalized
    } catch {
      return await call() // the manager refuses it with its own error
    }
    const previous = this.askEveryTimeQueues.get(origin) ?? Promise.resolve()
    const current = previous
      .catch(() => {})
      .then(async () => {
        this.keyIDInFlight.set(origin, String(args.keyID))
        try {
          return await call()
        } finally {
          this.keyIDInFlight.delete(origin)
        }
      })
    this.askEveryTimeQueues.set(origin, current)
    try {
      return await current
    } finally {
      if (this.askEveryTimeQueues.get(origin) === current) this.askEveryTimeQueues.delete(origin)
    }
  }

  override async grantPermission(params: GrantPermissionArgs): Promise<void> {
    const request = this.internals.activeRequests.get(params.requestID)?.request
    if (request?.type === 'protocol' && isAskEveryTimeProtocol(request.protocolID) && request.originator) {
      const keyID = this.keyIDInFlight.get(request.originator)
      if (keyID !== undefined) request.keyID = keyID
    }
    return await super.grantPermission(params)
  }
}

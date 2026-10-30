import { Hash, Utils } from '@bsv/sdk'
import { WalletPermissionsManager, type GroupedPermissions } from '@bsv/wallet-toolbox-mobile'

/** A site's manifest group request (BRC-73), as the Connect sheet shows it and `mintGroupedPermissions` mints it. */
export type GroupPermissions = GroupedPermissions

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
  firePermissionRequestEvent(request: ProtocolRequest, key: string): Promise<void>
  underlying: { verifySignature: WalletPermissionsManager['verifySignature'] }
  fetchManifestPermissions(originator: string): Promise<ManifestPermissions>
  callEvent(eventName: string, param: unknown): Promise<void>
  denyActiveRequest(requestID: string): void
  filterAlreadyGrantedPermissions(originator: string, group: GroupPermissions): Promise<GroupPermissions>
  buildOriginatorLookupValues(displayOriginator: string | undefined, originator: string): unknown
  persistPermissionGrant(toCreate: MintItem[], toRenew: MintItem[]): Promise<void>
}

/** One permission token to create or renew, as `persistPermissionGrant` takes it. */
interface MintItem {
  request: Record<string, unknown>
  expiry: number
  amount?: number
  oldToken?: unknown
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const isObject = (v: unknown): v is Record<string, any> => v !== null && typeof v === 'object' && !Array.isArray(v)

/**
 * The manifest group as a well-formed GroupPermissions, or null when it lists nothing. A site writes
 * the manifest, so every entry is checked: one that does not have the shape the manager reads is
 * left out, and what remains is both what the Connect sheet shows and what Connect mints.
 */
function sanitizeGroup(raw: unknown): GroupPermissions | null {
  if (!isObject(raw)) return null
  const group: GroupPermissions = {}
  if (typeof raw.description === 'string') group.description = raw.description
  const spending = raw.spendingAuthorization
  if (isObject(spending) && Number.isSafeInteger(spending.amount) && spending.amount > 0) {
    group.spendingAuthorization = { amount: spending.amount, description: str(spending.description) }
  }
  const list = (v: unknown): any[] => (Array.isArray(v) ? v.filter(isObject) : [])
  group.protocolPermissions = list(raw.protocolPermissions)
    .filter(
      p =>
        Array.isArray(p.protocolID) &&
        p.protocolID.length === 2 &&
        [0, 1, 2].includes(p.protocolID[0]) &&
        typeof p.protocolID[1] === 'string' &&
        (p.counterparty === undefined || typeof p.counterparty === 'string')
    )
    .map(p => ({
      protocolID: [p.protocolID[0], p.protocolID[1]] as [0 | 1 | 2, string],
      ...(p.counterparty !== undefined ? { counterparty: p.counterparty as string } : {}),
      description: str(p.description)
    }))
  group.basketAccess = list(raw.basketAccess)
    .filter(b => typeof b.basket === 'string' && b.basket.length > 0)
    .map(b => ({ basket: b.basket as string, description: str(b.description) }))
  group.certificateAccess = list(raw.certificateAccess)
    .filter(
      c =>
        typeof c.type === 'string' &&
        typeof c.verifierPublicKey === 'string' &&
        Array.isArray(c.fields) &&
        c.fields.every((f: unknown) => typeof f === 'string')
    )
    .map(c => ({
      type: c.type as string,
      fields: [...c.fields] as string[],
      verifierPublicKey: c.verifierPublicKey as string,
      description: str(c.description)
    }))
  const empty =
    group.spendingAuthorization === undefined &&
    !group.protocolPermissions.length &&
    !group.basketAccess.length &&
    !group.certificateAccess.length
  return empty ? null : group
}

/** The events that put a question to the user (all carry a `requestID`). A
 * retired manager denies these instead of raising them. */
const PROMPT_EVENTS = new Set([
  'onProtocolPermissionRequested',
  'onBasketAccessRequested',
  'onCertificateAccessRequested',
  'onSpendingAuthorizationRequested',
  'onGroupedPermissionRequested',
  'onCounterpartyPermissionRequested'
])

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
 *   grouped request; and one origin's createSignature calls under them run
 *   one at a time, so a burst of calls cannot ride on one approval;
 * - a non-privileged verifySignature is never prompted;
 * - once retired (its wallet was replaced), it raises no prompt: every prompt
 *   event is denied on the spot, so a call still parked inside it ends instead
 *   of surfacing a sheet for a wallet that is gone.
 * Every other check runs unchanged.
 */
export class SigningPolicyPermissionsManager extends WalletPermissionsManager {
  private readonly askEveryTimeQueues = new Map<string, Promise<unknown>>()
  /** Key ID of the ask-every-time createSignature call each (normalized)
   * origin has in flight. The per-origin queue keeps it to one at a time. */
  private readonly keyIDInFlight = new Map<string, string>()
  private retired = false
  private readonly retireHooks: Array<() => void> = []

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
    // The request object is the one the manager keeps until it is answered,
    // so the key ID set here reaches both the prompt (the event's arguments
    // spread it) and the token a grant mints (buildTagsForRequest above).
    const firePermissionRequestEvent = internals.firePermissionRequestEvent.bind(this)
    internals.firePermissionRequestEvent = async (request, key) => {
      if (request?.type === 'protocol' && isAskEveryTimeProtocol(request.protocolID) && request.originator) {
        const keyID = this.keyIDInFlight.get(request.originator)
        if (keyID !== undefined) request.keyID = keyID
      }
      return await firePermissionRequestEvent(request, key)
    }
    // Deny, never throw: a throw out of callEvent would leave the entry its
    // caller registered unsettled (its waiter hangs, and a grouped one holds
    // the per-originator lock). Denying settles the waiter and removes it.
    const callEvent = internals.callEvent.bind(this)
    internals.callEvent = async (eventName, param) => {
      const requestID = (param as { requestID?: unknown } | null | undefined)?.requestID
      if (this.retired && PROMPT_EVENTS.has(eventName) && typeof requestID === 'string') {
        try {
          internals.denyActiveRequest.call(this, requestID)
        } catch {
          // Already settled.
        }
        return
      }
      await callEvent(eventName, param)
    }
    const fetchManifestPermissions = internals.fetchManifestPermissions.bind(this)
    internals.fetchManifestPermissions = async originator =>
      withoutAskEveryTime(await fetchManifestPermissions(originator))
  }

  private get internals(): ManagerInternals {
    return this as unknown as ManagerInternals
  }

  /**
   * One-way: from here on this manager raises no prompt. Call it only on a
   * manager that has been replaced, never on the one just published. `onRetire`
   * hooks run in this same synchronous step.
   */
  retire(): void {
    if (this.retired) return
    this.retired = true
    for (const hook of this.retireHooks.splice(0)) {
      try {
        hook()
      } catch {
        // A hook must not stop the others.
      }
    }
  }

  isRetired(): boolean {
    return this.retired
  }

  /** Runs `hook` when this manager is retired (immediately if it already is). */
  onRetire(hook: () => void): void {
    if (this.retired) hook()
    else this.retireHooks.push(hook)
  }

  /**
   * The group this origin's manifest asks for, as the later group check will read it: the same
   * `fetchManifestPermissions` and its 5-minute cache, with ask-every-time protocols already
   * filtered (and, on the unverified manager, spending and token modules). Null when there is no
   * manifest, it lists nothing, or the fetch fails. Raises no prompt.
   */
  async peekGroupPermissions(originator: string): Promise<GroupPermissions | null> {
    try {
      const { normalized } = this.internals.prepareOriginator(originator)
      const { groupPermissions } = await this.internals.fetchManifestPermissions(normalized)
      return sanitizeGroup(groupPermissions)
    } catch {
      return null
    }
  }

  /**
   * Mints a permission token for every item of `group` that does not already hold one, the way
   * `grantGroupedPermission` does for a granted item, but with no active request to answer. An
   * expired token is renewed. Ask-every-time protocols are never minted. Throws if the mint fails;
   * the caller decides what that means.
   */
  async mintGroupedPermissions(originator: string, group: GroupPermissions): Promise<void> {
    const i = this.internals
    const { normalized } = i.prepareOriginator(originator)
    const wanted: GroupPermissions = {
      ...group,
      protocolPermissions: (group.protocolPermissions ?? []).filter(p => !isAskEveryTimeProtocol(p.protocolID))
    }
    const todo = await i.filterAlreadyGrantedPermissions(normalized, wanted)
    const lookup = i.buildOriginatorLookupValues(originator, normalized)
    const toCreate: MintItem[] = []
    const toRenew: MintItem[] = []
    if (todo.spendingAuthorization != null) {
      toCreate.push({
        request: {
          type: 'spending',
          originator: normalized,
          spending: { satoshis: todo.spendingAuthorization.amount },
          reason: todo.spendingAuthorization.description
        },
        expiry: 0,
        amount: todo.spendingAuthorization.amount
      })
    }
    for (const p of todo.protocolPermissions ?? []) {
      const counterparty = (p.protocolID?.[0] ?? 0) === 1 ? '' : p.counterparty || 'self'
      const request = {
        type: 'protocol',
        originator: normalized,
        privileged: false,
        protocolID: p.protocolID,
        counterparty,
        reason: p.description
      }
      const token = await i.findProtocolToken(normalized, false, p.protocolID, counterparty, true, lookup)
      if (token == null) toCreate.push({ request, expiry: 0 })
      else toRenew.push({ oldToken: token, request, expiry: 0 })
    }
    for (const b of todo.basketAccess ?? []) {
      toCreate.push({
        request: { type: 'basket', originator: normalized, basket: b.basket, reason: b.description },
        expiry: 0
      })
    }
    for (const c of todo.certificateAccess ?? []) {
      toCreate.push({
        request: {
          type: 'certificate',
          originator: normalized,
          privileged: false,
          certificate: { verifier: c.verifierPublicKey, certType: c.type, fields: c.fields },
          reason: c.description
        },
        expiry: 0
      })
    }
    if (toCreate.length === 0 && toRenew.length === 0) return
    await i.persistPermissionGrant(toCreate, toRenew)
  }

  /** Whether a prompt with this ID is still waiting for an answer. */
  hasActiveRequest(requestID: string): boolean {
    return this.internals.activeRequests.has(requestID)
  }

  /** Denies every request still waiting for an answer. Never throws. */
  denyAllActiveRequests(): void {
    for (const requestID of [...this.internals.activeRequests.keys()]) {
      try {
        this.internals.denyActiveRequest(requestID)
      } catch {
        // Already settled.
      }
    }
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

  /** Verifying a signature reveals nothing and spends nothing, so a
   * non-privileged verification is answered without a protocol prompt. The
   * originator is still validated, and admin-reserved (`admin…`) and
   * module-routed (`p …`) protocols still take the manager's full path. */
  override async verifySignature(
    ...args: VerifySignatureArgs
  ): ReturnType<WalletPermissionsManager['verifySignature']> {
    const [request, originator] = args
    const name = protocolName(request?.protocolID)
    if (request?.privileged || name === undefined || name.startsWith('admin') || name.startsWith('p ')) {
      return await super.verifySignature(...args)
    }
    this.internals.prepareOriginator(String(originator))
    return await this.internals.underlying.verifySignature(request, originator)
  }

  /**
   * Runs an ask-every-time createSignature call after the same origin's
   * previous one. The manager hands every call already waiting on a request
   * the same answer, so concurrent calls would otherwise share a single
   * approval. While it runs, its key ID is what its prompt shows and what a
   * grant of its request records.
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
}

/**
 * Site consent (spec 6.4): which websites the user has connected, per profile and per
 * attestation, the reconnect token that lets a remembered unverified site return silently, and
 * the clean slate every new approval starts from.
 *
 * Stateful but transport-free: the dispatcher parks requests and calls `requestConsent`, the
 * PermissionSheet reads `listPending` and answers by `requestId`. The store knows nothing about
 * bindings beyond the opaque epoch strings it is handed.
 *
 * Records are HMAC-tagged by the admin-scoped wallet under the reserved `bridge site authority`
 * namespace (the XR-027 / `connectionAuthority.ts` pattern), so a raw storage edit cannot plant
 * a connected site. A record whose tag fails to verify is simply not connected.
 */
import { Hash, type WalletInterface } from '@bsv/sdk'
import { b64uDecode, b64uEncode } from './protocol/base64url'
import { DECLINE_BACKOFF_MS, RECONNECT_TOKEN_BYTES } from './protocol/limits'
import type { Attestation } from './protocol/origin'
import { BRIDGE_SITE_AUTHORITY_PROTOCOL_ID } from './permissionPolicy'
import { mintGrantTag, unverifiedOriginator } from './unverifiedOriginator'

export type HmacCapableWallet = Pick<WalletInterface, 'createHmac' | 'verifyHmac'>

/** The subset of AsyncStorage the store needs. */
export interface KeyValue {
  getItem(key: string): Promise<string | null>
  setItem(key: string, value: string): Promise<void>
  removeItem(key: string): Promise<void>
  getAllKeys(): Promise<readonly string[]>
}

export interface SiteRecord {
  applicationOrigin: string
  originator: string
  attestation: Attestation
  transport: string
  approvedAt: number
  /** Unattested only: `g` + 10 base32 characters, minted at every approval. */
  grantTag?: string
  /** Unattested only: base64url SHA-256 of the reconnect token. The token itself is never stored. */
  reconnectHash?: string
  tag: string
}

export interface ConsentRequestInput {
  origin: string
  attestation: Attestation
  transportId: string
  bindingEpoch: string
  walletRevision: number
  /** The origin was approved before on this device, so the sheet says "Approving starts fresh". */
  connectedBefore: boolean
}

/** What the sheet needs to show a pending `connection` request. */
export interface PendingConsent {
  requestId: string
  origin: string
  attestation: Attestation
  transportId: string
  connectedBefore: boolean
  walletRevision: number
  profileKey: string
}

export interface ConsentAnswerContext {
  walletRevision: number
  profileKey: string
}

export interface ConsentStoreDeps {
  storage: KeyValue
  adminWallet: HmacCapableWallet
  adminOriginator: string
  profileKey: () => string
  now: () => number
  randomBytes: (n: number) => Uint8Array
}

export interface ConnectedSite {
  applicationOrigin: string
  originator: string
  attestation: Attestation
  transport: string
  approvedAt: number
}

export type ConsentOutcome = 'approved' | 'declined'

export interface ConsentStore {
  lookup(origin: string, attestation: Attestation): Promise<SiteRecord | undefined>
  /** Constant-time. Verified records need no token; an unattested record needs the matching one. */
  checkReconnect(record: SiteRecord, token?: string): boolean
  requestConsent(
    input: ConsentRequestInput
  ): { requestId: string; promise: Promise<ConsentOutcome> } | { refused: 'slot-held' | 'backoff' }
  answerConsent(
    requestId: string,
    approve: boolean,
    ctx: ConsentAnswerContext
  ): Promise<{ record: SiteRecord; reconnectToken?: string } | undefined>
  dropRequestsFor(epoch: string): void
  withdrawAll(): void
  listPending(): PendingConsent[]
  listConnectedSites(): Promise<ConnectedSite[]>
  /** Deletes the record only; closing the origin's live bindings with `revoked` is the caller's job. */
  revokeSite(origin: string, attestation: Attestation): Promise<void>
  onChange(fn: () => void): () => void
}

const STORE_PREFIX = 'bsv-bridge-sites'
const storeKey = (profileKey: string) => `${STORE_PREFIX}:${profileKey}`
const TAG_DOMAIN = 'bsv-wallet-bridge-site-record-v1'
const ORIGIN_RE = /^https?:\/\/([^/:]+)(?::\d+)?$/

/** Removes every profile's connected-sites key, including a bare profile 0 key. Run at logout and Delete Wallet. */
export async function sweepConsentStorage(storage: Pick<KeyValue, 'getAllKeys' | 'removeItem'>): Promise<void> {
  const keys = await storage.getAllKeys()
  for (const k of keys) {
    if (k === STORE_PREFIX || k.startsWith(`${STORE_PREFIX}:`)) await storage.removeItem(k)
  }
}

type Unsigned = Omit<SiteRecord, 'tag'>

function recordMessage(profileKey: string, r: Unsigned): number[] {
  // A JSON array has one unambiguous encoding, so no field can bleed into its neighbour.
  return Array.from(
    new TextEncoder().encode(
      JSON.stringify([
        TAG_DOMAIN,
        profileKey,
        r.applicationOrigin,
        r.originator,
        r.attestation,
        r.transport,
        r.approvedAt,
        r.grantTag ?? '',
        r.reconnectHash ?? ''
      ])
    )
  )
}

const recordKeyId = (origin: string, attestation: Attestation) => `site:${attestation}:${origin}`

function isRecordShape(v: unknown): v is SiteRecord {
  if (v === null || typeof v !== 'object') return false
  const r = v as Record<string, unknown>
  return (
    typeof r.applicationOrigin === 'string' &&
    typeof r.originator === 'string' &&
    (r.attestation === 'browser' || r.attestation === 'unattested') &&
    typeof r.transport === 'string' &&
    typeof r.approvedAt === 'number' &&
    (r.grantTag === undefined || typeof r.grantTag === 'string') &&
    (r.reconnectHash === undefined || typeof r.reconnectHash === 'string') &&
    typeof r.tag === 'string'
  )
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
  return diff === 0
}

interface Pending extends PendingConsent {
  epochs: Set<string>
  settle: (o: ConsentOutcome) => void
  promise: Promise<ConsentOutcome>
  answering: boolean
}

export function createConsentStore(deps: ConsentStoreDeps): ConsentStore {
  const { storage, adminWallet, adminOriginator } = deps
  const pending = new Map<string, Pending>()
  const slotByTransport = new Map<string, string>()
  const declinedAt = new Map<string, number>()
  const listeners = new Set<() => void>()
  let nextId = 0
  // Store writes read-modify-write one key; serializing them keeps two approvals from clobbering each other.
  let writeChain: Promise<unknown> = Promise.resolve()
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = writeChain.then(fn, fn)
    writeChain = run.catch(() => undefined)
    return run
  }

  const notify = () => {
    for (const fn of [...listeners]) {
      try {
        fn()
      } catch {
        // A listener must not stop the others.
      }
    }
  }
  const siteKey = (origin: string, attestation: Attestation) => `${attestation}|${origin}`

  async function readRecords(profileKey: string): Promise<SiteRecord[]> {
    try {
      const raw = await storage.getItem(storeKey(profileKey))
      if (raw === null) return []
      const parsed = JSON.parse(raw) as { records?: unknown }
      return Array.isArray(parsed?.records) ? parsed.records.filter(isRecordShape) : []
    } catch {
      return []
    }
  }

  async function tagFor(profileKey: string, r: Unsigned): Promise<string> {
    const { hmac } = await adminWallet.createHmac(
      {
        protocolID: BRIDGE_SITE_AUTHORITY_PROTOCOL_ID,
        keyID: recordKeyId(r.applicationOrigin, r.attestation),
        counterparty: 'self',
        data: recordMessage(profileKey, r)
      },
      adminOriginator
    )
    return b64uEncode(Uint8Array.from(hmac))
  }

  async function isAuthentic(profileKey: string, r: SiteRecord): Promise<boolean> {
    try {
      const { valid } = await adminWallet.verifyHmac(
        {
          protocolID: BRIDGE_SITE_AUTHORITY_PROTOCOL_ID,
          keyID: recordKeyId(r.applicationOrigin, r.attestation),
          counterparty: 'self',
          data: recordMessage(profileKey, r),
          hmac: Array.from(b64uDecode(r.tag))
        },
        adminOriginator
      )
      return valid === true
    } catch {
      // verifyHmac rejects on a mismatch; a locked wallet or a malformed tag land here too.
      return false
    }
  }

  async function lookup(origin: string, attestation: Attestation): Promise<SiteRecord | undefined> {
    const profileKey = deps.profileKey()
    const found = (await readRecords(profileKey)).find(
      r => r.applicationOrigin === origin && r.attestation === attestation
    )
    if (found === undefined) return undefined
    return (await isAuthentic(profileKey, found)) ? found : undefined
  }

  function checkReconnect(record: SiteRecord, token?: string): boolean {
    if (record.attestation !== 'unattested') return true
    if (typeof token !== 'string' || token.length === 0 || record.reconnectHash === undefined) return false
    try {
      const presented = b64uDecode(token)
      if (presented.length !== RECONNECT_TOKEN_BYTES) return false
      const hash = Uint8Array.from(Hash.sha256(Array.from(presented)))
      return constantTimeEqual(hash, b64uDecode(record.reconnectHash))
    } catch {
      return false
    }
  }

  function remove(p: Pending): void {
    pending.delete(p.requestId)
    // Joining transports hold a slot on this request too, so clear every one that points at it.
    for (const [transportId, held] of [...slotByTransport]) {
      if (held === p.requestId) slotByTransport.delete(transportId)
    }
  }

  function requestConsent(input: ConsentRequestInput) {
    const key = siteKey(input.origin, input.attestation)
    // One request per origin and attestation: a second binding joins the sheet already waiting.
    for (const p of pending.values()) {
      if (p.origin === input.origin && p.attestation === input.attestation) {
        const held = slotByTransport.get(input.transportId)
        if (held !== undefined && held !== p.requestId) return { refused: 'slot-held' as const }
        slotByTransport.set(input.transportId, p.requestId)
        p.epochs.add(input.bindingEpoch)
        return { requestId: p.requestId, promise: p.promise }
      }
    }
    const declined = declinedAt.get(key)
    if (declined !== undefined) {
      if (deps.now() - declined < DECLINE_BACKOFF_MS) return { refused: 'backoff' as const }
      declinedAt.delete(key)
    }
    if (slotByTransport.has(input.transportId)) return { refused: 'slot-held' as const }
    const requestId = `c${++nextId}-${b64uEncode(deps.randomBytes(9))}`
    let settle!: (o: ConsentOutcome) => void
    const promise = new Promise<ConsentOutcome>(res => (settle = res))
    const p: Pending = {
      requestId,
      origin: input.origin,
      attestation: input.attestation,
      transportId: input.transportId,
      connectedBefore: input.connectedBefore,
      walletRevision: input.walletRevision,
      profileKey: deps.profileKey(),
      epochs: new Set([input.bindingEpoch]),
      settle,
      promise,
      answering: false
    }
    pending.set(requestId, p)
    slotByTransport.set(input.transportId, requestId)
    notify()
    return { requestId, promise }
  }

  async function answerConsent(requestId: string, approve: boolean, ctx: ConsentAnswerContext) {
    const p = pending.get(requestId)
    if (p === undefined || p.answering) return undefined
    if (p.walletRevision !== ctx.walletRevision || p.profileKey !== ctx.profileKey) return undefined
    if (!approve) {
      remove(p)
      declinedAt.set(siteKey(p.origin, p.attestation), deps.now())
      p.settle('declined')
      notify()
      return undefined
    }
    const host = ORIGIN_RE.exec(p.origin)?.[1]
    if (host === undefined) return undefined
    p.answering = true
    const profileKey = p.profileKey
    let reconnectToken: string | undefined
    try {
      const unsigned: Unsigned = {
        applicationOrigin: p.origin,
        originator: host,
        attestation: p.attestation,
        transport: p.transportId,
        approvedAt: deps.now()
      }
      if (p.attestation === 'unattested') {
        // Clean slate: a fresh grant tag moves the site to a new originator, and a fresh token
        // replaces the hash, so nothing earlier carries over.
        unsigned.grantTag = mintGrantTag()
        unsigned.originator = unverifiedOriginator(host, unsigned.grantTag)
        const token = deps.randomBytes(RECONNECT_TOKEN_BYTES)
        reconnectToken = b64uEncode(token)
        unsigned.reconnectHash = b64uEncode(Uint8Array.from(Hash.sha256(Array.from(token))))
      }
      return await serial(async () => {
        const existing = await readRecords(profileKey)
        const tag = await tagFor(profileKey, unsigned)
        // No await between this re-check and the write call: a wallet replacement or teardown
        // that happened while the tag was computed already withdrew the request (the revision
        // is fixed for this entry, so withdrawal is how it shows). A profile switch leaves the
        // request pending, so drop it here.
        if (pending.get(requestId) !== p) return undefined
        if (deps.profileKey() !== profileKey) {
          remove(p)
          notify()
          return undefined
        }
        const record: SiteRecord = { ...unsigned, tag }
        const kept = existing.filter(r => !(r.applicationOrigin === p.origin && r.attestation === p.attestation))
        const write = storage.setItem(storeKey(profileKey), JSON.stringify({ records: [...kept, record] }))
        remove(p)
        notify()
        await write
        p.settle('approved')
        return { record, reconnectToken }
      })
    } catch {
      // A locked wallet or a failed write: nothing was stored, so the site is not connected.
      if (pending.get(requestId) === p) remove(p)
      p.settle('declined')
      notify()
      return undefined
    } finally {
      p.answering = false
      // No-op after an approval (already settled); every other exit leaves the request declined.
      p.settle('declined')
    }
  }

  function dropRequestsFor(epoch: string): void {
    let changed = false
    for (const p of [...pending.values()]) {
      if (!p.epochs.delete(epoch) || p.epochs.size > 0) continue
      remove(p)
      p.settle('declined')
      changed = true
    }
    if (changed) notify()
  }

  function withdrawAll(): void {
    const all = [...pending.values()]
    pending.clear()
    slotByTransport.clear()
    for (const p of all) p.settle('declined')
    if (all.length > 0) notify()
  }

  const listPending = (): PendingConsent[] =>
    [...pending.values()].map(
      ({ requestId, origin, attestation, transportId, connectedBefore, walletRevision, profileKey }) => ({
        requestId,
        origin,
        attestation,
        transportId,
        connectedBefore,
        walletRevision,
        profileKey
      })
    )

  async function listConnectedSites(): Promise<ConnectedSite[]> {
    const profileKey = deps.profileKey()
    const out: ConnectedSite[] = []
    for (const r of await readRecords(profileKey)) {
      if (!(await isAuthentic(profileKey, r))) continue
      out.push({
        applicationOrigin: r.applicationOrigin,
        originator: r.originator,
        attestation: r.attestation,
        transport: r.transport,
        approvedAt: r.approvedAt
      })
    }
    return out
  }

  async function revokeSite(origin: string, attestation: Attestation): Promise<void> {
    const profileKey = deps.profileKey()
    await serial(async () => {
      const records = await readRecords(profileKey)
      const kept = records.filter(r => !(r.applicationOrigin === origin && r.attestation === attestation))
      if (kept.length === records.length) return
      await storage.setItem(storeKey(profileKey), JSON.stringify({ records: kept }))
      notify()
    })
  }

  return {
    lookup,
    checkReconnect,
    requestConsent,
    answerConsent,
    dropRequestsFor,
    withdrawAll,
    listPending,
    listConnectedSites,
    revokeSite,
    onChange(fn) {
      listeners.add(fn)
      return () => {
        listeners.delete(fn)
      }
    }
  }
}

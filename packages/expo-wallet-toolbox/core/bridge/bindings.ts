/**
 * Binding registry (spec 6.7): the live pairing between one page (an epoch) and the wallet,
 * the install-wide tombstone ring that stops a closed epoch from ever binding again, the
 * admission horizon for implicit (queue) epochs, and the synchronous close fan-out.
 *
 * Transport-free and clock-injected. Bindings live in memory only; the tombstone ring, its
 * `evictedThrough` watermark and the `closeSeq` counter persist through `tombstoneStorage`.
 * Closes are synchronous: `onClosed` runs before `close` returns, so no request on a replacement
 * binding is admitted ahead of the fan-out. Persistence is a serialised write queue behind that;
 * the in-memory ring is authoritative once `load()` has resolved, and `flush()` awaits the queue.
 *
 * The ContinuityStore comparison for an explicit connect (a mismatch is `PROVIDER_CHANGED`) is the
 * transport's step before `connectExplicit`; this module only compares what each request repeats.
 */
import type { KeyValue } from './consent'
import { connectionError, isConnectionError, type ConnectionError } from './protocol/connectionError'
import type { InternalCloseReason } from './protocol/envelopes'
import { MAX_BINDINGS_PER_ORIGIN, MAX_BINDINGS_TOTAL, TOMBSTONE_RING_SIZE, TOMBSTONE_TTL_MS } from './protocol/limits'
import { canonicalizeBridgeOrigin, OriginRefused, type Attestation } from './protocol/origin'

/** The wallet revision is a persisted counter; the queue stores it as a string. Compared as text. */
export type WalletRevision = string | number

export interface Binding {
  epoch: string
  transportId: string
  applicationOrigin: string
  /** Browser: the hostname. Unattested: set when consent resolves (6.3). */
  originator?: string
  attestation: Attestation
  instanceId: string
  continuityKey: string
  accountContext: string
  walletRevision: WalletRevision
  boundAt: number
  createdAt: number
  state: 'live' | 'closed'
  closeReason?: InternalCloseReason
  /** Present and true on every unattested binding, absent on `browser` bindings. Fixed at connect. */
  launchProofVerified?: true
  /** True once the reconnect token matched or the user approved (6.4). */
  consented: boolean
}

export interface CloseEvent {
  closeSeq: number
  epoch: string
  reason: InternalCloseReason
  /** False for a page-initiated disconnect: tombstone and outbox event, but no notice to that page. */
  notifyPage: boolean
  transportId: string
  instanceId: string
  applicationOrigin: string
}

export interface BindingRegistryDeps {
  tombstoneStorage: KeyValue
  now: () => number
  onClosed: (e: CloseEvent) => void
  /**
   * The registered transport, which is where trust comes from (spec 6.2): its attestation and
   * binding mode. When given, a binding on an unknown transport, or one whose attestation or mode
   * differs from the registration, is refused. Absent in unit tests that exercise the registry alone.
   */
  transportInfo?: (id: string) => { attestation: Attestation; bindingMode: 'implicit' | 'explicit' } | undefined
  /** Host policy for `http://localhost:<port>` origins (development builds only). */
  allowLocalhostHttp?: () => boolean
}

export interface ExplicitConnectInput {
  epoch: string
  transportId: string
  applicationOrigin: string
  originator?: string
  attestation: Attestation
  instanceId: string
  continuityKey: string
  accountContext: string
  walletRevision: WalletRevision
  launchProofVerified?: boolean
  /**
   * Unattested only: the reconnect token the page presented at connect (6.4, 6.7). Held in memory
   * beside the binding, never on it, so no snapshot, log line or error can carry it. The
   * dispatcher takes it once, at the binding's first interactive request.
   */
  reconnectToken?: string
}

/** An inbox record (6.8) plus what the registered transport contributes: its id and attestation. */
export interface ImplicitRecord {
  epoch: string
  transportId: string
  attestation: Attestation
  origin: string
  instanceId: string
  continuityKey: string
  accountContext: string
  walletRevision: WalletRevision
  boundAt: number
  originator?: string
}

export interface ResolveRequest {
  epoch: string
  instanceId: string
  continuityKey: string
  origin: string
  accountContext?: string
}

export interface BindingRegistry {
  /** Reads the persisted ring. Must resolve before any other call; a storage failure rejects. */
  load(): Promise<void>
  /** Resolves once every queued ring write has reached storage. */
  flush(): Promise<void>
  connectExplicit(input: ExplicitConnectInput): Binding
  admitImplicit(
    record: ImplicitRecord,
    current: { walletRevision: WalletRevision; accountContext: string }
  ): Binding | ConnectionError
  resolve(transportId: string, request: ResolveRequest): Binding | ConnectionError
  /** Records the originator minted at consent and marks the binding consented. */
  markConsented(epoch: string, originator: string): void
  /** Returns the connect-time reconnect token once and forgets it. Undefined when none was presented. */
  takeReconnectToken(epoch: string): string | undefined
  close(epoch: string, reason: InternalCloseReason): void
  closeAll(reason: InternalCloseReason): void
  live(): Binding[]
}

interface Tombstone {
  reason: InternalCloseReason
  closedAt: number
}

const RING_KEY = 'bsv-bridge-binding-tombstones-v1'

export function createBindingRegistry(deps: BindingRegistryDeps): BindingRegistry {
  const liveByEpoch = new Map<string, Binding>()
  // Off the Binding object on purpose (see ExplicitConnectInput.reconnectToken).
  const reconnectTokens = new Map<string, string>()
  // Map keeps insertion order, which is close order: the first entry is the oldest.
  const ring = new Map<string, Tombstone>()
  let evictedThrough = 0
  let closeSeq = 0
  let loaded = false
  let writes: Promise<void> = Promise.resolve()

  const sameRev = (a: WalletRevision, b: WalletRevision) => String(a) === String(b)

  function assertLoaded() {
    // Fail closed: without the ring an old epoch could be re-admitted.
    if (!loaded) throw new Error('Binding registry used before load()')
  }

  function persist() {
    const body = JSON.stringify({
      v: 1,
      evictedThrough,
      closeSeq,
      entries: [...ring].map(([epoch, t]) => [epoch, t.reason, t.closedAt])
    })
    writes = writes.then(
      () => deps.tombstoneStorage.setItem(RING_KEY, body),
      () => deps.tombstoneStorage.setItem(RING_KEY, body)
    )
    // A failed write must not become an unhandled rejection; flush() surfaces it.
    writes.catch(() => undefined)
  }

  function prune(now: number) {
    for (const [epoch, t] of ring) {
      if (now - t.closedAt <= TOMBSTONE_TTL_MS) break
      ring.delete(epoch)
    }
  }

  function tombstone(epoch: string, reason: InternalCloseReason) {
    const now = deps.now()
    ring.set(epoch, { reason, closedAt: now })
    while (ring.size > TOMBSTONE_RING_SIZE) {
      const [oldest, t] = ring.entries().next().value as [string, Tombstone]
      ring.delete(oldest)
      if (t.closedAt > evictedThrough) evictedThrough = t.closedAt
    }
    prune(now)
  }

  /** The one close path: tombstone, increment closeSeq, persist, then fan out synchronously. */
  function recordClose(
    who: Pick<Binding, 'epoch' | 'transportId' | 'instanceId' | 'applicationOrigin'>,
    reason: InternalCloseReason
  ) {
    tombstone(who.epoch, reason)
    closeSeq += 1
    persist()
    deps.onClosed({
      closeSeq,
      epoch: who.epoch,
      reason,
      notifyPage: reason !== 'disconnected',
      transportId: who.transportId,
      instanceId: who.instanceId,
      applicationOrigin: who.applicationOrigin
    })
  }

  function tombstoneError(epoch: string, t: Tombstone): ConnectionError {
    return connectionError('PROVIDER_CHANGED', 'This connection was closed', 'not-sent', {
      epoch,
      ...(t.reason === 'disconnected' ? {} : { cause: t.reason })
    })
  }

  function limitError(epoch: string, message: string): ConnectionError {
    return connectionError('RESOURCE_LIMIT', message, 'not-sent', { epoch })
  }

  /** Returns an error when a new live binding for `origin` would exceed a limit. */
  function checkLimits(epoch: string, origin: string): ConnectionError | undefined {
    if (liveByEpoch.size >= MAX_BINDINGS_TOTAL) return limitError(epoch, 'Too many open connections')
    let perOrigin = 0
    for (const b of liveByEpoch.values()) if (b.applicationOrigin === origin) perOrigin++
    if (perOrigin >= MAX_BINDINGS_PER_ORIGIN) return limitError(epoch, 'Too many open connections for this site')
    return undefined
  }

  /**
   * The core's own check of the trust inputs it is handed (spec 6.3): the origin must be canonical
   * for its attestation, and the attestation and binding mode must be the registered transport's.
   * Returns the canonical originator for a `browser` binding.
   */
  function validateTrust(
    epoch: string,
    transportId: string,
    origin: string,
    attestation: Attestation,
    mode: 'implicit' | 'explicit'
  ): { originator: string | undefined } | ConnectionError {
    if (deps.transportInfo) {
      const info = deps.transportInfo(transportId)
      if (!info) return connectionError('CONFIGURATION_ERROR', 'Transport is not registered', 'not-sent', { epoch })
      if (info.attestation !== attestation || info.bindingMode !== mode) {
        return connectionError('PROTOCOL_ERROR', 'Attestation does not match the transport', 'not-sent', { epoch })
      }
    }
    try {
      const canon = canonicalizeBridgeOrigin({
        origin,
        attestation,
        allowLocalhostHttp: deps.allowLocalhostHttp?.() === true
      })
      return { originator: canon.originator }
    } catch (e) {
      if (e instanceof OriginRefused) {
        return connectionError('PROTOCOL_ERROR', 'Origin refused', 'not-sent', { epoch })
      }
      throw e
    }
  }

  function create(
    base: Omit<Binding, 'createdAt' | 'state' | 'consented' | 'launchProofVerified'>,
    launchProofVerified: boolean | undefined
  ): Binding {
    const b: Binding = { ...base, createdAt: deps.now(), state: 'live', consented: false }
    if (b.attestation === 'unattested' && launchProofVerified === true) b.launchProofVerified = true
    liveByEpoch.set(b.epoch, b)
    return b
  }

  return {
    async load() {
      const raw = await deps.tombstoneStorage.getItem(RING_KEY)
      ring.clear()
      evictedThrough = 0
      closeSeq = 0
      if (raw !== null) {
        const p = JSON.parse(raw)
        if (p && p.v === 1 && Array.isArray(p.entries)) {
          evictedThrough = Number(p.evictedThrough) || 0
          closeSeq = Number(p.closeSeq) || 0
          for (const e of p.entries) {
            if (Array.isArray(e) && typeof e[0] === 'string' && typeof e[2] === 'number') {
              ring.set(e[0], { reason: e[1], closedAt: e[2] })
            }
          }
        }
      }
      prune(deps.now())
      loaded = true
    },

    flush: () => writes,

    connectExplicit(input) {
      assertLoaded()
      if (input.attestation === 'unattested' && input.launchProofVerified !== true) {
        // No binding and no limit slot: the check runs before either.
        throw connectionError(
          'CONFIGURATION_ERROR',
          'An unattested connection needs a verified launch proof',
          'not-sent',
          { epoch: input.epoch }
        )
      }
      const trust = validateTrust(
        input.epoch,
        input.transportId,
        input.applicationOrigin,
        input.attestation,
        'explicit'
      )
      if (isConnectionError(trust)) throw trust
      const dead = ring.get(input.epoch)
      if (dead) throw tombstoneError(input.epoch, dead)
      if (liveByEpoch.has(input.epoch)) {
        throw connectionError('PROTOCOL_ERROR', 'Connection epoch already in use', 'not-sent', { epoch: input.epoch })
      }
      const over = checkLimits(input.epoch, input.applicationOrigin)
      if (over) throw over
      const created = create(
        {
          epoch: input.epoch,
          transportId: input.transportId,
          applicationOrigin: input.applicationOrigin,
          originator: trust.originator ?? input.originator,
          attestation: input.attestation,
          instanceId: input.instanceId,
          continuityKey: input.continuityKey,
          accountContext: input.accountContext,
          walletRevision: input.walletRevision,
          boundAt: deps.now()
        },
        input.launchProofVerified
      )
      if (input.attestation === 'unattested' && typeof input.reconnectToken === 'string' && input.reconnectToken) {
        reconnectTokens.set(input.epoch, input.reconnectToken)
      }
      return created
    },

    admitImplicit(record, current) {
      assertLoaded()
      const trust = validateTrust(record.epoch, record.transportId, record.origin, record.attestation, 'implicit')
      if (isConnectionError(trust)) return trust
      const who = {
        epoch: record.epoch,
        transportId: record.transportId,
        instanceId: record.instanceId,
        applicationOrigin: record.origin
      }
      const existing = liveByEpoch.get(record.epoch)
      if (existing) {
        return this.resolve(record.transportId, {
          epoch: record.epoch,
          instanceId: record.instanceId,
          continuityKey: record.continuityKey,
          origin: record.origin
        })
      }
      const dead = ring.get(record.epoch)
      if (dead) return tombstoneError(record.epoch, dead)

      const now = deps.now()
      // Admission horizon: with no tombstone to consult, an old epoch must not be re-admitted.
      if (now - record.boundAt > TOMBSTONE_TTL_MS || record.boundAt <= evictedThrough) {
        recordClose(who, 'lost')
        return connectionError('CONNECTION_CLOSED', 'This connection is too old; reconnect', 'not-sent', {
          epoch: record.epoch,
          cause: 'lost'
        })
      }
      if (!sameRev(record.walletRevision, current.walletRevision) || record.accountContext !== current.accountContext) {
        recordClose(who, 'account-changed')
        return connectionError('PROVIDER_CHANGED', 'The wallet changed since this page connected', 'not-sent', {
          epoch: record.epoch,
          cause: 'account-changed'
        })
      }
      const over = checkLimits(record.epoch, record.origin)
      if (over) return over
      return create(
        {
          epoch: record.epoch,
          transportId: record.transportId,
          applicationOrigin: record.origin,
          originator: trust.originator ?? record.originator,
          attestation: record.attestation,
          instanceId: record.instanceId,
          continuityKey: record.continuityKey,
          accountContext: record.accountContext,
          walletRevision: record.walletRevision,
          boundAt: record.boundAt
        },
        undefined
      )
    },

    resolve(transportId, request) {
      assertLoaded()
      const b = liveByEpoch.get(request.epoch)
      if (!b) {
        const dead = ring.get(request.epoch)
        if (dead) return tombstoneError(request.epoch, dead)
        return connectionError('PROVIDER_CHANGED', 'Unknown connection', 'not-sent', { epoch: request.epoch })
      }
      if (
        b.transportId !== transportId ||
        b.instanceId !== request.instanceId ||
        b.continuityKey !== request.continuityKey ||
        b.applicationOrigin !== request.origin
      ) {
        return connectionError('PROVIDER_CHANGED', 'Connection does not match', 'not-sent', { epoch: request.epoch })
      }
      if (request.accountContext !== undefined && request.accountContext !== b.accountContext) {
        return connectionError('PROVIDER_CHANGED', 'The wallet changed since this page connected', 'not-sent', {
          epoch: request.epoch,
          cause: 'account-changed'
        })
      }
      return b
    },

    markConsented(epoch, originator) {
      const b = liveByEpoch.get(epoch)
      if (!b) return
      b.originator = originator
      b.consented = true
    },

    takeReconnectToken(epoch) {
      const token = reconnectTokens.get(epoch)
      reconnectTokens.delete(epoch)
      return token
    },

    close(epoch, reason) {
      assertLoaded()
      reconnectTokens.delete(epoch)
      const b = liveByEpoch.get(epoch)
      if (!b) return
      b.state = 'closed'
      b.closeReason = reason
      liveByEpoch.delete(epoch)
      recordClose(b, reason)
    },

    closeAll(reason) {
      for (const epoch of [...liveByEpoch.keys()]) this.close(epoch, reason)
    },

    live: () => [...liveByEpoch.values()]
  }
}

/**
 * Durable inbox (spec 6.8): the queue contract for transports where the app is not running when
 * the page asks (iOS), and the processor that drives records through it.
 *
 * Lifecycle: `pending -> accepted -> claimed -> done`. The store is a dumb, sealed, atomic
 * adapter (project 2 supplies an App Group one; `memoryInboxStore.ts` is the reference and runs
 * the same contract suite). The processor owns the policy: size checks before reads, the
 * `notAfter` clamp, acceptance in `createdAt` order, binding admission, and crash recovery.
 *
 * The claim is the at-most-once point. It is awaited, so it cannot be fused with the dispatcher's
 * synchronous re-check; instead the dispatcher awaits `beforeCall` (the claim) and runs its
 * re-check after it, immediately before the wallet call (6.6 step 8).
 */
import { Hash, Utils } from '@bsv/sdk'
import type { BindingRegistry, CloseEvent } from './bindings'
import type { Dispatcher, Outcome } from './dispatcher'
import { connectionError, isConnectionError, type ConnectionError } from './protocol/connectionError'
import { isUuidV4, type InboxCloseEvent, type InboxRecord, type InboxResult } from './protocol/envelopes'
import { parseStrictJson } from './protocol/json'
import { INBOX_CLOCK_SKEW_MS, INBOX_MAX_VALIDITY_MS, MAX_BRIDGE_REQUEST_BYTES } from './protocol/limits'
import type { Attestation } from './protocol/origin'
import type { BridgeSnapshot } from './runtime'

export type InboxState = 'pending' | 'accepted' | 'claimed' | 'done'

export interface InboxStat {
  /** Size in bytes of the record as staged (plaintext). Stays known after the payload is deleted. */
  size: number
  state: InboxState
  /** Boot id stamped by `claim`. */
  claimBootId?: string
}

export type ClaimOutcome = 'claimed' | 'digest-mismatch' | 'not-accepted'

export type ResultRead =
  /** No result has been written yet. */
  | { kind: 'none' }
  | { kind: 'result'; bytes: Uint8Array }
  /** Acknowledged or past the retention window: the payload is gone, the id tombstone remains. */
  | { kind: 'purged' }

/**
 * The store adapter contract. Every method may be asynchronous; each is atomic. Records are
 * immutable and ids are create-exclusive across every state, tombstones included.
 */
export interface InboxStore {
  /** Stages a record as `pending`. False when the id already exists in any state. */
  create(id: string, bytes: Uint8Array): Promise<boolean>
  /** Undefined for an unknown id. Never reads the payload. */
  stat(id: string): Promise<InboxStat | undefined>
  /** The immutable bytes, without changing state. Undefined once the arguments are deleted. */
  read(id: string): Promise<Uint8Array | undefined>
  /** `pending -> accepted`. False when the record is not pending. */
  accept(id: string): Promise<boolean>
  /** `accepted -> pending`: crash recovery for a record that was never dispatched. */
  release(id: string): Promise<boolean>
  /** Atomic `accepted -> claimed` for exactly one caller, and only if the bytes still hash to `digest`. */
  claim(id: string, digest: string): Promise<ClaimOutcome>
  /** Writes the result once, moves to `done` and deletes the arguments. False if one exists. */
  writeResult(id: string, bytes: Uint8Array): Promise<boolean>
  readResult(id: string): Promise<ResultRead>
  /** Deletes the payload and result, never the id tombstone. */
  ack(id: string): Promise<void>
  writeEvent(e: InboxCloseEvent): Promise<void>
  readEventsAfter(seq: number): Promise<InboxCloseEvent[]>
  bootId(): string
  list(state: InboxState): Promise<string[]>
  /** Everything the adapter holds at rest, so the contract suite can assert none of it is plaintext. */
  rawBytes(): Uint8Array[]
}

/** Hex SHA-256 of the staged bytes: what `claim` compares. */
export function inboxDigest(bytes: Uint8Array): string {
  return Utils.toHex(Hash.sha256(Array.from(bytes)))
}

const encodeJson = (v: unknown): Uint8Array => Uint8Array.from(Utils.toArray(JSON.stringify(v), 'utf8'))

export function encodeInboxResult(r: InboxResult): Uint8Array {
  return encodeJson(r)
}

export function decodeInboxResult(bytes: Uint8Array): InboxResult | undefined {
  try {
    const v = parseStrictJson(Utils.toUTF8(Array.from(bytes))) as InboxResult
    return v && v.v === 1 && typeof v.id === 'string' && typeof v.ok === 'boolean' ? v : undefined
  } catch {
    return undefined
  }
}

/**
 * What a reader (the extension) sees for an id: the stored result, or for a purged or
 * acknowledged one `CONNECTION_CLOSED`, `unknown` (the call may have run and the answer is gone).
 * Undefined while no result exists yet.
 */
export async function resolveInboxResult(store: InboxStore, id: string): Promise<InboxResult | undefined> {
  const r = await store.readResult(id)
  if (r.kind === 'none') return undefined
  if (r.kind === 'purged') {
    return {
      v: 1,
      id,
      ok: false,
      error: connectionError('CONNECTION_CLOSED', 'The result is no longer available', 'unknown')
    }
  }
  return decodeInboxResult(r.bytes)
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isStr = (v: unknown): v is string => typeof v === 'string'
const isTime = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0

/** Structural check of a staged record; the key must equal the id it was staged under. */
export function parseInboxRecord(bytes: Uint8Array, expectedId: string): InboxRecord | undefined {
  let v: unknown
  try {
    v = parseStrictJson(Utils.toUTF8(Array.from(bytes)))
  } catch {
    return undefined
  }
  if (!isObj(v) || v.v !== 1 || !isUuidV4(v.id) || v.id !== expectedId) return undefined
  if (v.kind !== 'invoke' && v.kind !== 'disconnect') return undefined
  if (!isStr(v.epoch) || !isStr(v.instanceId) || !isStr(v.continuityKey) || !isStr(v.origin)) return undefined
  if (!isStr(v.accountContext) || !isStr(v.walletRevision)) return undefined
  if (!isTime(v.boundAt) || !isTime(v.createdAt) || !isTime(v.notAfter)) return undefined
  if (v.kind === 'invoke' && !isStr(v.method)) return undefined
  return v as unknown as InboxRecord
}

export interface InboxProcessorDeps {
  store: InboxStore
  dispatch: Dispatcher['dispatch']
  now: () => number
  bindings: Pick<BindingRegistry, 'admitImplicit' | 'resolve' | 'close'>
  /** The registered transport this inbox belongs to; trust comes from it, not from the record (6.2). */
  transport: { id: string; attestation: Attestation }
  /** The runtime's current revision and context. Defaults to `getBridgeSnapshot`. */
  snapshot?: () => Pick<BridgeSnapshot, 'walletRevision' | 'accountContext'> &
    Partial<Pick<BridgeSnapshot, 'readiness'>>
  /** Subscribes to snapshot changes (the wait for readiness). Defaults to the runtime's. */
  onSnapshotChange?: (fn: () => void) => () => void
  /** Subscribes to binding closes (the events outbox). Defaults to the runtime's `onBindingClosed`. */
  onClosed?: (fn: (e: CloseEvent) => void) => () => void
  /**
   * The registered transport for an id: trust comes from the registration, never from what the
   * caller of `createInboxProcessor` says (6.2). Defaults to the runtime's `getTransport`.
   */
  registeredTransport?: (id: string) => { attestation: Attestation } | undefined
}

export interface InboxProcessor {
  /**
   * Recovers after a restart (once), expires stale pending records, then accepts every pending
   * record in `createdAt` order and starts it without waiting for the earlier ones. Resolves when
   * everything it started has settled; a record parked behind a sheet keeps it open, so callers
   * that must not wait run `sweepExpired` on their timer instead.
   */
  processPending(): Promise<void>
  /** Answers `CONNECTION_CLOSED`, `not-sent` for pending records past `notAfter`. Needs no readiness. */
  sweepExpired(): Promise<void>
  /** Crash recovery (6.8). Idempotent; `processPending` runs it first. */
  recover(): Promise<void>
  /** Stops writing close events. The processor is meant to live as long as its transport. */
  dispose(): void
}

function errorResult(id: string, error: ConnectionError): Uint8Array {
  return encodeInboxResult({ v: 1, id, ok: false, error })
}

function outcomeResult(id: string, o: Outcome): Uint8Array {
  if (o.ok) return encodeInboxResult({ v: 1, id, ok: true, result: o.result })
  if ('walletError' in o) return encodeInboxResult({ v: 1, id, ok: false, error: o.walletError })
  return errorResult(id, o.connectionError)
}

export function createInboxProcessor(deps: InboxProcessorDeps): InboxProcessor {
  const { store, now, transport } = deps
  const snapshot =
    deps.snapshot ??
    (() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      return (require('./runtime') as typeof import('./runtime')).getBridgeSnapshot()
    })
  const registered =
    deps.registeredTransport ??
    ((id: string) => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      return (require('./runtime') as typeof import('./runtime')).getTransport(id)
    })
  const subscribeSnapshot =
    deps.onSnapshotChange ??
    ((fn: () => void) => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      return (require('./runtime') as typeof import('./runtime')).onSnapshotChange(fn)
    })
  const subscribeClosed =
    deps.onClosed ??
    ((fn: (e: CloseEvent) => void) => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      return (require('./runtime') as typeof import('./runtime')).onBindingClosed(fn)
    })
  let recovered: Promise<void> | undefined

  // Every close of one of this transport's bindings goes to the events outbox, in close order
  // (6.7). The writes are chained, and `handle` waits for the chain before it admits anything, so
  // a replacement binding never gets ahead of the event for the one it replaces.
  let eventWrites: Promise<void> = Promise.resolve()
  const unsubscribeClosed = subscribeClosed(e => {
    if (e.transportId !== transport.id) return
    const event: InboxCloseEvent = {
      v: 1,
      closeSeq: e.closeSeq,
      instanceId: e.instanceId,
      epoch: e.epoch,
      reason: e.reason === 'disconnected' ? 'lost' : e.reason,
      ...(e.notifyPage ? {} : { notifyPage: false as const })
    }
    eventWrites = eventWrites
      .then(() => store.writeEvent(event))
      .catch(err => console.warn('[bridge] inbox close event write failed', err))
  })

  /**
   * Parks until the runtime is `ready` (spec 6.8): while it is `building` or `blocked` the
   * snapshot's account context is empty, and admitting against it would tombstone every epoch
   * bound earlier as `account-changed`. Undefined when there is no wallet at all.
   */
  async function readySnapshot() {
    for (;;) {
      const snap = snapshot()
      if (snap.readiness === undefined || snap.readiness === 'ready') return snap
      if (snap.readiness === 'none') return undefined
      await new Promise<void>(resolve => {
        const off = subscribeSnapshot(() => {
          off()
          resolve()
        })
      })
    }
  }

  async function finish(id: string, bytes: Uint8Array) {
    try {
      await store.writeResult(id, bytes)
    } catch (e) {
      console.warn('[bridge] inbox result write failed', e)
    }
  }

  async function recoverOnce() {
    const boot = store.bootId()
    for (const id of await store.list('claimed')) {
      const st = await store.stat(id)
      if (!st || st.state !== 'claimed' || st.claimBootId === boot) continue
      // Claimed by a process that died: the call may have run, so it is never re-dispatched.
      await finish(
        id,
        errorResult(id, connectionError('CONNECTION_CLOSED', 'The wallet restarted during the call', 'unknown'))
      )
    }
    // Accepted only: the app took responsibility but nothing was dispatched.
    for (const id of await store.list('accepted')) await store.release(id)
  }

  /** Reads a pending record after the size check; refuses it with a result when it cannot be used. */
  async function load(id: string): Promise<{ record: InboxRecord; bytes: Uint8Array; size: number } | undefined> {
    const st = await store.stat(id)
    if (!st || st.state !== 'pending') return undefined
    if (st.size > MAX_BRIDGE_REQUEST_BYTES) {
      await finish(id, errorResult(id, connectionError('RESOURCE_LIMIT', 'Request too large', 'not-sent')))
      return undefined
    }
    const bytes = await store.read(id)
    if (!bytes) return undefined
    const record = parseInboxRecord(bytes, id)
    if (!record) {
      await finish(id, errorResult(id, connectionError('PROTOCOL_ERROR', 'Malformed inbox record', 'not-sent')))
      return undefined
    }
    return { record, bytes, size: st.size }
  }

  const effectiveNotAfter = (r: InboxRecord) => Math.min(r.notAfter, r.createdAt + INBOX_MAX_VALIDITY_MS)

  /** Stage-time checks that apply to a pending record. True when it may be accepted. */
  async function admissible(record: InboxRecord): Promise<boolean> {
    const t = now()
    if (record.createdAt > t + INBOX_CLOCK_SKEW_MS) {
      await finish(
        record.id,
        errorResult(
          record.id,
          connectionError('PROTOCOL_ERROR', 'Record is dated in the future', 'not-sent', { epoch: record.epoch })
        )
      )
      return false
    }
    if (t > effectiveNotAfter(record)) {
      await finish(
        record.id,
        errorResult(
          record.id,
          connectionError('CONNECTION_CLOSED', 'The request expired before it was handled', 'not-sent', {
            epoch: record.epoch
          })
        )
      )
      return false
    }
    return true
  }

  async function handle(id: string, record: InboxRecord, bytes: Uint8Array, size: number) {
    let snap = await readySnapshot()
    // Closes that happened while this record waited are in the outbox before it is admitted.
    await eventWrites
    if (snap !== undefined) snap = await readySnapshot()
    if (snap === undefined) {
      await finish(
        id,
        errorResult(
          id,
          connectionError('CONFIGURATION_ERROR', 'No wallet is available', 'not-sent', { epoch: record.epoch })
        )
      )
      return
    }
    const reg = registered(transport.id)
    if (reg !== undefined && reg.attestation !== transport.attestation) {
      await finish(
        id,
        errorResult(
          id,
          connectionError('PROTOCOL_ERROR', 'Attestation does not match the transport', 'not-sent', {
            epoch: record.epoch
          })
        )
      )
      return
    }
    const admitted = deps.bindings.admitImplicit(
      {
        epoch: record.epoch,
        transportId: transport.id,
        attestation: reg?.attestation ?? transport.attestation,
        origin: record.origin,
        instanceId: record.instanceId,
        continuityKey: record.continuityKey,
        accountContext: record.accountContext,
        walletRevision: record.walletRevision,
        boundAt: record.boundAt
      },
      { walletRevision: snap.walletRevision, accountContext: snap.accountContext }
    )
    if (isConnectionError(admitted)) {
      await finish(id, errorResult(id, admitted))
      return
    }
    if (record.kind === 'disconnect') {
      const claim = await store.claim(id, inboxDigest(bytes))
      if (claim !== 'claimed') return
      deps.bindings.close(record.epoch, 'disconnected')
      await finish(id, encodeInboxResult({ v: 1, id, ok: true, result: {} }))
      return
    }
    let claimed = false
    const outcome = await deps
      .dispatch({
        transport: transport.id,
        request: {
          epoch: record.epoch,
          instanceId: record.instanceId,
          continuityKey: record.continuityKey,
          origin: record.origin,
          accountContext: record.accountContext,
          method: record.method as string,
          args: record.args,
          sizeBytes: size,
          beforeCall: async () => {
            const c = await store.claim(id, inboxDigest(bytes))
            if (c === 'claimed') {
              claimed = true
              return
            }
            throw connectionError(
              'PROTOCOL_ERROR',
              c === 'digest-mismatch' ? 'The record changed after it was read' : 'The record is no longer waiting',
              'not-sent',
              { epoch: record.epoch }
            )
          }
        }
      })
      .catch(
        (e): Outcome => ({
          ok: false,
          connectionError: connectionError(
            'CONFIGURATION_ERROR',
            'The wallet bridge failed',
            claimed ? 'unknown' : 'not-sent',
            {
              epoch: record.epoch
            }
          )
        })
      )
    await finish(id, outcomeResult(id, outcome))
  }

  async function sweepExpired() {
    for (const id of await store.list('pending')) {
      const loaded = await load(id)
      if (!loaded) continue
      await admissible(loaded.record)
    }
  }

  return {
    recover() {
      recovered ??= recoverOnce().catch(e => {
        recovered = undefined
        throw e
      })
      return recovered
    },

    sweepExpired,

    dispose() {
      unsubscribeClosed()
    },

    async processPending() {
      await this.recover()
      const ready: Array<{ id: string; record: InboxRecord; bytes: Uint8Array; size: number }> = []
      for (const id of await store.list('pending')) {
        const loaded = await load(id)
        if (loaded && (await admissible(loaded.record))) ready.push({ id, ...loaded })
      }
      // Stable: records with equal timestamps keep the store's order.
      ready.sort((a, b) => a.record.createdAt - b.record.createdAt)
      const running: Promise<void>[] = []
      for (const item of ready) {
        if (!(await store.accept(item.id))) continue
        running.push(
          handle(item.id, item.record, item.bytes, item.size).catch(e => {
            console.warn('[bridge] inbox record failed', e)
          })
        )
      }
      await Promise.all(running)
    }
  }
}

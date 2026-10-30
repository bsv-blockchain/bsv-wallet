/**
 * In-memory `InboxStore` (spec 6.8): the reference adapter and the one the tests run. Project 2's
 * App Group adapter must pass the same contract suite (`__tests__/bridge/inboxContract.ts`).
 *
 * Everything held is sealed with AES-GCM (the SDK's `SymmetricKey`, pure JS so it works on every
 * runtime) under a key that lives only in the shared state, so the contract harness's `rawBytes` is a
 * meaningful view of "what is at rest". Sizes and states are metadata, not payload.
 */
import { SymmetricKey, Utils } from '@bsv/sdk'
import {
  inboxDigest,
  type ClaimOutcome,
  type InboxState,
  type InboxStat,
  type InboxStore,
  type ResultRead
} from './inbox'
import type { InboxCloseEvent } from './protocol/envelopes'
import { INBOX_CLOCK_SKEW_MS, INBOX_MAX_VALIDITY_MS, INBOX_RESULT_TTL_MS } from './protocol/limits'

/** An id tombstone outlives the longest `notAfter` window, the skew allowance and a result's life. */
const TOMBSTONE_MS = INBOX_MAX_VALIDITY_MS + INBOX_CLOCK_SKEW_MS + INBOX_RESULT_TTL_MS + 5 * 60 * 1000

interface Entry {
  state: InboxState
  size: number
  createdAt: number
  sealedRecord?: Uint8Array
  sealedResult?: Uint8Array
  resultAt?: number
  /** True once the result is acknowledged or purged. */
  gone?: boolean
  claimBootId?: string
}

interface Shared {
  key: SymmetricKey
  entries: Map<string, Entry>
  events: Array<{ closeSeq: number; at: number; sealed: Uint8Array }>
  /** Highest `closeSeq` retention has trimmed. */
  evictedThrough: number
}

export interface MemoryInboxStore extends InboxStore {
  /** The same persisted state under a new boot id: what a process restart looks like. */
  restart(bootId?: string): MemoryInboxStore
  /** Everything held at rest, for the contract suite's plaintext-marker test (via the harness). */
  rawBytes(): Uint8Array[]
}

export interface MemoryInboxStoreOptions {
  now?: () => number
  bootId?: string
  /** Event retention: at most this many events (default 1024, spec 6.4). */
  maxEvents?: number
  /** Event retention: events older than this are trimmed (default 24 h). */
  maxEventAgeMs?: number
}

const DEFAULT_MAX_EVENTS = 1024
const DEFAULT_MAX_EVENT_AGE_MS = 24 * 60 * 60 * 1000

let bootCounter = 0

export function createMemoryInboxStore(opts: MemoryInboxStoreOptions = {}): MemoryInboxStore {
  const shared: Shared = { key: SymmetricKey.fromRandom(), entries: new Map(), events: [], evictedThrough: 0 }
  return open(
    shared,
    opts.now ?? Date.now,
    opts.bootId ?? `boot-${++bootCounter}`,
    opts.maxEvents ?? DEFAULT_MAX_EVENTS,
    opts.maxEventAgeMs ?? DEFAULT_MAX_EVENT_AGE_MS
  )
}

function open(
  shared: Shared,
  now: () => number,
  boot: string,
  maxEvents: number,
  maxEventAgeMs: number
): MemoryInboxStore {
  const seal = (bytes: Uint8Array): Uint8Array => Uint8Array.from(shared.key.encrypt(Array.from(bytes)) as number[])
  const unseal = (bytes: Uint8Array): Uint8Array => Uint8Array.from(shared.key.decrypt(Array.from(bytes)) as number[])

  /** Time-based purge: results after 15 minutes, whole tombstones after their window. */
  function sweep() {
    const t = now()
    for (const [id, e] of shared.entries) {
      if (e.sealedResult && e.resultAt !== undefined && t - e.resultAt > INBOX_RESULT_TTL_MS) {
        e.sealedResult = undefined
        e.gone = true
      }
      if (t - e.createdAt > TOMBSTONE_MS && e.state === 'done') shared.entries.delete(id)
    }
  }

  /** Event retention (count and age); remembers the highest trimmed `closeSeq`. */
  function trimEvents() {
    const t = now()
    const keep = shared.events.filter(e => t - e.at <= maxEventAgeMs)
    const kept = keep.length > maxEvents ? keep.slice(keep.length - maxEvents) : keep
    if (kept.length === shared.events.length) return
    const keptSet = new Set(kept)
    for (const e of shared.events)
      if (!keptSet.has(e)) shared.evictedThrough = Math.max(shared.evictedThrough, e.closeSeq)
    shared.events = kept
  }

  const store: MemoryInboxStore = {
    async create(id, bytes) {
      sweep()
      if (shared.entries.has(id)) return false
      shared.entries.set(id, {
        state: 'pending',
        size: bytes.byteLength,
        createdAt: now(),
        sealedRecord: seal(bytes)
      })
      return true
    },

    async stat(id): Promise<InboxStat | undefined> {
      const e = shared.entries.get(id)
      if (!e) return undefined
      return { size: e.size, state: e.state, ...(e.claimBootId !== undefined ? { claimBootId: e.claimBootId } : {}) }
    },

    async read(id) {
      const e = shared.entries.get(id)
      return e?.sealedRecord ? unseal(e.sealedRecord) : undefined
    },

    async accept(id) {
      const e = shared.entries.get(id)
      if (!e || e.state !== 'pending') return false
      e.state = 'accepted'
      return true
    },

    async release(id) {
      const e = shared.entries.get(id)
      if (!e || e.state !== 'accepted') return false
      e.state = 'pending'
      return true
    },

    async claim(id, digest): Promise<ClaimOutcome> {
      const e = shared.entries.get(id)
      if (!e || e.state !== 'accepted' || !e.sealedRecord) return 'not-accepted'
      if (inboxDigest(unseal(e.sealedRecord)) !== digest) return 'digest-mismatch'
      e.state = 'claimed'
      e.claimBootId = boot
      // Arguments are deleted at claim; the record is never read again.
      e.sealedRecord = undefined
      return 'claimed'
    },

    async writeResult(id, bytes) {
      const e = shared.entries.get(id)
      if (!e || e.state === 'done') return false
      e.state = 'done'
      e.sealedRecord = undefined
      e.sealedResult = seal(bytes)
      e.resultAt = now()
      return true
    },

    async readResult(id): Promise<ResultRead> {
      sweep()
      const e = shared.entries.get(id)
      if (!e || e.state !== 'done') return { kind: 'none' }
      if (!e.sealedResult) return { kind: 'purged' }
      return { kind: 'result', bytes: unseal(e.sealedResult) }
    },

    async ack(id) {
      const e = shared.entries.get(id)
      if (!e || e.state !== 'done') return
      e.sealedRecord = undefined
      e.sealedResult = undefined
      e.gone = true
    },

    async writeEvent(ev: InboxCloseEvent) {
      shared.events.push({
        closeSeq: ev.closeSeq,
        at: now(),
        sealed: seal(Uint8Array.from(Utils.toArray(JSON.stringify(ev), 'utf8')))
      })
      shared.events.sort((a, b) => a.closeSeq - b.closeSeq)
      trimEvents()
    },

    async readEventsAfter(seq) {
      trimEvents()
      const events = shared.events
        .filter(e => e.closeSeq > seq)
        .map(e => JSON.parse(Utils.toUTF8(Array.from(unseal(e.sealed)))) as InboxCloseEvent)
      return { events, gap: seq < shared.evictedThrough }
    },

    bootId: () => boot,

    async list(state) {
      sweep()
      return [...shared.entries].filter(([, e]) => e.state === state).map(([id]) => id)
    },

    rawBytes() {
      const out: Uint8Array[] = shared.events.map(e => e.sealed)
      for (const e of shared.entries.values()) {
        if (e.sealedRecord) out.push(e.sealedRecord)
        if (e.sealedResult) out.push(e.sealedResult)
      }
      return out
    },

    restart: bootId => open(shared, now, bootId ?? `boot-${++bootCounter}`, maxEvents, maxEventAgeMs)
  }
  return store
}

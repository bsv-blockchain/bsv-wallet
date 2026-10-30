/**
 * In-memory port of the native module with the Swift semantics (spec 6.6, 10). It is a thin shell
 * over P1's reference `createMemoryInboxStore`, so the same contract suite exercises both and the
 * injected clock drives every purge and retention rule. Not for production.
 *
 * - `reset()` is synchronous and final: every mutating call rejects with `ERR_RESET` until `init`.
 * - `restart()` models a process restart whose `init` already ran: new boot id, same persisted state.
 * - `nowMs` arguments are accepted for signature parity and ignored; the injected clock rules.
 */
import { SymmetricKey, Utils } from '@bsv/sdk'
import { createMemoryInboxStore, type MemoryInboxStore } from '@bsv/expo-wallet-toolbox/core/bridge/memoryInboxStore'
import type { BsvBridgeNative, NativeState } from '../../shared/native'

export interface FakeNative extends BsvBridgeNative {
  /** Same as `init`, synchronous, for harnesses that build the adapter synchronously. */
  initSync(): { bootId: string; scheme: string }
  restart(): void
  /** Test-only synchronous raw bytes (events, records, results, the mirror), all sealed. */
  rawBytesSync(): Uint8Array[]
  /** Test-only: the mirror plaintext, or null when none is written. */
  readMirrorSync(): Uint8Array | null
  /** Test-only: deliver a nudge to subscribers, as the extension's Darwin notification would. */
  fireNudge(): void
  bootId(): string
}

export interface FakeNativeOptions {
  now?: () => number
  scheme?: string
}

class FakeError extends Error {
  constructor(
    message: string,
    readonly code: string
  ) {
    super(message)
  }
}

const b64ToBytes = (s: string): Uint8Array => Uint8Array.from(Utils.toArray(s, 'base64'))
const bytesToB64 = (b: Uint8Array): string => Utils.toBase64(Array.from(b))

export function createFakeNative(opts: FakeNativeOptions = {}): FakeNative {
  const now = opts.now ?? Date.now
  const scheme = opts.scheme ?? 'org.bsvblockchain.wallet'
  let store: MemoryInboxStore = createMemoryInboxStore({ now })
  let mirrorKey = SymmetricKey.fromRandom()
  let mirror: Uint8Array | null = null
  let isReset = false
  let initialised = false
  const nudges = new Set<() => void>()

  /** Every mutating call goes through here. */
  const writable = async <T>(fn: () => Promise<T>): Promise<T> => {
    if (isReset) throw new FakeError('The bridge was reset', 'ERR_RESET')
    if (!initialised) throw new FakeError('init has not run', 'ERR_UNAVAILABLE')
    return fn()
  }
  const readable = async <T>(fn: () => Promise<T>): Promise<T> => {
    if (!initialised) throw new FakeError('init has not run', 'ERR_UNAVAILABLE')
    return fn()
  }

  const initSync = () => {
    if (isReset) {
      // A reset deleted the key and the container: a new key, an empty queue, a new boot.
      store = createMemoryInboxStore({ now })
      mirrorKey = SymmetricKey.fromRandom()
      mirror = null
      isReset = false
    }
    initialised = true
    return { bootId: store.bootId(), scheme }
  }

  const fake: FakeNative = {
    initSync,
    init: async () => initSync(),

    create: (id, bytes) => writable(() => store.create(id, b64ToBytes(bytes))),

    stat: id =>
      readable(async () => {
        const s = await store.stat(id)
        return s ? { size: s.size, state: s.state as NativeState, claimBootId: s.claimBootId } : null
      }),

    read: id =>
      readable(async () => {
        const b = await store.read(id)
        return b ? bytesToB64(b) : null
      }),

    accept: id => writable(() => store.accept(id)),
    release: id => writable(() => store.release(id)),
    claim: (id, digest) => writable(() => store.claim(id, digest)),
    writeResult: (id, bytes) => writable(() => store.writeResult(id, b64ToBytes(bytes))),

    readResult: id =>
      readable(async () => {
        const r = await store.readResult(id)
        return r.kind === 'result' ? { kind: 'result' as const, bytes: bytesToB64(r.bytes) } : r
      }),

    ack: id => writable(() => store.ack(id)),
    list: state => readable(() => store.list(state === 'withdrawn' ? 'done' : state)),

    writeEvent: (_seq, event) => writable(() => store.writeEvent(JSON.parse(event))),

    readEventsAfter: seq =>
      readable(async () => {
        const r = await store.readEventsAfter(seq)
        return { events: r.events.map(e => JSON.stringify(e)), gap: r.gap }
      }),

    writeMirror: bytes =>
      writable(async () => {
        mirror = Uint8Array.from(mirrorKey.encrypt(Array.from(b64ToBytes(bytes))) as number[])
      }),

    // Retention and purges are lazy in the memory store, driven by the injected clock.
    sweep: () => writable(async () => undefined),

    reset() {
      isReset = true
      initialised = false
      nudges.clear()
      store = createMemoryInboxStore({ now })
      mirror = null
    },

    subscribeNudge(cb) {
      nudges.add(cb)
      return () => {
        nudges.delete(cb)
      }
    },

    rawBytes: async () => fake.rawBytesSync().map(bytesToB64),

    restart() {
      store = store.restart()
    },

    rawBytesSync() {
      const out = store.rawBytes()
      if (mirror) out.push(mirror)
      return out
    },

    readMirrorSync() {
      return mirror ? Uint8Array.from(mirrorKey.decrypt(Array.from(mirror)) as number[]) : null
    },

    fireNudge() {
      for (const cb of [...nudges]) cb()
    },

    bootId: () => store.bootId()
  }
  return fake
}

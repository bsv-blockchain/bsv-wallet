/**
 * `InboxStore` over the native module (spec 6.6). One adapter, one processor: two processors would
 * release each other's accepted records on `recover()`.
 *
 * The adapter is built after `await native.init()`; `bootId` comes from that call. It keeps no
 * state. Native failures that mean "nothing there" (`ERR_NOT_FOUND`) become the contract's return
 * values; every other failure is rethrown so the processor's own warning path runs.
 */
import { Utils } from '@bsv/sdk'
import type { InboxStore } from '@bsv/expo-wallet-toolbox/core/bridge/inbox'
import type { InboxCloseEvent } from '@bsv/expo-wallet-toolbox/core/bridge/protocol/envelopes'
import type { BsvBridgeNative } from '../shared/native'

export interface NativeInboxStoreOptions {
  now: () => number
  /** The boot id `native.init()` returned. */
  bootId: string
}

const toB64 = (bytes: Uint8Array): string => Utils.toBase64(Array.from(bytes))
const fromB64 = (s: string): Uint8Array => Uint8Array.from(Utils.toArray(s, 'base64'))

const isNotFound = (e: unknown): boolean =>
  typeof e === 'object' && e !== null && (e as { code?: unknown }).code === 'ERR_NOT_FOUND'

/** Runs `fn`; a not-found rejection becomes `fallback`, anything else propagates. */
async function orElse<T, F>(fn: () => Promise<T>, fallback: F): Promise<T | F> {
  try {
    return await fn()
  } catch (e) {
    if (isNotFound(e)) return fallback
    throw e
  }
}

export function createNativeInboxStore(native: BsvBridgeNative, opts: NativeInboxStoreOptions): InboxStore {
  const { now, bootId } = opts
  return {
    create: (id, bytes) => native.create(id, toB64(bytes), now()),

    async stat(id) {
      const s = await orElse(() => native.stat(id), null)
      if (!s) return undefined
      return {
        size: s.size,
        // The processor's `done` is the native `done`; `withdrawn` is a state the processor never sees
        // for a record it lists, and reads as a finished (tombstoned) id.
        state: s.state === 'withdrawn' ? 'done' : s.state,
        ...(s.claimBootId !== undefined ? { claimBootId: s.claimBootId } : {})
      }
    },

    async read(id) {
      const b = await orElse(() => native.read(id), null)
      return b === null ? undefined : fromB64(b)
    },

    accept: id => orElse(() => native.accept(id), false),
    release: id => orElse(() => native.release(id), false),
    claim: (id, digest) => orElse(() => native.claim(id, digest, now()), 'not-accepted' as const),
    writeResult: (id, bytes) => native.writeResult(id, toB64(bytes), now()),

    async readResult(id) {
      const r = await orElse(() => native.readResult(id, now()), { kind: 'none' as const })
      return r.kind === 'result' ? { kind: 'result', bytes: fromB64(r.bytes) } : r
    },

    async ack(id) {
      await orElse(() => native.ack(id), undefined)
    },

    async writeEvent(e: InboxCloseEvent) {
      await native.writeEvent(e.closeSeq, JSON.stringify(e), now())
    },

    async readEventsAfter(seq) {
      const r = await native.readEventsAfter(seq, now())
      return { events: r.events.map(s => JSON.parse(s) as InboxCloseEvent), gap: r.gap }
    },

    bootId: () => bootId,

    list: state => native.list(state, now())
  }
}

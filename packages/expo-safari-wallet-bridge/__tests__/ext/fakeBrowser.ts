/**
 * Test doubles for the extension libs: an in-memory `browser` (storage.session, tabs, runtime) and a fake
 * appex that answers the native messages with the Swift handler's reply shapes.
 */
import { ed25519 } from '@noble/curves/ed25519.js'
import { Utils } from '@bsv/sdk'
import type { InboxCloseEvent } from '@bsv/expo-wallet-toolbox/core/bridge/protocol/envelopes'
import { b64uEncode } from '@bsv/expo-wallet-toolbox/core/bridge/protocol/base64url'
import type { Mirror } from '../../shared/mirror'
import type { BridgeRequest, ContinuityContext } from '../../shared/native'
import type { NativeReply, NativeRequest } from '../../extension/src/lib/nativeClient'
import { createNativeClient } from '../../extension/src/lib/nativeClient'
import { fromBase64, sha256Hex, toBase64 } from '../../extension/src/lib/bytes'
import type { ExtDeps } from '../../extension/src/lib/reconcile'

export interface FakeBrowser {
  session: BrowserStorageArea
  /** Raw contents, for assertions. */
  data: Record<string, unknown>
  tabs: {
    updates: Array<{ tabId: number; url?: string }>
    /** Tab ids `tabs.query` reports. */
    open: Set<number>
    update(tabId: number, props: { url?: string }): Promise<unknown>
    query(info: Record<string, unknown>): Promise<Array<{ id: number }>>
    /** Makes `update` reject. */
    failUpdate: boolean
  }
  runtime: { nativeMessages: unknown[] }
}

export function createFakeBrowser(): FakeBrowser {
  const data: Record<string, unknown> = {}
  const clone = <T>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)))
  const session: BrowserStorageArea = {
    async get(keys) {
      if (keys == null) return clone({ ...data })
      const list = Array.isArray(keys) ? keys : [keys]
      const out: Record<string, unknown> = {}
      for (const k of list) if (k in data) out[k] = clone(data[k])
      return out
    },
    async set(items) {
      for (const [k, v] of Object.entries(items)) data[k] = clone(v)
    },
    async remove(keys) {
      for (const k of Array.isArray(keys) ? keys : [keys]) delete data[k]
    }
  }
  const tabs: FakeBrowser['tabs'] = {
    updates: [],
    open: new Set(),
    failUpdate: false,
    async update(tabId, props) {
      if (tabs.failUpdate) throw new Error('tabs.update failed')
      tabs.updates.push({ tabId, ...props })
      return {}
    },
    async query() {
      return [...tabs.open].map(id => ({ id }))
    }
  }
  return { session, data, tabs, runtime: { nativeMessages: [] } }
}

export const SEED = new Uint8Array(
  Buffer.from('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60', 'hex')
)
export const PUB = ed25519.getPublicKey(SEED)
export const INSTANCE = '11111111-1111-4111-8111-111111111111'
export const INSTANCE_PRIVATE = '33333333-3333-4333-8333-333333333333'

export type MirrorState = 'ok' | 'absent' | 'corrupt'

export interface FakeAppex {
  send: (m: NativeRequest) => Promise<NativeReply>
  requests: NativeRequest[]
  mirrorState: MirrorState
  mirror?: Mirror
  events: InboxCloseEvent[]
  gap: boolean
  /** Reported with `gap` (the eviction watermark). */
  gapThrough?: number
  /** Reply to every op with KEY_MISSING (wake before first unlock). */
  keyMissing: boolean
  /** Reject the transport instead of replying. */
  down: boolean
  /** Do not answer at all. */
  hang: boolean
  /** Ops whose request is dropped before the appex sees it (the transport rejects). */
  dropRequest: Set<string>
  /** Ops the appex executes but whose reply is lost (the transport rejects after the effect). */
  dropReply: Set<string>
  /** The next N replies of an op are lost after the appex executed it. */
  failNext: Record<string, number>
  /** The app is awake and drains at once: new records are `accepted`, so `withdraw` loses. */
  autoAccept: boolean
  /** Records by id: the bytes and their state, as the Swift queue keeps them. */
  records: Map<string, { bytes: Uint8Array; digest: string; state: 'pending' | 'accepted' | 'withdrawn' }>
  uploads: Map<string, { parts: number; size: number; digest: string; chunks: Map<number, Uint8Array> }>
  /** Result bytes by id (the app wrote them). */
  resultBytes: Map<string, Uint8Array>
  purged: Set<string>
  acked: string[]
  /** Split results into parts of this many bytes (default: whole). */
  partBytes: number
}

export function createFakeAppex(init: Partial<FakeAppex> = {}): FakeAppex {
  const state: FakeAppex = {
    send: undefined as never,
    requests: [],
    mirrorState: 'absent',
    events: [],
    gap: false,
    keyMissing: false,
    down: false,
    hang: false,
    dropRequest: new Set(),
    dropReply: new Set(),
    failNext: {},
    autoAccept: false,
    records: new Map(),
    uploads: new Map(),
    resultBytes: new Map(),
    purged: new Set(),
    acked: [],
    partBytes: 1 << 30,
    ...init
  }
  const known = [
    'sync',
    'identity',
    'sign',
    'stage',
    'stageBegin',
    'stageChunk',
    'stageEnd',
    'withdraw',
    'results',
    'ack',
    'nudge'
  ]
  state.send = async (m: BridgeRequest): Promise<NativeReply> => {
    state.requests.push(m)
    if (state.hang) return new Promise(() => undefined)
    if (state.down) throw new Error('native messaging unavailable')
    if (!known.includes(m.op)) return { ok: false, code: 'BAD_REQUEST', message: 'unknown op' }
    if (state.keyMissing) return { ok: false, code: 'KEY_MISSING', message: 'The sealing key is not available' }
    if (state.dropRequest.has(m.op)) throw new Error('dropped request')
    const reply = handle(m)
    if (state.dropReply.has(m.op)) throw new Error('dropped reply')
    if ((state.failNext[m.op] ?? 0) > 0) {
      state.failNext[m.op]--
      throw new Error('dropped reply')
    }
    return reply
  }

  function createRecord(id: string, bytes: Uint8Array): NativeReply {
    const digest = sha256Hex(bytes)
    const have = state.records.get(id)
    if (have) {
      return have.digest === digest
        ? { ok: true, status: 'exists' }
        : { ok: false, code: 'EXISTS_DIFFERENT', message: 'The id is taken' }
    }
    state.records.set(id, { bytes, digest, state: state.autoAccept ? 'accepted' : 'pending' })
    return { ok: true, status: 'created' }
  }

  function handle(m: BridgeRequest): NativeReply {
    switch (m.op) {
      case 'stage':
        return createRecord(m.id, fromBase64(m.bytes))
      case 'stageBegin':
        state.uploads.set(m.id, { parts: m.parts, size: m.size, digest: m.digest, chunks: new Map() })
        return { ok: true }
      case 'stageChunk': {
        const up = state.uploads.get(m.id)
        if (!up || m.n < 0 || m.n >= up.parts) return { ok: false, code: 'BAD_REQUEST', message: 'bad chunk' }
        up.chunks.set(m.n, fromBase64(m.bytes))
        return { ok: true }
      }
      case 'stageEnd': {
        const up = state.uploads.get(m.id)
        if (!up && state.records.has(m.id)) return { ok: true, status: 'exists' }
        if (!up) return { ok: false, code: 'BAD_REQUEST', message: 'not begun' }
        const parts: Uint8Array[] = []
        for (let n = 0; n < up.parts; n++) {
          const c = up.chunks.get(n)
          if (!c) return { ok: false, code: 'BAD_REQUEST', message: 'missing chunk' }
          parts.push(c)
        }
        const joined = Buffer.concat(parts)
        if (joined.length !== up.size || sha256Hex(joined) !== up.digest) {
          state.uploads.delete(m.id)
          return { ok: false, code: 'BAD_REQUEST', message: 'bad digest' }
        }
        state.uploads.delete(m.id)
        return createRecord(m.id, new Uint8Array(joined))
      }
      case 'withdraw': {
        const r = state.records.get(m.id)
        if (r && r.state === 'pending') {
          r.state = 'withdrawn'
          return { ok: true, won: true }
        }
        return { ok: true, won: false }
      }
      case 'results': {
        const results = m.ids.map(({ id, part = 0 }): import('../../shared/native').ResultItem => {
          if (state.purged.has(id)) return { id, state: 'purged' }
          const bytes = state.resultBytes.get(id)
          if (!bytes) return { id, state: 'none' }
          const size = m.maxPartBytes ?? state.partBytes
          const parts = Math.max(1, Math.ceil(bytes.length / size))
          const slice = bytes.subarray(part * size, (part + 1) * size)
          return { id, state: 'result', part, parts, bytes: toBase64(slice) }
        })
        return { ok: true, results }
      }
      case 'ack':
        state.acked.push(...m.ids)
        for (const id of m.ids) {
          state.resultBytes.delete(id)
          state.purged.delete(id)
        }
        return { ok: true }
      default:
        return handleBasic(m)
    }
  }

  function handleBasic(m: BridgeRequest): NativeReply {
    switch (m.op) {
      case 'sync': {
        const events = state.events.filter(e => e.closeSeq > m.cursor)
        return {
          ok: true,
          mirrorState: state.mirrorState,
          ...(state.mirrorState === 'ok' && state.mirror ? { mirror: state.mirror } : {}),
          events,
          gap: state.gap,
          ...(state.gapThrough === undefined ? {} : { gapThrough: state.gapThrough })
        }
      }
      case 'identity':
        return {
          ok: true,
          instanceId: (m.context as ContinuityContext) === 'safari' ? INSTANCE : INSTANCE_PRIVATE,
          continuityKey: b64uEncode(PUB)
        }
      case 'sign': {
        const pre = Uint8Array.from(Utils.toArray(m.preimage, 'base64'))
        const prefix = Buffer.from('BRC-185 descriptor v1\n')
        if (pre.length > 16 * 1024 || !Buffer.from(pre).subarray(0, prefix.length).equals(prefix)) {
          return { ok: false, code: 'BAD_PREIMAGE', message: 'Not a describe preimage' }
        }
        return { ok: true, signature: b64uEncode(ed25519.sign(pre, SEED)) }
      }
      default:
        return { ok: true } as NativeReply
    }
  }
  return state
}

export function fakeDeps(
  appex: FakeAppex,
  browser: FakeBrowser,
  over: Partial<ExtDeps> & { clock?: { t: number } } = {}
): ExtDeps & { closedLog: unknown[] } {
  const clock = over.clock ?? { t: 1_000_000 }
  const closedLog: unknown[] = []
  return {
    native: createNativeClient(appex.send, { timeoutMs: 20, retries: 3 }),
    session: browser.session,
    now: () => clock.t,
    allowLocalhostHttp: false,
    name: 'Bitcoin SV Wallet',
    vendor: 'org.bsvblockchain.wallet',
    onClosed: c => closedLog.push(...c),
    ...over,
    closedLog
  }
}

export function makeMirror(
  over: {
    readiness?: Mirror['snapshot']['readiness']
    revision?: string
    accountContext?: string
    connected?: string[]
    identityKey?: string | null
    prompts?: boolean
    baseVersion?: string
  } = {}
): Mirror {
  const readiness = over.readiness ?? 'ready'
  return {
    v: 1,
    writerBootId: 'boot',
    writtenAt: 1,
    snapshot: {
      schema: 1,
      baseVersion: over.baseVersion ?? 'vendor-1.0.0',
      network: 'main',
      accountContext: over.accountContext ?? 'ctx-a',
      walletRevision: over.revision ?? '5',
      readiness,
      closeSeq: 0
    },
    identityKey:
      over.identityKey === undefined ? (readiness === 'ready' ? '02' + 'ab'.repeat(32) : null) : over.identityKey,
    identityKeyPrompts: over.prompts ?? false,
    connected: over.connected ?? []
  }
}

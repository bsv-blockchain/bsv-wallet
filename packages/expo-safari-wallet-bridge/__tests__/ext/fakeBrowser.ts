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
import type { ExtDeps } from '../../extension/src/lib/reconcile'

export interface FakeBrowser {
  session: BrowserStorageArea
  /** Raw contents, for assertions. */
  data: Record<string, unknown>
  tabs: { updates: Array<{ tabId: number; url?: string }> }
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
  return { session, data, tabs: { updates: [] }, runtime: { nativeMessages: [] } }
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
  /** Reply to every op with KEY_MISSING (wake before first unlock). */
  keyMissing: boolean
  /** Reject the transport instead of replying. */
  down: boolean
  /** Do not answer at all. */
  hang: boolean
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
    switch (m.op) {
      case 'sync': {
        const events = state.events.filter(e => e.closeSeq > m.cursor)
        return {
          ok: true,
          mirrorState: state.mirrorState,
          ...(state.mirrorState === 'ok' && state.mirror ? { mirror: state.mirror } : {}),
          events,
          gap: state.gap
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

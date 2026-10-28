/**
 * The page-world script (spec 6.8, BRC-185 section 4.2). It holds nothing and decides nothing: it builds the
 * frozen handle, answers `brc185:request-provider` once per `requestId`, and carries calls to its content
 * script over one `MessagePort`. It never touches `window.CWI` and never announces unsolicited.
 *
 * The handshake with the content script is order independent: each side posts a hello when it starts, and the
 * first `content-ready` of its own channel this side hears is answered with a port (once; later ones are ignored, so a page that
 * forges the hello can only talk to itself).
 */
import {
  BRC185_VERSION,
  isCloseReason,
  isUuidV4,
  parseXdmEnvelope,
  type CloseReason,
  type XdmInvoke
} from '@bsv/expo-wallet-toolbox/core/bridge/protocol/envelopes'
import { BRIDGE_METHODS } from '@bsv/expo-wallet-toolbox/core/bridge/protocol/methods'
import { configurationError, connectionError, protocolError, type ConnectionError } from './errors'
import {
  EVENT_ANNOUNCE_PROVIDER,
  EVENT_REQUEST_PROVIDER,
  MSG_CONTENT_READY,
  MSG_MAIN_READY,
  MSG_PORT,
  isRecord,
  type PageControl
} from './wire'

/** What the page-world script needs from `window`; the real `window` satisfies it. */
export interface ProviderWindow {
  addEventListener(type: string, listener: (e: any) => void): void
  removeEventListener(type: string, listener: (e: any) => void): void
  dispatchEvent(e: unknown): boolean
  postMessage(message: unknown, targetOrigin: string, transfer?: unknown[]): void
  CustomEvent: new (type: string, init: { detail: unknown }) => unknown
  MessageChannel: new () => { port1: PagePort; port2: unknown }
  location: { protocol: string; origin?: string }
  origin?: string
  crypto: { getRandomValues<T extends ArrayBufferView>(a: T): T }
}

export interface PagePort {
  onmessage: ((e: { data: any }) => void) | null
  postMessage(message: unknown): void
  close(): void
  start?(): void
}

export interface ProviderMainOptions {
  /**
   * Names this wallet's script pair on the shared window. Two wallets' extensions run in the same page, and
   * both page-world scripts hear both content scripts' hellos: without a channel a page-world script answers
   * another wallet's hello and the two wallets' ports cross. Defaults to the `BRIDGE_SCHEME` build constant.
   */
  channel?: string
  /** How long a call waits for the content script's port before failing (default 3000 ms). */
  portWaitMs?: number
  setTimeout?: (fn: () => void, ms: number) => unknown
  clearTimeout?: (t: any) => void
}

export interface ProviderHandle {
  describe(origin: string, challenge: string): Promise<unknown>
  connect(origin: string, epoch: string, onClose: (reason: CloseReason) => void): Promise<Record<string, unknown>>
  disconnect(epoch: string): Promise<void>
}

export interface ProviderMain {
  handle: ProviderHandle
  dispose(): void
}

type DistributiveOmit<T, K extends string> = T extends unknown ? Omit<T, K> : never

const MAX_SEEN_REQUESTS = 256

interface EpochState {
  instanceId: string
  onClose: (reason: CloseReason) => void
  closed: boolean
}

interface Call {
  resolve(v: unknown): void
  reject(e: unknown): void
}

/** True for the frames that may announce: an http(s) page with a real (non-opaque) origin. */
function hasUsableOrigin(win: ProviderWindow): boolean {
  const protocol = win.location?.protocol
  if (protocol !== 'https:' && protocol !== 'http:') return false // about:blank, about:srcdoc, data:, blob: ...
  const origin = win.origin ?? win.location.origin
  return typeof origin === 'string' && origin !== 'null' && origin !== ''
}

export function createProviderMain(win: ProviderWindow, opts: ProviderMainOptions = {}): ProviderMain {
  const setT = opts.setTimeout ?? ((fn, ms) => setTimeout(fn, ms))
  const clearT = opts.clearTimeout ?? ((t: any) => clearTimeout(t))
  const portWaitMs = opts.portWaitMs ?? 3000
  const channel = opts.channel ?? (typeof BRIDGE_SCHEME === 'string' ? BRIDGE_SCHEME : '')

  let port: PagePort | undefined
  let disposed = false
  const waiting: Array<{ run(p: PagePort): void; fail(e: ConnectionError): void; timer: unknown }> = []
  const seen = new Set<string>()
  const calls = new Map<number, Call>()
  const invokes = new Map<string, Call & { epoch: string }>()
  const epochs = new Map<string, EpochState>()
  let rid = 0

  const uuid = (): string => {
    const b = win.crypto.getRandomValues(new Uint8Array(16))
    b[6] = (b[6] & 0x0f) | 0x40
    b[8] = (b[8] & 0x3f) | 0x80
    const h = Array.from(b, x => x.toString(16).padStart(2, '0')).join('')
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
  }

  // ---- port plumbing -------------------------------------------------------------------------------------

  function onPortMessage(e: { data: any }): void {
    const m = e.data
    if (!isRecord(m)) return
    if (m.kind === 'reply' && typeof m.rid === 'number') {
      const c = calls.get(m.rid)
      if (!c) return
      calls.delete(m.rid)
      if (m.ok === true) c.resolve(m.value)
      else c.reject(m.error)
      return
    }
    const env = parseXdmEnvelope(m)
    if (!env) return
    if (env.type === 'brc185:result' || env.type === 'brc185:error') {
      const c = invokes.get(env.id)
      if (!c || c.epoch !== env.epoch) return
      invokes.delete(env.id)
      if (env.type === 'brc185:result') c.resolve(env.result)
      else c.reject(env.error)
    } else if (env.type === 'brc185:closed') {
      const st = epochs.get(env.epoch)
      if (!st || st.closed || st.instanceId !== env.instanceId || !isCloseReason(env.reason)) return
      st.closed = true
      try {
        st.onClose(env.reason)
      } catch {
        // a throwing page callback must not break the relay
      }
    }
  }

  function attach(p: PagePort): void {
    port = p
    p.onmessage = onPortMessage
    p.start?.()
    for (const w of waiting.splice(0)) {
      clearT(w.timer)
      w.run(p)
    }
  }

  function onWindowMessage(e: any): void {
    if (
      e.source !== win ||
      !isRecord(e.data) ||
      e.data.type !== MSG_CONTENT_READY ||
      e.data.ch !== channel ||
      port ||
      disposed
    )
      return
    const ch = new win.MessageChannel()
    attach(ch.port1)
    win.postMessage({ type: MSG_PORT, ch: channel }, '*', [ch.port2])
  }

  function withPort<T>(send: (p: PagePort) => Promise<T>): Promise<T> {
    if (port) return send(port)
    return new Promise<T>((resolve, reject) => {
      const entry = {
        run: (p: PagePort) => send(p).then(resolve, reject),
        fail: (err: ConnectionError) => reject(err),
        timer: setT(() => {
          const i = waiting.indexOf(entry)
          if (i >= 0) waiting.splice(i, 1)
          reject(configurationError('The wallet extension is not ready'))
        }, portWaitMs)
      }
      waiting.push(entry)
    })
  }

  function control(c: DistributiveOmit<PageControl, 'rid'>): Promise<any> {
    return withPort(
      p =>
        new Promise((resolve, reject) => {
          const id = ++rid
          calls.set(id, { resolve, reject })
          try {
            p.postMessage({ ...c, rid: id })
          } catch {
            calls.delete(id)
            reject(protocolError('The call arguments cannot be sent'))
          }
        })
    )
  }

  // ---- the epoch-bound interface -------------------------------------------------------------------------

  function invoke(epoch: string, st: EpochState, method: string, params: unknown): Promise<unknown> {
    if (st.closed) {
      return Promise.reject(connectionError('CONNECTION_CLOSED', 'The connection is closed', 'not-sent', { epoch }))
    }
    return withPort(
      p =>
        new Promise((resolve, reject) => {
          const id = uuid()
          const envelope: XdmInvoke = {
            type: 'brc185:invoke',
            version: BRC185_VERSION,
            instanceId: st.instanceId,
            epoch,
            id,
            method,
            params
          }
          invokes.set(id, { resolve, reject, epoch })
          try {
            p.postMessage(envelope)
          } catch {
            invokes.delete(id)
            reject(protocolError('The call arguments cannot be sent'))
          }
        })
    )
  }

  function makeInterface(epoch: string, st: EpochState): Record<string, unknown> {
    const wallet: Record<string, unknown> = {}
    for (const method of Object.keys(BRIDGE_METHODS)) {
      // `originator` (the second WalletInterface argument) is never forwarded: the app derives it from the
      // attested origin, never from the page.
      wallet[method] = (args?: unknown) => invoke(epoch, st, method, args === undefined ? {} : args)
    }
    return Object.freeze(wallet)
  }

  // ---- the handle ------------------------------------------------------------------------------------------

  const handle: ProviderHandle = Object.freeze({
    describe(origin: string, challenge: string): Promise<unknown> {
      return control({ kind: 'describe', origin, challenge })
    },
    async connect(origin: string, epoch: string, onClose: (reason: CloseReason) => void) {
      if (typeof origin !== 'string' || !isUuidV4(epoch) || typeof onClose !== 'function') {
        throw protocolError('connect needs an origin, an epoch (UUIDv4) and an onClose callback')
      }
      if (epochs.has(epoch)) throw protocolError('The epoch is already in use')
      const value = await control({ kind: 'connect', origin, epoch })
      const instanceId = isRecord(value) ? value.instanceId : undefined
      if (typeof instanceId !== 'string') throw protocolError('The wallet extension sent an unreadable reply')
      const st: EpochState = { instanceId, onClose, closed: false }
      epochs.set(epoch, st)
      return makeInterface(epoch, st)
    },
    async disconnect(epoch: string): Promise<void> {
      if (!isUuidV4(epoch)) throw protocolError('disconnect needs the epoch (UUIDv4)')
      const st = epochs.get(epoch)
      const origin = win.origin ?? win.location.origin
      await control({ kind: 'disconnect', origin, epoch })
      if (!st) return
      st.closed = true // not echoed as `brc185:closed`: the page asked for it
      const closed = connectionError('DISCONNECTED', 'The connection was closed by the page', 'unknown', { epoch })
      for (const [id, c] of invokes) {
        if (c.epoch !== epoch) continue
        invokes.delete(id)
        c.reject(closed)
      }
    }
  })

  // ---- announce ----------------------------------------------------------------------------------------------

  function onRequestProvider(e: any): void {
    const d = e?.detail
    if (disposed || !isRecord(d) || d.version !== 1 || !isUuidV4(d.requestId)) return
    if (!hasUsableOrigin(win)) return
    if (seen.has(d.requestId)) return // each fresh request is answered once
    if (seen.size >= MAX_SEEN_REQUESTS) seen.delete(seen.values().next().value as string)
    seen.add(d.requestId)
    win.dispatchEvent(
      new win.CustomEvent(EVENT_ANNOUNCE_PROVIDER, { detail: { version: 1, requestId: d.requestId, handle } })
    )
  }

  win.addEventListener(EVENT_REQUEST_PROVIDER, onRequestProvider)
  win.addEventListener('message', onWindowMessage)
  // No unsolicited announce: this only tells our content script that we are here.
  win.postMessage({ type: MSG_MAIN_READY, ch: channel }, '*')

  return {
    handle,
    dispose(): void {
      disposed = true
      win.removeEventListener(EVENT_REQUEST_PROVIDER, onRequestProvider)
      win.removeEventListener('message', onWindowMessage)
      for (const w of waiting.splice(0)) {
        clearT(w.timer)
        w.fail(configurationError('The wallet extension was unloaded'))
      }
      port?.close()
      port = undefined
    }
  }
}

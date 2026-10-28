/**
 * The per-frame relay (isolated world, spec 6.8 and 6.11). It owns the page's port, the pending-invoke table
 * `recordId -> page invoke id`, and the triggers that fetch results: `visibilitychange` to visible, `pageshow`,
 * `focus` (the main one: Safari is suspended while the user is in the wallet), a timer while a call is pending
 * and the page is visible (`POLL_STEPS_MS`), and the page's next call. A pending call never times out here
 * (BRC-219); it ends on a result, an error or a close.
 *
 * Every request to the background is its own `runtime.sendMessage`, so the background re-attests the sender
 * frame on each one. The long-lived port exists only while this frame holds an epoch: it keeps the background
 * alive for pickup and tells it when the frame goes away.
 */
import {
  parseXdmEnvelope,
  xdmClosed,
  xdmError,
  xdmResult
} from '@bsv/expo-wallet-toolbox/core/bridge/protocol/envelopes'
import type { XdmInvoke } from '@bsv/expo-wallet-toolbox/core/bridge/protocol/envelopes'
import { POLL_STEPS_MS } from '../../../shared/constants'
import { configurationError, connectionError, protocolError } from './errors'
import {
  BACKGROUND_PORT_NAME,
  MSG_CONTENT_READY,
  MSG_MAIN_READY,
  MSG_PORT,
  isRecord,
  type BackgroundReply,
  type BackgroundRequest,
  type InvokeValue,
  type PollValue
} from './wire'

export interface ContentWindow {
  addEventListener(type: string, listener: (e: any) => void): void
  removeEventListener(type: string, listener: (e: any) => void): void
  postMessage(message: unknown, targetOrigin: string): void
  document: {
    visibilityState: string
    addEventListener(type: string, listener: () => void): void
    removeEventListener(type: string, listener: () => void): void
  }
}

export interface ContentPort {
  onmessage: ((e: { data: any }) => void) | null
  postMessage(message: unknown): void
  close(): void
  start?(): void
}

export interface ContentDeps {
  win: ContentWindow
  runtime: {
    sendMessage(message: unknown): Promise<any>
    connect(info?: { name?: string }): BrowserPort
  }
  timers?: { setTimeout(fn: () => void, ms: number): unknown; clearTimeout(t: any): void }
  /** Transport failures (the background was unloaded mid-call) are retried this many times in total. */
  transportAttempts?: number
}

export interface ContentRelay {
  /** Fetch results and closes now (also what every trigger runs). */
  poll(): Promise<void>
  /** Number of calls waiting for a result. */
  pendingCount(): number
  dispose(): void
}

interface Held {
  instanceId: string
  epoch: string
}

interface Pending {
  instanceId: string
  epoch: string
  id: string
}

const epochKey = (instanceId: string, epoch: string): string => `${instanceId}|${epoch}`

export function createContentRelay(deps: ContentDeps): ContentRelay {
  const { win, runtime } = deps
  const timers = deps.timers ?? { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: t => clearTimeout(t) }
  const attempts = Math.max(1, deps.transportAttempts ?? 3)

  let pagePort: ContentPort | undefined
  let bgPort: BrowserPort | undefined
  let disposed = false
  /** Epochs this frame connected and that are still open. */
  const held = new Map<string, Held>()
  /** Epochs the background closed (or the page disconnected): calls on them fail locally. */
  const closedEpochs = new Set<string>()
  const pending = new Map<string, Pending>()
  let timer: unknown
  let step = 0
  let again = false

  const visible = (): boolean => win.document.visibilityState !== 'hidden'

  // ---- background ------------------------------------------------------------------------------------------

  /** One request; a transport rejection (background reloaded) is retried, a typed reply is final. */
  async function ask<T>(request: BackgroundRequest): Promise<BackgroundReply<T>> {
    let last: unknown
    for (let i = 0; i < attempts; i++) {
      try {
        const reply = await runtime.sendMessage(request)
        if (isRecord(reply) && typeof reply.ok === 'boolean') return reply as BackgroundReply<T>
        last = new Error('unreadable reply')
      } catch (e) {
        last = e
      }
    }
    void last
    return { ok: false, error: configurationError('The wallet extension could not be reached', 'transport') }
  }

  function ensureBackgroundPort(): void {
    if (bgPort || held.size === 0 || disposed) return
    try {
      const p = runtime.connect({ name: BACKGROUND_PORT_NAME })
      p.onDisconnect.addListener(() => {
        if (bgPort === p) bgPort = undefined
      })
      bgPort = p
    } catch {
      bgPort = undefined
    }
  }

  function releaseBackgroundPort(): void {
    if (held.size > 0 || !bgPort) return
    const p = bgPort
    bgPort = undefined
    try {
      p.disconnect()
    } catch {
      // already gone
    }
  }

  // ---- delivery to the page --------------------------------------------------------------------------------

  const toPage = (message: unknown): void => {
    try {
      pagePort?.postMessage(message)
    } catch {
      // the page's port is gone; nothing to tell
    }
  }

  function failInvoke(env: XdmInvoke, error: unknown): void {
    toPage(xdmError(env.instanceId, env.epoch, env.id, error as never))
  }

  function applyClosed(instanceId: string, epoch: string, reason: 'account-changed' | 'revoked' | 'lost'): void {
    const key = epochKey(instanceId, epoch)
    if (!held.delete(key)) return // already closed or disconnected: closes are idempotent
    closedEpochs.add(key)
    toPage(xdmClosed(instanceId, epoch, reason))
    releaseBackgroundPort()
  }

  // ---- polling ---------------------------------------------------------------------------------------------

  function schedule(): void {
    if (timer !== undefined) timers.clearTimeout(timer)
    timer = undefined
    if (disposed || pending.size === 0 || !visible()) return
    const delay = POLL_STEPS_MS[Math.min(step, POLL_STEPS_MS.length - 1)]
    step++
    timer = timers.setTimeout(() => {
      timer = undefined
      void poll()
    }, delay)
  }

  async function pollOnce(): Promise<void> {
    if (held.size === 0 && pending.size === 0) return
    ensureBackgroundPort()
    const reply = await ask<PollValue>({
      bsv: 'poll',
      ids: [...pending.keys()],
      epochs: [...held.values()]
    })
    if (!reply.ok) return // typed refusal or transport: keep everything, try again at the next trigger
    const value = reply.value
    for (const item of Array.isArray(value?.items) ? value.items : []) {
      const p = pending.get(item.id)
      if (!p) continue // already delivered: ignored (the background acked it again)
      pending.delete(item.id)
      if (item.kind === 'result') toPage(xdmResult(p.instanceId, p.epoch, p.id, item.result))
      else toPage(xdmError(p.instanceId, p.epoch, p.id, item.error))
    }
    for (const c of Array.isArray(value?.closed) ? value.closed : []) applyClosed(c.instanceId, c.epoch, c.reason)
  }

  /** One poll loop at a time; a trigger that arrives meanwhile makes it run once more and shares its promise. */
  let running: Promise<void> | undefined
  function poll(): Promise<void> {
    if (running) {
      again = true
      return running
    }
    running = (async () => {
      try {
        do {
          again = false
          await pollOnce().catch(() => undefined)
        } while (again && !disposed)
      } finally {
        running = undefined
      }
      schedule()
    })()
    return running
  }

  /** A trigger from outside the timer: start the schedule over. */
  function trigger(): void {
    step = 0
    void poll()
  }

  // ---- page requests ---------------------------------------------------------------------------------------

  async function handleControl(m: Record<string, unknown>): Promise<void> {
    const rid = m.rid
    if (typeof rid !== 'number') return
    const reply = (ok: boolean, payload: unknown): void =>
      toPage(ok ? { kind: 'reply', rid, ok: true, value: payload } : { kind: 'reply', rid, ok: false, error: payload })

    if (m.kind === 'describe') {
      const r = await ask({ bsv: 'describe', origin: m.origin, challenge: m.challenge })
      return r.ok ? reply(true, r.value) : reply(false, r.error)
    }
    if (m.kind === 'connect') {
      const r = await ask<{ instanceId: string }>({ bsv: 'connect', origin: m.origin, epoch: m.epoch })
      if (!r.ok) return reply(false, r.error)
      held.set(epochKey(r.value.instanceId, String(m.epoch)), {
        instanceId: r.value.instanceId,
        epoch: String(m.epoch)
      })
      ensureBackgroundPort()
      return reply(true, { instanceId: r.value.instanceId })
    }
    if (m.kind === 'disconnect') {
      const r = await ask({ bsv: 'disconnect', origin: m.origin, epoch: m.epoch })
      if (!r.ok) return reply(false, r.error)
      for (const [key, h] of held) if (h.epoch === m.epoch) held.delete(key)
      for (const [recordId, p] of pending) if (p.epoch === m.epoch) pending.delete(recordId)
      releaseBackgroundPort()
      return reply(true, null)
    }
  }

  async function handleInvoke(env: XdmInvoke): Promise<void> {
    const key = epochKey(env.instanceId, env.epoch)
    if (!held.has(key)) {
      // Never connected through this frame: a routing mismatch. A closed epoch is a different answer.
      failInvoke(
        env,
        closedEpochs.has(key)
          ? connectionError('CONNECTION_CLOSED', 'The connection is closed', 'not-sent', { epoch: env.epoch })
          : protocolError('The call does not belong to a connection of this frame')
      )
      return
    }
    const r = await ask<InvokeValue>({
      bsv: 'invoke',
      instanceId: env.instanceId,
      epoch: env.epoch,
      id: env.id,
      method: env.method,
      params: env.params
    })
    if (!r.ok) {
      failInvoke(env, r.error)
    } else if (r.value.kind === 'local') {
      toPage(xdmResult(env.instanceId, env.epoch, env.id, r.value.result))
    } else {
      pending.set(r.value.recordId, { instanceId: env.instanceId, epoch: env.epoch, id: env.id })
    }
    trigger() // the page's next call is also a poll trigger
  }

  function onPageMessage(e: { data: any }): void {
    const m = e.data
    if (!isRecord(m)) return
    if (m.kind === 'describe' || m.kind === 'connect' || m.kind === 'disconnect') {
      void handleControl(m).catch(() => undefined)
      return
    }
    const env = parseXdmEnvelope(m)
    if (env?.type === 'brc185:invoke') void handleInvoke(env).catch(() => undefined)
    // anything else is not ours; there is nobody to answer
  }

  // ---- window wiring ---------------------------------------------------------------------------------------

  function hello(): void {
    win.postMessage({ type: MSG_CONTENT_READY }, '*')
  }

  function onWindowMessage(e: any): void {
    if (e.source !== win || !isRecord(e.data) || disposed) return
    if (e.data.type === MSG_MAIN_READY) {
      if (!pagePort) hello()
    } else if (e.data.type === MSG_PORT) {
      const p = Array.isArray(e.ports) ? e.ports[0] : undefined
      if (!p || pagePort) return // the first port only
      pagePort = p as ContentPort
      pagePort.onmessage = onPageMessage
      pagePort.start?.()
    }
  }

  const onVisibility = (): void => {
    if (visible()) trigger()
    else if (timer !== undefined) {
      timers.clearTimeout(timer)
      timer = undefined
    }
  }
  const onPageShow = (): void => {
    ensureBackgroundPort() // a page restored from the back/forward cache lost its port
    trigger()
  }
  const onFocus = (): void => trigger()

  win.addEventListener('message', onWindowMessage)
  win.document.addEventListener('visibilitychange', onVisibility)
  win.addEventListener('pageshow', onPageShow)
  win.addEventListener('focus', onFocus)
  hello()

  return {
    poll,
    pendingCount: () => pending.size,
    dispose(): void {
      disposed = true
      win.removeEventListener('message', onWindowMessage)
      win.document.removeEventListener('visibilitychange', onVisibility)
      win.removeEventListener('pageshow', onPageShow)
      win.removeEventListener('focus', onFocus)
      if (timer !== undefined) timers.clearTimeout(timer)
      pagePort?.close()
      pagePort = undefined
      held.clear()
      releaseBackgroundPort()
    }
  }
}

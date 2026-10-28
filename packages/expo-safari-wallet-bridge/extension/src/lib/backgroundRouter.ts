/**
 * The background's message router (spec 6.8, 6.10, 6.11). It is the only caller of native messaging, takes the
 * origin and the frame only from `sender` (re-read on every message), and keeps nothing but `storage.session`
 * and a few idempotent in-memory conveniences (the open content-script ports, a flush timer): the page can lose
 * the background at any moment and the next message finds everything it needs in session storage.
 *
 * Order for a call: attest the sender, check the routing fields, reconcile, then answer locally (three methods,
 * only for a bound open epoch) or stage and hand off. The reply is the staging acknowledgement; the handoff
 * (`tabs.update`) is fired after it and never delays it.
 */
import { canonicalizeBridgeOrigin } from '@bsv/expo-wallet-toolbox/core/bridge/protocol/origin'
import type { CloseReason } from '@bsv/expo-wallet-toolbox/core/bridge/protocol/envelopes'
import { MAX_BRIDGE_REQUEST_BYTES } from '@bsv/expo-wallet-toolbox/core/bridge/protocol/limits'
import { isBridgeMethod } from '@bsv/expo-wallet-toolbox/core/bridge/protocol/methods'
import { CLOSING_GRACE_MS } from '../../../shared/constants'
import { attestFrame, type AttestedFrame, type Sender } from './attest'
import { bindingKey, loadBindings, withSessionLock, type EpochBinding, type SessionArea } from './bindings'
import { utf8Bytes } from './bytes'
import { connect as connectEpoch, describe as describeProvider } from './describeConnect'
import { asConnectionError, configurationError, connectionError, protocolError, unknownDelivery } from './errors'
import { triggerHandoff } from './handoff'
import { isUuidV4 } from './ids'
import { loadUnresolved } from './limits'
import { localAnswer } from './localAnswers'
import { pickup, type PickupItem } from './pickup'
import { reconcile, type ClosedEpoch } from './reconcile'
import { retryWithdrawals, stageInvoke, type StageDeps } from './stage'
import { closeEpoch, detectGoneTabs, flushDisconnects, markTabClosing, reregister } from './tabs'
import {
  BACKGROUND_PORT_NAME,
  isRecord,
  type BackgroundReply,
  type ClosedNotice,
  type InvokeValue,
  type PollValue
} from './wire'

export interface BackgroundDeps extends StageDeps {
  tabs: {
    update(tabId: number, props: { url?: string }): Promise<unknown>
    query(info: Record<string, unknown>): Promise<Array<{ id?: number }>>
  }
  /** Overrides the `BRIDGE_SCHEME` build constant (tests). */
  scheme?: string
  /** Schedules the flush of epochs whose grace ran out (default `setTimeout`). */
  setTimeout?: (fn: () => void, ms: number) => unknown
  /** Answer for the popup's `ping`. */
  info?: Record<string, unknown>
}

export interface Background {
  handleMessage(message: unknown, sender: Sender): Promise<unknown>
  /** For `runtime.onMessage`: replies asynchronously. */
  onMessage(message: unknown, sender: Sender, sendResponse: (reply?: unknown) => void): boolean
  onConnect(port: BrowserPort): void
  onTabRemoved(tabId: number): void
  onTabUpdated(tabId: number, changeInfo: { url?: string; status?: string }): void
  /** Resolves when background work started by the listeners has settled (tests). */
  idle(): Promise<void>
}

const NOTICES_KEY = 'bsv.notices'
const MAX_NOTICES = 256

interface StoredNotice extends ClosedNotice {
  tabId: number
  frameId: number
}

const ok = <T>(value: T): BackgroundReply<T> => ({ ok: true, value })

export function createBackground(deps0: BackgroundDeps): Background {
  const { session } = deps0
  const setT = deps0.setTimeout ?? ((fn, ms) => setTimeout(fn, ms))
  const allowLocalhostHttp = deps0.allowLocalhostHttp === true

  // ---- closed-epoch notices --------------------------------------------------------------------------------
  // Reconcile closes epochs on behalf of whichever tab happened to ask; the owner of each epoch learns of it at
  // its next poll (stored here) and at once if its port is open.

  const ports = new Map<string, BrowserPort>()
  let noticeChain: Promise<unknown> = Promise.resolve()

  async function loadNotices(): Promise<StoredNotice[]> {
    const raw = (await session.get(NOTICES_KEY))[NOTICES_KEY]
    return Array.isArray(raw) ? (raw as StoredNotice[]) : []
  }

  function recordClosed(closed: ClosedEpoch[]): void {
    const fresh = closed.filter(c => c.notifyPage)
    if (fresh.length > 0) {
      noticeChain = noticeChain
        .then(() =>
          withSessionLock(session, async () => {
            const all = await loadNotices()
            for (const c of fresh) {
              all.push({
                tabId: c.binding.tabId,
                frameId: c.binding.frameId,
                instanceId: c.binding.instanceId,
                epoch: c.binding.epoch,
                reason: c.reason
              })
            }
            await session.set({ [NOTICES_KEY]: all.slice(-MAX_NOTICES) })
          })
        )
        .catch(() => undefined)
    }
    deps0.onClosed?.(closed)
  }

  const deps: BackgroundDeps = { ...deps0, onClosed: recordClosed }

  async function takeNotices(tabId: number, frameId: number): Promise<ClosedNotice[]> {
    await noticeChain
    return withSessionLock(session, async () => {
      const all = await loadNotices()
      const mine = all.filter(n => n.tabId === tabId && n.frameId === frameId)
      if (mine.length > 0) {
        await session.set({ [NOTICES_KEY]: all.filter(n => !(n.tabId === tabId && n.frameId === frameId)) })
      }
      return mine.map(({ instanceId, epoch, reason }) => ({ instanceId, epoch, reason }))
    })
  }

  async function noticeFor(instanceId: string, epoch: string): Promise<CloseReason | undefined> {
    await noticeChain
    return (await loadNotices()).find(n => n.instanceId === instanceId && n.epoch === epoch)?.reason
  }

  // ---- wake and grace flush -------------------------------------------------------------------------------

  let woken: Promise<void> | undefined
  /** Once per background lifetime: tabs that died while we were unloaded, withdrawals that never confirmed. */
  function wake(): Promise<void> {
    woken ??= (async () => {
      try {
        const gone = await detectGoneTabs(deps, deps.tabs)
        if (gone.length > 0) scheduleFlush()
      } catch {
        // the tab list is a convenience; the 24-hour horizon bounds anything missed
      }
      await retryWithdrawals(deps).catch(() => undefined)
    })()
    return woken
  }

  let flushScheduled = false
  let flushRunning: Promise<unknown> = Promise.resolve()
  function scheduleFlush(): void {
    if (flushScheduled) return
    flushScheduled = true
    setT(() => {
      flushScheduled = false
      flushRunning = flushDisconnects(deps, deps.now()).catch(() => undefined)
    }, CLOSING_GRACE_MS + 50)
  }
  const flushNow = (): Promise<unknown> => flushDisconnects(deps, deps.now()).catch(() => undefined)

  // ---- helpers ---------------------------------------------------------------------------------------------

  function attest(sender: Sender): AttestedFrame {
    const frame = attestFrame(sender, { allowLocalhostHttp })
    if (!frame) throw protocolError('This frame has no origin the wallet can serve')
    return frame
  }

  /** The epoch bound to exactly this frame, or undefined. */
  async function findBinding(
    frame: AttestedFrame,
    instanceId: unknown,
    epoch: string
  ): Promise<EpochBinding | undefined> {
    const bindings = await loadBindings(session)
    if (typeof instanceId === 'string') return bindings[bindingKey(instanceId, epoch)]
    return Object.values(bindings).find(
      b => b.epoch === epoch && b.tabId === frame.tabId && b.frameId === frame.frameId
    )
  }

  const requestBytes = (method: string, params: unknown): number => {
    try {
      return utf8Bytes(JSON.stringify({ method, params })).length
    } catch {
      return Infinity
    }
  }

  // ---- operations ------------------------------------------------------------------------------------------

  async function opDescribe(m: Record<string, unknown>, sender: Sender): Promise<unknown> {
    const frame = attest(sender)
    return describeProvider(deps, { frame, origin: m.origin as string, challenge: m.challenge as string })
  }

  async function opConnect(m: Record<string, unknown>, sender: Sender): Promise<unknown> {
    const frame = attest(sender)
    const epoch = m.epoch as string
    await connectEpoch(deps, { frame, origin: m.origin as string, epoch })
    const binding = await findBinding(frame, undefined, epoch)
    if (!binding) throw configurationError('The connection could not be recorded')
    return { instanceId: binding.instanceId }
  }

  async function opDisconnect(m: Record<string, unknown>, sender: Sender): Promise<unknown> {
    const frame = attest(sender)
    if (typeof m.origin !== 'string' || m.origin !== frame.origin) {
      throw protocolError('The origin does not match the frame that sent the call')
    }
    if (!isUuidV4(m.epoch)) throw protocolError('The epoch must be a lowercase UUIDv4')
    const binding = await findBinding(frame, undefined, m.epoch)
    if (!binding) return null // already closed: idempotent
    const key = bindingKey(binding.instanceId, binding.epoch)
    if (!(await closeEpoch(deps, key, deps.now()))) {
      // The disconnect record could not be staged now; keep it closing so the next wake retries it.
      await markTabClosing(deps, binding.tabId, binding.frameId)
      scheduleFlush()
    }
    return null
  }

  async function opInvoke(m: Record<string, unknown>, sender: Sender): Promise<InvokeValue> {
    const frame = attest(sender)
    const { instanceId, epoch, id, method, params } = m
    if (
      typeof instanceId !== 'string' ||
      !isUuidV4(epoch) ||
      !isUuidV4(id) ||
      typeof method !== 'string' ||
      !isBridgeMethod(method)
    ) {
      throw protocolError('The call is malformed or names an unknown method')
    }
    const size = requestBytes(method, params)
    if (size > MAX_BRIDGE_REQUEST_BYTES) {
      throw protocolError(Number.isFinite(size) ? 'The request is too large' : 'The call arguments cannot be sent')
    }

    // Reconcile before anything else (spec 6.10): closes epochs, tells their owners.
    const state = await reconcile(deps)
    const binding = (await loadBindings(session))[bindingKey(instanceId, epoch)]
    if (!binding) {
      const reason = await noticeFor(instanceId, epoch)
      if (reason === undefined) throw protocolError('The call does not belong to an open connection')
      throw reason === 'lost'
        ? connectionError('CONNECTION_CLOSED', 'The connection is closed', 'not-sent', { epoch })
        : connectionError('PROVIDER_CHANGED', 'The wallet changed', 'not-sent', { epoch, cause: reason })
    }
    if (binding.tabId !== frame.tabId || binding.frameId !== frame.frameId || binding.origin !== frame.origin) {
      throw protocolError('The call does not come from the frame that connected')
    }
    await reregister(deps, bindingKey(instanceId, epoch)) // a frame that is calling is alive

    const local = localAnswer(method, params, binding, state.mirror, frame.origin)
    if (local) return { kind: 'local', result: local.answer }

    const outcome = await stageInvoke(deps, { frame, binding, invokeId: id, method, params })
    if (outcome.kind === 'error') throw outcome.error
    // Fire and forget: the acknowledgement above is what the page waits on.
    void triggerHandoff(
      { session, now: deps.now, tabs: deps.tabs, ...(deps.scheme === undefined ? {} : { scheme: deps.scheme }) },
      frame.tabId
    ).catch(() => undefined)
    return { kind: 'staged', recordId: outcome.recordId }
  }

  async function opPoll(m: Record<string, unknown>, sender: Sender): Promise<PollValue> {
    const frame = attest(sender)
    const ids = Array.isArray(m.ids) ? m.ids.filter((x): x is string => typeof x === 'string') : []
    const epochs = Array.isArray(m.epochs) ? m.epochs : []
    // The page holds these epochs and is alive (it just asked): they are not closing.
    for (const e of epochs) {
      if (isRecord(e) && typeof e.instanceId === 'string' && typeof e.epoch === 'string') {
        const b = (await loadBindings(session))[bindingKey(e.instanceId, e.epoch)]
        if (b && b.tabId === frame.tabId && b.frameId === frame.frameId) {
          await reregister(deps, bindingKey(b.instanceId, b.epoch))
        }
      }
    }
    let items: PickupItem[] = []
    if (ids.length > 0) items = await pickup(deps, ids)
    else await reconcile(deps)

    // A call that is neither delivered nor outstanding any more (its epoch's grace ran out, or the table was
    // dropped) can never produce a result: close it instead of leaving the page waiting.
    const delivered = new Set(items.map(i => i.id))
    const outstanding = await loadUnresolved(session)
    for (const id of ids) {
      if (delivered.has(id) || outstanding[id]) continue
      items.push({
        id,
        kind: 'error',
        error: unknownDelivery('CONNECTION_CLOSED', 'The result is no longer available')
      })
    }
    return { items, closed: await takeNotices(frame.tabId, frame.frameId) }
  }

  async function dispatch(message: Record<string, unknown>, sender: Sender): Promise<unknown> {
    switch (message.bsv) {
      case 'describe':
        return opDescribe(message, sender)
      case 'connect':
        return opConnect(message, sender)
      case 'disconnect':
        return opDisconnect(message, sender)
      case 'invoke':
        return opInvoke(message, sender)
      case 'poll':
        return opPoll(message, sender)
      default:
        throw protocolError('Unknown request')
    }
  }

  async function handleMessage(message: unknown, sender: Sender): Promise<unknown> {
    if (isRecord(message) && message.type === 'ping') {
      return { pong: true, ...deps.info }
    }
    if (!isRecord(message) || typeof message.bsv !== 'string') {
      return { ok: false, error: protocolError('Unknown request') }
    }
    try {
      await wake()
      await flushNow() // epochs whose grace ran out while we were idle
      const value = await dispatch(message, sender)
      return ok(value)
    } catch (e) {
      return {
        ok: false,
        error: asConnectionError(e, () => configurationError('The wallet extension failed', (e as Error)?.message))
      }
    }
  }

  // ---- listeners ---------------------------------------------------------------------------------------------

  let work: Promise<unknown> = Promise.resolve()
  const track = (p: Promise<unknown>): void => {
    work = work.then(() => p).catch(() => undefined)
  }

  return {
    handleMessage,
    onMessage(message, sender, sendResponse) {
      handleMessage(message, sender).then(sendResponse, () =>
        sendResponse({ ok: false, error: configurationError('The wallet extension failed') })
      )
      return true // the reply is asynchronous
    },
    onConnect(port) {
      if (port.name !== BACKGROUND_PORT_NAME) return
      const tabId = port.sender?.tab?.id
      if (typeof tabId !== 'number') return
      const frameId = typeof port.sender?.frameId === 'number' ? port.sender.frameId : 0
      const key = `${tabId}:${frameId}`
      ports.set(key, port)
      port.onDisconnect.addListener(() => {
        if (ports.get(key) === port) ports.delete(key)
        // Frame unload, tab close, navigation or the content script going away: start the grace clock. A page
        // restored from the back/forward cache lists its epochs at its next poll, which stops it.
        track(
          markTabClosing(deps, tabId, frameId).then(hit => {
            if (hit.length > 0) scheduleFlush()
          })
        )
      })
    },
    onTabRemoved(tabId) {
      track(
        markTabClosing(deps, tabId).then(async hit => {
          if (hit.length > 0) scheduleFlush()
          await withSessionLock(session, async () => {
            const all = await loadNotices()
            await session.set({ [NOTICES_KEY]: all.filter(n => n.tabId !== tabId) })
          })
        })
      )
    },
    onTabUpdated(tabId, changeInfo) {
      const url = changeInfo?.url
      if (typeof url !== 'string') return
      const scheme = deps.scheme ?? (typeof BRIDGE_SCHEME === 'string' ? BRIDGE_SCHEME : '')
      if (scheme !== '' && url.startsWith(`${scheme}://`)) return // our own handoff, not a navigation of the page
      // A top-frame navigation to another origin destroys every document of the tab. A same-origin navigation
      // (or a pushState) keeps the page's script alive or ends it through its port, so it is not acted on here.
      track(
        (async () => {
          let next: string
          try {
            next = canonicalizeBridgeOrigin({
              origin: new URL(url).origin,
              attestation: 'browser',
              allowLocalhostHttp
            }).applicationOrigin
          } catch {
            next = ''
          }
          const top = Object.values(await loadBindings(session)).filter(b => b.tabId === tabId && b.frameId === 0)
          if (top.length > 0 && top.some(b => b.origin !== next)) {
            if ((await markTabClosing(deps, tabId)).length > 0) scheduleFlush()
          }
        })()
      )
    },
    async idle() {
      await work
      await noticeChain
      await flushRunning
    }
  }
}

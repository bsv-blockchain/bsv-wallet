/**
 * The whole extension on fakes: a fake window shared by the page world and the content script (real
 * `MessageChannel` between them), a shared background over the fake appex, and `runtime.sendMessage` /
 * `runtime.connect` that route to the background with a freshly built `sender` each time.
 */
import { createBackground, type Background, type BackgroundDeps } from '../../extension/src/lib/backgroundRouter'
import { createContentRelay, type ContentRelay } from '../../extension/src/lib/contentRelay'
import { createProviderMain, type ProviderMain } from '../../extension/src/lib/providerMain'
import type { Sender } from '../../extension/src/lib/attest'
import { createPageClient, type PageClient } from '../../src/testing/pageClient'
import {
  createFakeAppex,
  createFakeBrowser,
  fakeDeps,
  makeMirror,
  type FakeAppex,
  type FakeBrowser
} from './fakeBrowser'

export class FakeWindow {
  private target = new EventTarget()
  readonly crypto = globalThis.crypto
  readonly CustomEvent = CustomEvent
  readonly MessageChannel = MessageChannel
  readonly document: {
    visibilityState: string
    addEventListener: EventTarget['addEventListener']
    removeEventListener: EventTarget['removeEventListener']
    dispatchEvent: EventTarget['dispatchEvent']
  }
  readonly location: { protocol: string; origin: string; href: string }
  origin: string
  constructor(href: string, opaque = false) {
    const url = new URL(href)
    this.location = { protocol: url.protocol, origin: url.origin, href }
    this.origin = opaque ? 'null' : url.origin
    const doc = new EventTarget()
    this.document = {
      visibilityState: 'visible',
      addEventListener: doc.addEventListener.bind(doc),
      removeEventListener: doc.removeEventListener.bind(doc),
      dispatchEvent: doc.dispatchEvent.bind(doc)
    }
  }
  addEventListener(type: string, l: (e: any) => void): void {
    this.target.addEventListener(type, l)
  }
  removeEventListener(type: string, l: (e: any) => void): void {
    this.target.removeEventListener(type, l)
  }
  dispatchEvent(e: Event): boolean {
    return this.target.dispatchEvent(e)
  }
  postMessage(data: unknown, _origin: string, transfer: unknown[] = []): void {
    queueMicrotask(() => {
      const ev = new Event('message')
      Object.assign(ev, { data, source: this, ports: transfer })
      this.target.dispatchEvent(ev)
    })
  }
  /** Fires `visibilitychange`, `focus` or `pageshow`. */
  fire(what: 'visible' | 'hidden' | 'focus' | 'pageshow'): void {
    if (what === 'visible' || what === 'hidden') {
      this.document.visibilityState = what
      this.document.dispatchEvent(new Event('visibilitychange'))
    } else this.target.dispatchEvent(new Event(what))
  }
}

export const until = async (cond: () => boolean | Promise<boolean>, what = 'condition', ms = 2000): Promise<void> => {
  const end = Date.now() + ms
  while (!(await cond())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await new Promise(r => setTimeout(r, 1))
  }
}

export const tick = (ms = 20): Promise<void> => new Promise(r => setTimeout(r, ms))

export interface ManualTimers {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(t: any): void
  /** Pending delays in scheduling order. */
  delays(): number[]
  /** Runs the oldest pending timer. */
  fire(): void
}

export function manualTimers(): ManualTimers {
  let next = 1
  const pending = new Map<number, { fn: () => void; ms: number }>()
  return {
    setTimeout(fn, ms) {
      const id = next++
      pending.set(id, { fn, ms })
      return id
    },
    clearTimeout(t) {
      pending.delete(t)
    },
    delays: () => [...pending.values()].map(p => p.ms),
    fire() {
      const first = pending.entries().next().value
      if (!first) return
      pending.delete(first[0])
      first[1].fn()
    }
  }
}

export interface Frame {
  win: FakeWindow
  provider: ProviderMain
  relay: ContentRelay
  client: PageClient
  tabId: number
  frameId: number
  /** The messages this frame sent to the background. */
  sent: Record<string, any>[]
  /** Background-side ports (one per `runtime.connect`). */
  ports: Array<{ disconnected: boolean; disconnect(): void }>
  dispose(): void
}

export interface FrameOptions {
  tabId?: number
  frameId?: number
  url?: string
  incognito?: boolean
  opaque?: boolean
}

export interface RawFrame {
  win: FakeWindow
  relay: ContentRelay
  /** Messages the content script sent to the page, in order. */
  replies: any[]
  send(message: unknown): void
  /** Sends a control call and resolves with its reply. */
  control(message: Record<string, unknown>): Promise<any>
  dispose(): void
}

export interface World {
  browser: FakeBrowser
  appex: FakeAppex
  clock: { t: number }
  bg: Background
  deps: BackgroundDeps
  /** Timers of the content scripts (poll schedule). */
  timers: ManualTimers
  /** Timers of the background (grace flush). */
  bgTimers: ManualTimers
  frames: Frame[]
  newFrame(opts?: FrameOptions): Frame
  /** A content script with no page-world script: the test is the page and speaks the port protocol itself. */
  rawFrame(opts?: FrameOptions): RawFrame
  dispose(): void
}

export const PAGE_URL = 'https://app.example/page'

export function createWorld(appexInit: Partial<FakeAppex> = {}, opts: { scheme?: string } = {}): World {
  const browser = createFakeBrowser()
  const appex = createFakeAppex({ mirrorState: 'ok', mirror: makeMirror(), ...appexInit })
  const clock = { t: 1_000_000 }
  const timers = manualTimers()
  const bgTimers = manualTimers()
  let ids = 5000
  const base = fakeDeps(appex, browser, { clock })
  const deps: BackgroundDeps = {
    ...base,
    tabs: browser.tabs,
    scheme: opts.scheme ?? 'org.bsvblockchain.wallet',
    setTimeout: (fn, ms) => bgTimers.setTimeout(fn, ms),
    newId: () => `00000000-0000-4000-8000-${(ids++).toString(16).padStart(12, '0')}`,
    info: { name: 'Bitcoin SV Wallet' }
  }
  const bg = createBackground(deps)
  const frames: Frame[] = []
  const rawFrames: RawFrame[] = []

  function transport(o: FrameOptions) {
    const tabId = o.tabId ?? 1
    const frameId = o.frameId ?? 0
    const url = o.url ?? PAGE_URL
    const win = new FakeWindow(url, o.opaque)
    browser.tabs.open.add(tabId)
    const sent: Record<string, any>[] = []
    const ports: Frame['ports'] = []
    const sender = (): Sender => ({
      tab: { id: tabId, incognito: o.incognito ?? false, url },
      frameId,
      url: win.location.href,
      origin: win.location.origin
    })
    const runtime = {
      async sendMessage(m: unknown) {
        const clone = JSON.parse(JSON.stringify(m))
        sent.push(clone)
        return JSON.parse(JSON.stringify(await bg.handleMessage(clone, sender())))
      },
      connect(): BrowserPort {
        const l = { disc: [] as Array<() => void>, contentDisc: [] as Array<() => void> }
        const bgSide: BrowserPort = {
          name: 'bsv-bridge',
          sender: sender(),
          postMessage() {},
          disconnect() {},
          onMessage: { addListener() {}, removeListener() {} },
          onDisconnect: { addListener: f => l.disc.push(f), removeListener() {} }
        }
        const handle = {
          disconnected: false,
          disconnect() {
            if (handle.disconnected) return
            handle.disconnected = true
            l.disc.forEach(f => f())
            l.contentDisc.forEach(f => f())
          }
        }
        ports.push(handle)
        bg.onConnect(bgSide)
        return {
          name: 'bsv-bridge',
          postMessage() {},
          disconnect: handle.disconnect,
          onMessage: { addListener() {}, removeListener() {} },
          onDisconnect: { addListener: f => l.contentDisc.push(f), removeListener() {} }
        }
      }
    }
    return { win, runtime: { runtime, sent, ports } }
  }

  const world: World = {
    browser,
    appex,
    clock,
    bg,
    deps,
    timers,
    bgTimers,
    frames,
    rawFrame(o = {}) {
      const { win, runtime } = transport(o)
      const relay = createContentRelay({ win: win as never, runtime: runtime.runtime, timers })
      const replies: any[] = []
      const ch = new MessageChannel()
      ch.port1.onmessage = e => replies.push(e.data)
      win.postMessage({ type: 'bsv-bridge:port', ch: '' }, '*', [ch.port2])
      let rid = 0
      const raw: RawFrame = {
        win,
        relay,
        replies,
        send: m => ch.port1.postMessage(m),
        async control(m) {
          const id = ++rid
          ch.port1.postMessage({ ...m, rid: id })
          await until(() => replies.some(r => r.kind === 'reply' && r.rid === id), 'control reply')
          return replies.find(r => r.kind === 'reply' && r.rid === id)
        },
        dispose() {
          relay.dispose()
          ch.port1.close()
        }
      }
      rawFrames.push(raw)
      return raw
    },
    newFrame(o = {}) {
      const tabId = o.tabId ?? 1
      const frameId = o.frameId ?? 0
      const { win, runtime: t } = transport(o)
      const { runtime, sent, ports } = t
      const provider = createProviderMain(win as never, { portWaitMs: 300 })
      const relay = createContentRelay({ win: win as never, runtime, timers })
      const client = createPageClient(win as never, { collectMs: 5, describeDeadlineMs: 500 })
      const frame: Frame = {
        win,
        provider,
        relay,
        client,
        tabId,
        frameId,
        sent,
        ports,
        dispose() {
          provider.dispose()
          relay.dispose()
        }
      }
      frames.push(frame)
      return frame
    },
    dispose() {
      for (const f of frames) f.dispose()
      for (const f of rawFrames) f.dispose()
      frames.length = 0
      rawFrames.length = 0
    }
  }
  return world
}

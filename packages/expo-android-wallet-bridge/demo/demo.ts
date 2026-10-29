/**
 * Demo page logic for the Android loopback kit (spec 6.16): a button per BRC-185 step, driven by the stand-in loopback
 * page client. Test tool only: not in the package's published files or the host app.
 *
 * `wireDemo` takes the document and a client factory so jest can drive it with fakes; main.ts starts it on the real
 * page (the element `#demo-root` marks that page), together with the Conformance panel shared with the iOS kit.
 *
 * "Open wallet" is the one step that needs a user gesture: its click handler builds the client and calls `launch()`
 * synchronously, with nothing awaited before it, so Chrome still sees the navigation as gesture-initiated.
 */
import {
  isConnectionError,
  type Connection,
  type DiscoveredProvider
} from '@bsv/expo-wallet-toolbox/core/bridge/testing/pageClient'
import { actionDescription, randomMarker, type DemoDocument } from '../../expo-safari-wallet-bridge/demo/demo'
import type { LoopbackPageClient } from '../src/testing/loopbackPageClient'

export type { DemoDocument, DemoElement } from '../../expo-safari-wallet-bridge/demo/demo'

export const BUTTONS = [
  'open',
  'describe',
  'connect',
  'getVersion',
  'isAuthenticated',
  'getPublicKey',
  'createAction',
  'disconnect',
  'permission'
] as const
export type DemoButton = (typeof BUTTONS)[number]

export const DEFAULT_SCHEME = 'bsv-wallet-bridge'
export const DEFAULT_PACKAGE = 'org.bsvblockchain.wallet'
export const BASE_PORT = 3321
/** Offsets 0 to 63 above the base (spec: ceiling 3384). */
export const PORT_WINDOW = 64
export const DEFAULT_ATTEMPT_TIMEOUT_MS = 3000
export const PERMISSION_NAMES = ['loopback-network', 'local-network-access'] as const

export interface LaunchTarget {
  scheme: string
  packageId: string
  fallbackUrl?: string
}

/** `?scheme=&package=&fallback=` override the launch target (for a debug build with another package id). */
export function launchTarget(search: string | undefined): LaunchTarget {
  const q = new URLSearchParams(search ?? '')
  const scheme = q.get('scheme')
  const packageId = q.get('package')
  const fallbackUrl = q.get('fallback')
  return {
    scheme: scheme || DEFAULT_SCHEME,
    packageId: packageId || DEFAULT_PACKAGE,
    ...(fallbackUrl ? { fallbackUrl } : {})
  }
}

export interface ScanSettings {
  basePort: number
  window: number
  attemptTimeoutMs: number
}

/** The port-window and timeout fields: a first port of 3321 to 3384 (the window shrinks to stay under 3384). */
export function scanSettings(portValue: string | undefined, timeoutValue: string | undefined): ScanSettings {
  const port = Math.floor(Number(portValue))
  const basePort = Number.isFinite(port) && port >= BASE_PORT && port <= BASE_PORT + PORT_WINDOW - 1 ? port : BASE_PORT
  const t = Math.floor(Number(timeoutValue))
  const attemptTimeoutMs = Number.isFinite(t) && t >= 100 && t <= 30000 ? t : DEFAULT_ATTEMPT_TIMEOUT_MS
  return { basePort, window: BASE_PORT + PORT_WINDOW - basePort, attemptTimeoutMs }
}

/** Name what a rejected announcement means, so blocked, absent, refused and unauthenticated read differently. */
export function classifyRejection(reason: string): string {
  if (reason === 'blocked') return 'BLOCKED: the browser denied loopback access to this page'
  if (reason === 'unauthenticated')
    return 'UNAUTHENTICATED: a responder answered without proving it holds the launch key; sent nothing'
  if (reason === 'wallet did not open') return 'ABSENT: no wallet answered in the scan window'
  if (reason.startsWith('refused')) return `REFUSED: ${reason.replace(/^refused:\s*/, '')}`
  return reason
}

const describeError = (e: unknown): string => {
  if (isConnectionError(e)) return `${e.code} (delivery ${e.delivery}): ${e.message}`
  if (e instanceof Error) return `${e.name}: ${e.message}`
  if (typeof e === 'object' && e !== null) {
    const { code, message } = e as { code?: unknown; message?: unknown }
    if (typeof message === 'string') return typeof code === 'undefined' ? message : `${String(code)}: ${message}`
    return JSON.stringify(e)
  }
  return String(e)
}

/** What the Conformance panel needs to know: the live connection (or none after disconnect or close). */
export interface ConnectionSink {
  setConnection(client: LoopbackPageClient | undefined, connection: Connection | undefined): void
}

export interface DemoOptions {
  doc: DemoDocument
  /** Build a client for the given settings; called at Open wallet (and lazily for describe and connect). */
  makeClient(settings: ScanSettings & LaunchTarget): LoopbackPageClient
  /** `location.search` of the page. */
  search?: string
  rand: (n: number) => Uint8Array
  /** `navigator.permissions.query` result for one name, or `undefined` when the browser does not know the name. */
  queryPermission?: (name: string) => Promise<string | undefined>
  now?: () => Date
  conformance?: ConnectionSink
}

export function wireDemo({
  doc,
  makeClient,
  search,
  rand,
  queryPermission,
  now = () => new Date(),
  conformance
}: DemoOptions) {
  let client: LoopbackPageClient | undefined
  let providers: DiscoveredProvider[] = []
  let connection: Connection | undefined
  const logEl = doc.getElementById('log')

  const log = (kind: 'ok' | 'err' | 'info', text: string): void => {
    if (!logEl) return
    const stamp = now().toISOString().slice(11, 23)
    logEl.textContent = `${stamp} ${kind.toUpperCase()} ${text}\n${logEl.textContent ?? ''}`
  }

  const build = (): LoopbackPageClient =>
    makeClient({
      ...scanSettings(doc.getElementById('port')?.value, doc.getElementById('timeout')?.value),
      ...launchTarget(search)
    })
  const current = (): LoopbackPageClient => (client ??= build())

  const need = (): Connection => {
    if (!connection) throw new Error('not connected: press connect first')
    return connection
  }

  const run = async (name: string, fn: () => Promise<unknown>): Promise<void> => {
    try {
      const result = await fn()
      log('ok', `${name} -> ${result === undefined ? 'done' : JSON.stringify(result)}`)
    } catch (e) {
      log('err', `${name} -> ${describeError(e)}`)
    }
  }

  const scan = async (): Promise<unknown> => {
    const found = await current().discover()
    providers = found.providers
    for (const r of found.rejected) log('err', classifyRejection(r.reason))
    return found.providers.map(p => ({ continuityKey: p.descriptor.continuityKey, name: p.descriptor.name }))
  }

  const actions: Record<DemoButton, () => Promise<unknown>> = {
    // Everything up to `launch()` is synchronous: the click is the user gesture that lets Chrome follow the intent.
    open() {
      client = build()
      providers = []
      const { epoch } = client.launch()
      log('info', `launched epoch ${epoch.slice(0, 8)}…; scanning for the wallet`)
      return scan()
    },
    describe: scan,
    async connect() {
      if (!providers.length) await scan()
      const want = (doc.getElementById('wallet')?.value ?? '').trim().toLowerCase()
      const provider = want ? providers.find(p => p.descriptor.name.toLowerCase().includes(want)) : providers[0]
      if (!provider) throw new Error('no wallet announced')
      const c = current()
      const opened = await c.connect(provider, reason => {
        log('info', `closed: ${reason}`)
        if (connection === opened) {
          connection = undefined
          conformance?.setConnection(undefined, undefined)
        }
      })
      connection = opened
      conformance?.setConnection(c, opened)
      return { epoch: opened.epoch }
    },
    getVersion: () => current().invoke(need(), 'getVersion', {}),
    isAuthenticated: () => current().invoke(need(), 'isAuthenticated', {}),
    getPublicKey: () => current().invoke(need(), 'getPublicKey', { identityKey: true }),
    createAction() {
      const marker = randomMarker(rand)
      const label = doc.getElementById('description')?.value ?? ''
      const sats = Math.max(1, Math.floor(Number(doc.getElementById('satoshis')?.value) || 1))
      const description = actionDescription(label, marker)
      log('info', `createAction marker ${marker}`)
      return current().invoke(need(), 'createAction', {
        description,
        outputs: [{ lockingScript: '51', satoshis: sats, outputDescription: 'Demo output' }]
      })
    },
    async disconnect() {
      await need().disconnect()
      connection = undefined
      conformance?.setConnection(undefined, undefined)
      return undefined
    },
    async permission() {
      const result: Record<string, string> = {}
      for (const name of PERMISSION_NAMES) {
        try {
          result[name] = (await queryPermission?.(name)) ?? 'unknown name'
        } catch {
          result[name] = 'unknown name'
        }
      }
      const c = current()
      const summary = await c.permission()
      // 'prompt' means Chrome has not asked yet: one eliciting request makes it ask.
      if (summary === 'prompt') void c.elicit().then(() => log('info', 'permission request sent'))
      return { ...result, summary }
    }
  }

  for (const name of BUTTONS) {
    doc.getElementById(name)?.addEventListener('click', () => void run(name, actions[name]))
  }
  log('info', `origin ${(globalThis as { location?: { origin?: string } }).location?.origin ?? '?'}`)
  return { run, actions, log }
}

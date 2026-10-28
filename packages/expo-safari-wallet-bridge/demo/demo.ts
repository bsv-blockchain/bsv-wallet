/**
 * Demo page logic (spec 6.16): a button per BRC-185 step, driven by the stand-in page client. Test tool only: not in
 * the package's published files, the extension bundle or the host app.
 *
 * `wireDemo` takes the document and the client so jest can drive it with fakes; the bottom of the file starts it on
 * the real page (the element `#demo-root` marks that page).
 */
import {
  createPageClient,
  isConnectionError,
  type Connection,
  type DiscoveredProvider,
  type PageClient,
  type PageClientWindow
} from '../src/testing/pageClient'

export interface DemoElement {
  textContent: string | null
  value?: string
  disabled?: boolean
  addEventListener(type: string, listener: () => void): void
}

export interface DemoDocument {
  getElementById(id: string): DemoElement | null
}

export const BUTTONS = [
  'describe',
  'connect',
  'getVersion',
  'isAuthenticated',
  'getPublicKey',
  'createAction',
  'disconnect'
] as const
export type DemoButton = (typeof BUTTONS)[number]

export const randomMarker = (rand: (n: number) => Uint8Array): string =>
  'BRIDGE-MARKER-' + Array.from(rand(6), b => b.toString(16).padStart(2, '0')).join('')

/** BRC-100 limits a description to 50 characters; the marker always wins over the label. */
/** Page client options from `?deadline=<ms>` (100 to 30000); anything else keeps the BRC-185 default. */
export function describeOptions(search: string | undefined): { describeDeadlineMs?: number } {
  const raw = new URLSearchParams(search ?? '').get('deadline')
  const ms = raw === null ? NaN : Number(raw)
  return Number.isFinite(ms) && ms >= 100 && ms <= 30000 ? { describeDeadlineMs: ms } : {}
}

export function actionDescription(label: string, marker: string): string {
  const trimmed = label.trim()
  const both = trimmed ? `${trimmed} ${marker}` : marker
  return both.length <= 50 ? both : marker.slice(0, 50)
}

const describeError = (e: unknown): string => {
  if (isConnectionError(e)) return `${e.code} (delivery ${e.delivery}): ${e.message}`
  if (e instanceof Error) return `${e.name}: ${e.message}`
  // A wallet error arrives as a plain { code, message } object, which String() would print as [object Object].
  if (typeof e === 'object' && e !== null) {
    const { code, message } = e as { code?: unknown; message?: unknown }
    if (typeof message === 'string') return typeof code === 'undefined' ? message : `${String(code)}: ${message}`
    return JSON.stringify(e)
  }
  return String(e)
}

export interface DemoOptions {
  doc: DemoDocument
  client: PageClient
  rand: (n: number) => Uint8Array
  now?: () => Date
}

export function wireDemo({ doc, client, rand, now = () => new Date() }: DemoOptions) {
  let providers: DiscoveredProvider[] = []
  let connection: Connection | undefined
  const logEl = doc.getElementById('log')

  const log = (kind: 'ok' | 'err' | 'info', text: string): void => {
    if (!logEl) return
    const stamp = now().toISOString().slice(11, 23)
    logEl.textContent = `${stamp} ${kind.toUpperCase()} ${text}\n${logEl.textContent ?? ''}`
  }

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

  const actions: Record<DemoButton, () => Promise<unknown>> = {
    async describe() {
      const found = await client.discover()
      providers = found.providers
      for (const r of found.rejected) log('err', `rejected announcement: ${r.reason}`)
      return found.providers.map(p => ({ continuityKey: p.descriptor.continuityKey, name: p.descriptor.name }))
    },
    async connect() {
      if (!providers.length) await actions.describe()
      // With two wallets announcing, the optional field picks the one whose name contains the text.
      const want = (doc.getElementById('wallet')?.value ?? '').trim().toLowerCase()
      const provider = want ? providers.find(p => p.descriptor.name.toLowerCase().includes(want)) : providers[0]
      if (!provider) throw new Error('no wallet announced')
      connection = await client.connect(provider, reason => log('info', `closed: ${reason}`))
      return { epoch: connection.epoch }
    },
    getVersion: () => client.invoke(need(), 'getVersion', {}),
    isAuthenticated: () => client.invoke(need(), 'isAuthenticated', {}),
    getPublicKey: () => client.invoke(need(), 'getPublicKey', { identityKey: true }),
    createAction() {
      const marker = randomMarker(rand)
      const label = doc.getElementById('description')?.value ?? ''
      const sats = Math.max(1, Math.floor(Number(doc.getElementById('satoshis')?.value) || 1))
      const description = actionDescription(label, marker)
      log('info', `createAction marker ${marker}`)
      return client.invoke(need(), 'createAction', {
        description,
        outputs: [{ lockingScript: '51', satoshis: sats, outputDescription: 'Demo output' }]
      })
    },
    async disconnect() {
      await need().disconnect()
      connection = undefined
      return undefined
    }
  }

  for (const name of BUTTONS) {
    doc.getElementById(name)?.addEventListener('click', () => void run(name, actions[name]))
  }
  log('info', `origin ${(globalThis as { location?: { origin?: string } }).location?.origin ?? '?'}`)
  return { run, actions }
}

if (typeof document !== 'undefined' && document.getElementById('demo-root')) {
  const w = window as unknown as PageClientWindow
  wireDemo({
    doc: document as unknown as DemoDocument,
    // `?deadline=<ms>` widens the describe deadline: with two wallets announcing at once on a loaded
    // Simulator the slower cold extension otherwise misses the 1000 ms budget (spike S2). Test tool only.
    client: createPageClient(w, describeOptions((w as unknown as { location: { search?: string } }).location.search)),
    rand: n => crypto.getRandomValues(new Uint8Array(n))
  })
}

/**
 * Entry of the demo bundle (build.mjs): starts the demo page logic and the shared Conformance panel on the real page
 * (the element `#demo-root` marks that page). Kept apart from demo.ts so jest can import the demo logic without
 * pulling in the vendored fast snippets.
 */
import { createController } from '../../expo-safari-wallet-bridge/demo/conformance/controller'
import { mountConformance } from '../../expo-safari-wallet-bridge/demo/conformance/ui'
import { createLoopbackPageClient, type LoopbackWindow, type TokenStore } from '../src/testing/loopbackPageClient'
import { wireDemo, type DemoDocument } from './demo'

/** localStorage when the page has it, else memory: a reload then simply forgets the pin and token. */
function tokenStore(): TokenStore {
  const memory = new Map<string, string>()
  return {
    getItem(k) {
      try {
        return window.localStorage.getItem(k)
      } catch {
        return memory.get(k) ?? null
      }
    },
    setItem(k, v) {
      try {
        window.localStorage.setItem(k, v)
      } catch {
        memory.set(k, v)
      }
    }
  }
}

if (typeof document !== 'undefined' && document.getElementById('demo-root')) {
  const w = window as unknown as LoopbackWindow & { location: { search?: string } }
  const store = tokenStore()
  let panel: ReturnType<typeof mountConformance>
  let log: ((kind: 'ok' | 'err' | 'info', text: string) => void) | undefined
  const controller = createController({ onChange: () => panel?.render(), onLog: (k, t) => log?.(k, t) })
  const demo = wireDemo({
    doc: document as unknown as DemoDocument,
    search: w.location.search,
    makeClient: settings =>
      createLoopbackPageClient(w, {
        scheme: settings.scheme,
        packageId: settings.packageId,
        ...(settings.fallbackUrl ? { fallbackUrl: settings.fallbackUrl } : {}),
        basePort: settings.basePort,
        window: settings.window,
        attemptTimeoutMs: settings.attemptTimeoutMs,
        fetch: (url, init) => window.fetch(url, init as RequestInit) as never,
        setTimeout: (fn, ms) => window.setTimeout(fn, ms),
        clearTimeout: t => window.clearTimeout(t),
        tokenStore: store
      }),
    rand: n => crypto.getRandomValues(new Uint8Array(n)),
    queryPermission: async name => {
      try {
        return (await navigator.permissions.query({ name } as unknown as PermissionDescriptor)).state
      } catch {
        return undefined
      }
    },
    conformance: controller as never
  })
  log = demo.log
  panel = mountConformance(document, controller, { userAgent: navigator.userAgent })
}

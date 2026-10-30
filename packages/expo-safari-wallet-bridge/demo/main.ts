/**
 * Entry of the demo bundle (build.mjs): starts the demo page logic and the Conformance panel on the real page (the
 * element `#demo-root` marks that page). Kept apart from demo.ts so jest can import the demo logic without pulling
 * in the vendored fast snippets.
 */
import { createPageClient, type PageClientWindow } from '../src/testing/pageClient'
import { createController } from './conformance/controller'
import { mountConformance } from './conformance/ui'
import { describeOptions, wireDemo, type DemoDocument } from './demo'

if (typeof document !== 'undefined' && document.getElementById('demo-root')) {
  const w = window as unknown as PageClientWindow
  let panel: ReturnType<typeof mountConformance>
  let log: ((kind: 'ok' | 'err' | 'info', text: string) => void) | undefined
  const controller = createController({ onChange: () => panel?.render(), onLog: (k, t) => log?.(k, t) })
  const demo = wireDemo({
    doc: document as unknown as DemoDocument,
    // `?deadline=<ms>` widens the describe deadline: with two wallets announcing at once on a loaded
    // Simulator the slower cold extension otherwise misses the 1000 ms budget (spike S2). Test tool only.
    client: createPageClient(w, describeOptions((w as unknown as { location: { search?: string } }).location.search)),
    rand: n => crypto.getRandomValues(new Uint8Array(n)),
    conformance: controller
  })
  log = demo.log
  panel = mountConformance(document, controller, { userAgent: navigator.userAgent })
}

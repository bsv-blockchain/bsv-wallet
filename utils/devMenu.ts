/**
 * Dev-only profiling controls. Imported for its side effect from app/_layout.tsx
 * in __DEV__. Adds entries to the expo-dev-client menu (shake the device, or
 * Cmd+D on iOS sim / Cmd+M on Android) so profiling data can be captured without
 * a JS REPL — everything prints to the Metro terminal.
 *
 * Also exposes the same helpers on globalThis for use from a connected JS
 * debugger console (e.g. `globalThis.perf.dump()`).
 */
import { perf } from '@/utils/perf'
import { setLoggingEnabled, isLoggingEnabled, setForwardWebViewLogs, shouldForwardWebViewLogs } from '@bsv/expo-wallet-toolbox'

if (__DEV__) {
  // globalThis fallbacks (callable from a connected JS debugger).
  const g = globalThis as any
  g.perf = perf
  g.setLoggingEnabled = setLoggingEnabled
  g.setForwardWebViewLogs = setForwardWebViewLogs

  // Register dev-menu buttons. Wrapped in try/catch + dynamic require so a
  // production/headless context (no dev client) never breaks.
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { registerDevMenuItems } = require('expo-dev-client')
    /**
     * Demo mode lives behind the same `__DEV__` gate as everything else here,
     * and is required by deep path rather than from the package barrel so it
     * never enters the production module graph. Also mirrored onto globalThis
     * so a connected debugger can drive it without the menu.
     */
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const demo = require('@bsv/expo-wallet-toolbox/core/demo') as typeof import('@bsv/expo-wallet-toolbox/core/demo')
    g.demo = demo
    registerDevMenuItems([
      {
        name: '📊 Perf: dump summary',
        callback: () => perf.dump()
      },
      {
        name: '🧹 Perf: reset buffer',
        callback: () => {
          perf.reset()
          console.log('[perf] buffer reset — reproduce the slow action, then dump')
        }
      },
      {
        name: '🔇 Toggle app logging',
        callback: () => {
          const next = !isLoggingEnabled()
          setLoggingEnabled(next)
          console.log(`[log] app logging ${next ? 'ON' : 'OFF'}`)
        }
      },
      {
        name: '🧪 Toggle demo mode (mock data)',
        callback: () => {
          const next = !demo.isDemoModeEnabled()
          demo.setDemoModeEnabled(next)
          console.log(`[demo] mock data ${next ? 'LOADED' : 'UNLOADED'}`)
        }
      },
      {
        name: '♻️ Reset demo data',
        callback: () => {
          demo.resetDemoLedger()
          console.log('[demo] ledger reset to its opening position')
        }
      },
      {
        name: '🌐 Toggle WebView log relay',
        callback: () => {
          const next = !shouldForwardWebViewLogs()
          setForwardWebViewLogs(next)
          console.log(`[log] WebView log relay ${next ? 'ON' : 'OFF'}`)
        }
      }
    ]).catch((e: unknown) => console.log('[devMenu] registration failed:', e))
  } catch (e) {
    console.log('[devMenu] expo-dev-client unavailable:', e)
  }
}

export {}

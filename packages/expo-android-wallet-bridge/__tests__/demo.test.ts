/** @jest-environment jsdom */
import fs from 'fs'
import path from 'path'
import '../../expo-safari-wallet-bridge/__tests__/jsdomPolyfills'

// The jsdom environment resolves the toolbox client's ESM browser build; the bundle uses this same shim.
jest.mock('@bsv/wallet-toolbox-client', () =>
  require('../../expo-safari-wallet-bridge/demo/conformance/shims/walletToolboxClient')
)
import { createController } from '../../expo-safari-wallet-bridge/demo/conformance/controller'
import { mountConformance } from '../../expo-safari-wallet-bridge/demo/conformance/ui'
import type { Card } from '../../expo-safari-wallet-bridge/demo/conformance/registry'
import { BUTTONS, classifyRejection, launchTarget, scanSettings, wireDemo, type DemoElement } from '../demo/demo'
import type { LoopbackPageClient } from '../src/testing/loopbackPageClient'

const KIT = path.resolve(__dirname, '..')

class FakeEl implements DemoElement {
  textContent: string | null = ''
  value?: string
  listeners: (() => void)[] = []
  constructor(value?: string) {
    this.value = value
  }
  addEventListener(_type: string, listener: () => void) {
    this.listeners.push(listener)
  }
  /** Fire the handlers and return without awaiting anything. */
  fire() {
    this.listeners.forEach(l => l())
  }
  async click() {
    this.fire()
    await new Promise(r => setTimeout(r, 0))
    await new Promise(r => setTimeout(r, 0))
  }
}

function setup(search?: string) {
  const els: Record<string, FakeEl> = {}
  for (const b of BUTTONS) els[b] = new FakeEl()
  els.log = new FakeEl()
  els.description = new FakeEl('Demo payment')
  els.satoshis = new FakeEl('1')
  els.port = new FakeEl('3321')
  els.timeout = new FakeEl('3000')
  const calls: [string, unknown][] = []
  const events: string[] = []
  const connection: any = { epoch: 'e', disconnect: jest.fn(async () => {}) }
  const provider: any = { descriptor: { continuityKey: 'k', name: 'W' } }
  const client = {
    launch: jest.fn(() => {
      events.push('launch')
      return { epoch: '12345678-aaaa' }
    }),
    discover: jest.fn(async () => ({ providers: [provider], rejected: [] })),
    connect: jest.fn(async () => connection),
    permission: jest.fn(async () => 'exempt'),
    elicit: jest.fn(async () => {}),
    invoke: jest.fn(async (_c: unknown, m: string, a: unknown) => {
      calls.push([m, a])
      return { ok: m }
    })
  } as unknown as LoopbackPageClient
  const makeClient = jest.fn((_s: unknown) => client)
  wireDemo({
    doc: { getElementById: (id: string) => els[id] ?? null },
    makeClient,
    search,
    rand: n => new Uint8Array(n).fill(0xab),
    queryPermission: async name => (name === 'loopback-network' ? 'granted' : undefined)
  })
  return { els, calls, client, connection, makeClient, events }
}

describe('Android demo page', () => {
  it('demo wires every button to the loopback client', async () => {
    const { els, calls, client, connection, makeClient } = setup()
    await els.open.click()
    expect(client.launch).toHaveBeenCalledTimes(1)
    expect(client.discover).toHaveBeenCalledTimes(1)
    await els.describe.click()
    expect(client.discover).toHaveBeenCalledTimes(2)
    await els.connect.click()
    expect(client.connect).toHaveBeenCalledTimes(1)
    await els.getVersion.click()
    await els.isAuthenticated.click()
    await els.getPublicKey.click()
    await els.createAction.click()
    expect(calls.map(c => c[0])).toEqual(['getVersion', 'isAuthenticated', 'getPublicKey', 'createAction'])
    expect(calls[2][1]).toEqual({ identityKey: true })
    await els.permission.click()
    expect(els.log.textContent).toMatch(
      /OK permission -> .*"loopback-network":"granted".*"local-network-access":"unknown name".*"summary":"exempt"/
    )
    await els.disconnect.click()
    expect(connection.disconnect).toHaveBeenCalledTimes(1)
    expect(els.log.textContent).toMatch(/OK getVersion/)
    await els.getVersion.click()
    expect(els.log.textContent).toMatch(/ERR getVersion -> Error: not connected/)
    expect(makeClient).toHaveBeenCalledTimes(1)
  })

  it('Open wallet performs navigation only from a click handler with nothing awaited before it', () => {
    const { els, client, events } = setup()
    els.open.fire() // synchronous: no microtask has run when it returns
    expect(client.launch).toHaveBeenCalledTimes(1)
    expect(events).toEqual(['launch'])
    // and no other button navigates
    const src = fs.readFileSync(path.join(KIT, 'demo', 'demo.ts'), 'utf8')
    expect(src.match(/\.launch\(\)/g)).toHaveLength(1)
    const openBody = /open\(\) \{([\s\S]*?)\n    \},/.exec(src)![1]
    expect(openBody).not.toMatch(/await/)
    expect(openBody.indexOf('launch()')).toBeGreaterThan(-1)
  })

  it('query overrides change the launch target', () => {
    expect(launchTarget(undefined)).toEqual({ scheme: 'bsv-wallet-bridge', packageId: 'org.bsvblockchain.wallet' })
    expect(launchTarget('?scheme=dbg-scheme&package=org.example.dbg&fallback=https%3A%2F%2Fx.test%2Fp')).toEqual({
      scheme: 'dbg-scheme',
      packageId: 'org.example.dbg',
      fallbackUrl: 'https://x.test/p'
    })
    const { els, makeClient } = setup('?scheme=dbg&package=org.example.dbg')
    els.open.fire()
    expect(makeClient).toHaveBeenCalledWith(
      expect.objectContaining({ scheme: 'dbg', packageId: 'org.example.dbg', basePort: 3321, window: 64 })
    )
  })

  it('port window and timeout fields set the scan, clamped to 3321 to 3384', () => {
    expect(scanSettings('3321', '3000')).toEqual({ basePort: 3321, window: 64, attemptTimeoutMs: 3000 })
    expect(scanSettings('3330', '500')).toEqual({ basePort: 3330, window: 55, attemptTimeoutMs: 500 })
    expect(scanSettings('9999', '1')).toEqual({ basePort: 3321, window: 64, attemptTimeoutMs: 3000 })
    expect(scanSettings(undefined, undefined)).toEqual({ basePort: 3321, window: 64, attemptTimeoutMs: 3000 })
  })

  it('the log tells blocked, absent, refused and unauthenticated apart', () => {
    const labels = ['blocked', 'wallet did not open', 'refused: bad proof', 'unauthenticated'].map(classifyRejection)
    expect(labels.map(l => l.split(':')[0])).toEqual(['BLOCKED', 'ABSENT', 'REFUSED', 'UNAUTHENTICATED'])
  })

  it('createAction button sends the marker in the description', async () => {
    const { els, calls } = setup()
    await els.open.click()
    await els.connect.click()
    await els.createAction.click()
    const args = calls.find(c => c[0] === 'createAction')![1] as { description: string }
    expect(args.description).toBe('Demo payment BRIDGE-MARKER-abababababab')
    expect(els.log.textContent).toContain('BRIDGE-MARKER-abababababab')
  })

  it('conformance panel mounts on #demo-root and Run all safe skips spending cards', async () => {
    const html = fs.readFileSync(path.join(KIT, 'demo', 'index.html'), 'utf8')
    document.documentElement.innerHTML = html.replace(/<script[\s\S]*?<\/script>/g, '')
    expect(document.getElementById('demo-root')).not.toBeNull()
    expect(document.getElementById('conformance')).not.toBeNull()
    for (const b of BUTTONS) expect(document.getElementById(b)).not.toBeNull()
    for (const f of ['port', 'timeout', 'log']) expect(document.getElementById(f)).not.toBeNull()

    const ran: string[] = []
    const cards: Card[] = [
      { id: 'safe', title: 'safe', group: 'conformance', explanation: 'x', run: async () => void ran.push('safe') },
      {
        id: 'spend',
        title: 'spend',
        group: 'funded',
        explanation: 'x',
        spending: 'Spends sats.',
        run: async () => void ran.push('spend')
      }
    ]
    let ui: ReturnType<typeof mountConformance>
    const ctl = createController({ cards, onChange: () => ui?.render() })
    ui = mountConformance(document, ctl, { confirm: () => true, clipboard: { writeText: async () => {} } })
    expect(ui).toBeDefined()
    ctl.setConnection({ invoke: jest.fn() } as never, { epoch: 'e', provider: { descriptor: { name: 'W' } } } as never)
    ;(document.querySelector('#cf-run-all') as HTMLElement).click()
    await new Promise(r => setTimeout(r, 0))
    expect(ran).toEqual(['safe'])
    expect(document.querySelector('[data-card="spend"] .cf-st')!.textContent).toBe('-')
  })

  it('demo bundle is excluded from package files and host-facing code', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(KIT, 'package.json'), 'utf8'))
    const files: string[] = pkg.files
    expect(files.some(f => f === 'demo' || f.startsWith('demo/'))).toBe(false)
    expect(files.some(f => f.startsWith('.build') && !f.startsWith('!'))).toBe(false)
    for (const dir of ['src', 'plugin']) {
      const full = path.join(KIT, dir)
      for (const f of fs.readdirSync(full, { recursive: true }).map(x => path.join(full, String(x)))) {
        if (!fs.statSync(f).isFile() || f.includes(`${path.sep}testing${path.sep}`)) continue
        expect(fs.readFileSync(f, 'utf8')).not.toMatch(/\.\.\/demo|\/demo\//)
      }
    }
  })
})

/** @jest-environment node */
import fs from 'fs'
import os from 'os'
import path from 'path'
import { BUTTONS, actionDescription, wireDemo, type DemoElement } from '../demo/demo'
import type { PageClient } from '../src/testing/pageClient'
import { buildExtension } from '../plugin/buildExtension'
import { deriveIds } from '../plugin/ids'

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
  async click() {
    this.listeners.forEach(l => l())
    await new Promise(r => setTimeout(r, 0))
    await new Promise(r => setTimeout(r, 0))
  }
}

function setup() {
  const els: Record<string, FakeEl> = {}
  for (const b of BUTTONS) els[b] = new FakeEl()
  els.log = new FakeEl()
  els.description = new FakeEl('Demo payment')
  els.satoshis = new FakeEl('1')
  const calls: [string, unknown][] = []
  const connection: any = { epoch: 'e', disconnect: jest.fn(async () => {}) }
  const provider: any = { descriptor: { continuityKey: 'k', name: 'W' } }
  const client = {
    discover: jest.fn(async () => ({ providers: [provider], rejected: [] })),
    connect: jest.fn(async () => connection),
    invoke: jest.fn(async (_c: unknown, m: string, a: unknown) => {
      calls.push([m, a])
      return { ok: m }
    })
  } as unknown as PageClient
  wireDemo({
    doc: { getElementById: (id: string) => els[id] ?? null },
    client,
    rand: n => new Uint8Array(n).fill(0xab)
  })
  return { els, calls, client, connection }
}

describe('demo page', () => {
  it('demo wires every button to the page client', async () => {
    const { els, calls, client, connection } = setup()
    await els.describe.click()
    expect(client.discover).toHaveBeenCalledTimes(1)
    await els.connect.click()
    expect(client.connect).toHaveBeenCalledTimes(1)
    await els.getVersion.click()
    await els.isAuthenticated.click()
    await els.getPublicKey.click()
    await els.createAction.click()
    expect(calls.map(c => c[0])).toEqual(['getVersion', 'isAuthenticated', 'getPublicKey', 'createAction'])
    expect(calls[2][1]).toEqual({ identityKey: true })
    await els.disconnect.click()
    expect(connection.disconnect).toHaveBeenCalledTimes(1)
    expect(els.log.textContent).toMatch(/OK getVersion/)
    await els.getVersion.click()
    expect(els.log.textContent).toMatch(/ERR getVersion -> Error: not connected/)
  })

  it('createAction button sends the marker in the description', async () => {
    const { els, calls } = setup()
    await els.connect.click()
    await els.createAction.click()
    const args = calls.find(c => c[0] === 'createAction')![1] as { description: string }
    expect(args.description).toBe('Demo payment BRIDGE-MARKER-abababababab')
    expect(els.log.textContent).toContain('BRIDGE-MARKER-abababababab')
    expect(actionDescription('x'.repeat(60), 'BRIDGE-MARKER-abababababab')).toBe('BRIDGE-MARKER-abababababab')
  })

  it('demo bundle is excluded from package.json files, the extension Resources and the host', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(KIT, 'package.json'), 'utf8'))
    const files: string[] = pkg.files
    expect(Array.isArray(files)).toBe(true)
    expect(files.some(f => f === 'demo' || f.startsWith('demo/'))).toBe(false)
    expect(files.some(f => f.startsWith('.build') && !f.startsWith('!'))).toBe(false)

    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'safari-bridge-demo-'))
    buildExtension({
      outDir,
      profile: 'release',
      allowLocalhostHttp: undefined,
      ids: deriveIds('org.bsvblockchain.wallet'),
      bundleId: 'org.bsvblockchain.wallet',
      extensionName: 'Bitcoin SV Wallet'
    })
    const names = fs.readdirSync(outDir)
    expect(names.some(n => /demo/i.test(n))).toBe(false)
    for (const n of names.filter(n => /\.(js|json|html)$/.test(n))) {
      expect(fs.readFileSync(path.join(outDir, n), 'utf8')).not.toContain('BRIDGE-MARKER')
    }

    // host-facing code (plugin, module, src entry) never refers to the demo directory
    const hostFacing = ['plugin', 'src', 'ios', 'app.plugin.js']
      .flatMap(p => {
        const full = path.join(KIT, p)
        return fs.statSync(full).isDirectory()
          ? fs.readdirSync(full, { recursive: true }).map(f => path.join(full, String(f)))
          : [full]
      })
      .filter(f => fs.statSync(f).isFile())
    for (const f of hostFacing) expect(fs.readFileSync(f, 'utf8')).not.toMatch(/\.\.\/demo|\/demo\//)
  })
})

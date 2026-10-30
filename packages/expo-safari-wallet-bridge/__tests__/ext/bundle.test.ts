/** @jest-environment node */
import fs from 'fs'
import os from 'os'
import path from 'path'
import vm from 'vm'
import { buildExtension } from '../../plugin/buildExtension'
import { deriveIds } from '../../plugin/ids'
import { FakeWindow, tick } from './chain'

const B = 'org.bsvblockchain.wallet'
const build = (injection?: 'main-world' | 'script-tag') => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'safari-bridge-inject-'))
  const r = buildExtension({
    outDir,
    profile: 'release',
    allowLocalhostHttp: undefined,
    ids: deriveIds(B),
    bundleId: B,
    extensionName: 'Bitcoin SV Wallet',
    ...(injection ? { injection } : {})
  })
  return { outDir, manifest: r.manifest }
}

/** Runs a built page-world bundle the way the browser would: as a script whose global is the window. */
function runInPage(code: string, win: FakeWindow, extra: Record<string, unknown> = {}) {
  const sandbox: Record<string, unknown> = {
    window: win,
    crypto: globalThis.crypto,
    TextEncoder,
    TextDecoder,
    setTimeout,
    clearTimeout,
    console,
    ...extra
  }
  vm.runInNewContext(code, sandbox)
}

const announce = (win: FakeWindow, requestId: string) =>
  new Promise<any>(resolve => {
    win.addEventListener('brc185:announce-provider', e => resolve(e.detail))
    win.dispatchEvent(new CustomEvent('brc185:request-provider', { detail: { version: 1, requestId } }))
  })

describe('page-world entry', () => {
  it('the built MAIN-world bundle announces a frozen handle with exactly three members', async () => {
    const { outDir, manifest } = build()
    expect(manifest.content_scripts[1]).toMatchObject({ js: ['provider-main.js'], world: 'MAIN' })
    const win = new FakeWindow('https://app.example/')
    runInPage(fs.readFileSync(path.join(outDir, 'provider-main.js'), 'utf8'), win)
    const detail = await announce(win, '11111111-1111-4111-8111-aaaaaaaaaaaa')
    expect(Object.isFrozen(detail.handle)).toBe(true)
    expect(Object.keys(detail.handle).sort()).toEqual(['connect', 'describe', 'disconnect'])
    expect('CWI' in win).toBe(false)
    await tick(5)
  })

  it('the <script src> fallback produces the same handle behaviour', async () => {
    const { outDir, manifest } = build('script-tag')
    // The MAIN-world entry is replaced by an isolated one, and the page script is web-accessible.
    expect(manifest.content_scripts.map((s: any) => s.js)).toEqual([['content.js'], ['inject-fallback.js']])
    expect(manifest.content_scripts.every((s: any) => s.world === undefined)).toBe(true)
    expect(manifest.web_accessible_resources).toEqual([{ resources: ['provider-main.js'], matches: ['https://*/*'] }])

    // The isolated fallback script adds a <script src> ...
    const added: Array<{ src: string }> = []
    const doc = {
      createElement: () => ({ src: '', onload: null as (() => void) | null }),
      documentElement: { appendChild: (n: { src: string }) => added.push(n) }
    }
    const win = new FakeWindow('https://app.example/')
    runInPage(fs.readFileSync(path.join(outDir, 'inject-fallback.js'), 'utf8'), win, {
      document: doc,
      browser: { runtime: { getURL: (p: string) => `safari-web-extension://abc/${p}` } }
    })
    expect(added.map(a => a.src)).toEqual(['safari-web-extension://abc/provider-main.js'])
    // ... which the page then loads: the same bundle, the same handle.
    runInPage(fs.readFileSync(path.join(outDir, 'provider-main.js'), 'utf8'), win)
    const detail = await announce(win, '11111111-1111-4111-8111-bbbbbbbbbbbb')
    expect(Object.isFrozen(detail.handle)).toBe(true)
    expect(Object.keys(detail.handle).sort()).toEqual(['connect', 'describe', 'disconnect'])
    await tick(5)
  })
})

describe('extension modules', () => {
  const walk = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
      const p = path.join(dir, e.name)
      return e.isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : []
    })

  it('no network request is made by any extension module', () => {
    const files = [
      ...walk(path.join(__dirname, '../../extension/src')),
      path.join(__dirname, '../../src/testing/pageClient.ts')
    ]
    expect(files.length).toBeGreaterThan(15)
    for (const file of files) {
      const text = fs
        .readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '')
      expect({
        file,
        hit: /\b(fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon|importScripts)\b/.exec(text)?.[0]
      }).toEqual({
        file,
        hit: undefined
      })
    }
  })

  it('the built bundles import no app code and no error codec', () => {
    const { outDir } = build()
    for (const f of ['background.js', 'content.js', 'provider-main.js', 'inject-fallback.js', 'popup.js']) {
      const text = fs.readFileSync(path.join(outDir, f), 'utf8')
      expect(text).not.toContain('__DEV__')
      expect(text).not.toContain('errorCodec')
      expect(text).not.toMatch(/node_modules\/(react-native|expo)|require\(["']react-native["']\)/)
    }
  })
})

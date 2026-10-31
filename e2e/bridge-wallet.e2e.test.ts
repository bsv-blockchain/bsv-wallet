/**
 * End-to-end: Chromium drives the critical journeys against the real modules.
 *
 * Onboarding, restore, the testnet receive address and settings are HTTP calls
 * into mnemonic / address code running in this process. Connect, identity and
 * pay go through the real BRC-185 loopback router and the Android page client
 * bundled into the page — the same client the browser bridge uses. Approving
 * the sheet resolves the parked wallet call. Nothing is broadcast and fetch
 * from this process is rejected.
 */
jest.mock(
  'expo-secure-store',
  () => require('../packages/expo-wallet-toolbox/__tests__/__mocks__/secureStoreFake').fake
)
jest.mock('@bsv/sdk', () => {
  const actual = jest.requireActual('@bsv/sdk')
  return { ...actual, createPublicHTTPSFetch: jest.fn() }
})

import http from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import AsyncStorage from '@react-native-async-storage/async-storage'
import * as esbuild from 'esbuild'
import * as SecureStore from 'expo-secure-store'
import { chromium, type Browser, type Page } from 'playwright'
import { PrivateKey } from '@bsv/sdk'
import {
  generateMnemonicWallet,
  recoverMnemonicWallet,
  type MnemonicWalletResult
} from '../packages/expo-wallet-toolbox/core/mnemonicWallet'
import { configureToolbox, resetToolboxConfig } from '../packages/expo-wallet-toolbox/core/toolboxConfig'
import { addressNetwork } from '../packages/expo-wallet-toolbox/core/pay/rails'
import {
  createConsentStore,
  type ConsentStore,
  type KeyValue
} from '../packages/expo-wallet-toolbox/core/bridge/consent'
import { createDispatcher, dispatch, installDispatcher } from '../packages/expo-wallet-toolbox/core/bridge/dispatcher'
import { answerConnection, setConsentSheetSource } from '../packages/expo-wallet-toolbox/core/bridge/consentSheetSource'
import { parseLaunchUri } from '../packages/expo-wallet-toolbox/core/bridge/loopback/launchProof'
import type { RoutePlan } from '../packages/expo-wallet-toolbox/core/bridge/loopback'
import {
  attachBridgeHost,
  getBindingRegistry,
  getBridgeSnapshot,
  initBridgeRuntime,
  publish,
  registerConsentWithdrawal,
  registerTransport,
  resetBridgeRuntimeForTests
} from '../packages/expo-wallet-toolbox/core/bridge/runtime'
import {
  makeHarness,
  type Harness
} from '../packages/expo-wallet-toolbox/__tests__/bridge/loopback/helpers/routerHarness'

const ADMIN = 'admin.wallet'
const TXID = '11'.repeat(32)

function memoryKv(): KeyValue {
  const data = new Map<string, string>()
  return {
    getItem: async k => data.get(k) ?? null,
    setItem: async (k, v) => void data.set(k, v),
    removeItem: async k => void data.delete(k),
    getAllKeys: async () => [...data.keys()]
  }
}

function fakeAdminWallet() {
  const mac = (data: number[]) => {
    let h = 1
    const out: number[] = []
    for (let i = 0; i < 32; i++) {
      for (const b of data) h = (h * 31 + b + i) >>> 0
      out.push(h & 255)
    }
    return out
  }
  return {
    createHmac: async (args: { data: number[] }) => ({ hmac: mac(args.data) }),
    verifyHmac: async (args: { data: number[]; hmac: number[] }) => {
      const expected = mac(args.data)
      if (expected.some((b, i) => b !== args.hmac[i])) throw new Error('HMAC is not valid')
      return { valid: true as const }
    }
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function headersOf(req: IncomingMessage): [string, string][] {
  const out: [string, string][] = []
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue
    for (const v of Array.isArray(value) ? value : [value]) out.push([name, v])
  }
  return out
}

function json(res: ServerResponse, status: number, body: unknown) {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(text)
}

async function settle(plan: RoutePlan) {
  return plan.kind === 'respond' ? plan : plan.settled
}

function intentToLaunch(intent: string) {
  const hash = intent.indexOf('#')
  const before = hash === -1 ? intent : intent.slice(0, hash)
  if (!before.startsWith('intent://')) return undefined
  return parseLaunchUri(`bsv-browser://${before.slice('intent://'.length)}`, 'bsv-browser')
}

async function waitForText(page: Page, testId: string): Promise<string> {
  try {
    await page.waitForFunction(
      (id: string) => (document.querySelector(`[data-testid="${id}"]`)?.textContent ?? '').trim().length > 0,
      testId,
      { timeout: 20000 }
    )
  } catch (err) {
    const status = await page.getByTestId('status').innerText()
    const errors = (page as unknown as { __errors?: string[] }).__errors ?? []
    throw new Error(
      `timed out waiting for ${testId}\nstatus: ${status}\npage errors: ${errors.join(' | ')}\n${err instanceof Error ? err.message : String(err)}`
    )
  }
  return (await page.getByTestId(testId).innerText()).trim()
}

describe('browser journeys', () => {
  const fetchSpy = jest.spyOn(global, 'fetch').mockRejectedValue(new Error('network disabled in tests'))
  let browser: Browser
  let page: Page
  let server: http.Server
  let port = 0
  let detachHost: () => void = () => {}
  let walletState: MnemonicWalletResult | undefined
  const calls: { options?: { noSend?: boolean }; outputs?: { satoshis?: number }[] }[] = []

  beforeAll(async () => {
    const built = await esbuild.build({
      absWorkingDir: process.cwd(),
      entryPoints: [path.join(process.cwd(), 'e2e/browser/page.ts')],
      bundle: true,
      write: false,
      format: 'iife',
      platform: 'browser',
      target: 'es2022',
      logLevel: 'silent'
    })
    const pageJs = built.outputFiles?.[0]?.text
    if (!pageJs) throw new Error('esbuild produced no page bundle')
    const html = fs.readFileSync(path.join(process.cwd(), 'e2e/browser/index.html'), 'utf8')

    ;(globalThis as { __DEV__?: boolean }).__DEV__ = true
    configureToolbox({ backupUrl: null, browserBridge: { allowLocalhostHttp: true } })

    await AsyncStorage.clear()
    ;(SecureStore as unknown as { __reset: () => void }).__reset()
    resetBridgeRuntimeForTests()
    await initBridgeRuntime()
    detachHost = attachBridgeHost({ withdrawPrompts: jest.fn() })
    const consent: ConsentStore = createConsentStore({
      storage: memoryKv(),
      adminWallet: fakeAdminWallet() as never,
      adminOriginator: ADMIN,
      profileKey: () => '',
      now: () => Date.now(),
      randomBytes: n => globalThis.crypto.getRandomValues(new Uint8Array(n))
    })
    registerConsentWithdrawal(() => consent.withdrawAll())
    registerTransport({
      id: 'android-loopback',
      attestation: 'unattested',
      bindingMode: 'explicit',
      requestAttention: () => {},
      deliverReconnectToken: () => {}
    })
    installDispatcher(createDispatcher({ consent, noteChanged: jest.fn() }))
    setConsentSheetSource({
      store: consent,
      context: () => ({ walletRevision: Number(getBridgeSnapshot().walletRevision), profileKey: '' })
    })
    const bridgeWallet = {
      getPublicKey: async () => {
        if (!walletState) throw new Error('no wallet')
        return { publicKey: walletState.identityKey }
      },
      createAction: async (args: (typeof calls)[number]) => {
        calls.push(args)
        return { txid: TXID }
      },
      getHeight: async () => ({ height: 1 }),
      createSignature: async () => ({ signature: [1] })
    }
    publish({
      attestedManager: { wallet: bridgeWallet as never, signing: {} as never },
      unverifiedManager: { wallet: bridgeWallet as never, signing: {} as never },
      readiness: 'ready',
      network: 'test',
      accountContext: 'e2e'
    })

    const harness: Harness = makeHarness({ registry: getBindingRegistry() })
    harness.state.allowLocalhostHttp = true
    harness.state.readiness = 'go'
    const snap = getBridgeSnapshot()
    harness.state.snapshot = { accountContext: snap.accountContext, walletRevision: snap.walletRevision }
    harness.state.dispatch = dispatch

    let seq = 0
    server = http.createServer(async (req, res) => {
      try {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        if (req.method === 'GET' && url.pathname === '/') {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
          res.end(html)
          return
        }
        if (req.method === 'GET' && url.pathname === '/page.js') {
          res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' })
          res.end(pageJs)
          return
        }
        if (req.method === 'POST' && url.pathname === '/__test/create-wallet') {
          walletState = generateMnemonicWallet()
          json(res, 200, { words: walletState.mnemonic.split(/\s+/), identityKey: walletState.identityKey })
          return
        }
        if (req.method === 'POST' && url.pathname === '/__test/restore') {
          const body = JSON.parse(await readBody(req)) as { mnemonic?: string }
          const restored = recoverMnemonicWallet(body.mnemonic ?? '')
          json(res, 200, { identityKey: restored.identityKey })
          return
        }
        if (req.method === 'GET' && url.pathname === '/__test/receive') {
          if (!walletState) {
            json(res, 409, { error: 'create a wallet first' })
            return
          }
          const address = new PrivateKey(walletState.primaryKey).toPublicKey().toAddress('testnet')
          const network = addressNetwork(address)
          if (network !== 'test') {
            json(res, 500, { error: `expected a testnet address, got ${network}` })
            return
          }
          json(res, 200, { address, network })
          return
        }
        if (req.method === 'GET' && url.pathname === '/__test/settings') {
          json(res, 200, { network: 'test', broadcasts: false })
          return
        }
        if (req.method === 'GET' && url.pathname === '/__test/pending') {
          json(
            res,
            200,
            consent.listPending().map(p => ({ requestId: p.requestId, origin: p.origin }))
          )
          return
        }
        if (req.method === 'POST' && url.pathname === '/__test/approve') {
          const body = JSON.parse(await readBody(req)) as { requestId?: string }
          await answerConnection(body.requestId ?? '', true)
          json(res, 200, { ok: true })
          return
        }
        if (req.method === 'GET' && url.pathname === '/__test/calls') {
          const last = calls[calls.length - 1]
          json(res, 200, { noSend: last?.options?.noSend === true, satoshis: last?.outputs?.[0]?.satoshis ?? null })
          return
        }
        if (req.method === 'POST' && url.pathname === '/__test/launch') {
          const launch = intentToLaunch(await readBody(req))
          if (!launch) {
            res.writeHead(400, { 'content-type': 'text/plain' })
            res.end('intent was not a bsv-browser launch')
            return
          }
          harness.state.records.push({ epoch: launch.epoch, k: launch.k, n: launch.n })
          json(res, 200, { ok: true })
          return
        }

        const plan = await harness.handle({
          id: `e2e-${++seq}`,
          method: req.method ?? 'GET',
          target: `${url.pathname}${url.search}`,
          headers: headersOf(req),
          body: await readBody(req)
        })
        const settled = await settle(plan)
        const headers: Record<string, string | string[]> = {}
        for (const [name, value] of settled.headers) {
          const prev = headers[name]
          headers[name] = prev === undefined ? value : Array.isArray(prev) ? [...prev, value] : [prev, value]
        }
        res.writeHead(settled.status, headers)
        res.end(settled.body)
      } catch (e) {
        if (res.headersSent) return
        res.writeHead(500, { 'content-type': 'text/plain' })
        res.end(e instanceof Error ? (e.stack ?? e.message) : String(e))
      }
    })

    await new Promise<void>(resolve => {
      server.listen(0, '127.0.0.1', () => resolve())
    })
    const addr = server.address()
    if (addr === null || typeof addr === 'string') throw new Error('test server has no port')
    port = addr.port
    harness.state.bound = { port, ipv4: true, ipv6: true }

    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage']
    })
    page = await browser.newPage()
    const errors: string[] = []
    page.on('pageerror', err => errors.push(err.message))
    page.on('console', msg => {
      if (msg.type() === 'error') errors.push(msg.text())
    })
    await page.goto(`http://localhost:${port}/?port=${port}`)
    ;(page as unknown as { __errors?: string[] }).__errors = errors
  }, 120000)

  afterAll(async () => {
    await browser?.close()
    await new Promise<void>(resolve => server?.close(() => resolve()))
    setConsentSheetSource(undefined)
    installDispatcher(undefined)
    detachHost()
    resetBridgeRuntimeForTests()
    resetToolboxConfig()
    fetchSpy.mockRestore()
  })

  test('create, restore, receive, settings, then approve a bridged payment', async () => {
    const errors = (page as unknown as { __errors?: string[] }).__errors ?? []

    await page.getByRole('button', { name: 'Create wallet' }).click()
    const identity = await waitForText(page, 'identity')
    const mnemonic = await waitForText(page, 'mnemonic')
    expect(mnemonic.split(/\s+/)).toHaveLength(12)
    expect(identity.length).toBeGreaterThan(32)

    await page.getByRole('button', { name: 'Restore wallet' }).click()
    expect(await waitForText(page, 'restored')).toBe(identity)

    await page.getByRole('button', { name: 'Show receive address' }).click()
    const address = await waitForText(page, 'address')
    expect(address.length).toBeGreaterThan(20)
    expect(await waitForText(page, 'address-network')).toBe('test')

    await page.getByRole('button', { name: 'Settings' }).click()
    expect(await waitForText(page, 'settings-out')).toBe('test broadcasts off')

    await page.getByRole('button', { name: 'Connect site' }).click()
    expect(await waitForText(page, 'connected')).toBe('connected')

    await page.getByRole('button', { name: 'Request identity' }).click()
    await page.getByRole('button', { name: 'Approve' }).click()
    expect(await waitForText(page, 'bridge-identity')).toBe(identity)

    await page.getByRole('button', { name: 'Pay 1 sat' }).click()
    const payStarted = Date.now()
    let txid = ''
    while (Date.now() - payStarted < 20000) {
      txid = (await page.getByTestId('txid').innerText()).trim()
      if (txid) break
      const problem = (await page.getByTestId('status').innerText()).trim()
      if (problem) throw new Error(problem)
      const approveAgain = page.getByRole('button', { name: 'Approve' })
      if ((await approveAgain.count()) > 0 && (await approveAgain.first().isVisible())) {
        await approveAgain.first().click()
      }
      await page.waitForTimeout(200)
    }
    expect(txid).toBe(TXID)
    expect(await waitForText(page, 'nosend')).toBe('noSend')
    expect(calls[0]?.outputs?.[0]?.satoshis).toBe(1)
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(errors).toEqual([])
    expect(await page.getByTestId('status').innerText()).toBe('')
  }, 120000)
})

jest.mock('expo-secure-store', () => require('../__mocks__/secureStoreFake').fake)
jest.mock('@bsv/sdk', () => {
  const actual = jest.requireActual('@bsv/sdk')
  return { ...actual, createPublicHTTPSFetch: jest.fn() }
})

import AsyncStorage from '@react-native-async-storage/async-storage'
import * as SecureStore from 'expo-secure-store'
import { Hash } from '@bsv/sdk'
import type { Binding } from '../../core/bridge/bindings'
import { createConsentStore, type ConsentStore, type KeyValue } from '../../core/bridge/consent'
import { createDispatcher, dispatch, installDispatcher, type Outcome } from '../../core/bridge/dispatcher'
import { answerConnection, setConsentSheetSource } from '../../core/bridge/consentSheetSource'
import { b64uEncode } from '../../core/bridge/protocol/base64url'
import {
  DEFAULT_UNVERIFIED_SEEK_FLAGS,
  DEFAULT_VERIFIED_SEEK_FLAGS,
  effectiveUnverified
} from '../../core/bridge/permissionPolicy'
import { buildUnverifiedPermissionsManager } from '../../core/bridge/unverifiedManager'
import { isUnattestedOriginator } from '../../core/bridge/unverifiedOriginator'
import {
  attachBridgeHost,
  getBindingRegistry,
  getBridgeSnapshot,
  initBridgeRuntime,
  publish,
  registerConsentWithdrawal,
  registerTransport,
  resetBridgeRuntimeForTests
} from '../../core/bridge/runtime'

const ADMIN = 'admin.wallet'
const ORIGIN = 'https://example.com'
const TXID = 'ab'.repeat(32)
const CREATE_ACTION = {
  description: 'Golden action',
  outputs: [{ lockingScript: '51', satoshis: 1, outputDescription: 'Golden output' }],
  options: { noSend: true, returnTXIDOnly: true }
}

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
    createHmac: async (args: any) => ({ hmac: mac(args.data) }),
    verifyHmac: async (args: any) => {
      const expected = mac(args.data)
      if (expected.some((b, i) => b !== args.hmac[i])) throw new Error('HMAC is not valid')
      return { valid: true as const }
    }
  } as any
}

function fakeWallet() {
  return {
    createAction: jest.fn(async () => ({ txid: TXID })),
    getHeight: jest.fn(async () => ({ height: 800000 })),
    createSignature: jest.fn(async () => ({ signature: [1] }))
  }
}

const tick = () => new Promise(r => setTimeout(r, 0))
const connErr = (o: Outcome) => (o.ok === false && 'connectionError' in o ? o.connectionError : undefined)

let consent: ConsentStore
let attestedWallet: ReturnType<typeof fakeWallet>
let unverifiedWallet: ReturnType<typeof fakeWallet>
let attention: Array<[string, string]>
let delivered: Array<{ epoch: string; token: string }>
let nextEpoch = 0
let detachHost: () => void

/**
 * Stands in for project 4's loopback transport: it opens an explicit unattested binding with a
 * verified launch proof and passes along the reconnect token the page presented. The core checks it.
 */
async function pageConnects(token?: string): Promise<Binding> {
  return getBindingRegistry().connectExplicit({
    epoch: `epoch-${++nextEpoch}`,
    transportId: 'loopback',
    applicationOrigin: ORIGIN,
    attestation: 'unattested',
    instanceId: 'inst',
    continuityKey: 'ck',
    accountContext: getBridgeSnapshot().accountContext,
    walletRevision: getBridgeSnapshot().walletRevision,
    launchProofVerified: true,
    reconnectToken: token
  })
}

const send = (b: Binding, method: string, args: unknown = {}) =>
  dispatch({
    transport: 'loopback',
    request: {
      epoch: b.epoch,
      instanceId: 'inst',
      continuityKey: 'ck',
      origin: b.applicationOrigin,
      method,
      args,
      sizeBytes: 100
    }
  })

async function approveSheet(): Promise<void> {
  const pending = consent.listPending()
  expect(pending).toHaveLength(1)
  await answerConnection(pending[0].requestId, true)
}

beforeEach(async () => {
  await AsyncStorage.clear()
  ;(SecureStore as any).__reset()
  resetBridgeRuntimeForTests()
  attestedWallet = fakeWallet()
  unverifiedWallet = fakeWallet()
  attention = []
  delivered = []
  await initBridgeRuntime()
  detachHost = attachBridgeHost({ withdrawPrompts: jest.fn() })
  consent = createConsentStore({
    storage: memoryKv(),
    adminWallet: fakeAdminWallet(),
    adminOriginator: ADMIN,
    profileKey: () => '',
    now: () => Date.now(),
    randomBytes: n => globalThis.crypto.getRandomValues(new Uint8Array(n))
  })
  registerConsentWithdrawal(() => consent.withdrawAll())
  registerTransport({
    id: 'loopback',
    attestation: 'unattested',
    bindingMode: 'explicit',
    requestAttention: (reason, b) => attention.push([reason, b.epoch]),
    deliverReconnectToken: (b, token) => delivered.push({ epoch: b.epoch, token })
  })
  installDispatcher(createDispatcher({ consent, noteChanged: jest.fn() }))
  setConsentSheetSource({
    store: consent,
    context: () => ({ walletRevision: Number(getBridgeSnapshot().walletRevision), profileKey: '' })
  })
  publish({
    attestedManager: { wallet: attestedWallet as any, signing: {} as any },
    unverifiedManager: { wallet: unverifiedWallet as any, signing: {} as any },
    readiness: 'ready',
    network: 'main',
    accountContext: 'ctx'
  })
})

afterEach(() => {
  setConsentSheetSource(undefined)
  installDispatcher(undefined)
  detachHost()
})

describe('integration: unverified site over an explicit unattested transport with launch proof', () => {
  it('connect, park, approve, deliver, disconnect, reconnect with and without the token', async () => {
    // A binding without a verified launch proof is refused before it exists.
    expect(() =>
      getBindingRegistry().connectExplicit({
        epoch: 'no-proof',
        transportId: 'loopback',
        applicationOrigin: ORIGIN,
        attestation: 'unattested',
        instanceId: 'inst',
        continuityKey: 'ck',
        accountContext: 'ctx',
        walletRevision: getBridgeSnapshot().walletRevision
      })
    ).toThrow(expect.objectContaining({ code: 'CONFIGURATION_ERROR' }))

    // 1. First createAction parks on the connection sheet; nothing reaches either wallet.
    const first = await pageConnects()
    expect(first.launchProofVerified).toBe(true)
    expect(first.consented).toBe(false)
    const parked = send(first, 'createAction', CREATE_ACTION)
    await tick()
    expect(attention).toEqual([['consent', first.epoch]])
    expect(consent.listPending()).toMatchObject([{ origin: ORIGIN, attestation: 'unattested', connectedBefore: false }])
    expect(unverifiedWallet.createAction).not.toHaveBeenCalled()
    expect(attestedWallet.createAction).not.toHaveBeenCalled()

    // 2. Approved: the call runs on the unverified manager under the minted originator, and the
    // reconnect token reaches the transport once.
    await approveSheet()
    expect(await parked).toEqual({ ok: true, result: { txid: TXID } })
    const originator1 = (unverifiedWallet.createAction.mock.calls[0] as any[])[1] as string
    expect(isUnattestedOriginator(originator1)).toBe(true)
    expect(originator1.startsWith('example.com.g')).toBe(true)
    expect(attestedWallet.createAction).not.toHaveBeenCalled()
    expect(delivered).toHaveLength(1)
    expect(delivered[0].epoch).toBe(first.epoch)
    const token1 = delivered[0].token

    // 3. Disconnect, then reconnect with the token: no sheet, same originator.
    getBindingRegistry().close(first.epoch, 'disconnected')
    const second = await pageConnects(token1)
    expect(second.consented).toBe(false) // checked by the core at the first interactive request
    expect(await send(second, 'getHeight')).toEqual({ ok: true, result: { height: 800000 } })
    expect(second.consented).toBe(true)
    expect(consent.listPending()).toHaveLength(0)
    expect((unverifiedWallet.getHeight.mock.calls[0] as any[])[1]).toBe(originator1)
    expect(delivered).toHaveLength(1)

    // 4. Reconnect without the token (and with a wrong one): never silent; the sheet says "connected before".
    getBindingRegistry().close(second.epoch, 'disconnected')
    const wrong = await pageConnects(b64uEncode(new Uint8Array(32).fill(7)))
    const wrongSend = send(wrong, 'getHeight')
    await tick()
    expect(wrong.consented).toBe(false)
    expect(consent.listPending()).toMatchObject([{ origin: ORIGIN, attestation: 'unattested', connectedBefore: true }])
    expect(unverifiedWallet.getHeight).toHaveBeenCalledTimes(1)
    // Closing the page withdraws its request (no decline, so no backoff).
    getBindingRegistry().close(wrong.epoch, 'disconnected')
    expect(connErr(await wrongSend)).toMatchObject({ code: 'DISCONNECTED' })
    expect(consent.listPending()).toHaveLength(0)
    const third = await pageConnects()
    expect(third.consented).toBe(false)
    const reparked = send(third, 'getHeight')
    await tick()
    expect(consent.listPending()).toMatchObject([{ origin: ORIGIN, attestation: 'unattested', connectedBefore: true }])
    expect(unverifiedWallet.getHeight).toHaveBeenCalledTimes(1)
    await approveSheet()
    expect(await reparked).toEqual({ ok: true, result: { height: 800000 } })

    // 5. Approval starts fresh: new grant tag, new token, the old token no longer reconnects.
    const originator2 = (unverifiedWallet.getHeight.mock.calls[1] as any[])[1] as string
    expect(originator2).not.toBe(originator1)
    expect(delivered).toHaveLength(2)
    const token2 = delivered[1].token
    expect(token2).not.toBe(token1)
    const record = (await consent.lookup(ORIGIN, 'unattested'))!
    expect(record.originator).toBe(originator2)
    expect(consent.checkReconnect(record, token1)).toBe(false)
    expect(consent.checkReconnect(record, token2)).toBe(true)
    expect(record.reconnectHash).toBe(
      b64uEncode(Uint8Array.from(Hash.sha256(Array.from(Buffer.from(token2, 'base64url')))))
    )

    // 6. A permission token held under the old grant tag does not satisfy a protocol check under the new one.
    const flags = effectiveUnverified({
      verified: DEFAULT_VERIFIED_SEEK_FLAGS,
      unverified: DEFAULT_UNVERIFIED_SEEK_FLAGS
    })
    const underlying = fakeWallet()
    const pm = buildUnverifiedPermissionsManager(underlying as any, ADMIN, flags)
    ;(pm as any).findProtocolToken = async (originator: string) =>
      originator === originator1 ? { tx: [], txid: 'aa', outputIndex: 0 } : undefined
    ;(pm as any).isTokenExpired = () => false
    const prompts: any[] = []
    pm.bindCallback('onProtocolPermissionRequested', (r: any) => {
      prompts.push(r)
      void pm.denyPermission(r.requestID)
    })
    const args = { protocolID: [2, 'notes'], keyID: '1', counterparty: 'self', data: [1] } as any
    await pm.createSignature(args, originator1)
    expect(prompts).toHaveLength(0)
    await expect(pm.createSignature(args, originator2)).rejects.toThrow()
    expect(prompts).toHaveLength(1)
    expect(prompts[0].originator).toBe(originator2)
    expect(underlying.createSignature).toHaveBeenCalledTimes(1)
  })

  it('approving after a wrong token starts fresh: new grant tag, old token dead, token never on the binding', async () => {
    const first = await pageConnects()
    const p1 = send(first, 'getHeight')
    await tick()
    await approveSheet()
    await p1
    const originator1 = (unverifiedWallet.getHeight.mock.calls[0] as any[])[1] as string
    const token1 = delivered[0].token
    getBindingRegistry().close(first.epoch, 'disconnected')

    const wrong = await pageConnects(b64uEncode(new Uint8Array(32).fill(9)))
    expect(JSON.stringify(wrong)).not.toContain(b64uEncode(new Uint8Array(32).fill(9)))
    const p2 = send(wrong, 'getHeight')
    await tick()
    expect(consent.listPending()).toMatchObject([{ connectedBefore: true }])
    expect(unverifiedWallet.getHeight).toHaveBeenCalledTimes(1)
    await approveSheet()
    await p2
    expect(delivered).toHaveLength(2)
    const originator2 = (unverifiedWallet.getHeight.mock.calls[1] as any[])[1] as string
    expect(originator2).not.toBe(originator1)

    getBindingRegistry().close(wrong.epoch, 'disconnected')
    const stale = await pageConnects(token1)
    const p3 = send(stale, 'getHeight')
    await tick()
    expect(consent.listPending()).toHaveLength(1)
    getBindingRegistry().close(stale.epoch, 'disconnected')
    await p3
    const fresh = await pageConnects(delivered[1].token)
    expect(await send(fresh, 'getHeight')).toEqual({ ok: true, result: { height: 800000 } })
    expect((unverifiedWallet.getHeight.mock.calls[2] as any[])[1]).toBe(originator2)
    expect(consent.listPending()).toHaveLength(0)
  })

  it('a declined sheet is USER_CANCELLED and reaches no wallet', async () => {
    const b = await pageConnects()
    const p = send(b, 'createAction', CREATE_ACTION)
    await tick()
    await answerConnection(consent.listPending()[0].requestId, false)
    expect(connErr(await p)).toMatchObject({ code: 'USER_CANCELLED', delivery: 'not-sent' })
    expect(unverifiedWallet.createAction).not.toHaveBeenCalled()
    expect(delivered).toHaveLength(0)
  })
})

describe('integration: merged Connect sheet (preview, then mint)', () => {
  const GROUP = {
    basketAccess: [{ basket: 'notes', description: 'your notes' }],
    protocolPermissions: [{ protocolID: [2, 'notes'] as [2, string], description: 'notes' }]
  }
  let mint: jest.Mock
  let previewGroup: jest.Mock

  beforeEach(() => {
    mint = jest.fn(async () => {})
    previewGroup = jest.fn(async () => GROUP)
    consent = createConsentStore({
      storage: memoryKv(),
      adminWallet: fakeAdminWallet(),
      adminOriginator: ADMIN,
      profileKey: () => '',
      now: () => Date.now(),
      randomBytes: n => globalThis.crypto.getRandomValues(new Uint8Array(n)),
      mint
    })
    registerConsentWithdrawal(() => consent.withdrawAll())
    installDispatcher(createDispatcher({ consent, noteChanged: jest.fn(), previewGroup }))
    setConsentSheetSource({
      store: consent,
      context: () => ({ walletRevision: Number(getBridgeSnapshot().walletRevision), profileKey: '' })
    })
  })

  it('previews before the sheet, mints on Connect under the approved originator, then runs the call', async () => {
    const b = await pageConnects()
    const parked = send(b, 'createAction', CREATE_ACTION)
    await tick()
    expect(previewGroup).toHaveBeenCalledTimes(1)
    expect(consent.listPending()[0].groupPermissions).toEqual(GROUP)
    expect(mint).not.toHaveBeenCalled()
    await approveSheet()
    expect(await parked).toEqual({ ok: true, result: { txid: TXID } })
    const originator = (unverifiedWallet.createAction.mock.calls[0] as any[])[1] as string
    expect(mint).toHaveBeenCalledTimes(1)
    expect(mint).toHaveBeenCalledWith(originator, GROUP)
  })

  it('Dont connect mints nothing and the site stays unconnected', async () => {
    const b = await pageConnects()
    const parked = send(b, 'createAction', CREATE_ACTION)
    await tick()
    await answerConnection(consent.listPending()[0].requestId, false)
    expect(connErr(await parked)).toMatchObject({ code: 'USER_CANCELLED' })
    expect(mint).not.toHaveBeenCalled()
    expect(await consent.lookup(ORIGIN, 'unattested')).toBeUndefined()
  })

  it('a mint failure keeps the connection and the call still runs', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
    mint.mockRejectedValue(new Error('mint failed'))
    const b = await pageConnects()
    const parked = send(b, 'createAction', CREATE_ACTION)
    await tick()
    await approveSheet()
    expect(await parked).toEqual({ ok: true, result: { txid: TXID } })
    expect(await consent.lookup(ORIGIN, 'unattested')).toBeDefined()
    warn.mockRestore()
  })
})

jest.mock('expo-secure-store', () => require('../../expo-wallet-toolbox/__tests__/__mocks__/secureStoreFake').fake)

import AsyncStorage from '@react-native-async-storage/async-storage'
import * as SecureStore from 'expo-secure-store'
import { AppState } from 'react-native'
import { PrivateKey } from '@bsv/sdk'
import { createConsentStore, type ConsentStore, type KeyValue } from '@bsv/expo-wallet-toolbox/core/bridge/consent'
import { createDispatcher, dispatch, installDispatcher } from '@bsv/expo-wallet-toolbox/core/bridge/dispatcher'
import { runSessionTeardown, registerSessionTeardown } from '@bsv/expo-wallet-toolbox/core/context/sessionTeardown'
import {
  attachBridgeHost,
  getBindingRegistry,
  getBridgeSnapshot,
  getPermissionPolicy,
  initBridgeRuntime,
  isBridgeHostAttached,
  listConnectedSites,
  onConnectedSitesChange,
  onSnapshotChange,
  publish,
  registerTransport,
  resetBridgeRuntimeForTests,
  setActiveConsent,
  setPermissionPolicy
} from '@bsv/expo-wallet-toolbox/core/bridge/runtime'
import { createMirrorWriter, type MirrorWriter, type MirrorWriterDeps } from '../src/mirror'
import { createFakeNative, type FakeNative } from '../src/testing/fakeNative'
import { connectedHash, type Mirror } from '../shared/mirror'

const IDENTITY = new PrivateKey(7).toPublicKey().toString()
const tick = () => new Promise(r => setTimeout(r, 0))

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

let native: FakeNative
let consent: ConsentStore
let flush: jest.Mock
let writer: MirrorWriter | undefined
let detach: (() => void) | undefined
let identity: jest.Mock
const wallet = { getPublicKey: jest.fn(async () => ({ publicKey: IDENTITY })) }

function deps(over: Partial<MirrorWriterDeps> = {}): MirrorWriterDeps {
  return {
    native,
    processor: { flushEvents: flush },
    getSnapshot: getBridgeSnapshot,
    onSnapshotChange,
    isBridgeHostAttached,
    listConnectedSites,
    onConsentChange: onConnectedSitesChange,
    getPermissionPolicy,
    getIdentityKey: identity,
    bootId: 'boot-1',
    now: () => 1000,
    ...over
  }
}

const mirrorOf = (): Mirror | null => {
  const b = native.readMirrorSync()
  return b === null ? null : JSON.parse(Buffer.from(b).toString('utf8'))
}

function publishReady(readiness: 'ready' | 'building' = 'ready') {
  publish({
    attestedManager: { wallet: wallet as any, signing: {} as any },
    readiness,
    network: 'main',
    accountContext: 'ctx'
  })
}

async function connectSite(origin: string, attestation: 'browser' | 'unattested') {
  const r = consent.requestConsent({
    origin,
    attestation,
    transportId: 't',
    bindingEpoch: `e-${origin}-${attestation}`,
    walletRevision: 0,
    connectedBefore: false
  } as any)
  if ('refused' in r) throw new Error(r.refused)
  await consent.answerConsent(r.requestId, true, { walletRevision: 0, profileKey: '' } as any)
}

beforeEach(async () => {
  await AsyncStorage.clear()
  ;(SecureStore as any).__reset()
  resetBridgeRuntimeForTests()
  native = createFakeNative()
  await native.init({ nowMs: 1 })
  flush = jest.fn(async () => undefined)
  identity = jest.fn(async () => IDENTITY)
  wallet.getPublicKey.mockClear()
  consent = createConsentStore({
    storage: memoryKv(),
    adminWallet: fakeAdminWallet(),
    adminOriginator: 'admin.test',
    profileKey: () => '',
    now: () => Date.now(),
    randomBytes: n => globalThis.crypto.getRandomValues(new Uint8Array(n))
  })
  setActiveConsent({
    store: consent,
    adminWallet: fakeAdminWallet(),
    adminOriginator: 'admin.test',
    profileKey: () => ''
  })
  writer = undefined
  detach = undefined
})

afterEach(() => {
  writer?.disable()
  detach?.()
  installDispatcher(undefined)
})

async function attach() {
  await initBridgeRuntime()
  detach = attachBridgeHost({ withdrawPrompts: () => undefined })
}

describe('mirror writer', () => {
  it('never writes the pre-init snapshot (revision 0, closeSeq 0)', async () => {
    writer = createMirrorWriter(deps())
    writer.start()
    await writer.writeNow()
    await tick()
    expect(getBridgeSnapshot()).toMatchObject({ readiness: 'none', walletRevision: '0', closeSeq: 0 })
    expect(mirrorOf()).toBeNull()
  })

  it('writes a real none after attach, with a null identity key', async () => {
    await attach()
    writer = createMirrorWriter(deps())
    await writer.writeNow()
    expect(mirrorOf()).toMatchObject({
      v: 1,
      writerBootId: 'boot-1',
      writtenAt: 1000,
      identityKey: null,
      connected: [],
      snapshot: { readiness: 'none' }
    })
    expect(identity).not.toHaveBeenCalled()
  })

  it('identityKey is null when not ready and set when ready', async () => {
    await attach()
    writer = createMirrorWriter(deps())
    publishReady('building')
    await writer.writeNow()
    expect(mirrorOf()).toMatchObject({ identityKey: null, snapshot: { readiness: 'building' } })
    publishReady('ready')
    await writer.writeNow()
    expect(mirrorOf()).toMatchObject({ identityKey: IDENTITY, snapshot: { readiness: 'ready' } })
  })

  it('a ready mirror is not written when the identity key cannot be read', async () => {
    await attach()
    identity.mockResolvedValue(null)
    writer = createMirrorWriter(deps())
    publishReady('ready')
    await writer.writeNow()
    expect(mirrorOf()).toBeNull()
  })

  it('connected equals listConnectedSites filtered to browser, hashed, and equals what consent.lookup would skip', async () => {
    await attach()
    await connectSite('https://b.example', 'browser')
    await connectSite('https://a.example', 'browser')
    await connectSite('https://c.example', 'unattested')
    writer = createMirrorWriter(deps())
    await writer.writeNow()
    const expected = ['https://a.example', 'https://b.example'].map(connectedHash).sort()
    expect(mirrorOf()!.connected).toEqual(expected)
    for (const origin of ['https://a.example', 'https://b.example']) {
      expect(await consent.lookup(origin, 'browser')).toBeDefined()
    }
    expect(await consent.lookup('https://c.example', 'browser')).toBeUndefined()
    expect(mirrorOf()!.connected).not.toContain(connectedHash('https://c.example'))
  })

  it('unverified sites are never listed', async () => {
    await attach()
    await connectSite('https://u.example', 'unattested')
    writer = createMirrorWriter(deps())
    await writer.writeNow()
    expect(mirrorOf()!.connected).toEqual([])
  })

  it('identityKey equals getPublicKey({identityKey:true}) through the P1 dispatcher', async () => {
    await attach()
    installDispatcher(createDispatcher({ consent, noteChanged: jest.fn() } as any))
    publishReady('ready')
    registerTransport({ id: 't1', attestation: 'browser', bindingMode: 'explicit', requestAttention: jest.fn() })
    getBindingRegistry().connectExplicit({
      epoch: 'ep',
      transportId: 't1',
      applicationOrigin: 'https://a.example',
      originator: 'a.example',
      attestation: 'browser',
      instanceId: 'inst',
      continuityKey: 'ck',
      accountContext: 'ctx',
      walletRevision: getBridgeSnapshot().walletRevision
    })
    getBindingRegistry().markConsented('ep', 'a.example')
    const out: any = await dispatch({
      transport: 't1',
      request: {
        epoch: 'ep',
        instanceId: 'inst',
        continuityKey: 'ck',
        origin: 'https://a.example',
        method: 'getPublicKey',
        args: { identityKey: true },
        sizeBytes: 10
      }
    } as any)
    expect(out.ok).toBe(true)
    writer = createMirrorWriter(deps({ getIdentityKey: async () => (await wallet.getPublicKey()).publicKey }))
    await writer.writeNow()
    expect(mirrorOf()!.identityKey).toBe(out.result.publicKey)
  })

  it('identityKeyPrompts follows the verified policy flag', async () => {
    await attach()
    writer = createMirrorWriter(deps())
    await writer.writeNow()
    expect(mirrorOf()!.identityKeyPrompts).toBe(false)
    const base = await getPermissionPolicy()
    await setPermissionPolicy({
      verified: { ...base.verified, seekPermissionsForIdentityKeyRevelation: true },
      unverified: base.unverified
    })
    await writer.writeNow()
    expect(mirrorOf()!.identityKeyPrompts).toBe(true)
  })

  it('writes on snapshot change, consent change, policy refresh (app active)', async () => {
    await attach()
    const handlers: Array<(s: string) => void> = []
    const spy = jest.spyOn(AppState, 'addEventListener').mockImplementation(((_: string, h: (s: string) => void) => {
      handlers.push(h)
      return { remove: jest.fn() }
    }) as any)
    const writeMirror = jest.spyOn(native, 'writeMirror')
    writer = createMirrorWriter(deps())
    writer.start()
    await tick()
    const base = writeMirror.mock.calls.length
    expect(base).toBeGreaterThanOrEqual(1)
    publishReady('ready')
    await tick()
    expect(writeMirror.mock.calls.length).toBeGreaterThan(base)
    expect(mirrorOf()!.snapshot.readiness).toBe('ready')
    const afterSnapshot = writeMirror.mock.calls.length
    await connectSite('https://a.example', 'browser')
    await tick()
    expect(writeMirror.mock.calls.length).toBeGreaterThan(afterSnapshot)
    expect(mirrorOf()!.connected).toEqual([connectedHash('https://a.example')])
    const afterConsent = writeMirror.mock.calls.length
    handlers.forEach(h => h('background'))
    await tick()
    expect(writeMirror.mock.calls.length).toBe(afterConsent)
    handlers.forEach(h => h('active'))
    await tick()
    expect(writeMirror.mock.calls.length).toBe(afterConsent + 1)
    spy.mockRestore()
  })

  it('ordinary write awaits flushEvents so a mirror with closeSeq N is never durable before event N', async () => {
    await attach()
    let release!: () => void
    flush.mockImplementation(() => new Promise<void>(r => (release = r)))
    const writeMirror = jest.spyOn(native, 'writeMirror')
    writer = createMirrorWriter(deps())
    const done = writer.writeNow()
    await tick()
    expect(flush).toHaveBeenCalled()
    expect(writeMirror).not.toHaveBeenCalled()
    release()
    await done
    expect(writeMirror).toHaveBeenCalledTimes(1)
  })

  it('a detach-induced none is not written while a real none is', async () => {
    await attach()
    publishReady('ready')
    writer = createMirrorWriter(deps())
    writer.start()
    await tick()
    expect(mirrorOf()!.snapshot.readiness).toBe('ready')
    detach!()
    detach = undefined
    expect(getBridgeSnapshot().readiness).toBe('none')
    await tick()
    expect(mirrorOf()!.snapshot.readiness).toBe('ready') // the last mirror stays
    await attach()
    // The provider registers its consent store right after attaching; that is the trigger.
    setActiveConsent({
      store: consent,
      adminWallet: fakeAdminWallet(),
      adminOriginator: 'admin.test',
      profileKey: () => ''
    })
    await tick()
    expect(mirrorOf()!.snapshot.readiness).toBe('none') // the next attach writes a real none
  })

  it('logout order: P1 teardown sets none, the writer callback fires, the kit hook disables synchronously, the pending write re-checks disabled and writes nothing', async () => {
    await attach()
    publishReady('ready')
    writer = createMirrorWriter(deps())
    writer.start()
    await tick()
    expect(mirrorOf()!.snapshot.readiness).toBe('ready')
    const writeMirror = jest.spyOn(native, 'writeMirror')
    const order: string[] = []
    const w = writer
    const unregister = registerSessionTeardown(['logout'], () => {
      order.push('hook')
      w.disable()
      native.reset()
    })
    runSessionTeardown('logout') // attachBridgeHost's hook ran first (set none), then ours, all synchronously
    expect(getBridgeSnapshot().readiness).toBe('none')
    expect(order).toEqual(['hook'])
    await tick()
    expect(writeMirror).not.toHaveBeenCalled()
    expect(mirrorOf()).toBeNull()
    unregister()
  })

  it('late write after disable rejects and is swallowed', async () => {
    await attach()
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    writer = createMirrorWriter(deps())
    const pending = writer.writeNow()
    native.reset()
    await expect(pending).resolves.toBeUndefined() // the module rejected ERR_RESET; the writer swallowed it
    writer.disable()
    await expect(writer.writeNow()).resolves.toBeUndefined()
    expect(mirrorOf()).toBeNull()
    warn.mockRestore()
  })
})

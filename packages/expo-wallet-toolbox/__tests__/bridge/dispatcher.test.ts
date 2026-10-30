jest.mock('expo-secure-store', () => require('../__mocks__/secureStoreFake').fake)

import AsyncStorage from '@react-native-async-storage/async-storage'
import * as SecureStore from 'expo-secure-store'
import { LockingScript, PrivateKey, Transaction, Utils } from '@bsv/sdk'
import { createConsentStore, type ConsentStore, type KeyValue } from '../../core/bridge/consent'
import {
  createDispatcher,
  dispatch,
  installDispatcher,
  type DispatchRequest,
  type Outcome
} from '../../core/bridge/dispatcher'
import { connectionError } from '../../core/bridge/protocol/connectionError'
import { findTokenModuleVariant, isValidVersionString } from '../../core/bridge/policy'
import { BRIDGE_METHODS } from '../../core/bridge/protocol/methods'
import {
  attachBridgeHost,
  getBindingRegistry,
  getBridgeSnapshot,
  initBridgeRuntime,
  publish,
  registerConsentWithdrawal,
  registerTransport,
  resetBridgeRuntimeForTests,
  setBridgeBaseVersion,
  type BridgeManager,
  type BridgeReadiness
} from '../../core/bridge/runtime'
import { limitsForTier } from '../../core/services/walletArgLimits'

const ADMIN = 'admin.wallet'
const ORIGIN = 'https://example.com'
const PK = new PrivateKey(7).toPublicKey().toString()
const PK2 = new PrivateKey(9).toPublicKey().toString()
const TXID = 'ab'.repeat(32)
const B64_32 = Utils.toBase64(Array(32).fill(1))
const bytes = (n: number, v = 1) => Array(n).fill(v)
const DER = new PrivateKey(7).sign(bytes(10)).toDER() as number[]
const ATOMIC_BEEF = (() => {
  const tx = new Transaction()
  tx.addOutput({ lockingScript: LockingScript.fromHex('51'), satoshis: 1 })
  return tx.toAtomicBEEF()
})()

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

/* ------------------------------ golden table ------------------------------- */

const cert = {
  type: B64_32,
  serialNumber: Utils.toBase64(Array(32).fill(2)),
  subject: PK2,
  certifier: PK,
  revocationOutpoint: `${TXID}.0`,
  signature: '3006020101020101',
  fields: { name: 'AAAA' }
}

interface Golden {
  args: Record<string, unknown>
  result: unknown
}

const GOLDEN: Record<string, Golden> = {
  getPublicKey: { args: { identityKey: true }, result: { publicKey: PK } },
  revealCounterpartyKeyLinkage: {
    args: { counterparty: PK, verifier: PK2 },
    result: {
      prover: PK2,
      verifier: PK2,
      counterparty: PK,
      revelationTime: '2024-01-01T00:00:00.000Z',
      encryptedLinkage: bytes(40),
      encryptedLinkageProof: bytes(40)
    }
  },
  revealSpecificKeyLinkage: {
    args: { counterparty: PK, verifier: PK2, protocolID: [1, 'test protocol'], keyID: 'k1' },
    result: {
      prover: PK2,
      verifier: PK2,
      counterparty: PK,
      protocolID: [1, 'test protocol'],
      keyID: 'k1',
      encryptedLinkage: bytes(40),
      encryptedLinkageProof: bytes(40),
      proofType: 0
    }
  },
  encrypt: {
    args: { protocolID: [1, 'test protocol'], keyID: 'k1', plaintext: bytes(10) },
    result: { ciphertext: bytes(40) }
  },
  decrypt: {
    args: { protocolID: [1, 'test protocol'], keyID: 'k1', ciphertext: bytes(40) },
    result: { plaintext: bytes(10) }
  },
  createHmac: {
    args: { protocolID: [1, 'test protocol'], keyID: 'k1', data: bytes(10) },
    result: { hmac: bytes(32) }
  },
  verifyHmac: {
    args: { protocolID: [1, 'test protocol'], keyID: 'k1', data: bytes(10), hmac: bytes(32) },
    result: { valid: true }
  },
  createSignature: {
    args: { protocolID: [1, 'test protocol'], keyID: 'k1', data: bytes(10) },
    result: { signature: DER }
  },
  verifySignature: {
    args: { protocolID: [1, 'test protocol'], keyID: 'k1', data: bytes(10), signature: DER },
    result: { valid: true }
  },
  createAction: {
    args: {
      description: 'Golden action',
      outputs: [{ lockingScript: '51', satoshis: 1, outputDescription: 'Golden output' }],
      options: { noSend: true, returnTXIDOnly: true }
    },
    result: { txid: TXID }
  },
  signAction: {
    args: { spends: {}, reference: 'cmVmZXJlbmNl', options: { returnTXIDOnly: true } },
    result: { txid: TXID }
  },
  abortAction: { args: { reference: 'cmVmZXJlbmNl' }, result: { aborted: true } },
  listActions: { args: { labels: ['label one'] }, result: { totalActions: 0, actions: [] } },
  internalizeAction: {
    args: {
      tx: ATOMIC_BEEF,
      outputs: [
        {
          outputIndex: 0,
          protocol: 'basket insertion',
          insertionRemittance: { basket: 'default' }
        }
      ],
      description: 'Golden internalize'
    },
    result: { accepted: true }
  },
  listOutputs: { args: { basket: 'default' }, result: { totalOutputs: 0, outputs: [] } },
  relinquishOutput: { args: { basket: 'default', output: `${TXID}.0` }, result: { relinquished: true } },
  acquireCertificate: {
    args: {
      type: B64_32,
      certifier: PK,
      acquisitionProtocol: 'direct',
      fields: { name: 'AAAA' },
      serialNumber: cert.serialNumber,
      revocationOutpoint: cert.revocationOutpoint,
      signature: cert.signature,
      keyringRevealer: 'certifier',
      keyringForSubject: { name: 'AAAA' }
    },
    result: cert
  },
  listCertificates: {
    args: { certifiers: [PK], types: [B64_32], limit: 10 },
    result: { totalCertificates: 0, certificates: [] }
  },
  proveCertificate: {
    args: { certificate: cert, fieldsToReveal: ['name'], verifier: PK2 },
    result: { keyringForVerifier: { name: 'AAAA' } }
  },
  relinquishCertificate: {
    args: { type: B64_32, serialNumber: cert.serialNumber, certifier: PK },
    result: { relinquished: true }
  },
  discoverByIdentityKey: {
    args: { identityKey: PK },
    result: { totalCertificates: 0, certificates: [] }
  },
  discoverByAttributes: {
    args: { attributes: { name: 'AAAA' } },
    result: { totalCertificates: 0, certificates: [] }
  },
  waitForAuthentication: { args: {}, result: { authenticated: true } },
  getHeight: { args: {}, result: { height: 800000 } },
  getHeaderForHeight: { args: { height: 800000 }, result: { header: '00'.repeat(80) } },
  getNetwork: { args: {}, result: { network: 'mainnet' } }
}

/* --------------------------------- harness --------------------------------- */

interface Fake {
  wallet: Record<string, jest.Mock>
  manager: BridgeManager
}

function fakeManager(): Fake {
  const wallet: Record<string, jest.Mock> = {}
  for (const [name, g] of Object.entries(GOLDEN)) wallet[name] = jest.fn(async () => g.result)
  return { wallet, manager: { wallet: wallet as any, signing: {} as any } }
}

const detaches: Array<() => void> = []
let attested: Fake
let unverified: Fake
let consent: ConsentStore
let noteChanged: jest.Mock
let nextEpoch = 0
const withdrawPrompts = jest.fn()

function publishAll(readiness: BridgeReadiness = 'ready', over: { attested?: Fake; unverified?: Fake } = {}) {
  publish({
    attestedManager: (over.attested ?? attested).manager,
    unverifiedManager: (over.unverified ?? unverified).manager,
    readiness,
    network: 'main',
    accountContext: 'ctx'
  })
}

let attention: Array<[string, string]>

beforeEach(async () => {
  await AsyncStorage.clear()
  ;(SecureStore as any).__reset()
  resetBridgeRuntimeForTests()
  attested = fakeManager()
  unverified = fakeManager()
  noteChanged = jest.fn()
  attention = []
  await initBridgeRuntime()
  detaches.push(attachBridgeHost({ withdrawPrompts }))
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
    id: 't1',
    attestation: 'browser',
    bindingMode: 'explicit',
    requestAttention: (reason, b) => attention.push([reason, b.epoch])
  })
  registerTransport({
    id: 'u1',
    attestation: 'unattested',
    bindingMode: 'explicit',
    requestAttention: (reason, b) => attention.push([reason, b.epoch]),
    deliverReconnectToken: () => {}
  })
  installDispatcher(createDispatcher({ consent, noteChanged }))
  publishAll()
})

afterEach(() => {
  while (detaches.length) detaches.pop()!()
  installDispatcher(undefined)
})

function connect(over: { attestation?: 'browser' | 'unattested'; consented?: boolean; origin?: string } = {}) {
  const attestation = over.attestation ?? 'browser'
  const epoch = `epoch-${++nextEpoch}`
  const origin = over.origin ?? ORIGIN
  const binding = getBindingRegistry().connectExplicit({
    epoch,
    transportId: attestation === 'browser' ? 't1' : 'u1',
    applicationOrigin: origin,
    originator: attestation === 'browser' ? new URL(origin).hostname : undefined,
    attestation,
    instanceId: 'inst',
    continuityKey: 'ck',
    accountContext: 'ctx',
    walletRevision: getBridgeSnapshot().walletRevision,
    launchProofVerified: attestation === 'unattested' ? true : undefined
  })
  if (over.consented !== false) {
    getBindingRegistry().markConsented(
      epoch,
      attestation === 'browser' ? new URL(origin).hostname : `example.com.gabcdefghij.unverified.invalid`
    )
  }
  return binding
}

function send(
  binding: { epoch: string; applicationOrigin: string },
  method: string,
  args: unknown = {},
  over: Partial<DispatchRequest> = {}
): Promise<Outcome> {
  return dispatch({
    transport: binding.epoch && (binding as any).transportId,
    request: {
      epoch: binding.epoch,
      instanceId: 'inst',
      continuityKey: 'ck',
      origin: binding.applicationOrigin,
      method,
      args,
      sizeBytes: 100,
      ...over
    }
  })
}

const connErr = (o: Outcome) => (o.ok === false && 'connectionError' in o ? o.connectionError : undefined)
const walletErr = (o: Outcome) => (o.ok === false && 'walletError' in o ? o.walletError : undefined)
const tick = () => new Promise(r => setTimeout(r, 0))

/* ---------------------------------- tests ---------------------------------- */

describe('dispatcher: method table', () => {
  it('covers exactly the 26 non-probe methods', () => {
    const nonProbe = Object.entries(BRIDGE_METHODS)
      .filter(([, i]) => !i.probe)
      .map(([n]) => n)
      .sort()
    expect(Object.keys(GOLDEN).sort()).toEqual(nonProbe)
  })

  it.each(Object.keys(GOLDEN))('%s: originator comes from the binding, result is the validated copy', async name => {
    const b = connect()
    const out = await send(b, name, GOLDEN[name].args)
    expect(out).toEqual({ ok: true, result: GOLDEN[name].result })
    expect(attested.wallet[name]).toHaveBeenCalledTimes(1)
    expect(attested.wallet[name].mock.calls[0][1]).toBe('example.com')
    expect(unverified.wallet[name]).not.toHaveBeenCalled()
    expect(noteChanged).toHaveBeenCalledTimes(BRIDGE_METHODS[name as keyof typeof BRIDGE_METHODS].mutating ? 1 : 0)
  })

  it('a page cannot choose the originator: an originator argument is not forwarded', async () => {
    const b = connect()
    await send(b, 'getHeight', {}, { origin: b.applicationOrigin })
    expect(attested.wallet.getHeight.mock.calls[0][1]).toBe('example.com')
  })
})

describe('dispatcher: boundaries', () => {
  it('refuses a typed-array argument', async () => {
    const b = connect()
    const out = await send(b, 'internalizeAction', { ...GOLDEN.internalizeAction.args, tx: new Uint8Array(40) })
    expect(connErr(out)).toMatchObject({ code: 'RESOURCE_LIMIT', delivery: 'not-sent' })
    expect(attested.wallet.internalizeAction).not.toHaveBeenCalled()
  })

  it('refuses a 3 MB inputBEEF before the wallet is touched', async () => {
    const b = connect()
    const args = { ...GOLDEN.createAction.args, inputBEEF: bytes(3_000_000, 0) }
    const out = await send(b, 'createAction', args, { sizeBytes: 3_000_100 })
    expect(walletErr(out)).toMatchObject({ code: 6, parameter: 'inputBEEF' })
    expect(attested.wallet.createAction).not.toHaveBeenCalled()
    expect(noteChanged).not.toHaveBeenCalled()
  })

  it('refuses a request over 5 MiB', async () => {
    const b = connect()
    const out = await send(b, 'getHeight', {}, { sizeBytes: 5 * 1024 * 1024 + 1 })
    expect(connErr(out)).toMatchObject({ code: 'RESOURCE_LIMIT', delivery: 'not-sent' })
  })

  it('an unknown method is a protocol error', async () => {
    const b = connect()
    expect(connErr(await send(b, 'toString'))).toMatchObject({ code: 'PROTOCOL_ERROR', delivery: 'not-sent' })
    expect(connErr(await send(b, 'nope'))).toMatchObject({ code: 'PROTOCOL_ERROR' })
  })

  it('invalid arguments give code 6, not-sent', async () => {
    const b = connect()
    const out = await send(b, 'getHeaderForHeight', { height: 'x' })
    expect(out).toMatchObject({ ok: false, delivery: 'not-sent' })
    expect(walletErr(out)?.code).toBe(6)
    expect(attested.wallet.getHeaderForHeight).not.toHaveBeenCalled()
  })

  it('a request that fails the result snapshot gives code 6, not-sent', async () => {
    const b = connect()
    const hostile = { ...GOLDEN.listOutputs.args }
    Object.defineProperty(hostile, 'limit', {
      enumerable: true,
      get() {
        throw new Error('getter')
      }
    })
    const out = await send(b, 'listOutputs', hostile)
    expect(walletErr(out)?.code).toBe(6)
    expect(attested.wallet.listOutputs).not.toHaveBeenCalled()
  })

  it('no provider mounted gives CONFIGURATION_ERROR', async () => {
    const b = connect()
    detaches.pop()!()
    expect(connErr(await send(b, 'getHeight'))).toMatchObject({ code: 'CONFIGURATION_ERROR', delivery: 'not-sent' })
  })

  it('an unknown or mismatched binding is PROVIDER_CHANGED', async () => {
    const b = connect()
    expect(connErr(await send(b, 'getHeight', {}, { epoch: 'nope' }))).toMatchObject({ code: 'PROVIDER_CHANGED' })
    expect(connErr(await send(b, 'getHeight', {}, { continuityKey: 'other' }))).toMatchObject({
      code: 'PROVIDER_CHANGED'
    })
  })

  it('limits requests in flight per binding', async () => {
    const b = connect()
    publishAll('blocked')
    const parked = [1, 2, 3, 4].map(() => send(b, 'getHeight'))
    await tick()
    expect(connErr(await send(b, 'getHeight'))).toMatchObject({ code: 'RESOURCE_LIMIT', delivery: 'not-sent' })
    // Probes hold nothing and are not limited.
    expect(await send(b, 'getVersion')).toMatchObject({ ok: true })
    publishAll('ready')
    for (const p of parked) expect(await p).toMatchObject({ ok: true })
  })

  it('limits total requests in flight', async () => {
    publishAll('blocked')
    const bindings = Array.from({ length: 5 }, (_, i) => connect({ origin: `https://site${i}.example.com` }))
    const parked: Promise<Outcome>[] = []
    for (let i = 0; i < 16; i++) parked.push(send(bindings[Math.floor(i / 4)], 'getHeight'))
    await tick()
    expect(connErr(await send(bindings[4], 'getHeight'))).toMatchObject({ code: 'RESOURCE_LIMIT' })
    publishAll('ready')
    for (const p of parked) expect(await p).toMatchObject({ ok: true })
  })
})

describe('dispatcher: probes', () => {
  it.each<BridgeReadiness>(['none', 'building', 'blocked', 'ready'])(
    'probes never park (runtime %s, site not connected)',
    async readiness => {
      const b = connect({ consented: false })
      publishAll(readiness)
      const requestConsent = jest.spyOn(consent, 'requestConsent')
      const v = await send(b, 'getVersion')
      expect(v).toEqual({ ok: true, result: { version: getBridgeSnapshot().baseVersion } })
      const a = await send(b, 'isAuthenticated')
      expect(a).toEqual({ ok: true, result: { authenticated: readiness === 'ready' } })
      expect(requestConsent).not.toHaveBeenCalled()
      expect(consent.listPending()).toHaveLength(0)
      expect(attention).toEqual([])
      for (const f of Object.values(attested.wallet)) expect(f).not.toHaveBeenCalled()
    }
  )

  it('getVersion accepts a BRC-205 extended string', async () => {
    setBridgeBaseVersion('bsv-wallet-1.2.3 ios;build=42;' + 'x'.repeat(100))
    const b = connect({ consented: false })
    const out = await send(b, 'getVersion')
    expect(out).toMatchObject({ ok: true })
    expect(isValidVersionString('bsv-wallet-1.2.3 ios;build=42')).toBe(true)
    expect(isValidVersionString('short')).toBe(false)
    expect(isValidVersionString('a'.repeat(31))).toBe(false)
    expect(isValidVersionString('bsv-wallet-1 ' + 'x'.repeat(2048))).toBe(false)
    expect(isValidVersionString('bsv-wallet-1 é')).toBe(false)
  })

  it('an invalid static version is a configuration error', async () => {
    setBridgeBaseVersion('x')
    const b = connect()
    expect(connErr(await send(b, 'getVersion'))).toMatchObject({ code: 'CONFIGURATION_ERROR' })
  })
})

describe('dispatcher: wallet state and consent', () => {
  it('none fails at once, not-sent', async () => {
    const b = connect()
    publish({ readiness: 'none', network: 'main', accountContext: '' })
    expect(connErr(await send(b, 'getHeight'))).toMatchObject({ code: 'CONFIGURATION_ERROR', delivery: 'not-sent' })
  })

  it('blocked parks with attention, then proceeds when ready', async () => {
    const b = connect()
    publishAll('blocked')
    const p = send(b, 'getHeight')
    await tick()
    expect(attested.wallet.getHeight).not.toHaveBeenCalled()
    expect(attention).toEqual([['wallet-not-ready', b.epoch]])
    expect(consent.listPending()).toHaveLength(0)
    publishAll('ready')
    expect(await p).toMatchObject({ ok: true })
  })

  it('parked on readiness then profile switch never reaches the new wallet', async () => {
    const b = connect()
    publishAll('blocked')
    const p = send(b, 'getHeight')
    await tick()
    const fresh = fakeManager()
    // A different manager object: a wallet replacement closes every binding.
    publishAll('ready', { attested: fresh, unverified: fakeManager() })
    const out = await p
    expect(connErr(out)).toMatchObject({ code: 'PROVIDER_CHANGED', delivery: 'not-sent', cause: 'account-changed' })
    expect(fresh.wallet.getHeight).not.toHaveBeenCalled()
    expect(attested.wallet.getHeight).not.toHaveBeenCalled()
  })

  it('a remembered browser site connects without a sheet', async () => {
    const b = connect({ consented: false })
    const approve = consent.requestConsent({
      origin: ORIGIN,
      attestation: 'browser',
      transportId: 't1',
      bindingEpoch: 'seed',
      walletRevision: 0,
      connectedBefore: false
    }) as any
    await consent.answerConsent(approve.requestId, true, { walletRevision: 0, profileKey: '' })
    expect(await send(b, 'getHeight')).toMatchObject({ ok: true })
    expect(consent.listPending()).toHaveLength(0)
    expect(attested.wallet.getHeight.mock.calls[0][1]).toBe('example.com')
  })

  it('an unconnected site parks behind the sheet; approval releases it', async () => {
    const b = connect({ consented: false })
    const p = send(b, 'getHeight')
    await tick()
    await tick()
    expect(attested.wallet.getHeight).not.toHaveBeenCalled()
    expect(attention).toContainEqual(['consent', b.epoch])
    const [pending] = consent.listPending()
    expect(pending).toMatchObject({ origin: ORIGIN, attestation: 'browser' })
    await consent.answerConsent(pending.requestId, true, { walletRevision: 0, profileKey: '' })
    expect(await p).toMatchObject({ ok: true })
    expect(attested.wallet.getHeight.mock.calls[0][1]).toBe('example.com')
  })

  it('a decline answers USER_CANCELLED, not-sent', async () => {
    const b = connect({ consented: false })
    const p = send(b, 'getHeight')
    await tick()
    await tick()
    await consent.answerConsent(consent.listPending()[0].requestId, false, { walletRevision: 0, profileKey: '' })
    expect(connErr(await p)).toMatchObject({ code: 'USER_CANCELLED', delivery: 'not-sent' })
    expect(attested.wallet.getHeight).not.toHaveBeenCalled()
  })

  it('a second sheet on the same transport is RESOURCE_LIMIT', async () => {
    const a = connect({ consented: false })
    const b = connect({ consented: false, origin: 'https://other.example.com' })
    const first = send(a, 'getHeight')
    await tick()
    await tick()
    expect(connErr(await send(b, 'getHeight'))).toMatchObject({ code: 'RESOURCE_LIMIT', delivery: 'not-sent' })
    await consent.answerConsent(consent.listPending()[0].requestId, false, { walletRevision: 0, profileKey: '' })
    await first
  })

  it('seekPermission false from an unconnected site is permission denied, no sheet', async () => {
    const b = connect({ consented: false })
    const out = await send(b, 'getPublicKey', { identityKey: true, seekPermission: false })
    expect(out).toMatchObject({ ok: false, delivery: 'not-sent' })
    expect(walletErr(out)?.code).toBe(1)
    expect(consent.listPending()).toHaveLength(0)
    expect(attested.wallet.getPublicKey).not.toHaveBeenCalled()
  })

  it('closing the binding settles the parked request and drops the sheet', async () => {
    const b = connect({ consented: false })
    const p = send(b, 'getHeight')
    await tick()
    await tick()
    expect(consent.listPending()).toHaveLength(1)
    getBindingRegistry().close(b.epoch, 'disconnected')
    expect(connErr(await p)).toMatchObject({ code: 'DISCONNECTED', delivery: 'not-sent' })
    expect(consent.listPending()).toHaveLength(0)
  })

  it('an unattested site with no reconnect token gets the sheet even if it was connected before', async () => {
    const seed = consent.requestConsent({
      origin: ORIGIN,
      attestation: 'unattested',
      transportId: 'u1',
      bindingEpoch: 'seed',
      walletRevision: 0,
      connectedBefore: false
    }) as any
    await consent.answerConsent(seed.requestId, true, { walletRevision: 0, profileKey: '' })
    const b = connect({ attestation: 'unattested', consented: false })
    const p = send(b, 'getHeight')
    await tick()
    await tick()
    expect(consent.listPending()[0]).toMatchObject({ attestation: 'unattested', connectedBefore: true })
    expect(unverified.wallet.getHeight).not.toHaveBeenCalled()
    getBindingRegistry().close(b.epoch, 'disconnected')
    await p
  })
})

describe('dispatcher: re-check and call', () => {
  it('a stale revision before the call is PROVIDER_CHANGED, wallet not called', async () => {
    const b = connect()
    // The binding keeps its old revision while the runtime moves on without a close event.
    ;(b as any).walletRevision = '99'
    const out = await send(b, 'getHeight')
    expect(connErr(out)).toMatchObject({ code: 'PROVIDER_CHANGED', delivery: 'not-sent', cause: 'account-changed' })
    expect(attested.wallet.getHeight).not.toHaveBeenCalled()
  })

  it('beforeCall (an inbox claim) runs before the re-check and the wallet call', async () => {
    const b = connect()
    const order: string[] = []
    attested.wallet.getHeight.mockImplementation(async () => {
      order.push('wallet')
      return { height: 1 }
    })
    const out = await send(
      b,
      'getHeight',
      {},
      {
        beforeCall: async () => {
          order.push('claim')
        }
      }
    )
    expect(out).toEqual({ ok: true, result: { height: 1 } })
    expect(order).toEqual(['claim', 'wallet'])
  })

  it('a revision change during the claim is PROVIDER_CHANGED, wallet not called', async () => {
    const b = connect()
    const out = await send(
      b,
      'getHeight',
      {},
      {
        beforeCall: async () => {
          // The wallet is replaced while the claim is in flight, with no close event for this binding.
          publishAll('ready', { attested: fakeManager() })
        }
      }
    )
    expect(connErr(out)).toMatchObject({ code: 'PROVIDER_CHANGED', delivery: 'not-sent', cause: 'account-changed' })
    expect(attested.wallet.getHeight).not.toHaveBeenCalled()
  })

  it('a claim that refuses with a connection error settles with it, wallet not called', async () => {
    const b = connect()
    const out = await send(
      b,
      'getHeight',
      {},
      {
        beforeCall: async () => {
          throw connectionError('PROTOCOL_ERROR', 'Record changed', 'not-sent')
        }
      }
    )
    expect(connErr(out)).toMatchObject({ code: 'PROTOCOL_ERROR', delivery: 'not-sent' })
    expect(attested.wallet.getHeight).not.toHaveBeenCalled()
  })

  it('a non-canonical originator never reaches the wallet', async () => {
    const b = connect()
    ;(b as any).originator = 'bad.invalid'
    const out = await send(b, 'getHeight')
    expect(connErr(out)).toMatchObject({ code: 'PROVIDER_CHANGED', delivery: 'not-sent' })
    expect(attested.wallet.getHeight).not.toHaveBeenCalled()
  })

  it('no timeout while a prompt is pending', async () => {
    const b = connect()
    let release!: (v: unknown) => void
    attested.wallet.getHeight.mockImplementation(() => new Promise(res => (release = res)))
    jest.useFakeTimers()
    try {
      const p = send(b, 'getHeight')
      await Promise.resolve()
      jest.advanceTimersByTime(60 * 60 * 1000)
      let settled = false
      void p.then(() => (settled = true))
      await Promise.resolve()
      await Promise.resolve()
      expect(settled).toBe(false)
      release({ height: 5 })
      expect(await p).toEqual({ ok: true, result: { height: 5 } })
    } finally {
      jest.useRealTimers()
    }
  })

  it('a wallet error stays a wallet error; a mutating one is delivery unknown and still nudges backup', async () => {
    const b = connect()
    attested.wallet.createAction.mockRejectedValue(
      Object.assign(new Error('review'), {
        name: 'WERR_REVIEW_ACTIONS',
        code: 5,
        reviewActionResults: [],
        sendWithResults: []
      })
    )
    const out = await send(b, 'createAction', GOLDEN.createAction.args)
    expect(out).toMatchObject({ ok: false, delivery: 'unknown' })
    expect(walletErr(out)?.code).toBe(5)
    expect(noteChanged).toHaveBeenCalledTimes(1)
  })

  it('a read-only failure is delivery not-sent and does not nudge backup', async () => {
    const b = connect()
    attested.wallet.getHeight.mockRejectedValue(new Error('boom'))
    const out = await send(b, 'getHeight')
    expect(out).toMatchObject({ ok: false, delivery: 'not-sent' })
    expect(walletErr(out)?.code).toBe(1)
    expect(noteChanged).not.toHaveBeenCalled()
  })

  it('a mutating result that fails validation is unknown, with the txid kept', async () => {
    const b = connect()
    attested.wallet.createAction.mockResolvedValue({ txid: TXID, tx: 'not bytes' })
    const out = await send(b, 'createAction', GOLDEN.createAction.args)
    expect(connErr(out)).toMatchObject({
      code: 'PROTOCOL_ERROR',
      delivery: 'unknown',
      cause: 'invalid-result',
      txid: TXID
    })
    expect(noteChanged).toHaveBeenCalledTimes(1)
  })

  it('a read-only result that fails validation is wallet code 1', async () => {
    const b = connect()
    attested.wallet.getHeight.mockResolvedValue({ height: 'x' })
    expect(walletErr(await send(b, 'getHeight'))?.code).toBe(1)
  })

  it('a response over 5 MiB is RESOURCE_LIMIT, unknown', async () => {
    const b = connect()
    attested.wallet.encrypt.mockResolvedValue({ ciphertext: bytes(2_000_000, 255) })
    const out = await send(b, 'encrypt', GOLDEN.encrypt.args)
    expect(connErr(out)).toMatchObject({ code: 'RESOURCE_LIMIT', delivery: 'unknown' })
  })

  it('a binding closed during the call settles CONNECTION_CLOSED, unknown; the call still nudges backup', async () => {
    const b = connect()
    let release!: (v: unknown) => void
    attested.wallet.createAction.mockImplementation(() => new Promise(res => (release = res)))
    const p = send(b, 'createAction', GOLDEN.createAction.args)
    await tick()
    getBindingRegistry().close(b.epoch, 'revoked')
    expect(connErr(await p)).toMatchObject({ code: 'CONNECTION_CLOSED', delivery: 'unknown' })
    release({ txid: TXID })
    await tick()
    expect(noteChanged).toHaveBeenCalledTimes(1)
  })

  it('the guarded stack is read fresh for every call', async () => {
    const b = connect()
    await send(b, 'getHeight')
    const second = fakeManager()
    // Same identity: publish a second build of managers and rebind.
    publishAll('ready', { attested: second })
    const b2 = connect()
    await send(b2, 'getHeight')
    expect(second.wallet.getHeight).toHaveBeenCalledTimes(1)
    expect(attested.wallet.getHeight).toHaveBeenCalledTimes(1)
  })
})

describe('dispatcher: routing and pre-scan', () => {
  it('an unattested binding reaches the unverified manager, an attested one the attested manager, never crossing', async () => {
    const a = connect()
    const u = connect({ attestation: 'unattested' })
    await send(a, 'getHeight')
    await send(u, 'getHeight')
    expect(attested.wallet.getHeight).toHaveBeenCalledTimes(1)
    expect(unverified.wallet.getHeight).toHaveBeenCalledTimes(1)
    expect(attested.wallet.getHeight.mock.calls[0][1]).toBe('example.com')
    expect(unverified.wallet.getHeight.mock.calls[0][1]).toBe('example.com.gabcdefghij.unverified.invalid')
  })

  it('an unattested binding without an unverified manager is PROVIDER_CHANGED', async () => {
    const u = connect({ attestation: 'unattested' })
    publish({ attestedManager: attested.manager, readiness: 'ready', network: 'main', accountContext: 'ctx' })
    expect(connErr(await send(u, 'getHeight'))).toMatchObject({ code: 'PROVIDER_CHANGED', delivery: 'not-sent' })
  })

  const variantCases: Array<[string, string, unknown]> = [
    ['basket', 'listOutputs', { basket: 'P Color' }],
    ['exact-case basket', 'listOutputs', { basket: 'p color token' }],
    [
      'exact-case protocol name on revealSpecificKeyLinkage (never delegated to the stub)',
      'revealSpecificKeyLinkage',
      { ...GOLDEN.revealSpecificKeyLinkage.args, protocolID: [2, 'p btms x'] }
    ],
    ['basket with leading space', 'listOutputs', { basket: ' p btms x' }],
    ['double space', 'listOutputs', { basket: 'p  btms' }],
    [
      'output basket',
      'createAction',
      {
        ...GOLDEN.createAction.args,
        outputs: [{ lockingScript: '51', satoshis: 1, outputDescription: 'out desc', basket: 'P Color token' }]
      }
    ],
    ['label', 'listActions', { labels: ['P BTMS spend'] }],
    ['protocol name', 'encrypt', { ...GOLDEN.encrypt.args, protocolID: [1, ' p color token'] }],
    [
      'internalize basket',
      'internalizeAction',
      {
        ...GOLDEN.internalizeAction.args,
        outputs: [{ outputIndex: 0, protocol: 'basket insertion', insertionRemittance: { basket: 'P BTMS x' } }]
      }
    ]
  ]

  it.each(variantCases)(
    'pre-scan refuses variants (%s) for unattested, before the wallet call',
    async (_n, method, args) => {
      const u = connect({ attestation: 'unattested' })
      const out = await send(u, method, args)
      expect(out).toMatchObject({ ok: false, delivery: 'not-sent' })
      expect(walletErr(out)?.code).toBe(1)
      expect(unverified.wallet[method]).not.toHaveBeenCalled()
      expect(noteChanged).not.toHaveBeenCalled()
    }
  )

  it('does not pre-scan an attested binding', async () => {
    const a = connect()
    expect(await send(a, 'listOutputs', { basket: 'P Color' })).toMatchObject({ ok: true })
    expect(attested.wallet.listOutputs).toHaveBeenCalledTimes(1)
  })

  it('refuses exact-case token-module names too, and leaves ordinary names alone', async () => {
    expect(findTokenModuleVariant({ basket: 'p color token' })).toBe('p color token')
    expect(findTokenModuleVariant({ protocolID: [2, 'p btms x'], keyID: '1' })).toBe('p btms x')
    expect(findTokenModuleVariant({ basket: 'pasta' })).toBeUndefined()
    expect(findTokenModuleVariant({ labels: ['plain', 'p other x'] })).toBeUndefined()
    expect(findTokenModuleVariant({ basket: 'P Color' })).toBe('P Color')
  })
})

describe('dispatcher: install', () => {
  it('dispatch without an installed dispatcher is CONFIGURATION_ERROR', async () => {
    installDispatcher(undefined)
    const b = connect()
    expect(connErr(await send(b, 'getHeight'))).toMatchObject({ code: 'CONFIGURATION_ERROR' })
  })
})

// Keep the limits import honest: the dispatcher applies the device tier's limits by default.
it('uses the same limits as capWalletArgs', () => {
  expect(limitsForTier('mid').inputBEEF).toBe(2 * 1024 * 1024)
})

/**
 * Shared harness for the controller and setup tests: the real P1 core (runtime, binding registry, consent store,
 * dispatcher) behind the real router, session machine and controller, with only the Kotlin module faked. The page is
 * played by raw requests through `FakeNative.emitRequest`, exactly what Kotlin delivers.
 */
import AsyncStorage from '@react-native-async-storage/async-storage'
import * as SecureStore from 'expo-secure-store'
import { LockingScript, PrivateKey, Transaction, Utils } from '@bsv/sdk'
import { createConsentStore, type ConsentStore, type KeyValue } from '@bsv/expo-wallet-toolbox/core/bridge/consent'
import { answerConnection, setConsentSheetSource } from '@bsv/expo-wallet-toolbox/core/bridge/consentSheetSource'
import {
  createDispatcher,
  dispatch as coreDispatch,
  installDispatcher,
  type Outcome
} from '@bsv/expo-wallet-toolbox/core/bridge/dispatcher'
import { bindingSecret, launchProof } from '@bsv/expo-wallet-toolbox/core/bridge/loopback/launchProof'
import {
  attachBridgeHost,
  getBridgeSnapshot,
  initBridgeRuntime,
  publish,
  registerConsentWithdrawal,
  resetBridgeRuntimeForTests,
  type BridgeManager,
  type BridgeReadiness
} from '@bsv/expo-wallet-toolbox/core/bridge/runtime'
import { createAndroidBridge, type AndroidBridge, type AndroidBridgeDeps } from '../src/setup'
import { createFakeNative, type FakeNative, type FakeResponse } from '../src/testing/fakeNative'
import { CHALLENGE, epochOf, flush, kOf, nOf, uriOf } from './controller/support'

export const ORIGIN = 'https://example.com'
export const HOST = '127.0.0.1:3321'
const ADMIN = 'admin.wallet'
const TXID = 'ab'.repeat(32)
const PK = new PrivateKey(7).toPublicKey().toString()
const PK2 = new PrivateKey(9).toPublicKey().toString()
const B64_32 = Utils.toBase64(Array(32).fill(1))
const bytes = (n: number, v = 1) => Array(n).fill(v)
const DER = new PrivateKey(7).sign(bytes(10)).toDER() as number[]
const ATOMIC_BEEF = (() => {
  const tx = new Transaction()
  tx.addOutput({ lockingScript: LockingScript.fromHex('51'), satoshis: 1 })
  return tx.toAtomicBEEF()
})()
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

/** One valid call and its result for each of the 26 non-probe methods (the two probes are answered by the core). */
export const GOLDEN: Record<string, Golden> = {
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
      outputs: [{ outputIndex: 0, protocol: 'basket insertion', insertionRemittance: { basket: 'default' } }],
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
  discoverByIdentityKey: { args: { identityKey: PK }, result: { totalCertificates: 0, certificates: [] } },
  discoverByAttributes: { args: { attributes: { name: 'AAAA' } }, result: { totalCertificates: 0, certificates: [] } },
  waitForAuthentication: { args: {}, result: { authenticated: true } },
  getHeight: { args: {}, result: { height: 800000 } },
  getHeaderForHeight: { args: { height: 800000 }, result: { header: '00'.repeat(80) } },
  getNetwork: { args: {}, result: { network: 'mainnet' } }
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

export function fakeManager(): { wallet: Record<string, jest.Mock>; manager: BridgeManager } {
  const wallet: Record<string, jest.Mock> = {}
  for (const [name, g] of Object.entries(GOLDEN)) wallet[name] = jest.fn(async () => g.result)
  return { wallet, manager: { wallet: wallet as any, signing: {} as any } }
}

export function memorySecureStore() {
  const data = new Map<string, string>()
  return {
    data,
    getItemAsync: async (k: string) => data.get(k) ?? null,
    setItemAsync: async (k: string, v: string) => void data.set(k, v)
  }
}

export interface Connected {
  epoch: string
  /** base64url binding secret the page presents as `BRC-185-Android-Binding`. */
  secret: string
  wallet: { instanceId: string; continuityKey: string }
  response: FakeResponse
}

export interface Harness {
  native: FakeNative
  bridge: AndroidBridge
  consent: ConsentStore
  attested: ReturnType<typeof fakeManager>
  unverified: ReturnType<typeof fakeManager>
  /** Outcomes of every core dispatch, in completion order. */
  outcomes: Outcome[]
  publishAll(readiness?: BridgeReadiness): void
  /** Deliver a request and resolve with its response (fails the test if none arrives). */
  request(req: Parameters<FakeNative['emitRequest']>[0]): Promise<FakeResponse>
  /** Deliver a request without waiting. */
  send(req: Parameters<FakeNative['emitRequest']>[0]): void
  response(id: string): FakeResponse | undefined
  waitFor(cond: () => boolean, what: string): Promise<void>
  describe(origin?: string): Promise<{ instanceId: string; continuityKey: string }>
  launch(i: number): Promise<void>
  /** Launch `i` then describe and connect; the binding exists on a 200. */
  connect(i: number, o?: { origin?: string; reconnectToken?: string }): Promise<Connected>
  rpc(c: Connected, method: string, args?: unknown, o?: { id?: string; origin?: string }): Promise<FakeResponse>
  sendRpc(c: Connected, method: string, args: unknown, id: string, origin?: string): void
  approve(): Promise<void>
  teardown(): void
}

export interface HarnessOptions {
  /** Do not attach the host or publish a wallet (a cold start). */
  cold?: boolean
  deps?: Partial<AndroidBridgeDeps>
}

let seq = 0

export async function createHarness(opts: HarnessOptions = {}): Promise<Harness> {
  await AsyncStorage.clear()
  ;(SecureStore as any).__reset()
  resetBridgeRuntimeForTests()
  await initBridgeRuntime()
  const native = createFakeNative()
  const attested = fakeManager()
  const unverified = fakeManager()
  const outcomes: Outcome[] = []
  const dispatch: typeof coreDispatch = async input => {
    const o = await (opts.deps?.dispatch ?? coreDispatch)(input)
    outcomes.push(o)
    return o
  }
  const consent = createConsentStore({
    storage: memoryKv(),
    adminWallet: fakeAdminWallet(),
    adminOriginator: ADMIN,
    profileKey: () => '',
    now: () => Date.now(),
    randomBytes: n => globalThis.crypto.getRandomValues(new Uint8Array(n))
  })
  registerConsentWithdrawal(() => consent.withdrawAll())
  installDispatcher(createDispatcher({ consent, noteChanged: jest.fn() }))
  setConsentSheetSource({
    store: consent,
    context: () => ({ walletRevision: Number(getBridgeSnapshot().walletRevision), profileKey: '' })
  })
  const publishAll = (readiness: BridgeReadiness = 'ready') =>
    publish({
      attestedManager: attested.manager,
      unverifiedManager: unverified.manager,
      readiness,
      network: 'main',
      accountContext: 'ctx'
    })
  let detachHost: (() => void) | undefined
  const build = () =>
    createAndroidBridge({
      native,
      appName: 'Test Wallet',
      vendor: 'org.test',
      continuityDeps: { secureStore: memorySecureStore() },
      ...opts.deps,
      dispatch
    })
  const bridge = build()
  if (!opts.cold) {
    detachHost = attachBridgeHost({ withdrawPrompts: jest.fn() })
    publishAll()
  }

  const response = (id: string) => native.responses.find(r => r.id === id)
  const waitFor = async (cond: () => boolean, what: string) => {
    for (let i = 0; i < 400; i++) {
      if (cond()) return
      await new Promise<void>(r => setImmediate(r))
    }
    throw new Error(`timed out waiting for ${what}`)
  }
  const send: Harness['send'] = req => native.emitRequest(req)
  const request: Harness['request'] = async req => {
    send(req)
    await waitFor(() => response(req.id) !== undefined, `response to ${req.id}`)
    return response(req.id)!
  }
  const baseHeaders = (origin = ORIGIN): [string, string][] => [
    ['host', HOST],
    ['origin', origin]
  ]
  const json = (r: FakeResponse) => JSON.parse(r.body)

  const describe: Harness['describe'] = async origin => {
    const r = await request({
      id: `d${++seq}`,
      method: 'GET',
      target: `/.well-known/brc-wallet?challenge=${CHALLENGE}`,
      headers: baseHeaders(origin)
    })
    if (r.status !== 200) throw new Error(`describe answered ${r.status}`)
    const d = json(r).descriptor
    return { instanceId: d.instanceId, continuityKey: d.continuityKey }
  }

  const launch: Harness['launch'] = async i => {
    native.emitLaunch(uriOf(i))
    await flush()
  }

  const connect: Harness['connect'] = async (i, o = {}) => {
    const origin = o.origin ?? ORIGIN
    await launch(i)
    const wallet = await describe(origin)
    const epoch = epochOf(i)
    const message = { wallet, epoch, origin, challenge: CHALLENGE, host: HOST, nonce: nOf(i) }
    const android: Record<string, string> = { launchProof: launchProof(kOf(i), message) }
    if (o.reconnectToken !== undefined) android.reconnectToken = o.reconnectToken
    const response = await request({
      id: `c${++seq}`,
      method: 'POST',
      target: '/.well-known/brc-wallet/connect',
      headers: [...baseHeaders(origin), ['content-type', 'application/json']],
      body: JSON.stringify({ epoch, challenge: CHALLENGE, ...wallet, android })
    })
    return {
      epoch,
      wallet,
      secret: bindingSecret(kOf(i), message),
      response
    }
  }

  const rpcRequest = (c: Connected, method: string, args: unknown, id: string, origin = ORIGIN) => ({
    id,
    method: 'POST',
    target: `/brc185/v1/rpc/${method}`,
    headers: [
      ...baseHeaders(origin),
      ['content-type', 'application/json'],
      ['brc-185-epoch', c.epoch],
      ['brc-185-instance', c.wallet.instanceId],
      ['brc-185-key', c.wallet.continuityKey],
      ['brc-185-android-binding', c.secret]
    ] as [string, string][],
    body: JSON.stringify(args ?? {})
  })

  const approve = async () => {
    await waitFor(() => consent.listPending().length === 1, 'a pending consent request')
    await answerConnection(consent.listPending()[0].requestId, true)
  }

  return {
    native,
    bridge,
    consent,
    attested,
    unverified,
    outcomes,
    publishAll,
    request,
    send,
    response,
    waitFor,
    describe,
    launch,
    connect,
    rpc: (c, method, args, o = {}) => request(rpcRequest(c, method, args, o.id ?? `r${++seq}`, o.origin)),
    sendRpc: (c, method, args, id, origin) => send(rpcRequest(c, method, args, id, origin)),
    approve,
    teardown() {
      bridge.dispose()
      detachHost?.()
      setConsentSheetSource(undefined)
      installDispatcher(undefined)
    }
  }
}

export const bodyOf = (r: FakeResponse) => JSON.parse(r.body)
export const headerOf = (r: FakeResponse, name: string) =>
  r.headers.find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1]

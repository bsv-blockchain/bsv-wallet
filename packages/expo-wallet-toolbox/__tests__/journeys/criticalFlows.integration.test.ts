/**
 * Cross-module journey, still in-process.
 *
 * Restore a known mnemonic, persist the identity in the real wallet schema,
 * derive a testnet receive address, build a P2PKH send with sendToAddress,
 * then deliver that same action through the BRC-100 bridge only after the
 * consent sheet is approved. Chain services are not called: createPublicHTTPSFetch
 * is a jest mock and fetch is rejected.
 */
jest.mock('expo-secure-store', () => require('../__mocks__/secureStoreFake').fake)
jest.mock('@bsv/sdk', () => {
  const actual = jest.requireActual('@bsv/sdk')
  return { ...actual, createPublicHTTPSFetch: jest.fn() }
})

import AsyncStorage from '@react-native-async-storage/async-storage'
import * as SecureStore from 'expo-secure-store'
import { P2PKH, PrivateKey } from '@bsv/sdk'
import { recoverMnemonicWallet } from '../../core/mnemonicWallet'
import { openTestDb } from '../__helpers__/nodeSqlite'
import { addressNetwork, isValidBsvAddress } from '../../core/pay/rails'
import { sendToAddress } from '../../core/pay/rails/address'
import { DEFAULT_SETTINGS } from '../../core/context/defaultWalletSettings'
import type { Binding } from '../../core/bridge/bindings'
import { createConsentStore, type ConsentStore, type KeyValue } from '../../core/bridge/consent'
import { createDispatcher, dispatch, installDispatcher } from '../../core/bridge/dispatcher'
import { answerConnection, setConsentSheetSource } from '../../core/bridge/consentSheetSource'
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

const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const ADMIN = 'admin.wallet'
const ORIGIN = 'https://pay.example'
const TXID = 'cd'.repeat(32)

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

describe('wallet lifecycle without a network', () => {
  const fetchSpy = jest.spyOn(global, 'fetch').mockRejectedValue(new Error('network disabled in tests'))

  afterAll(() => {
    fetchSpy.mockRestore()
  })

  test('restore, store the identity, receive on testnet, and build a P2PKH send', async () => {
    const restored = recoverMnemonicWallet(PHRASE)
    expect(restored.mnemonic).toBe(PHRASE)
    expect(restored.identityKey).toBe(recoverMnemonicWallet(PHRASE).identityKey)

    const opened = await openTestDb()
    try {
      await opened.kv.setKeyValue('identity', restored.identityKey)
      expect(await opened.kv.getKeyValue('identity')).toBe(restored.identityKey)
    } finally {
      opened.raw.close()
    }

    const address = new PrivateKey(restored.primaryKey).toPublicKey().toAddress('testnet')
    expect(isValidBsvAddress(address)).toBe(true)
    expect(addressNetwork(address)).toBe('test')

    const createAction = jest.fn(async (_args: Record<string, any>, _originator?: string) => ({}))
    await sendToAddress({
      wallet: { createAction } as never,
      adminOriginator: ADMIN,
      address,
      satoshis: 1_000,
      note: 'testnet fixture'
    })

    const [args, originator] = createAction.mock.calls[0]
    expect(originator).toBe(ADMIN)
    expect(args.outputs).toEqual([
      {
        lockingScript: new P2PKH().lock(address).toHex(),
        satoshis: 1000,
        outputDescription: 'BSV for recipient address'
      }
    ])
    expect(args.description).toBe('testnet fixture')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  test('BRC-100 createAction reaches the wallet only after the spend is approved', async () => {
    await AsyncStorage.clear()
    ;(SecureStore as unknown as { __reset: () => void }).__reset()
    resetBridgeRuntimeForTests()
    await initBridgeRuntime()
    const detachHost = attachBridgeHost({ withdrawPrompts: jest.fn() })
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
      id: 'loopback',
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

    const createAction = jest.fn(async (_args: Record<string, any>) => ({ txid: TXID }))
    const wallet = { createAction, getHeight: jest.fn(async () => ({ height: 1 })) }
    publish({
      attestedManager: { wallet: wallet as never, signing: {} as never },
      unverifiedManager: { wallet: wallet as never, signing: {} as never },
      readiness: 'ready',
      network: 'test',
      accountContext: 'e2e'
    })

    const restored = recoverMnemonicWallet(PHRASE)
    const address = new PrivateKey(restored.primaryKey).toPublicKey().toAddress('testnet')
    const built = jest.fn(async (_args: Record<string, any>) => ({}))
    await sendToAddress({
      wallet: { createAction: built } as never,
      adminOriginator: ADMIN,
      address,
      satoshis: 500
    })
    const payment = built.mock.calls[0][0]

    const binding: Binding = await getBindingRegistry().connectExplicit({
      epoch: 'epoch-journey',
      transportId: 'loopback',
      applicationOrigin: ORIGIN,
      attestation: 'unattested',
      instanceId: 'inst',
      continuityKey: 'ck',
      accountContext: getBridgeSnapshot().accountContext,
      walletRevision: getBridgeSnapshot().walletRevision,
      launchProofVerified: true
    })

    const pending = dispatch({
      transport: 'loopback',
      request: {
        epoch: binding.epoch,
        instanceId: 'inst',
        continuityKey: 'ck',
        origin: ORIGIN,
        method: 'createAction',
        args: { ...payment, options: { noSend: true, returnTXIDOnly: true } },
        sizeBytes: 400
      }
    })
    await new Promise(r => setTimeout(r, 0))
    expect(createAction).not.toHaveBeenCalled()
    expect(consent.listPending()).toHaveLength(1)

    await answerConnection(consent.listPending()[0].requestId, true)
    await expect(pending).resolves.toEqual({ ok: true, result: { txid: TXID } })

    const [args] = createAction.mock.calls[0]
    expect(args.outputs[0].lockingScript).toBe(new P2PKH().lock(address).toHex())
    expect(args.outputs[0].satoshis).toBe(500)
    expect(args.options).toEqual({ noSend: true, returnTXIDOnly: true })
    expect(fetchSpy).not.toHaveBeenCalled()

    setConsentSheetSource(undefined)
    installDispatcher(undefined)
    detachHost()
    resetBridgeRuntimeForTests()
  })

  test('shipped certifier descriptions stay inside the BRC-100 5–50 byte bound', () => {
    const utf8 = new TextEncoder()
    for (const certifier of DEFAULT_SETTINGS.trustSettings.trustedCertifiers) {
      const bytes = utf8.encode(certifier.description).length
      expect(bytes).toBeGreaterThanOrEqual(5)
      expect(bytes).toBeLessThanOrEqual(50)
    }
  })
})

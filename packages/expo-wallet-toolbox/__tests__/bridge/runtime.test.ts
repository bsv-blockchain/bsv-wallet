jest.mock('expo-secure-store', () => require('../__mocks__/secureStoreFake').fake)

import AsyncStorage from '@react-native-async-storage/async-storage'
import * as SecureStore from 'expo-secure-store'
import { runSessionTeardown } from '../../core/context/sessionTeardown'
import {
  assertBridgeHost,
  attachBridgeHost,
  computeAccountContext,
  getBindingRegistry,
  getBridgeSnapshot,
  initBridgeRuntime,
  onBindingClosed,
  onSnapshotChange,
  publish,
  registerConsentWithdrawal,
  registerTransport,
  resetBridgeRuntimeForTests,
  type BridgeManager,
  type PublishInput
} from '../../core/bridge/runtime'
import { hasUnattestedTransport } from '../../core/bridge/runtimeFlags'
import { isConnectionError } from '../../core/bridge/protocol/connectionError'

const manager = (): BridgeManager => ({ wallet: {} as any, signing: {} as any })

function publication(over: Partial<PublishInput> = {}): PublishInput {
  return {
    attestedManager: manager(),
    readiness: 'ready',
    network: 'main',
    accountContext: 'ctx',
    ...over
  }
}

function explicit(epoch: string) {
  return getBindingRegistry().connectExplicit({
    epoch,
    transportId: 't1',
    applicationOrigin: 'https://a.example',
    attestation: 'browser',
    instanceId: 'i',
    continuityKey: 'k',
    accountContext: 'ctx',
    walletRevision: getBridgeSnapshot().walletRevision
  })
}

const withdrawPrompts = jest.fn()
const withdrawConsent = jest.fn()
let detach: () => void

async function start() {
  await initBridgeRuntime()
  detach = attachBridgeHost({ withdrawPrompts })
  registerConsentWithdrawal(withdrawConsent)
}

beforeEach(async () => {
  await AsyncStorage.clear()
  ;(SecureStore as any).__reset()
  resetBridgeRuntimeForTests()
  withdrawPrompts.mockClear()
  withdrawConsent.mockClear()
})

afterEach(() => detach?.())

describe('bridge runtime', () => {
  it('no provider -> CONFIGURATION_ERROR', async () => {
    let caught: unknown
    try {
      assertBridgeHost()
    } catch (e) {
      caught = e
    }
    expect(isConnectionError(caught)).toBe(true)
    expect(caught).toMatchObject({ code: 'CONFIGURATION_ERROR', delivery: 'not-sent' })
    expect(getBridgeSnapshot().readiness).toBe('none')
    // Loaded but nothing attached is still unserved.
    await initBridgeRuntime()
    expect(() => assertBridgeHost()).toThrow()
  })

  it('first build after launch does not bump', async () => {
    await start()
    expect(getBridgeSnapshot().walletRevision).toBe('0')
    publish(publication())
    expect(getBridgeSnapshot().walletRevision).toBe('0')
    expect(withdrawPrompts).not.toHaveBeenCalled()
  })

  it('same-wallet rebuild bumps revision', async () => {
    await start()
    const first = manager()
    publish(publication({ attestedManager: first }))
    explicit('e1')
    const closed: string[] = []
    onBindingClosed(e => closed.push(`${e.epoch}:${e.reason}`))

    // Same identity key and network (so the same account context), a new manager object.
    const second = manager()
    publish(publication({ attestedManager: second }))

    expect(getBridgeSnapshot().walletRevision).toBe('1')
    expect(closed).toEqual(['e1:account-changed'])
    expect(getBindingRegistry().live()).toHaveLength(0)
    expect(withdrawPrompts).toHaveBeenCalledTimes(1)
    expect(withdrawPrompts.mock.calls[0][0]).toEqual([first.signing])
    expect(withdrawConsent).toHaveBeenCalled()
    // Persisted, install-wide.
    await Promise.resolve()
    expect(await AsyncStorage.getItem('bsv-bridge-wallet-revision')).toBe('1')

    // Publishing the same manager again is not a replacement.
    publish(publication({ attestedManager: second, readiness: 'building' }))
    expect(getBridgeSnapshot().walletRevision).toBe('1')
  })

  it('reads the persisted revision on the next launch and does not bump on its first build', async () => {
    await AsyncStorage.setItem('bsv-bridge-wallet-revision', '7')
    await start()
    expect(getBridgeSnapshot().walletRevision).toBe('7')
    publish(publication())
    expect(getBridgeSnapshot().walletRevision).toBe('7')
  })

  it('profile switch closes bindings and withdraws prompts', async () => {
    await start()
    const a = manager()
    publish(publication({ attestedManager: a }))
    explicit('e1')
    explicit('e2')

    // WalletContext tears down, then the new profile's wallet is built and published.
    runSessionTeardown('profile')
    expect(getBindingRegistry().live()).toHaveLength(0)
    expect(withdrawConsent).toHaveBeenCalled()

    const b = manager()
    publish(publication({ attestedManager: b, accountContext: 'ctx-b' }))
    expect(withdrawPrompts).toHaveBeenCalledWith([a.signing])
    expect(getBridgeSnapshot()).toMatchObject({ walletRevision: '1', accountContext: 'ctx-b' })
  })

  it('withdraws the unverified manager too', async () => {
    await start()
    const a = manager()
    const u = manager()
    publish(publication({ attestedManager: a, unverifiedManager: u }))
    publish(publication({ attestedManager: manager(), unverifiedManager: manager() }))
    expect(withdrawPrompts.mock.calls[0][0]).toEqual(expect.arrayContaining([a.signing, u.signing]))
  })

  it('snapshot change events', async () => {
    await start()
    const m = manager()
    const seen: string[] = []
    const off = onSnapshotChange(s => seen.push(`${s.readiness}:${s.closeSeq}:${s.walletRevision}`))
    publish(publication({ attestedManager: m, readiness: 'building' }))
    publish(publication({ attestedManager: m, readiness: 'building' })) // no change
    expect(seen).toEqual(['building:0:0'])
    publish(publication({ attestedManager: m, readiness: 'ready' }))
    explicit('e1')
    getBindingRegistry().close('e1', 'revoked')
    expect(seen).toEqual(['building:0:0', 'ready:0:0', 'ready:1:0'])
    expect(getBridgeSnapshot()).toMatchObject({ schema: 1, closeSeq: 1 })
    off()
    publish(publication({ attestedManager: m, readiness: 'blocked' }))
    expect(seen).toHaveLength(3)
  })

  it('install secret deleted at logout rotates account context', async () => {
    await start()
    const before = await computeAccountContext('02aa', 'main')
    expect(await computeAccountContext('02aa', 'main')).toBe(before)
    expect(await computeAccountContext('02aa', 'test')).not.toBe(before)
    expect(await computeAccountContext('02bb', 'main')).not.toBe(before)
    expect(before).toMatch(/^[0-9a-f]{64}$/)

    runSessionTeardown('logout')
    await new Promise(r => setTimeout(r, 0))
    expect(await computeAccountContext('02aa', 'main')).not.toBe(before)
  })

  it('a profile switch keeps the install secret', async () => {
    await start()
    const before = await computeAccountContext('02aa', 'main')
    runSessionTeardown('profile')
    await new Promise(r => setTimeout(r, 0))
    expect(await computeAccountContext('02aa', 'main')).toBe(before)
  })

  it('detaching the provider closes bindings and reports no readiness', async () => {
    await start()
    publish(publication())
    explicit('e1')
    detach()
    expect(getBindingRegistry().live()).toHaveLength(0)
    expect(getBridgeSnapshot().readiness).toBe('none')
    expect(() => assertBridgeHost()).toThrow()
  })

  describe('registerTransport', () => {
    const base = { id: 't1', requestAttention: jest.fn() }

    it('refuses unattested + implicit', async () => {
      await start()
      expect(() =>
        registerTransport({
          ...base,
          attestation: 'unattested',
          bindingMode: 'implicit',
          deliverReconnectToken: jest.fn()
        })
      ).toThrow(expect.objectContaining({ code: 'CONFIGURATION_ERROR' }))
      expect(hasUnattestedTransport()).toBe(false)
    })

    it('refuses unattested without deliverReconnectToken', async () => {
      await start()
      expect(() => registerTransport({ ...base, attestation: 'unattested', bindingMode: 'explicit' })).toThrow(
        expect.objectContaining({ code: 'CONFIGURATION_ERROR' })
      )
    })

    it('refuses a browser transport that delivers tokens, a missing requestAttention and a duplicate id', async () => {
      await start()
      expect(() =>
        registerTransport({
          ...base,
          attestation: 'browser',
          bindingMode: 'implicit',
          deliverReconnectToken: jest.fn()
        })
      ).toThrow()
      expect(() => registerTransport({ id: 'x', attestation: 'browser', bindingMode: 'implicit' } as any)).toThrow()
      const h = registerTransport({ ...base, attestation: 'browser', bindingMode: 'implicit' })
      expect(() => registerTransport({ ...base, attestation: 'browser', bindingMode: 'implicit' })).toThrow()
      h.unregister()
      registerTransport({ ...base, attestation: 'browser', bindingMode: 'implicit' }).unregister()
    })

    it('flags and unflags the unverified manager need, and forwards closes to its transport', async () => {
      await start()
      const onClosed = jest.fn()
      const h = registerTransport({
        ...base,
        attestation: 'unattested',
        bindingMode: 'explicit',
        deliverReconnectToken: jest.fn(),
        onClosed
      })
      expect(hasUnattestedTransport()).toBe(true)
      publish(publication())
      explicit('e1')
      getBindingRegistry().close('e1', 'revoked')
      expect(onClosed).toHaveBeenCalledWith(expect.objectContaining({ epoch: 'e1', reason: 'revoked', closeSeq: 1 }))
      h.unregister()
      expect(hasUnattestedTransport()).toBe(false)
    })
  })
})

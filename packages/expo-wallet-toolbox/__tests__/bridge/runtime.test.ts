jest.mock('expo-secure-store', () => require('../__mocks__/secureStoreFake').fake)

import { Hash, Utils } from '@bsv/sdk'
import AsyncStorage from '@react-native-async-storage/async-storage'
import * as SecureStore from 'expo-secure-store'
import { runSessionTeardown } from '../../core/context/sessionTeardown'
import {
  assertBridgeHost,
  attachBridgeHost,
  computeAccountContext,
  getBindingRegistry,
  getBridgeSnapshot,
  getPublishedManagers,
  getTransport,
  initBridgeRuntime,
  listConnectedSites,
  notifyPromptRaised,
  getPermissionPolicy,
  revokeSite,
  setActiveConsent,
  setPermissionPolicy,
  onBindingClosed,
  onSnapshotChange,
  publish,
  registerConsentWithdrawal,
  registerTransport,
  resetBridgeRuntimeForTests,
  type BridgeManager,
  type PublishInput
} from '../../core/bridge/runtime'
import type { ConnectedSite } from '../../core/bridge/consent'
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
  if (!getTransport('t1')) {
    registerTransport({ id: 't1', attestation: 'browser', bindingMode: 'explicit', requestAttention: jest.fn() })
  }
  return getBindingRegistry().connectExplicit({
    epoch,
    transportId: 't1',
    applicationOrigin: 'https://a.example',
    attestation: getTransport('t1')!.attestation,
    launchProofVerified: true,
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

  it('walletRevision bumps on profile, network and rebuild manager replacement', async () => {
    await start()
    publish(publication())
    expect(getBridgeSnapshot().walletRevision).toBe('0')
    // The three replacement causes all end in the provider publishing a new manager object,
    // whatever teardown preceded it; the revision is install-wide and monotonic.
    for (const [i, reason] of (['profile', 'network', 'rebuild'] as const).entries()) {
      runSessionTeardown(reason)
      publish(publication({ attestedManager: manager(), network: reason === 'network' ? 'test' : 'main' }))
      expect(getBridgeSnapshot().walletRevision).toBe(String(i + 1))
    }
    expect(await AsyncStorage.getItem('bsv-bridge-wallet-revision')).toBe('3')
  })

  it('attach on an install with a wallet is building from attach until first publish, never none', async () => {
    await initBridgeRuntime()
    const seen: string[] = []
    onSnapshotChange(s => seen.push(s.readiness))
    detach = attachBridgeHost({ withdrawPrompts, hasWallet: true })
    expect(getBridgeSnapshot().readiness).toBe('building')
    expect(seen).not.toContain('none')
    publish(publication({ readiness: 'building' }))
    expect(getBridgeSnapshot().readiness).toBe('building')
    publish(publication({ readiness: 'ready' }))
    expect(getBridgeSnapshot().readiness).toBe('ready')
    expect(seen).not.toContain('none')
  })

  it('attach without a wallet stays none', async () => {
    await start()
    expect(getBridgeSnapshot().readiness).toBe('none')
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

describe('session teardown', () => {
  it("logout sweeps every profile's connected-sites key, and only logout does", async () => {
    await start()
    await AsyncStorage.setItem('bsv-bridge-sites', '{"records":[]}')
    await AsyncStorage.setItem('bsv-bridge-sites:__p1', '{"records":[]}')
    await AsyncStorage.setItem('unrelated', 'x')
    runSessionTeardown('profile')
    await new Promise(r => setTimeout(r, 0))
    expect(await AsyncStorage.getItem('bsv-bridge-sites:__p1')).not.toBeNull()
    runSessionTeardown('logout')
    await new Promise(r => setTimeout(r, 0))
    expect(await AsyncStorage.getItem('bsv-bridge-sites')).toBeNull()
    expect(await AsyncStorage.getItem('bsv-bridge-sites:__p1')).toBeNull()
    expect(await AsyncStorage.getItem('unrelated')).toBe('x')
  })

  it.each(['rebuild', 'network', 'profile'] as const)(
    '%s closes the bindings and drops the published managers at once, before the wallet is gone',
    async reason => {
      await start()
      publish(publication())
      explicit('e1')
      expect(getPublishedManagers().attested).toBeDefined()
      runSessionTeardown(reason)
      expect(getBindingRegistry().live()).toHaveLength(0)
      expect(getPublishedManagers()).toEqual({ attested: undefined, unverified: undefined })
      expect(getBridgeSnapshot().readiness).toBe('building')
      expect(withdrawConsent).toHaveBeenCalled()
    }
  )

  it('the next build after a rebuild teardown is still a wallet replacement', async () => {
    await start()
    publish(publication())
    runSessionTeardown('rebuild')
    publish(publication())
    expect(getBridgeSnapshot()).toMatchObject({ walletRevision: '1', readiness: 'ready' })
  })
})

describe('connected sites and permission policy APIs', () => {
  function stubConsent() {
    const calls: string[] = []
    const key = Utils.toArray('k'.repeat(32), 'utf8')
    return {
      calls,
      consent: {
        store: {
          listConnectedSites: jest.fn(
            async (): Promise<ConnectedSite[]> => [
              {
                applicationOrigin: 'https://a.example',
                originator: 'a.example',
                attestation: 'browser',
                transport: 'tb',
                approvedAt: 1
              }
            ]
          ),
          revokeSite: jest.fn(async (o: string, a: string) => void calls.push(`revoke ${o} ${a}`)),
          dropRequestsFor: jest.fn()
        },
        adminWallet: {
          createHmac: async (a: any) => ({ hmac: Hash.sha256hmac(key, a.data) }),
          verifyHmac: async (a: any) => ({
            valid: Utils.toHex(Hash.sha256hmac(key, a.data)) === Utils.toHex(a.hmac)
          })
        } as any,
        adminOriginator: 'admin.test',
        profileKey: () => ''
      }
    }
  }

  it('listConnectedSites reads the live store, and is empty without one', async () => {
    await start()
    expect(await listConnectedSites()).toEqual([])
    const { consent } = stubConsent()
    setActiveConsent(consent)
    expect(await listConnectedSites()).toHaveLength(1)
  })

  it("revokeSite deletes the record and closes only that origin's bindings of that attestation", async () => {
    await start()
    const { consent, calls } = stubConsent()
    setActiveConsent(consent)
    publish(publication())
    registerTransport({ id: 'tb', attestation: 'browser', bindingMode: 'explicit', requestAttention: jest.fn() })
    registerTransport({
      id: 'tu',
      attestation: 'unattested',
      bindingMode: 'explicit',
      requestAttention: jest.fn(),
      deliverReconnectToken: jest.fn()
    })
    const connect = (epoch: string, transportId: string, origin: string, attestation: 'browser' | 'unattested') =>
      getBindingRegistry().connectExplicit({
        epoch,
        transportId,
        applicationOrigin: origin,
        attestation,
        launchProofVerified: true,
        instanceId: 'i',
        continuityKey: 'k',
        accountContext: 'ctx',
        walletRevision: '0'
      })
    connect('e-browser', 'tb', 'https://a.example', 'browser')
    connect('e-unverified', 'tu', 'https://a.example', 'unattested')
    connect('e-other', 'tb', 'https://b.example', 'browser')
    const closes: string[] = []
    onBindingClosed(e => closes.push(`${e.epoch}:${e.reason}`))

    await revokeSite('https://a.example', 'unattested')
    expect(calls).toEqual(['revoke https://a.example unattested'])
    expect(closes).toEqual(['e-unverified:revoked'])
    expect(
      getBindingRegistry()
        .live()
        .map(b => b.epoch)
        .sort()
    ).toEqual(['e-browser', 'e-other'])

    await revokeSite('https://a.example', 'browser')
    expect(closes).toEqual(['e-unverified:revoked', 'e-browser:revoked'])
  })

  it('revokeSite without a mounted store is CONFIGURATION_ERROR', async () => {
    await start()
    await expect(revokeSite('https://a.example', 'browser')).rejects.toMatchObject({ code: 'CONFIGURATION_ERROR' })
  })

  it('a stored policy round-trips through set/get and changes the effective flags', async () => {
    await start()
    setActiveConsent(stubConsent().consent)
    expect((await getPermissionPolicy()).verified.seekBasketListingPermissions).toBe(false)
    const base = await getPermissionPolicy()
    await setPermissionPolicy({
      verified: { ...base.verified, seekBasketListingPermissions: true },
      unverified: base.unverified
    })
    expect((await getPermissionPolicy()).verified.seekBasketListingPermissions).toBe(true)
  })
})

describe('closeSeq across a restart', () => {
  it('the snapshot starts from the persisted ring, not from 0', async () => {
    await start()
    publish(publication())
    explicit('e1')
    explicit('e2')
    getBindingRegistry().close('e1', 'lost')
    getBindingRegistry().close('e2', 'revoked')
    expect(getBridgeSnapshot().closeSeq).toBe(2)
    await getBindingRegistry().flush()
    detach()

    // A new process: same storage, fresh runtime state.
    resetBridgeRuntimeForTests()
    await initBridgeRuntime()
    expect(getBridgeSnapshot().closeSeq).toBe(2)
    expect(getBindingRegistry().closeSeq()).toBe(2)
  })
})

describe('requestAttention for a parked manager prompt (6.2)', () => {
  async function bound(originator: string) {
    await start()
    publish(publication())
    const requestAttention = jest.fn()
    registerTransport({ id: 'tp', attestation: 'browser', bindingMode: 'explicit', requestAttention })
    const b = getBindingRegistry().connectExplicit({
      epoch: 'e1',
      transportId: 'tp',
      applicationOrigin: 'https://a.example',
      attestation: 'browser',
      instanceId: 'i',
      continuityKey: 'k',
      accountContext: 'ctx',
      walletRevision: '0'
    })
    getBindingRegistry().markConsented(b.epoch, originator)
    return { requestAttention, binding: b }
  }

  it('asks the transport for attention when the app is backgrounded', async () => {
    const { requestAttention, binding } = await bound('a.example')
    notifyPromptRaised('a.example', () => false)
    expect(requestAttention).toHaveBeenCalledWith('prompt', binding)
  })

  it('does nothing in the foreground, for another originator, or without a live binding', async () => {
    const { requestAttention } = await bound('a.example')
    notifyPromptRaised('a.example', () => true)
    notifyPromptRaised('b.example', () => false)
    getBindingRegistry().close('e1', 'lost')
    notifyPromptRaised('a.example', () => false)
    expect(requestAttention).not.toHaveBeenCalled()
  })

  it('defaults to the real AppState', async () => {
    const { requestAttention } = await bound('a.example')
    const { AppState } = require('react-native')
    const original = AppState.currentState
    try {
      AppState.currentState = 'background'
      notifyPromptRaised('a.example')
      AppState.currentState = 'active'
      notifyPromptRaised('a.example')
    } finally {
      AppState.currentState = original
    }
    expect(requestAttention).toHaveBeenCalledTimes(1)
  })
})

describe('onPromptRaised (6.15 item 5)', () => {
  async function boundWith(originator: string, onPromptRaised: any, id = 'tp', instanceId = 'i') {
    registerTransport({
      id,
      attestation: 'browser',
      bindingMode: 'explicit',
      requestAttention: jest.fn(),
      onPromptRaised
    })
    const b = getBindingRegistry().connectExplicit({
      epoch: 'e-' + id,
      transportId: id,
      applicationOrigin: 'https://a.example',
      attestation: 'browser',
      instanceId,
      continuityKey: 'k',
      accountContext: 'ctx',
      walletRevision: '0'
    })
    getBindingRegistry().markConsented(b.epoch, originator)
    return b
  }

  it('fires in the foreground', async () => {
    await start()
    publish(publication())
    const onPromptRaised = jest.fn()
    const b = await boundWith('a.example', onPromptRaised)
    notifyPromptRaised('a.example', () => true)
    expect(onPromptRaised).toHaveBeenCalledTimes(1)
    expect(onPromptRaised).toHaveBeenCalledWith(b)
  })

  it('fires only for bindings of that originator', async () => {
    await start()
    publish(publication())
    const mine = jest.fn()
    const other = jest.fn()
    await boundWith('a.example', mine, 'ta', 'i1')
    await boundWith('b.example', other, 'tb', 'i2')
    notifyPromptRaised('a.example', () => true)
    expect(mine).toHaveBeenCalledTimes(1)
    expect(other).not.toHaveBeenCalled()
  })

  it('requestAttention prompt still skipped when active', async () => {
    await start()
    publish(publication())
    const requestAttention = jest.fn()
    registerTransport({
      id: 'tp',
      attestation: 'browser',
      bindingMode: 'explicit',
      requestAttention,
      onPromptRaised: jest.fn()
    })
    const b = getBindingRegistry().connectExplicit({
      epoch: 'e1',
      transportId: 'tp',
      applicationOrigin: 'https://a.example',
      attestation: 'browser',
      instanceId: 'i',
      continuityKey: 'k',
      accountContext: 'ctx',
      walletRevision: '0'
    })
    getBindingRegistry().markConsented(b.epoch, 'a.example')
    notifyPromptRaised('a.example', () => true)
    expect(requestAttention).not.toHaveBeenCalled()
    notifyPromptRaised('a.example', () => false)
    expect(requestAttention).toHaveBeenCalledWith('prompt', b)
  })

  it('a throwing onPromptRaised does not stop the others', async () => {
    await start()
    publish(publication())
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
    const thrower = jest.fn(() => {
      throw new Error('boom')
    })
    const ok = jest.fn()
    await boundWith('a.example', thrower, 'ta', 'i1')
    await boundWith('a.example', ok, 'tb', 'i2')
    expect(() => notifyPromptRaised('a.example', () => true)).not.toThrow()
    expect(thrower).toHaveBeenCalledTimes(1)
    expect(ok).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })
})

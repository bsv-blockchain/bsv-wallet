jest.mock('expo-secure-store', () => require('../../expo-wallet-toolbox/__tests__/__mocks__/secureStoreFake').fake)
jest.mock(
  'expo-local-authentication',
  () => require('../../expo-wallet-toolbox/__tests__/__mocks__/localAuthFake').fake
)
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: '3rdParty', init: () => {} }
}))
jest.mock('../src/native', () => ({ getBsvAndroidBridge: () => (globalThis as any).__fakeAndroidNative }))

import { AppRegistry, Platform } from 'react-native'
import { configureToolbox, resetToolboxConfig } from '@bsv/expo-wallet-toolbox/core/toolboxConfig'
import { runSessionTeardown } from '@bsv/expo-wallet-toolbox/core/context/sessionTeardown'
import {
  getBindingRegistry,
  getTransport,
  resetBridgeRuntimeForTests
} from '@bsv/expo-wallet-toolbox/core/bridge/runtime'
import { __resetSheetRootRegistrationForTests } from '../src/ui/registerSheetRoot'
import { __resetAndroidBridgeForTests, getAndroidBridge, setupAndroidBridge } from '../src/setup'
import { ANDROID_TRANSPORT_ID } from '../src'
import { createFakeNative } from '../src/testing/fakeNative'
import { flush, uriOf } from './controller/support'
import { createHarness, type Harness } from './bridgeHarness'

const originalOS = Platform.OS
const setOS = (os: string) => Object.defineProperty(Platform, 'OS', { value: os, configurable: true })

afterEach(() => {
  getAndroidBridge()?.dispose()
  __resetAndroidBridgeForTests()
  setOS(originalOS)
  delete (globalThis as any).__fakeAndroidNative
  resetToolboxConfig()
  ;(globalThis as any).__DEV__ = true
  resetBridgeRuntimeForTests()
})

describe('setupAndroidBridge', () => {
  it('setupAndroidBridge twice registers once', () => {
    setOS('android')
    ;(globalThis as any).__fakeAndroidNative = createFakeNative()
    setupAndroidBridge({ appName: 'Test Wallet', vendor: 'org.test' })
    const first = getAndroidBridge()
    expect(first).toBeDefined()
    expect(getTransport(ANDROID_TRANSPORT_ID)).toMatchObject({ attestation: 'unattested', bindingMode: 'explicit' })
    expect(() => setupAndroidBridge({ appName: 'Test Wallet', vendor: 'org.test' })).not.toThrow()
    expect(getAndroidBridge()).toBe(first)
  })

  it('setupAndroidBridge registers the sheet root on android and not on ios, before it returns', () => {
    const spy = jest.spyOn(AppRegistry, 'registerComponent').mockImplementation(() => 'x')
    try {
      __resetSheetRootRegistrationForTests()
      setOS('ios')
      ;(globalThis as any).__fakeAndroidNative = createFakeNative()
      setupAndroidBridge({ appName: 'Test Wallet', vendor: 'org.test' })
      expect(spy).not.toHaveBeenCalled()
      setOS('android')
      setupAndroidBridge({ appName: 'Test Wallet', vendor: 'org.test' })
      expect(spy.mock.calls.map(c => c[0])).toEqual(['BsvBridgeSheet'])
    } finally {
      spy.mockRestore()
      __resetSheetRootRegistrationForTests()
    }
  })

  it('does nothing off Android and opens no port', () => {
    setOS('ios')
    const native = createFakeNative()
    ;(globalThis as any).__fakeAndroidNative = native
    setupAndroidBridge({ appName: 'Test Wallet', vendor: 'org.test' })
    expect(getAndroidBridge()).toBeUndefined()
    expect(getTransport(ANDROID_TRANSPORT_ID)).toBeUndefined()
    expect(native.calls.map(c => c.name)).toEqual([])
  })

  it('drains a launch left by a cold start and arms from it', async () => {
    setOS('android')
    const native = createFakeNative()
    native.pushLaunch(uriOf(1), 5_000)
    ;(globalThis as any).__fakeAndroidNative = native
    setupAndroidBridge({ appName: 'Test Wallet', vendor: 'org.test' })
    await flush()
    // The launch is live, so the session arms (service, then listener). 'does nothing off Android' shows nothing else starts one.
    expect(native.calls.map(c => c.name)).toEqual(expect.arrayContaining(['ensureService', 'startServer']))
  })

  it('logout teardown runs the reset', async () => {
    setOS('android')
    const native = createFakeNative()
    ;(globalThis as any).__fakeAndroidNative = native
    setupAndroidBridge({ appName: 'Test Wallet', vendor: 'org.test' })
    const spy = jest.spyOn(getAndroidBridge()!, 'reset')
    runSessionTeardown('logout')
    await flush()
    expect(spy).toHaveBeenCalledTimes(1)
    expect(getBindingRegistry().live()).toEqual([])
  })
})

describe('allowLocalhostHttp', () => {
  let h: Harness | undefined
  afterEach(() => {
    h?.teardown()
    h = undefined
  })
  const LOCAL = 'http://localhost:3000'
  const connectLocal = async (t: Harness) => {
    await t.launch(1)
    return t.request({
      id: 'local-d',
      method: 'GET',
      target: `/.well-known/brc-wallet?challenge=${'A'.repeat(43)}`,
      headers: [
        ['host', '127.0.0.1:3321'],
        ['origin', LOCAL]
      ]
    })
  }

  it('true reaches both configureToolbox and the router env: a development build accepts http://localhost', async () => {
    configureToolbox({ backupUrl: null, browserBridge: { allowLocalhostHttp: true } })
    h = await createHarness()
    const c = await h.connect(1, { origin: LOCAL })
    // The core registry uses the same flag, so the binding exists, not only the router's describe.
    expect(c.response.status).toBe(200)
    expect(
      getBindingRegistry()
        .live()
        .map(b => b.applicationOrigin)
    ).toEqual([LOCAL])
  })

  it('is false in a non-DEV build', async () => {
    configureToolbox({ backupUrl: null, browserBridge: { allowLocalhostHttp: true } })
    ;(globalThis as any).__DEV__ = false
    h = await createHarness()
    expect((await connectLocal(h)).status).toBe(403)
  })

  it('is false when the host did not state it, and the kit option can switch it off', async () => {
    h = await createHarness()
    expect((await connectLocal(h)).status).toBe(403)
    h.teardown()
    configureToolbox({ backupUrl: null, browserBridge: { allowLocalhostHttp: true } })
    h = await createHarness({ deps: { allowLocalhostHttp: false } })
    expect((await connectLocal(h)).status).toBe(403)
  })
})

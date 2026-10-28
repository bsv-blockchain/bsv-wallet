jest.mock('expo-secure-store', () => require('../../expo-wallet-toolbox/__tests__/__mocks__/secureStoreFake').fake)

import AsyncStorage from '@react-native-async-storage/async-storage'
import * as SecureStore from 'expo-secure-store'
import React from 'react'
import { AppState, Linking } from 'react-native'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import * as inbox from '@bsv/expo-wallet-toolbox/core/bridge/inbox'
import { runSessionTeardown } from '@bsv/expo-wallet-toolbox/core/context/sessionTeardown'
import {
  attachBridgeHost,
  getTransport,
  initBridgeRuntime,
  publish,
  registerTransport,
  resetBridgeRuntimeForTests
} from '@bsv/expo-wallet-toolbox/core/bridge/runtime'
import { SafariBridgeHost } from '../src/SafariBridgeHost'
import { createFakeNative, type FakeNative } from '../src/testing/fakeNative'
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const SCHEME = 'org.bsvblockchain.wallet'
const tick = () => new Promise(r => setTimeout(r, 0))
const settle = async (n = 8) => {
  for (let i = 0; i < n; i++) await act(async () => void (await tick()))
}

let native: FakeNative
let detach: (() => void) | undefined
let tree: ReactTestRenderer | undefined
let urlHandlers: Array<(e: { url: string }) => void>
let appStateHandlers: Array<(s: string) => void>
let initialUrl: string | null
let processors: Array<{ recover: jest.Mock; processPending: jest.Mock; sweepExpired: jest.Mock; dispose: jest.Mock }>
let processPendingImpl: () => Promise<void>

const getKey = jest.fn(async () => null)

function mount(n: FakeNative = native) {
  act(() => {
    tree = create(<SafariBridgeHost native={n} getIdentityKey={getKey} />)
  })
  return tree!
}
async function unmount() {
  if (tree) await act(async () => tree!.unmount())
  tree = undefined
}
async function attach() {
  await initBridgeRuntime()
  detach = attachBridgeHost({ withdrawPrompts: () => undefined })
}

beforeEach(async () => {
  jest.restoreAllMocks()
  await AsyncStorage.clear()
  ;(SecureStore as any).__reset()
  resetBridgeRuntimeForTests()
  native = createFakeNative({ scheme: SCHEME })
  urlHandlers = []
  appStateHandlers = []
  initialUrl = null
  processors = []
  processPendingImpl = async () => undefined
  jest.spyOn(Linking, 'addEventListener').mockImplementation(((_: string, h: any) => {
    urlHandlers.push(h)
    return { remove: () => void urlHandlers.splice(urlHandlers.indexOf(h), 1) }
  }) as any)
  jest.spyOn(Linking, 'getInitialURL').mockImplementation(async () => initialUrl)
  jest.spyOn(AppState, 'addEventListener').mockImplementation(((_: string, h: any) => {
    appStateHandlers.push(h)
    return { remove: () => void appStateHandlers.splice(appStateHandlers.indexOf(h), 1) }
  }) as any)
  ;(AppState as any).currentState = 'active'
  const real = inbox.createInboxProcessor
  jest.spyOn(inbox, 'createInboxProcessor').mockImplementation(deps => {
    const p = real(deps)
    const wrapped = {
      recover: jest.fn(() => p.recover()),
      processPending: jest.fn(() => processPendingImpl()),
      sweepExpired: jest.fn(() => p.sweepExpired()),
      flushEvents: () => p.flushEvents(),
      dispose: jest.fn(() => p.dispose())
    }
    processors.push(wrapped)
    return wrapped as any
  })
})

afterEach(async () => {
  await unmount()
  detach?.()
  detach = undefined
})

describe('SafariBridgeHost', () => {
  it('registration precedes the processor and unregisters on remount (duplicate id never throws)', async () => {
    const order: string[] = []
    const real = inbox.createInboxProcessor as any
    ;(inbox.createInboxProcessor as jest.Mock).mockImplementation(d => {
      order.push(`processor:${getTransport('safari-extension') ? 'registered' : 'missing'}`)
      return real.getMockImplementation ? real(d) : real(d)
    })
    await attach()
    mount()
    await settle()
    expect(getTransport('safari-extension')).toMatchObject({ attestation: 'browser', bindingMode: 'implicit' })
    expect(order[0]).toBe('processor:registered')
    await unmount()
    expect(getTransport('safari-extension')).toBeUndefined()
    mount()
    await settle()
    expect(getTransport('safari-extension')).toBeDefined()
  })

  it('deliverReconnectToken is never passed', async () => {
    await attach()
    mount()
    await settle()
    expect(getTransport('safari-extension')!.deliverReconnectToken).toBeUndefined()
  })

  it('a wake before attach waits', async () => {
    mount()
    await settle()
    expect(getTransport('safari-extension')).toBeUndefined()
    expect(processors).toHaveLength(0)
    await attach()
    await act(async () => {
      await new Promise(r => setTimeout(r, 120))
    })
    await settle()
    expect(getTransport('safari-extension')).toBeDefined()
    expect(processors).toHaveLength(1)
    expect(processors[0].processPending).toHaveBeenCalled()
  })

  it('a wake while building or blocked parks with no deadline and no CONFIGURATION_ERROR; only none fails', async () => {
    await attach()
    publish({ readiness: 'building', network: 'main', accountContext: 'ctx' } as any)
    mount()
    await settle()
    // The host adds nothing of its own: no result is written for anything while building.
    expect(await native.list('done', Date.now())).toEqual([])
    expect(processors[0].processPending).toHaveBeenCalled()
    // The park-versus-fail decision is the processor's (P1 inbox tests pin it); the host never short-circuits.
    expect(await native.list('pending', Date.now())).toEqual([])
  })

  it('url handler nudges and never awaits processPending', async () => {
    await attach()
    mount()
    await settle()
    let release!: () => void
    processPendingImpl = () => new Promise<void>(r => (release = r))
    const before = processors[0].processPending.mock.calls.length
    expect(() => urlHandlers.forEach(h => h({ url: `${SCHEME}://bridge?v=1&n=zz` }))).not.toThrow()
    await settle(3)
    expect(processors[0].processPending.mock.calls.length).toBe(before + 1)
    release()
  })

  it.each([
    ['wrong scheme', 'other.app://bridge?v=1'],
    ['wrong host', `${SCHEME}://pay?v=1`],
    ['v missing', `${SCHEME}://bridge?n=1`],
    ['v=2', `${SCHEME}://bridge?v=2`]
  ])('url table: %s does not drain', async (_n, url) => {
    await attach()
    mount()
    await settle()
    const before = processors[0].processPending.mock.calls.length
    urlHandlers.forEach(h => h({ url }))
    await settle(3)
    expect(processors[0].processPending.mock.calls.length).toBe(before)
  })

  it('extra params with the nonce ignored still drain', async () => {
    await attach()
    mount()
    await settle()
    const before = processors[0].processPending.mock.calls.length
    urlHandlers.forEach(h => h({ url: `${SCHEME}://bridge?v=1&n=ignored&x=y` }))
    await settle(3)
    expect(processors[0].processPending.mock.calls.length).toBe(before + 1)
  })

  it('singleton processor under Fast Refresh and recover() runs once', async () => {
    await attach()
    const first = mount()
    await settle()
    // A second mount of the same native (Fast Refresh, a remounted subtree) shares the instance.
    let second!: ReactTestRenderer
    act(() => {
      second = create(<SafariBridgeHost native={native} getIdentityKey={getKey} />)
    })
    await settle()
    expect(processors).toHaveLength(1)
    expect(processors[0].recover).toHaveBeenCalledTimes(1)
    await act(async () => second.unmount())
    expect(getTransport('safari-extension')).toBeDefined()
    expect(processors[0].dispose).not.toHaveBeenCalled()
    await act(async () => first.unmount())
    tree = undefined
    expect(processors[0].dispose).toHaveBeenCalledTimes(1)
    expect(getTransport('safari-extension')).toBeUndefined()
  })

  it('unmounting before startup finishes registers nothing', async () => {
    mount()
    await unmount()
    await attach()
    await act(async () => {
      await new Promise(r => setTimeout(r, 120))
    })
    expect(getTransport('safari-extension')).toBeUndefined()
    expect(processors).toHaveLength(0)
  })

  it('logout hook disables the writer then reset() synchronously with no await', async () => {
    await attach()
    const resetSpy = jest.spyOn(native, 'reset')
    const writeMirror = jest.spyOn(native, 'writeMirror')
    mount()
    await settle()
    const writesBefore = writeMirror.mock.calls.length
    runSessionTeardown('logout')
    // Both happened before the next await.
    expect(resetSpy).toHaveBeenCalledTimes(1)
    await settle()
    expect(writeMirror.mock.calls.length).toBe(writesBefore)
    expect(getTransport('safari-extension')).toBeUndefined()
  })

  it('Delete Wallet reaches the hook once', async () => {
    await attach()
    const resetSpy = jest.spyOn(native, 'reset')
    mount()
    await settle()
    const logout = () => runSessionTeardown('logout')
    logout()
    expect(resetSpy).toHaveBeenCalledTimes(1)
    logout()
    expect(resetSpy).toHaveBeenCalledTimes(1)
  })

  it('late writeEvent and writeResult after reset reject and are swallowed; no mirror or key recreated until the next init', async () => {
    await attach()
    mount()
    await settle()
    runSessionTeardown('logout')
    await expect(native.writeEvent(1, '{}', 1)).rejects.toMatchObject({ code: 'ERR_RESET' })
    await expect(native.writeResult('a'.repeat(32), 'AA==', 1)).rejects.toMatchObject({ code: 'ERR_RESET' })
    await expect(native.writeMirror('AA==')).rejects.toMatchObject({ code: 'ERR_RESET' })
    await settle()
    expect(native.readMirrorSync()).toBeNull()
    await act(async () => {
      urlHandlers.forEach(h => h({ url: `${SCHEME}://bridge?v=1` }))
    })
    await settle()
    expect(native.readMirrorSync()).toBeNull()
  })

  it('restarts after a reset once a new wallet appears, not before', async () => {
    await attach()
    publish({ readiness: 'ready', network: 'main', accountContext: 'ctx' } as any)
    const initSpy = jest.spyOn(native, 'init')
    mount()
    await settle()
    expect(initSpy).toHaveBeenCalledTimes(1)
    runSessionTeardown('logout')
    await settle()
    // P1's own teardown reported none before the kit hook ran; nothing restarts while it stays none.
    expect(getTransport('safari-extension')).toBeUndefined()
    expect(initSpy).toHaveBeenCalledTimes(1)
    publish({ readiness: 'building', network: 'main', accountContext: 'ctx3' } as any)
    await settle()
    expect(initSpy).toHaveBeenCalledTimes(2)
    expect(getTransport('safari-extension')).toBeDefined()
  })

  it('cold start into a scheme wake drains after attach', async () => {
    initialUrl = `${SCHEME}://bridge?v=1&n=cold`
    mount()
    await settle()
    expect(processors).toHaveLength(0)
    await attach()
    await act(async () => {
      await new Promise(r => setTimeout(r, 120))
    })
    await settle()
    expect(processors[0].processPending.mock.calls.length).toBeGreaterThanOrEqual(1)
  })

  it('the nudge is honoured only while active; becoming active drains', async () => {
    await attach()
    mount()
    await settle()
    const base = processors[0].processPending.mock.calls.length
    ;(AppState as any).currentState = 'background'
    native.fireNudge()
    await settle(3)
    expect(processors[0].processPending.mock.calls.length).toBe(base)
    ;(AppState as any).currentState = 'active'
    native.fireNudge()
    await settle(3)
    expect(processors[0].processPending.mock.calls.length).toBe(base + 1)
    appStateHandlers.forEach(h => h('active'))
    await settle(3)
    expect(processors[0].processPending.mock.calls.length).toBe(base + 2)
  })

  it('sweepExpired runs every 60 seconds while active only', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] })
    try {
      await attach()
      mount()
      for (let i = 0; i < 6; i++) await act(async () => void (await jest.advanceTimersByTimeAsync(60)))
      const base = processors[0].sweepExpired.mock.calls.length
      await act(async () => void (await jest.advanceTimersByTimeAsync(60_000)))
      expect(processors[0].sweepExpired.mock.calls.length).toBe(base + 1)
      appStateHandlers.forEach(h => h('background'))
      await act(async () => void (await jest.advanceTimersByTimeAsync(120_000)))
      expect(processors[0].sweepExpired.mock.calls.length).toBe(base + 1)
    } finally {
      jest.useRealTimers()
    }
  })
})

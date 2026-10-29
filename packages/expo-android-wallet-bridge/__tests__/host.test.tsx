jest.mock('expo-secure-store', () => require('../../expo-wallet-toolbox/__tests__/__mocks__/secureStoreFake').fake)
jest.mock(
  'expo-local-authentication',
  () => require('../../expo-wallet-toolbox/__tests__/__mocks__/localAuthFake').fake
)
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: '3rdParty', init: () => {} }
}))

import React from 'react'
import { AppState } from 'react-native'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { attachBridgeHost } from '@bsv/expo-wallet-toolbox/core/bridge/runtime'
import { AndroidBridgeHost, RETURN_HYSTERESIS_MS, RETURN_TIMER } from '../src/AndroidBridgeHost'
import { ContextRelaySubscriber, resetContextRelay } from '@bsv/expo-wallet-toolbox/ui/bridgeSheet/ContextRelay'
import { createHarness, type Harness } from './bridgeHarness'
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

let h: Harness | undefined
let tree: ReactTestRenderer | undefined
let appStateHandlers: Array<(s: string) => void>

const mk = async (...a: Parameters<typeof createHarness>) => (h = await createHarness(...a))
const mount = (t: Harness) => {
  act(() => {
    tree = create(<AndroidBridgeHost bridge={t.bridge} />)
  })
}
const callsOf = (t: Harness, name: string) => t.native.calls.filter(c => c.name === name)

beforeEach(() => {
  appStateHandlers = []
  jest.spyOn(AppState, 'addEventListener').mockImplementation(((_: string, handler: any) => {
    appStateHandlers.push(handler)
    return { remove: () => void appStateHandlers.splice(appStateHandlers.indexOf(handler), 1) }
  }) as any)
  ;(AppState as any).currentState = 'active'
})

afterEach(() => {
  act(() => tree?.unmount())
  tree = undefined
  h?.teardown()
  h = undefined
  jest.restoreAllMocks()
})

const setAppState = (state: string) => act(() => appStateHandlers.forEach(fn => fn(state)))

/** Connects, parks the first call on the consent sheet and approves it. */
async function consented(t: Harness, i = 1) {
  const c = await t.connect(i)
  expect(c.response.status).toBe(200)
  t.sendRpc(c, 'getHeight', {}, `first-${i}`)
  return c
}

describe('AndroidBridgeHost', () => {
  it('mounts the context relay publisher, so a second root has values to render with', async () => {
    const t = await mk()
    resetContextRelay()
    let sub: ReactTestRenderer | undefined
    act(() => {
      sub = create(
        <ContextRelaySubscriber>
          <></>
        </ContextRelaySubscriber>
      )
    })
    expect(sub!.toJSON()).toBeNull()
    mount(t)
    // Rendered children, not null: every relayed context was published once.
    act(() => sub!.update(<ContextRelaySubscriber>{'ready'}</ContextRelaySubscriber>))
    expect(sub!.toJSON()).toBe('ready')
    act(() => sub!.unmount())
    resetContextRelay()
  })

  it('notification permission asked once at the first accepted launch and not again after denial', async () => {
    const t = await mk()
    t.native.notificationPermissionState = 'undetermined'
    mount(t)
    expect(callsOf(t, 'requestNotificationPermission')).toHaveLength(0)
    await t.launch(1)
    expect(callsOf(t, 'requestNotificationPermission')).toHaveLength(1)
    // The user denied it: Android reports 'denied' from now on.
    t.native.notificationPermissionState = 'denied'
    await t.launch(2)
    expect(callsOf(t, 'requestNotificationPermission')).toHaveLength(1)
    // Not again even if the state were somehow undetermined again (once per bridge).
    t.native.notificationPermissionState = 'undetermined'
    await t.launch(3)
    expect(callsOf(t, 'requestNotificationPermission')).toHaveLength(1)
  })

  it('a launch that arrived before the host mounted still asks, once', async () => {
    const t = await mk()
    t.native.notificationPermissionState = 'undetermined'
    await t.launch(1)
    mount(t)
    expect(callsOf(t, 'requestNotificationPermission')).toHaveLength(1)
  })

  it('an invalid launch does not ask', async () => {
    const t = await mk()
    t.native.notificationPermissionState = 'undetermined'
    mount(t)
    t.native.emitLaunch('not-a-launch-uri')
    await new Promise(r => setImmediate(r))
    expect(callsOf(t, 'requestNotificationPermission')).toHaveLength(0)
  })

  it('AppState changes reach attention.setMainInFront', async () => {
    const t = await mk()
    const spy = jest.spyOn(t.bridge.attention, 'setMainInFront')
    mount(t)
    expect(t.bridge.attention.isMainInFront()).toBe(true)
    setAppState('background')
    expect(spy).toHaveBeenLastCalledWith(false)
    expect(t.bridge.attention.isMainInFront()).toBe(false)
    setAppState('active')
    expect(spy).toHaveBeenLastCalledWith(true)
    expect(t.bridge.attention.isMainInFront()).toBe(true)
  })

  it('setSession counts follow the ledger and the waiting count', async () => {
    const t = await mk()
    mount(t)
    const lastCounts = () => callsOf(t, 'setSession').at(-1)?.args
    const c = await t.connect(1)
    expect(c.response.status).toBe(200)
    expect(lastCounts()).toEqual([1, 0])
    t.sendRpc(c, 'getHeight', {}, 'first')
    await t.waitFor(() => lastCounts()?.[1] === 1, 'the waiting count')
    expect(lastCounts()).toEqual([1, 1])
    await t.approve()
    await t.waitFor(() => t.response('first') !== undefined, 'the approved call')
    await t.waitFor(() => lastCounts()?.[1] === 0, 'the waiting count to clear')
    expect(lastCounts()).toEqual([1, 0])
  })

  it('returnToBrowser fires 600 ms after the last pending item and not while one is pending', async () => {
    const t = await mk()
    mount(t)
    const c = await consented(t)
    await t.waitFor(() => t.bridge.attention.waitingCount() === 1, 'a pending consent')
    // While the consent is pending nothing is armed, however long it takes.
    t.native.advance(10 * RETURN_HYSTERESIS_MS)
    expect(callsOf(t, 'returnToBrowser')).toHaveLength(0)
    expect(t.native.activeTimers().some(x => x.name === RETURN_TIMER)).toBe(false)

    await t.approve()
    await t.waitFor(() => t.response('first-1') !== undefined, 'the approved call')
    await t.waitFor(() => t.native.activeTimers().some(x => x.name === RETURN_TIMER), 'the hysteresis timer')
    t.native.advance(RETURN_HYSTERESIS_MS - 1)
    expect(callsOf(t, 'returnToBrowser')).toHaveLength(0)
    t.native.advance(1)
    expect(callsOf(t, 'returnToBrowser')).toHaveLength(1)
    // Once only: later quiet time requests nothing.
    t.native.advance(10_000)
    expect(callsOf(t, 'returnToBrowser')).toHaveLength(1)
    expect(c.epoch).toBeDefined()
  })

  it('a new pending item inside the hysteresis cancels the return', async () => {
    const t = await mk()
    mount(t)
    const c = await consented(t)
    await t.approve()
    await t.waitFor(() => t.native.activeTimers().some(x => x.name === RETURN_TIMER), 'the hysteresis timer')
    t.native.advance(RETURN_HYSTERESIS_MS - 100)
    // The manager raises a prompt for the same binding.
    t.bridge.attention.onPromptRaised({ epoch: c.epoch, applicationOrigin: 'https://example.com' } as any)
    expect(t.native.activeTimers().some(x => x.name === RETURN_TIMER)).toBe(false)
    t.native.advance(5_000)
    expect(callsOf(t, 'returnToBrowser')).toHaveLength(0)
  })

  it('returnToBrowser is not requested when nothing was ever pending', async () => {
    const t = await mk()
    mount(t)
    await t.launch(1)
    t.native.advance(60_000)
    expect(callsOf(t, 'returnToBrowser')).toHaveLength(0)
    expect(t.native.activeTimers().some(x => x.name === RETURN_TIMER)).toBe(false)
  })

  it('hostAttached and readiness changes drive session.onHostAttached', async () => {
    const t = await mk({ cold: true })
    const spy = jest.spyOn(t.bridge.session, 'onHostAttached')
    mount(t)
    expect(spy).toHaveBeenLastCalledWith(false)
    const detach = attachBridgeHost({ withdrawPrompts: jest.fn(), hasWallet: true })
    expect(spy).toHaveBeenLastCalledWith(true)
    t.publishAll('ready')
    expect(spy).toHaveBeenLastCalledWith(true)
    detach()
    expect(spy).toHaveBeenLastCalledWith(false)
  })

  it('host sends setHostState on attach, ready and detach', async () => {
    const t = await mk({ cold: true })
    mount(t)
    const states = () => callsOf(t, 'setHostState').map(c => c.args[0])
    expect(states().at(-1)).toEqual({ attached: false, ready: false })
    const detach = attachBridgeHost({ withdrawPrompts: jest.fn(), hasWallet: true })
    expect(states().at(-1)).toEqual({ attached: true, ready: false })
    act(() => t.publishAll('ready'))
    expect(states().at(-1)).toEqual({ attached: true, ready: true })
    act(() => t.publishAll('building'))
    expect(states().at(-1)).toEqual({ attached: true, ready: false })
    detach()
    expect(states().at(-1)).toEqual({ attached: false, ready: false })
    act(() => t.publishAll('ready'))
    act(() => tree!.unmount())
    tree = undefined
    expect(states().at(-1)).toEqual({ attached: false, ready: false })
  })

  it('renders nothing of its own when no notice applies', async () => {
    const t = await mk()
    mount(t)
    expect(tree!.toJSON()).toBeNull()
  })

  it('unmount removes the listeners and clears the timer', async () => {
    const t = await mk()
    mount(t)
    expect(appStateHandlers).toHaveLength(2) // the host and the notices
    act(() => tree!.unmount())
    tree = undefined
    expect(appStateHandlers).toHaveLength(0)
    expect(callsOf(t, 'clearTimer').some(c => c.args[0] === RETURN_TIMER)).toBe(true)
  })
})

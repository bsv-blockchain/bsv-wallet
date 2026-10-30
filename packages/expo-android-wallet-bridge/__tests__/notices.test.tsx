jest.mock('expo-secure-store', () => require('../../expo-wallet-toolbox/__tests__/__mocks__/secureStoreFake').fake)
// The real English strings, resolved the way i18next does, so a raw key can never pass.
jest.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({
    t: (key: string) => require('../../expo-wallet-toolbox/core/i18n/translations').resources.en.translation[key] ?? key
  })
}))

import React from 'react'
import { AppState } from 'react-native'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { attachBridgeHost } from '@bsv/expo-wallet-toolbox/core/bridge/runtime'
import { AndroidBridgeNotices } from '../src/AndroidBridgeNotices'
import { createHarness, type Harness } from './bridgeHarness'
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const IDS = ['bridge_notifications_off', 'bridge_ports_exhausted', 'bridge_not_ready_android'] as const

let h: Harness | undefined
let tree: ReactTestRenderer | undefined

const mk = async (...a: Parameters<typeof createHarness>) => (h = await createHarness(...a))
const mount = (t: Harness) => {
  act(() => {
    tree = create(<AndroidBridgeNotices bridge={t.bridge} />)
  })
}
const shown = () => IDS.filter(id => tree!.root.findAllByProps({ testID: id }).length > 0)
const textOf = (id: string) => {
  const node = tree!.root.findAllByProps({ testID: id }).find(n => typeof n.props.children === 'string')
  return node?.props.children as string | undefined
}
const flushAll = () => act(async () => void (await new Promise(r => setImmediate(r))))

beforeEach(() => {
  jest.spyOn(AppState, 'addEventListener').mockImplementation((() => ({ remove: () => undefined })) as any)
})
afterEach(() => {
  act(() => tree?.unmount())
  tree = undefined
  h?.teardown()
  h = undefined
  jest.restoreAllMocks()
})

describe('AndroidBridgeNotices', () => {
  it('each notice renders for its condition and not otherwise (three testIDs)', async () => {
    const t = await mk({ cold: true })
    mount(t)
    expect(shown()).toEqual([])
    expect(tree!.toJSON()).toBeNull()

    // 1. Ports exhausted: the range was full when the launch tried to open the server.
    t.native.startServerResult = Object.assign(new Error('no free port'), { code: 'ERR_PORTS_EXHAUSTED' })
    await t.launch(1)
    await flushAll()
    expect(shown()).toEqual(['bridge_ports_exhausted'])
    // A later successful start clears it.
    t.native.startServerResult = undefined
    await t.launch(2)
    await flushAll()
    expect(shown()).toEqual([])

    // 2. Attached with no wallet: a parked connect is answered 503.
    const parked = t.connect(3)
    await t.waitFor(() => t.bridge.session.parkedCount() === 1, 'a parked connect')
    const detach = attachBridgeHost({ withdrawPrompts: jest.fn() })
    expect((await parked).response.status).toBe(503)
    await flushAll()
    expect(shown()).toEqual(['bridge_not_ready_android'])
    // The wallet appears: the notice goes.
    detach()
    const detach2 = attachBridgeHost({ withdrawPrompts: jest.fn(), hasWallet: true })
    t.publishAll('ready')
    await flushAll()
    expect(shown()).toEqual([])

    // 3. Notifications off with a request pending.
    t.native.notificationPermissionState = 'denied'
    const c = await t.connect(4)
    expect(c.response.status).toBe(200)
    await flushAll()
    expect(shown()).toEqual([])
    t.sendRpc(c, 'getHeight', {}, 'first')
    await t.waitFor(() => t.bridge.attention.waitingCount() === 1, 'a pending consent')
    await flushAll()
    expect(shown()).toEqual(['bridge_notifications_off'])
    // Granted in settings: nothing to say any more.
    t.native.notificationPermissionState = 'granted'
    await t.approve()
    await t.waitFor(() => t.response('first') !== undefined, 'the approved call')
    await flushAll()
    expect(shown()).toEqual([])
    detach2()
  })

  it('notifications_off needs a pending item: denied alone shows nothing', async () => {
    const t = await mk()
    t.native.notificationPermissionState = 'denied'
    mount(t)
    expect(shown()).toEqual([])
    const c = await t.connect(1)
    expect(c.response.status).toBe(200)
    await flushAll()
    expect(shown()).toEqual([])
  })

  it('notices render translated text, not raw keys', async () => {
    const t = await mk()
    t.bridge.notices.raise('ports-exhausted')
    t.bridge.notices.raise('not-ready')
    mount(t)
    await flushAll()
    expect(shown()).toEqual(['bridge_ports_exhausted', 'bridge_not_ready_android'])
    expect(textOf('bridge_ports_exhausted')).toBe('Another program is using the ports BSV Wallet needs')
    expect(textOf('bridge_not_ready_android')).toBe('Create or restore a wallet in BSV Wallet first')
    for (const id of IDS) expect(textOf(id)).not.toBe(id)
    // No site, epoch or secret reaches the text.
    expect(JSON.stringify(tree!.toJSON())).not.toMatch(/example\.com/)
  })
})

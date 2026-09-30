/**
 * Receive screen, live inbox listener.
 *
 * While the handle Receive screen is focused and the app active it opens a
 * MessageBox WebSocket so a payment shows up the moment it lands, and the
 * 5 s poll drops to every third tick (15 s) as a fallback. These tests pin the
 * contract around that:
 *
 *  - a live payment runs the SAME satoshi fetch the poll runs (one crediting
 *    path; the callback never accepts anything itself);
 *  - only the satoshi read slows while the socket is live — the Mandala token
 *    inbox has no live channel, so its drain keeps the 5 s tick;
 *  - a listener that cannot start leaves full 5 s polling and one quiet warning;
 *  - blur, background and unmount disconnect the socket.
 *
 * The real HandleReceive renders; the wallet, the MessageBox client and the
 * crediting pass are mocked so a "fetch" is just a call to creditInboxOnce.
 */
jest.mock('expo-haptics', () => ({
  selectionAsync: jest.fn(() => Promise.resolve()),
  impactAsync: jest.fn(() => Promise.resolve()),
  notificationAsync: jest.fn(() => Promise.resolve()),
  ImpactFeedbackStyle: { Light: 'light', Medium: 'medium', Heavy: 'heavy' },
  NotificationFeedbackType: { Success: 'success', Warning: 'warning', Error: 'error' }
}))
jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }))
jest.mock('expo-local-authentication', () => require('../__mocks__/localAuthFake').fake)
jest.mock('expo-secure-store', () => require('../__mocks__/secureStoreFake').fake)
jest.mock('react-native-qrcode-svg', () => 'QRCode')
// A stable `t`: it is a dependency of the screen's read callback, and a fresh
// one per render would re-fire the mount-time read on every re-render.
const mockI18n = { t: (key: string) => key, i18n: { language: 'en' } }
jest.mock('react-i18next', () => ({
  useTranslation: () => mockI18n,
  initReactI18next: { type: '3rdParty', init: () => {} }
}))

// `mockFocused` stands in for navigation focus: the effect runs only while it
// is true, and its cleanup runs on blur, exactly like expo-router's.
const mockFocus = { value: true }
jest.mock('expo-router', () => ({
  useFocusEffect: (effect: () => void | (() => void)) => {
    const React = require('react')
    React.useEffect(() => {
      if (!mockFocus.value) return undefined
      return effect()
    }, [effect, mockFocus.value])
  }
}))

const mockClient = {
  listenForLivePayments: jest.fn(),
  disconnectWebSocket: jest.fn()
}
jest.mock('@bsv/message-box-client', () => ({
  PeerPayClient: jest.fn().mockImplementation(() => mockClient)
}))

const mockWallet = {
  getPublicKey: jest.fn(async () => ({ publicKey: '02'.padEnd(66, 'a') }))
}
// One object for every render: a fresh function per render would change the
// screen's read callbacks and re-fire its mount-time read.
const mockWalletState = {
  managers: { permissionsManager: mockWallet },
  adminOriginator: 'admin.test',
  selectedNetwork: 'main',
  storage: null,
  peekLastMissHeight: jest.fn()
}
jest.mock('@bsv/expo-wallet-toolbox', () => ({
  ...jest.requireActual('@bsv/expo-wallet-toolbox'),
  useWallet: () => mockWalletState
}))

jest.mock('../../ui/components/pay/MessageBoxConfig', () => ({
  useMessageBoxConfig: () => ({ messageBoxUrl: 'https://mb.example.test' })
}))
jest.mock('../../ui/hooks/useOnline', () => ({ useOnline: () => true }))
jest.mock('../../ui/resolveIdentity', () => ({
  makeIdentityClient: jest.fn(() => null),
  resolveIdentity: jest.fn(async () => [null, null])
}))

const mockReceiveFromInbox = jest.fn(async () => ({ credited: 0 }))
const mockMandala = { runtime: { receiveFromInbox: mockReceiveFromInbox } }
jest.mock('../../ui/hooks/useMandala', () => ({ useMandala: () => mockMandala }))

const mockCreditInboxOnce = jest.fn()
jest.mock('../../core/pay/creditInbox', () => ({
  creditInboxOnce: (...args: unknown[]) => mockCreditInboxOnce(...args)
}))
jest.mock('../../core/pay/creditErrors', () => ({
  makeCreditClassifier: jest.fn(async () => jest.fn())
}))

import React from 'react'
import { AppState } from 'react-native'
import { act, render } from '@testing-library/react-native'
import { ThemeProvider } from '@bsv/expo-wallet-toolbox'
import HandleReceive from '../../ui/components/pay/HandleReceive'

const POLL_MS = 5000
const EMPTY_OUTCOME = {
  accepted: 0,
  attempts: {},
  attentionCount: 0,
  payments: [],
  displayPayments: [],
  damaged: []
}

let appStateHandlers: ((state: string) => void)[] = []
let currentAppState = 'active'

const draw = () =>
  render(
    <ThemeProvider>
      <HandleReceive />
    </ThemeProvider>
  )

/** Mount and let the mount-time read, identity load and listener start settle. */
async function mount() {
  const view = draw()
  await act(async () => {})
  mockCreditInboxOnce.mockClear()
  mockReceiveFromInbox.mockClear()
  return view
}

async function tick(times = 1) {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      jest.advanceTimersByTime(POLL_MS)
    })
  }
}

/** The onPayment callback the screen handed the client. */
const onPayment = () => mockClient.listenForLivePayments.mock.calls[0][0].onPayment as (p: unknown) => void

beforeEach(() => {
  jest.useFakeTimers()
  mockFocus.value = true
  currentAppState = 'active'
  appStateHandlers = []
  Object.defineProperty(AppState, 'currentState', { configurable: true, get: () => currentAppState })
  jest.spyOn(AppState, 'addEventListener').mockImplementation(((_type: string, handler: (s: string) => void) => {
    appStateHandlers.push(handler)
    return { remove: jest.fn() }
  }) as never)
  mockClient.listenForLivePayments.mockReset().mockResolvedValue(undefined)
  mockClient.disconnectWebSocket.mockReset().mockResolvedValue(undefined)
  mockCreditInboxOnce.mockReset().mockResolvedValue(EMPTY_OUTCOME)
  mockReceiveFromInbox.mockClear()
})

afterEach(() => {
  jest.useRealTimers()
  jest.restoreAllMocks()
})

describe('HandleReceive live inbox listener', () => {
  it('starts one listener on the screen and hands it a payment callback', async () => {
    await mount()
    expect(mockClient.listenForLivePayments).toHaveBeenCalledTimes(1)
    expect(typeof onPayment()).toBe('function')
  })

  it('reads the inbox when a live payment arrives, without waiting for a tick', async () => {
    await mount()
    expect(mockCreditInboxOnce).not.toHaveBeenCalled()

    await act(async () => {
      onPayment()({ messageId: 'm1' })
    })

    expect(mockCreditInboxOnce).toHaveBeenCalledTimes(1)
    // The satoshi inbox only: the token drain has its own inbox and no push.
    expect(mockReceiveFromInbox).not.toHaveBeenCalled()
  })

  it('reads the inbox again when a payment arrives while a read is in flight', async () => {
    await mount()
    let release!: (v: unknown) => void
    mockCreditInboxOnce.mockImplementationOnce(() => new Promise(resolve => (release = resolve)))

    // A poll-started read (every third tick while live) is in flight and will
    // not see what lands next.
    await tick(3)
    expect(mockCreditInboxOnce).toHaveBeenCalledTimes(1)
    await act(async () => {
      onPayment()({ messageId: 'm2' })
    })
    expect(mockCreditInboxOnce).toHaveBeenCalledTimes(1)

    await act(async () => {
      release(EMPTY_OUTCOME)
    })
    expect(mockCreditInboxOnce).toHaveBeenCalledTimes(2)
  })

  it('does not read on a live payment while the screen is blurred or the app is backgrounded', async () => {
    await mount()
    currentAppState = 'background'
    await act(async () => {
      onPayment()({ messageId: 'm3' })
    })
    expect(mockCreditInboxOnce).not.toHaveBeenCalled()
  })

  it('slows the satoshi read to every third tick while live, but drains tokens every tick', async () => {
    await mount()

    await tick(1)
    expect(mockCreditInboxOnce).toHaveBeenCalledTimes(0)
    expect(mockReceiveFromInbox).toHaveBeenCalledTimes(1)

    await tick(1)
    expect(mockCreditInboxOnce).toHaveBeenCalledTimes(0)
    expect(mockReceiveFromInbox).toHaveBeenCalledTimes(2)

    await tick(1)
    expect(mockCreditInboxOnce).toHaveBeenCalledTimes(1)
    expect(mockReceiveFromInbox).toHaveBeenCalledTimes(3)

    await tick(3)
    expect(mockCreditInboxOnce).toHaveBeenCalledTimes(2)
    expect(mockReceiveFromInbox).toHaveBeenCalledTimes(6)
  })

  it('keeps reading the satoshi inbox every tick until the socket is up', async () => {
    let connect!: () => void
    mockClient.listenForLivePayments.mockImplementation(() => new Promise<void>(resolve => (connect = resolve)))
    await mount()

    await tick(2)
    expect(mockCreditInboxOnce).toHaveBeenCalledTimes(2)

    await act(async () => {
      connect()
    })
    await tick(2)
    expect(mockCreditInboxOnce).toHaveBeenCalledTimes(2)
    await tick(1)
    expect(mockCreditInboxOnce).toHaveBeenCalledTimes(3)
  })

  it('polls the satoshi inbox every tick and warns once when the listener cannot start', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
    mockClient.listenForLivePayments.mockRejectedValue(new Error('socket refused'))
    await mount()

    await tick(3)

    expect(mockCreditInboxOnce).toHaveBeenCalledTimes(3)
    expect(mockReceiveFromInbox).toHaveBeenCalledTimes(3)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith('[pay] live inbox listener unavailable: socket refused')
    // A failed start is not retried on every tick.
    expect(mockClient.listenForLivePayments).toHaveBeenCalledTimes(1)
  })

  it('treats a listener that throws synchronously like one that rejects', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
    mockClient.listenForLivePayments.mockImplementation(() => {
      throw new Error('no socket support')
    })
    await mount()

    await tick(2)

    expect(mockCreditInboxOnce).toHaveBeenCalledTimes(2)
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('disconnects the socket on unmount', async () => {
    const view = await mount()
    expect(mockClient.disconnectWebSocket).not.toHaveBeenCalled()

    view.unmount()

    expect(mockClient.disconnectWebSocket).toHaveBeenCalledTimes(1)
  })

  it('swallows a failing disconnect', async () => {
    mockClient.disconnectWebSocket.mockRejectedValue(new Error('already closed'))
    const view = await mount()
    expect(() => view.unmount()).not.toThrow()
    await act(async () => {})
    expect(mockClient.disconnectWebSocket).toHaveBeenCalledTimes(1)
  })

  it('stops the poll on unmount', async () => {
    const view = await mount()
    view.unmount()
    await tick(3)
    expect(mockCreditInboxOnce).not.toHaveBeenCalled()
    expect(mockReceiveFromInbox).not.toHaveBeenCalled()
  })

  it('disconnects when the app is backgrounded and listens again when it returns', async () => {
    await mount()
    expect(mockClient.listenForLivePayments).toHaveBeenCalledTimes(1)

    currentAppState = 'background'
    await act(async () => {
      appStateHandlers.forEach(h => h('background'))
    })
    expect(mockClient.disconnectWebSocket).toHaveBeenCalledTimes(1)
    await tick(2)
    expect(mockCreditInboxOnce).not.toHaveBeenCalled()

    currentAppState = 'active'
    await act(async () => {
      appStateHandlers.forEach(h => h('active'))
    })
    expect(mockClient.listenForLivePayments).toHaveBeenCalledTimes(2)
    // Coming back shows what arrived while away: both inboxes at once, however
    // far into the slow cadence the poll was.
    expect(mockCreditInboxOnce).toHaveBeenCalledTimes(1)
    expect(mockReceiveFromInbox).toHaveBeenCalledTimes(1)
  })

  it('disconnects when the screen loses focus and listens again when it regains it', async () => {
    const view = await mount()
    expect(mockClient.listenForLivePayments).toHaveBeenCalledTimes(1)

    mockFocus.value = false
    view.rerender(
      <ThemeProvider>
        <HandleReceive />
      </ThemeProvider>
    )
    await tick(1)
    expect(mockClient.disconnectWebSocket).toHaveBeenCalledTimes(1)
    expect(mockCreditInboxOnce).not.toHaveBeenCalled()

    mockFocus.value = true
    view.rerender(
      <ThemeProvider>
        <HandleReceive />
      </ThemeProvider>
    )
    await tick(1)
    expect(mockClient.listenForLivePayments).toHaveBeenCalledTimes(2)
  })
})

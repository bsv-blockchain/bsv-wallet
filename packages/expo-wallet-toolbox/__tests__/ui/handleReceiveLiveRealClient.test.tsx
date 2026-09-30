/**
 * Receive screen, live inbox listener, against the REAL MessageBoxClient.
 *
 * handleReceiveLive.test.tsx mocks PeerPayClient entirely, so it cannot see
 * what a real client does with a second listen. This file can. The facts it
 * pins about @bsv/message-box-client (2.5.3):
 *
 *  - disconnectWebSocket() and the socket's own 'disconnect' handler do not
 *    clear the client's joined-room set, and joinRoom() returns early for a
 *    room already in it. So a SECOND listenForLivePayments on the same
 *    instance authenticates a fresh socket but never emits joinRoom: the call
 *    resolves, the screen believes the socket is live, and no push ever
 *    arrives.
 *  - A listen that was stopped while still authenticating leaves the client's
 *    connection-init promise pending, so a re-listen on the same instance
 *    waits out its auth timeout and then fails.
 *
 * The screen therefore opens a fresh client per listening session. Only the
 * socket layer (AuthSocketClient) is faked; HandleReceive, PeerPayClient and
 * MessageBoxClient are the real ones. Real timers: the fake socket connects
 * on a zero-delay timeout.
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
const mockI18n = { t: (key: string) => key, i18n: { language: 'en' } }
jest.mock('react-i18next', () => ({
  useTranslation: () => mockI18n,
  initReactI18next: { type: '3rdParty', init: () => {} }
}))

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

const IDENTITY_KEY = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
const SERVER_KEY = '02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5'

// A stand-in for the WebSocket: connects on the next tick, answers the
// client's 'authenticated' message with authenticationSuccess unless told not
// to, and records everything the client emits. The client's own message-box
// logic above it is real.
const mockSockets: MockSocket[] = []
const mockSocketBehaviour = { authenticate: true }
class MockSocket {
  handlers: Record<string, ((...args: unknown[]) => void)[]> = {}
  emits: unknown[][] = []
  connected = false
  dead = false
  serverIdentityKey = SERVER_KEY
  constructor() {
    mockSockets.push(this)
    setTimeout(() => {
      if (this.dead) return
      this.connected = true
      this.fire('connect')
    }, 0)
  }
  fire(event: string, ...args: unknown[]) {
    ;(this.handlers[event] ?? []).slice().forEach(h => h(...args))
  }
  on(event: string, handler: (...args: unknown[]) => void) {
    ;(this.handlers[event] ||= []).push(handler)
  }
  off(event: string, handler: (...args: unknown[]) => void) {
    this.handlers[event] = (this.handlers[event] ?? []).filter(h => h !== handler)
  }
  emit(event: string, ...args: unknown[]) {
    this.emits.push([event, ...args])
    if (event === 'authenticated' && mockSocketBehaviour.authenticate) {
      setTimeout(() => this.fire('authenticationSuccess'), 0)
    }
  }
  disconnect() {
    this.dead = true
    this.connected = false
    this.fire('disconnect', 'io client disconnect')
  }
}
jest.mock('@bsv/authsocket-client', () => ({ AuthSocketClient: () => new MockSocket() }))

const mockWallet = {
  getPublicKey: jest.fn(async () => ({ publicKey: IDENTITY_KEY })),
  waitForAuthentication: jest.fn(async () => ({ authenticated: true })),
  getNetwork: jest.fn(async () => ({ network: 'main' })),
  getVersion: jest.fn(async () => ({ version: 'test' }))
}
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
jest.mock('../../ui/hooks/useMandala', () => ({ useMandala: () => ({ runtime: undefined }) }))
// The reads are not under test; a crediting pass that finds nothing keeps the
// reading client (which would need a server) out of it.
jest.mock('../../core/pay/creditInbox', () => ({
  creditInboxOnce: jest.fn(async () => ({
    accepted: 0,
    attempts: {},
    attentionCount: 0,
    payments: [],
    displayPayments: [],
    damaged: []
  }))
}))
jest.mock('../../core/pay/creditErrors', () => ({
  makeCreditClassifier: jest.fn(async () => jest.fn())
}))

import React from 'react'
import { AppState } from 'react-native'
import { act, render } from '@testing-library/react-native'
import { ThemeProvider } from '@bsv/expo-wallet-toolbox'
import HandleReceive from '../../ui/components/pay/HandleReceive'

let appStateHandlers: ((state: string) => void)[] = []
let currentAppState = 'active'

const screen = () => (
  <ThemeProvider>
    <HandleReceive />
  </ThemeProvider>
)

/** Real time for the fake socket's zero-delay timers and the client's promise chain. */
const settle = () =>
  act(async () => {
    await new Promise(resolve => setTimeout(resolve, 60))
  })

const fireAppState = async (state: 'active' | 'background') => {
  currentAppState = state
  await act(async () => {
    appStateHandlers.forEach(h => h(state))
  })
  await settle()
}

const joinRooms = (socket: MockSocket) => socket.emits.filter(e => e[0] === 'joinRoom').map(e => e[1])
const roomListener = (socket: MockSocket) =>
  Object.keys(socket.handlers).filter(event => event.startsWith('sendMessage-'))

beforeEach(() => {
  mockFocus.value = true
  currentAppState = 'active'
  appStateHandlers = []
  mockSockets.length = 0
  mockSocketBehaviour.authenticate = true
  Object.defineProperty(AppState, 'currentState', { configurable: true, get: () => currentAppState })
  jest.spyOn(AppState, 'addEventListener').mockImplementation(((_type: string, handler: (s: string) => void) => {
    appStateHandlers.push(handler)
    return { remove: jest.fn() }
  }) as never)
})

afterEach(() => {
  jest.restoreAllMocks()
})

describe('HandleReceive live listener with the real MessageBox client', () => {
  it('joins the payments room on the new socket after a blur and refocus', async () => {
    const view = render(screen())
    await settle()
    expect(mockSockets).toHaveLength(1)
    const room = joinRooms(mockSockets[0])
    expect(room).toHaveLength(1)
    expect(String(room[0])).toBe(`${IDENTITY_KEY}-payment_inbox`)
    expect(roomListener(mockSockets[0])).toEqual([`sendMessage-${room[0]}`])

    // Blur.
    mockFocus.value = false
    view.rerender(screen())
    await fireAppState('active')
    expect(mockSockets[0].dead).toBe(true)

    // Refocus.
    mockFocus.value = true
    view.rerender(screen())
    await fireAppState('active')

    expect(mockSockets).toHaveLength(2)
    expect(mockSockets[1].dead).toBe(false)
    // Without a fresh client this is [] and the screen would sit on a socket
    // that is authenticated but in no room.
    expect(joinRooms(mockSockets[1])).toEqual(room)
    expect(roomListener(mockSockets[1])).toEqual([`sendMessage-${room[0]}`])
  })

  it('joins the room on every foreground after repeated background cycles', async () => {
    render(screen())
    await settle()

    for (let cycle = 1; cycle <= 3; cycle++) {
      await fireAppState('background')
      await fireAppState('active')
      expect(mockSockets).toHaveLength(cycle + 1)
      expect(joinRooms(mockSockets[cycle])).toEqual([`${IDENTITY_KEY}-payment_inbox`])
    }
    // Exactly one live socket at the end.
    expect(mockSockets.filter(socket => !socket.dead)).toHaveLength(1)
  })

  it('listens again at once after a stop that came while the first socket was still authenticating', async () => {
    mockSocketBehaviour.authenticate = false
    render(screen())
    await settle()
    expect(mockSockets).toHaveLength(1)
    expect(joinRooms(mockSockets[0])).toEqual([])

    await fireAppState('background')
    expect(mockSockets[0].dead).toBe(true)

    // The server answers from now on. A re-listen on the old instance would
    // wait out its connection attempt's auth timeout before doing anything.
    mockSocketBehaviour.authenticate = true
    await fireAppState('active')

    expect(mockSockets).toHaveLength(2)
    expect(joinRooms(mockSockets[1])).toEqual([`${IDENTITY_KEY}-payment_inbox`])
    expect(mockSockets[1].dead).toBe(false)
  })

  it('closes the socket on unmount', async () => {
    const view = render(screen())
    await settle()
    expect(mockSockets[0].dead).toBe(false)

    view.unmount()
    await settle()

    expect(mockSockets[0].dead).toBe(true)
  })
})

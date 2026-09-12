import React from 'react'
import { act, fireEvent, render, waitFor } from '@testing-library/react-native'
import { ConnectionsScreen } from '../../ui/screens/ConnectionsScreen'

const mockConnect = jest.fn(async () => {})
const mockClipboard = jest.fn()
const mockToast = jest.fn()
const mockPermissionsManager = {}
let mockDeepLinkParams: Record<string, string> = {}
const mockConnections: any[] = []
const mockSetConnectionStatus = jest.fn((..._args: unknown[]) => {})
const mockGetStoredSequence = jest.fn(async (..._args: unknown[]) => null as string | null)
const mockDeleteStoredSequence = jest.fn(async (..._args: unknown[]) => {})
const mockGetIdentityKey = jest.fn(async (..._args: unknown[]) => ({ publicKey: '02' + 'aa'.repeat(32) }))
const mockEncrypt = jest.fn(async (..._args: unknown[]) => ({ ciphertext: [1, 2, 3] }))
const mockWebSockets: any[] = []
const mockWebSocketConstructor = jest.fn(function (this: any, url: string) {
  this.url = url
  this.send = jest.fn()
  this.close = jest.fn()
  mockWebSockets.push(this)
})
const GENERATOR_X = '79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'

jest.mock('@bsv/expo-wallet-toolbox', () => ({
  ...jest.requireActual('../../core/theme/tokens'),
  useTheme: () => ({ colors: {} }),
  useWallet: () => ({ managers: { permissionsManager: mockPermissionsManager } }),
  useWalletConnection: () => ({ connect: mockConnect, reconnect: jest.fn() }),
  guardVaultAccess: (wallet: unknown) => wallet,
  capWalletArgs: (wallet: unknown) => wallet,
  ADMIN_ORIGINATOR: 'admin.test',
  lastSeqKey: (topic: string) => `wallet_pairing_lastseq_${topic}`,
  parseExternalOrigin: (raw: string) => {
    const u = new URL(raw)
    if (u.protocol !== 'https:' || u.pathname !== '/' || u.search || u.hash || u.username || u.password) {
      throw new Error('Origin must be a bare HTTPS origin without a path, query, or fragment')
    }
    return { origin: u.origin, originator: u.host }
  },
  connectionStore: {
    get connections() { return mockConnections },
    setStatus: (...args: unknown[]) => mockSetConnectionStatus(...args),
    remove: jest.fn()
  }
}))
jest.mock('@bsv/sdk', () => ({
  ...jest.requireActual('@bsv/sdk'),
  WalletClient: jest.fn().mockImplementation(() => ({
    getPublicKey: (...args: unknown[]) => mockGetIdentityKey(...args),
    encrypt: (...args: unknown[]) => mockEncrypt(...args)
  }))
}))
jest.mock('expo-router', () => ({
  router: { back: jest.fn() },
  useLocalSearchParams: () => mockDeepLinkParams
}))
jest.mock('expo-clipboard', () => ({ getStringAsync: () => mockClipboard() }))
jest.mock('expo-secure-store', () => ({
  getItemAsync: (...args: unknown[]) => mockGetStoredSequence(...args),
  deleteItemAsync: (...args: unknown[]) => mockDeleteStoredSequence(...args)
}))
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }))
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }))
jest.mock('../../ui/components/ui/Toast', () => ({ showToast: (...args: unknown[]) => mockToast(...args) }))
jest.mock('../../ui/components/ui/GroupedList', () => ({ GroupedSection: ({ children }: any) => children }))
jest.mock('../../ui/components/ui/ListRow', () => ({ ListRow: ({ trailing }: any) => trailing }))
jest.mock('../../ui/components/QRScanner', () => () => null)

const pairingParams = () => ({
  topic: 'session+with&reserved%characters',
  backendIdentityKey: '02' + 'a'.repeat(64),
  protocolID: JSON.stringify([2, 'pairing & browser']),
  origin: 'https://app.example',
  expiry: String(Math.floor(Date.now() / 1000) + 3600),
  sig: 'signature+with/slashes=&percent%25'
})

beforeEach(() => {
  jest.clearAllMocks()
  mockDeepLinkParams = {}
  mockConnections.splice(0)
  mockWebSockets.splice(0)
  mockGetStoredSequence.mockResolvedValue(null)
  mockGetIdentityKey.mockResolvedValue({ publicKey: '02' + 'aa'.repeat(32) })
  ;(global as any).WebSocket = mockWebSocketConstructor
})

const storedConnection = (over: Record<string, unknown> = {}) => ({
  sessionId: 'stored-session',
  origin: 'https://app.example',
  relay: 'wss://relay.example',
  backendIdentityKey: '02' + GENERATOR_X,
  mobileIdentityKey: '02' + 'aa'.repeat(32),
  protocolID: JSON.stringify([0, 'mobile wallet session']),
  connectedAt: Date.now(),
  status: 'active',
  ...over
})

it.each(['bsv-wallet', 'bsv-browser'])('accepts a pasted %s pairing URI with intact parameters', async scheme => {
  const params = pairingParams()
  mockClipboard.mockResolvedValue(`${scheme}://pair?${new URLSearchParams(params)}`)
  const screen = render(<ConnectionsScreen />)

  fireEvent.press(screen.getByText('paste_uri'))

  await waitFor(() => expect(mockConnect).toHaveBeenCalledTimes(1))
  expect(mockConnect).toHaveBeenCalledWith(params, expect.any(Object))
  expect(mockToast).not.toHaveBeenCalled()
})

it('preserves parameters forwarded by the native deep-link route', async () => {
  const params = pairingParams()
  mockDeepLinkParams = params

  render(<ConnectionsScreen />)

  await waitFor(() => expect(mockConnect).toHaveBeenCalledTimes(1))
  expect(mockConnect).toHaveBeenCalledWith(params, expect.any(Object))
})

it.each(['https', 'unrelated-app'])('rejects a pasted pairing URI from the %s scheme', async scheme => {
  mockClipboard.mockResolvedValue(`${scheme}://pair?${new URLSearchParams(pairingParams())}`)
  const screen = render(<ConnectionsScreen />)

  fireEvent.press(screen.getByText('paste_uri'))

  await waitFor(() => expect(mockToast).toHaveBeenCalledWith(expect.stringContaining('Not a bsv-wallet:// or bsv-browser:// URI'), { type: 'error' }))
  expect(mockConnect).not.toHaveBeenCalled()
})

it.each(['bsv-wallet', 'bsv-browser'])('retains required-field validation for %s links', async scheme => {
  const { origin: _origin, ...params } = pairingParams()
  mockClipboard.mockResolvedValue(`${scheme}://pair?${new URLSearchParams(params)}`)
  const screen = render(<ConnectionsScreen />)

  fireEvent.press(screen.getByText('paste_uri'))

  await waitFor(() => expect(mockToast).toHaveBeenCalledWith(expect.stringContaining('missing required fields'), { type: 'error' }))
  expect(mockConnect).not.toHaveBeenCalled()
})

it.each(['bsv-wallet', 'bsv-browser'])('retains expiry validation for %s links', async scheme => {
  const params = { ...pairingParams(), expiry: '1' }
  mockClipboard.mockResolvedValue(`${scheme}://pair?${new URLSearchParams(params)}`)
  const screen = render(<ConnectionsScreen />)

  fireEvent.press(screen.getByText('paste_uri'))

  await waitFor(() => expect(mockToast).toHaveBeenCalledWith(expect.stringContaining('has expired'), { type: 'error' }))
  expect(mockConnect).not.toHaveBeenCalled()
})

it('validates a stored revocation session before opening its canonical relay socket', async () => {
  mockConnections.push(storedConnection())
  mockGetStoredSequence.mockResolvedValue('7')
  const screen = render(<ConnectionsScreen />)

  fireEvent.press(screen.getByText('disconnect'))

  await waitFor(() => expect(mockWebSocketConstructor).toHaveBeenCalledWith(
    'wss://relay.example/ws?topic=stored-session&role=mobile'
  ))
  expect(mockGetIdentityKey).toHaveBeenCalledWith({ identityKey: true })
  const ws = mockWebSockets[0]
  await act(async () => { await ws.onopen() })
  expect(mockEncrypt).toHaveBeenCalledWith(expect.objectContaining({
    protocolID: [0, 'mobile wallet session'],
    keyID: 'stored-session',
    counterparty: '02' + GENERATOR_X
  }))
  expect(ws.send).toHaveBeenCalledTimes(1)
})

it.each([
  ['an unsafe relay', { relay: 'ws://relay.example' }, null],
  ['a malformed sequence', {}, '1e2'],
  ['a mismatched wallet identity', { mobileIdentityKey: '03' + GENERATOR_X }, null]
])('does not open a revocation socket for %s', async (_label, override, storedSequence) => {
  mockConnections.push(storedConnection(override as Record<string, unknown>))
  mockGetStoredSequence.mockResolvedValue(storedSequence as string | null)
  const screen = render(<ConnectionsScreen />)

  fireEvent.press(screen.getByText('disconnect'))

  await waitFor(() => expect(mockSetConnectionStatus).toHaveBeenCalled())
  await act(async () => {})
  expect(mockWebSocketConstructor).not.toHaveBeenCalled()
})

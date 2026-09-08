import React from 'react'
import { fireEvent, render, waitFor } from '@testing-library/react-native'
import { ConnectionsScreen } from '../../ui/screens/ConnectionsScreen'

const mockConnect = jest.fn(async () => {})
const mockClipboard = jest.fn()
const mockToast = jest.fn()
const mockPermissionsManager = {}
let mockDeepLinkParams: Record<string, string> = {}

jest.mock('@bsv/expo-wallet-toolbox', () => ({
  ...jest.requireActual('../../core/theme/tokens'),
  useTheme: () => ({ colors: {} }),
  useWallet: () => ({ managers: { permissionsManager: mockPermissionsManager } }),
  useWalletConnection: () => ({ connect: mockConnect, reconnect: jest.fn() }),
  guardVaultAccess: (wallet: unknown) => wallet,
  capWalletArgs: (wallet: unknown) => wallet,
  ADMIN_ORIGINATOR: 'admin.test',
  connectionStore: { connections: [] }
}))
jest.mock('@bsv/sdk', () => ({ WalletClient: jest.fn() }))
jest.mock('expo-router', () => ({
  router: { back: jest.fn() },
  useLocalSearchParams: () => mockDeepLinkParams
}))
jest.mock('expo-clipboard', () => ({ getStringAsync: () => mockClipboard() }))
jest.mock('expo-secure-store', () => ({}))
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }))
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }))
jest.mock('../../ui/components/ui/Toast', () => ({ showToast: (...args: unknown[]) => mockToast(...args) }))
jest.mock('../../ui/components/ui/GroupedList', () => ({ GroupedSection: ({ children }: any) => children }))
jest.mock('../../ui/components/ui/ListRow', () => ({ ListRow: () => null }))
jest.mock('../../ui/components/QRScanner', () => () => null)

const pairingParams = () => ({
  topic: 'session+with&reserved%characters',
  backendIdentityKey: '02' + 'a'.repeat(64),
  protocolID: JSON.stringify([2, 'pairing & browser']),
  origin: 'https://app.example/return?state=one&next=two%20three',
  expiry: String(Math.floor(Date.now() / 1000) + 3600),
  sig: 'signature+with/slashes=&percent%25'
})

beforeEach(() => {
  jest.clearAllMocks()
  mockDeepLinkParams = {}
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

/**
 * NearbyFlow — the payee/receive path, P1-1.
 *
 * The success overlay's TIMING never changes here (still shown the instant
 * the payment is durably queued), but its `verification` prop must move
 * through three states as `processPending` resolves: 'pending' the moment
 * the overlay appears, then 'verified' on a credit or 'not-credited'
 * otherwise. This pins that against the real NearbyFlow component, driving a
 * QR-scanned frame exactly the way __tests__/ui/nearbyFlowToken.test.tsx's
 * COVER-failure test does (mockScanHandler feeding a stubbed decode chain),
 * so no real fountain codec or crypto has to run.
 */
jest.mock('expo-haptics', () => ({
  selectionAsync: jest.fn(() => Promise.resolve()),
  impactAsync: jest.fn(() => Promise.resolve()),
  notificationAsync: jest.fn(() => Promise.resolve()),
  ImpactFeedbackStyle: { Light: 'light', Medium: 'medium', Heavy: 'heavy' },
  NotificationFeedbackType: { Success: 'success', Warning: 'warning', Error: 'error' }
}))
jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons', MaterialCommunityIcons: 'MaterialCommunityIcons' }))
jest.mock('expo-local-authentication', () => require('../__mocks__/localAuthFake').fake)
jest.mock('expo-secure-store', () => require('../__mocks__/secureStoreFake').fake)
jest.mock('expo-status-bar', () => ({ StatusBar: 'StatusBar' }))
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  SafeAreaProvider: ({ children }: { children: React.ReactNode }) => children
}))
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) => (values ? `${key}:${Object.values(values).join('|')}` : key),
    i18n: { language: 'en' }
  }),
  initReactI18next: { type: '3rdParty', init: () => {} }
}))
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), back: jest.fn(), replace: jest.fn(), dismissTo: jest.fn(), canGoBack: () => true },
  useLocalSearchParams: () => ({}),
  useFocusEffect: () => {},
  useNavigation: () => ({ addListener: () => () => {} })
}))
jest.mock('react-native-qrcode-svg', () => 'QRCode')
jest.mock('@bsv/react-native-localpay-transport', () => ({
  getLocalPayTransport: jest.fn(),
  getLocalPayBleTransport: jest.fn()
}))
jest.mock('@react-native-community/netinfo', () => ({
  __esModule: true,
  default: {
    fetch: jest.fn(async () => ({ isConnected: false, isInternetReachable: false, type: 'none' })),
    addEventListener: jest.fn(() => jest.fn())
  }
}))
jest.mock('../../ui/resolveIdentity', () => ({
  makeIdentityClient: jest.fn(() => null),
  resolveIdentity: jest.fn(async () => [null, null]),
  identityLabel: jest.fn(() => undefined)
}))
jest.mock('../../ui/hooks/useSpendableBalance', () => ({ useSpendableBalance: () => 50_000 }))

// `startRequest` mints the session's derivationPrefix/Suffix via
// `createNonce`'s own internal `Random(16)`, which cannot be pinned by
// mocking the wallet alone — mocked here (imported directly by NearbyFlow.tsx
// from '@bsv/sdk', not through the app barrel) so the mocked `unsealFrame`
// below can echo back a frame that actually matches the minted session,
// exactly as a genuine payer's frame would.
const FIXED_PREFIX = 'cHJlZml4'
const FIXED_SUFFIX = 'c3VmZml4'
const mockCreateNonce = jest.fn()
jest.mock('@bsv/sdk', () => ({
  ...jest.requireActual('@bsv/sdk'),
  createNonce: (...args: unknown[]) => mockCreateNonce(...args)
}))

let mockScanHandler: ((data: string) => void) | undefined
jest.mock('../../ui/components/QRScanner', () => ({
  __esModule: true,
  default: (props: { onScan?: (data: string) => void }) => {
    mockScanHandler = props.onScan
    return null
  }
}))

const mockVerifyFramePayment = jest.fn()
const mockProcessPending = jest.fn()
const mockSavePending = jest.fn()
const mockMarkSessionSpent = jest.fn()

function mockWallet() {
  return {
    getPublicKey: jest.fn(async () => ({ publicKey: PAYEE_IDENTITY })),
    createHmac: jest.fn(async () => ({ hmac: new Array(32).fill(7) }))
  }
}

jest.mock('@bsv/expo-wallet-toolbox', () => {
  const actual = jest.requireActual('@bsv/expo-wallet-toolbox')
  return {
    ...actual,
    useWalletManagers: () => ({
      managers: { permissionsManager: mockWallet() },
      adminOriginator: 'admin.test',
      storage: { sqliteDb: {} }
    }),
    localSupportsAwdl: jest.fn(() => false),
    localSupportsBle: jest.fn(() => false),
    localSupportsNearby: jest.fn(() => false),
    probeDeviceCaps: jest.fn(async () => ({})),
    capsFromProbe: jest.fn(() => 0),
    prepareBle: jest.fn(async () => 'unsupported'),
    readBluetoothState: jest.fn(() => 'unknown'),
    requestNearbyPermissions: jest.fn(async () => false),
    requestBlePermissions: jest.fn(async () => false),
    raceReceivers: jest.fn(() => {}),
    describeFloor: jest.fn(() => 'none'),
    selectTransport: jest.fn(() => 'qr'),
    awdlTransport: { kind: 'awdl', send: jest.fn(async () => ({ ok: true })) },
    bleTransport: { kind: 'ble', send: jest.fn(async () => ({ ok: true })) },
    nearbyTransport: { kind: 'nearby', send: jest.fn(async () => ({ ok: true })) },
    sealFrame: jest.fn(() => new Uint8Array(4)),
    sealedToQr: jest.fn(() => 'bsvpayf1:stub'),
    frameBytesFromQr: jest.fn(() => new Uint8Array(4)),
    isAirGapPart: jest.fn(() => true),
    AirGapDecoder: jest.fn().mockImplementation(() => ({
      accept: jest.fn(() => ({ ok: true, have: 1, total: 1, done: true })),
      message: jest.fn(() => new Uint8Array(4))
    })),
    // The payer's frame this suite is settling — a plain BSV frame, decoded
    // straight to a fixed object regardless of what the mocked scanner "saw".
    unsealFrame: jest.fn(() => ({
      version: 1,
      kind: 'bsv',
      transaction: new Uint8Array(0),
      outputIndex: 0,
      senderIdentityKey: '02'.padEnd(66, 'a'),
      // Must match the minted session's own nonces (see the `createNonce`
      // mock above) or settleReceived's binding check declines the frame as
      // 'session_mismatch' before ever reaching verification.
      derivationPrefix: FIXED_PREFIX,
      derivationSuffix: FIXED_SUFFIX
    })),
    verifyFramePayment: (...args: unknown[]) => mockVerifyFramePayment(...args),
    // The one-shot session latch: never spent in this suite, so every test
    // reaches the durable write below it.
    isSessionSpent: jest.fn(async () => false),
    savePending: (...args: unknown[]) => mockSavePending(...args),
    markSessionSpent: (...args: unknown[]) => mockMarkSessionSpent(...args),
    processPending: (...args: unknown[]) => mockProcessPending(...args)
  }
})

import React from 'react'
import { act, render, fireEvent, waitFor } from '@testing-library/react-native'
import { ThemeProvider } from '@bsv/expo-wallet-toolbox'
import NearbyFlow from '../../ui/components/pay/NearbyFlow'
import { MandalaProvider } from '../../ui/hooks/useMandala'
import { makeFakeMandala } from '../__mocks__/fakeMandalaRuntime'

const PAYEE_IDENTITY = '03'.padEnd(66, 'e')

const wrap = (ui: React.ReactElement) =>
  render(
    <ThemeProvider>
      <MandalaProvider runtime={makeFakeMandala()}>{ui}</MandalaProvider>
    </ThemeProvider>
  )

const settle = async () => {
  await act(async () => {
    await new Promise(resolve => setImmediate(resolve))
  })
}

beforeEach(() => {
  jest.clearAllMocks()
  mockScanHandler = undefined
  mockCreateNonce.mockResolvedValueOnce(FIXED_PREFIX).mockResolvedValueOnce(FIXED_SUFFIX)
  mockVerifyFramePayment.mockResolvedValue({ kind: 'bsv', satoshis: 5000 })
  mockSavePending.mockResolvedValue(undefined)
  mockMarkSessionSpent.mockResolvedValue(undefined)
  mockProcessPending.mockResolvedValue([{ success: true }])
  const barrel = jest.requireMock('@bsv/expo-wallet-toolbox') as { selectTransport: jest.Mock }
  barrel.selectTransport.mockReturnValue('qr')
})

async function scanPayerFrame(s: ReturnType<typeof wrap>) {
  await waitFor(() => expect(s.getByText('local_pay_show_qr')).toBeTruthy())
  await act(async () => {
    fireEvent.press(s.getByText('local_pay_scan_payer_qr'))
  })
  await waitFor(() => expect(mockScanHandler).toBeTruthy())
  await act(async () => {
    mockScanHandler!('bsvpayf1:stub-part')
  })
}

describe('NearbyFlow — payee receive verification (P1-1)', () => {
  it('shows the neutral confirming copy the instant the overlay appears, before processPending resolves', async () => {
    // Never resolves within this test, so the overlay is pinned at 'pending'.
    let resolveProcessPending: (v: { success: boolean }[]) => void = () => {}
    mockProcessPending.mockReturnValue(new Promise(resolve => (resolveProcessPending = resolve)))

    const s = wrap(<NearbyFlow role="payee" initialRequest={{ sats: 5000 }} onExit={jest.fn()} />)
    await scanPayerFrame(s)

    await waitFor(() => expect(s.getByText('local_pay_received_confirming')).toBeTruthy())
    expect(s.queryByText('local_pay_added')).toBeNull()
    expect(s.queryByText('local_pay_received_not_credited')).toBeNull()

    // Clean up the dangling promise so it cannot leak into another test.
    resolveProcessPending([{ success: true }])
    await settle()
  })

  it('flips to the green verified state once processPending credits the payment', async () => {
    mockProcessPending.mockResolvedValue([{ success: true }])

    const s = wrap(<NearbyFlow role="payee" initialRequest={{ sats: 5000 }} onExit={jest.fn()} />)
    await scanPayerFrame(s)
    await settle()

    await waitFor(() => expect(s.getByText('local_pay_added')).toBeTruthy())
    expect(s.queryByText('local_pay_received_confirming')).toBeNull()
    expect(s.queryByText('local_pay_received_not_credited')).toBeNull()
  })

  it('flips to the non-green not-credited state when processPending returns no success', async () => {
    mockProcessPending.mockResolvedValue([{ success: false }])

    const s = wrap(<NearbyFlow role="payee" initialRequest={{ sats: 5000 }} onExit={jest.fn()} />)
    await scanPayerFrame(s)
    await settle()

    await waitFor(() => expect(s.getByText('local_pay_received_not_credited')).toBeTruthy())
    expect(s.queryByText('local_pay_added')).toBeNull()
  })

  it('flips to the non-green not-credited state when processPending throws', async () => {
    mockProcessPending.mockRejectedValue(new Error('storage down'))
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})

    const s = wrap(<NearbyFlow role="payee" initialRequest={{ sats: 5000 }} onExit={jest.fn()} />)
    await scanPayerFrame(s)
    await settle()

    await waitFor(() => expect(s.getByText('local_pay_received_not_credited')).toBeTruthy())
    expect(s.queryByText('local_pay_added')).toBeNull()
    warn.mockRestore()
  })

  it('the durable write itself is unaffected: savePending and markSessionSpent still ran before the overlay resolved', async () => {
    mockProcessPending.mockResolvedValue([{ success: true }])

    const s = wrap(<NearbyFlow role="payee" initialRequest={{ sats: 5000 }} onExit={jest.fn()} />)
    await scanPayerFrame(s)
    await settle()

    expect(mockSavePending).toHaveBeenCalled()
    expect(mockMarkSessionSpent).toHaveBeenCalled()
  })
})
